/**
 * Cubeloom 桌面端（Electron）入口。
 *
 * 结构：
 *   app/
 *     electron-main.cjs        ← 本文件
 *     server/admin-server.cjs  ← admin-server 预编译产物
 *     server/main.cjs          ← WS 服务预编译产物（由 admin-server 拉起）
 *     server/voxel-geometry.iife.js
 *     admin/                   ← 面板静态资源（启动时复制到 userData）
 *
 * 设计要点：
 *   · 不在 Electron 主进程里跑业务代码：admin-server 仍作为子进程，
 *     崩溃/重启语义和 CLI 版一致；
 *   · 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node，
 *     用户不需要另外装 Node；
 *   · 可写目录（日志 / auth.json / 结构临时文件）放 `app.getPath("userData")`，
 *     安装目录（AppImage / Program Files）保持只读也能跑；
 *   · 面板仍是普通 http://127.0.0.1:11452，游戏里照常 `/connect`。
 */
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN_PORT = Number(process.env.FB_ADMIN_PORT || 11452);
/** 实际使用的端口：11452 被占用时会自动换一个，窗口地址跟着变 */
let activePort = ADMIN_PORT;
let APP_URL = `http://127.0.0.1:${activePort}/`;
/** 是否由本进程拉起后台服务（端口上已有 Cubeloom 时直接复用） */
let spawnedByUs = false;

let serverChild = null;
let mainWindow = null;
let quitting = false;

function httpGetJson(url, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
        if (body.length > 4096) req.destroy();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
  });
}

async function ping(url, timeout = 800) {
  const res = await httpGetJson(url, timeout);
  return res.status === 200;
}

/** 端口上跑的是不是 Cubeloom（/api/ping 由 admin-server 提供，不需要登录） */
async function probeCubeloom(port) {
  const res = await httpGetJson(`http://127.0.0.1:${port}/api/ping`, 800);
  return res.status === 200 && res.json && res.json.app === "Cubeloom";
}

