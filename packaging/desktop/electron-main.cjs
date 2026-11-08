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
const APP_URL = `http://127.0.0.1:${ADMIN_PORT}/`;

let serverChild = null;
let mainWindow = null;
let quitting = false;

function ping(url, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitServer(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ping(APP_URL)) return true;
    if (serverChild && serverChild.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 把只读安装目录里的静态资源同步到可写 userData */
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
  }
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  // 机器人体积大（~43MB），只在缺失时复制一次；升级由安装包重新解压到新 userData 处理
  const srcBot = path.join(__dirname, "netease-bot");
  const dstBot = path.join(dir, "netease-bot");
  if (fs.existsSync(srcBot) && !fs.existsSync(path.join(dstBot, "ntvector", "Program.exe"))) {
    try {
      fs.cpSync(srcBot, dstBot, { recursive: true });
    } catch (e) {
      console.error("复制网易机器人失败：", e);
    }
  }
  return dir;
}

function startServer() {
  const userData = prepareUserData();
  const serverDir = path.join(__dirname, "server");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FB_APP_ROOT: userData,
    FB_WS_ENTRY: path.join(serverDir, "main.cjs"),
    FB_FORCE_ENTRY: "1",
    FB_NO_REPL: "1",
    FB_NO_OPEN: "1",
    FB_GEOMETRY_BUNDLE: path.join(serverDir, "voxel-geometry.iife.js"),
    FB_NETEASE_ENTRY: path.join(serverDir, "netease-service.cjs"),
    FB_NETEASE_BOT_DIR: path.join(userData, "netease-bot"),
    FB_ADMIN_PORT: String(ADMIN_PORT),
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
  serverChild.stdout.on("data", (d) => process.stdout.write(d));
  serverChild.stderr.on("data", (d) => process.stderr.write(d));
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
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0b",
    title: "Cubeloom",
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
    startServer();
    const ok = await waitServer();
    if (!ok) {
      dialog.showErrorBox(
        "Cubeloom 启动失败",
        `后台服务 20 秒内没有就绪。\n可能是端口 ${ADMIN_PORT} 被占用，或日志目录不可写。\n\n日志：${path.join(app.getPath("userData"), "logs")}`
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
    stopServer();
  });
}