/** 端口是否被别的程序占着 */
function portInUse(port) {
  return new Promise((resolve) => {
    const net = require("node:net");
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e && e.code === "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

/** 桌面端自己的日志：后台服务的 stdout/stderr 都落这里，启动失败时能直接看到原因 */
function serverLogFile() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "desktop.log");
}

function appendLog(line) {
  try {
    fs.appendFileSync(serverLogFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function readLogTail(lines = 30) {
  try {
    const text = fs.readFileSync(serverLogFile(), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function waitServer(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ping(`http://127.0.0.1:${port}/`)) return true;
    if (serverChild && serverChild.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * 选一个能用的端口：11452 → 11462..11472。
 * 如果 11452 上已经是 Cubeloom（比如旧实例没退干净），直接复用，不再拉起第二个。
 */
async function pickServerPort() {
  if (await probeCubeloom(ADMIN_PORT)) return { port: ADMIN_PORT, reuse: true };
  for (const port of [ADMIN_PORT, 11462, 11463, 11464, 11465, 11466, 11467, 11468, 11469, 11470, 11471, 11472]) {
    if (!(await portInUse(port))) return { port, reuse: false };
  }
  return { port: ADMIN_PORT, reuse: false };
}

/** 把只读安装目录里的静态资源同步到可写 userData（只做小文件，保证服务尽快起来） */
function prepareUserData() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  const srcAdmin = path.join(__dirname, "admin");
  const dstAdmin = path.join(dir, "admin");
  try {
    fs.rmSync(dstAdmin, { recursive: true, force: true });
    fs.cpSync(srcAdmin, dstAdmin, { recursive: true });
  } catch (e) {
    console.error("复制面板资源失败：", e);
    appendLog(`[desktop] 复制面板资源失败：${e && e.message ? e.message : e}`);
  }
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

/**
 * 网易机器人体积大（~43MB、上万个文件），首次启动复制会被杀软扫很久。
 * 放到后台做，不挡面板启动；复制完成前用户点「启动机器人」会看到引擎未解压，稍等即可。
 */
function ensureBotCopyAsync() {
  const dir = app.getPath("userData");
  const srcBot = path.join(__dirname, "netease-bot");
  const dstBot = path.join(dir, "netease-bot");
  if (!fs.existsSync(srcBot) || fs.existsSync(path.join(dstBot, "ntvector", "Program.exe"))) return;
  fs.mkdirSync(dstBot, { recursive: true });
  appendLog("[desktop] 正在复制网易机器人到 userData（后台进行）…");
  setTimeout(() => {
    try {
      fs.cpSync(srcBot, dstBot, { recursive: true });
      appendLog("[desktop] 网易机器人复制完成");
    } catch (e) {
      appendLog(`[desktop] 复制网易机器人失败：${e && e.message ? e.message : e}`);
      console.error("复制网易机器人失败：", e);
    }
  }, 500);
}

function startServer(port) {
  const userData = prepareUserData();
  const serverDir = path.join(__dirname, "server");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FB_APP_ROOT: userData,
    // panel 的 auth.json 不能放在 userData/admin（每次启动会被静态资源覆盖）
    FB_ADMIN_AUTH_FILE: path.join(userData, "auth.json"),
    FB_WS_ENTRY: path.join(serverDir, "main.cjs"),
    FB_FORCE_ENTRY: "1",
    FB_NO_REPL: "1",
    FB_NO_OPEN: "1",
    FB_GEOMETRY_BUNDLE: path.join(serverDir, "voxel-geometry.iife.js"),
    FB_NETEASE_ENTRY: path.join(serverDir, "netease-service.cjs"),
    FB_NETEASE_BOT_DIR: path.join(userData, "netease-bot"),
    FB_X19LOGIN: path.join(serverDir, process.platform === "win32" ? "x19login.exe" : "x19login"),
    FB_X19_CACHE: path.join(userData, "x19-device.json"),
    FB_ADMIN_PORT: String(port),
    FB_APP_VERSION: app.getVersion(),
    FB_WS_PORT: process.env.FB_WS_PORT || "11451",
    FB_CONTROL_PORT: process.env.FB_CONTROL_PORT || "11453",
    FB_LOG_DIR: path.join(userData, "logs"),
  };
  serverChild = spawn(process.execPath, [path.join(serverDir, "admin-server.cjs")], {
    cwd: userData,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  appendLog(`[desktop] 启动后台服务：port=${port} cwd=${userData}`);
  ensureBotCopyAsync();
  serverChild.stdout.on("data", (d) => {
    process.stdout.write(d);
    appendLog(String(d).replace(/\r?\n$/, ""));
  });
  serverChild.stderr.on("data", (d) => {
    process.stderr.write(d);
    appendLog(`[stderr] ${String(d).replace(/\r?\n$/, "")}`);
  });
  serverChild.on("exit", (code) => {
    console.log(`[cubeloom] server exited: ${code}`);
    if (!quitting) {
      dialog.showErrorBox("Cubeloom 服务已退出", `后台服务退出（code=${code}）。\n日志：${path.join(userData, "logs")}`);
    }
  });
}

function stopServer() {
  if (!serverChild || serverChild.exitCode !== null) return;
  try {
    if (process.platform === "win32") serverChild.kill();
    else process.kill(-serverChild.pid, "SIGTERM");
  } catch {
    try {
      serverChild.kill("SIGTERM");
    } catch {}
  }
}

function createWindow() {
  // 图标：打包后与 electron-main.cjs 同目录；开发时可能不存在，存在才传
  const iconPath = path.join(__dirname, "icon.png");
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0b",
    title: "Cubeloom",
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(APP_URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Cubeloom",
        submenu: [
          { role: "reload", label: "刷新面板" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      { role: "editMenu", label: "编辑" },
      { role: "viewMenu", label: "视图" },
    ])
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const picked = await pickServerPort();
    activePort = picked.port;
    APP_URL = `http://127.0.0.1:${activePort}/`;
    if (picked.reuse) {
      appendLog(`[desktop] 复用已在运行的 Cubeloom：${APP_URL}`);
    } else {
      if (activePort !== ADMIN_PORT) {
        appendLog(`[desktop] 端口 ${ADMIN_PORT} 被占用，改用 ${activePort}`);
      }
      startServer(activePort);
      spawnedByUs = true;
    }
    const ok = await waitServer(activePort);
    if (!ok) {
      const tail = readLogTail();
      dialog.showErrorBox(
        "Cubeloom 启动失败",
        `后台服务 30 秒内没有就绪（端口 ${activePort}）。\n\n` +
          `最近的日志：\n${tail || "（没有日志，可能是权限/杀软拦截）"}\n\n` +
          `完整日志：${path.join(app.getPath("userData"), "logs")}`
      );
      app.quit();
      return;
    }
    buildMenu();
    mainWindow = createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    // 复用别人起的服务时不要去杀它
    if (spawnedByUs) stopServer();
  });
}
