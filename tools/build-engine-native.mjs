#!/usr/bin/env node
/**
 * 构建 Linux / macOS 原生网易引擎（NTvector），不再依赖 Wine。
 *
 *   npm run build:engine            # 当前平台
 *   npm run build:engine -- --clean # 清掉源码/构建缓存后重来
 *
 * 产物：
 *   netease-bot/ntvector-native/Program          原生可执行文件
 *   netease-bot/ntvector-native/python312/       随包 Python 3.12 运行时
 *   netease-bot/ntvector-native/scripts/...      事件桥插件
 *
 * 上游 NTvector 是 Windows 优先的项目；本脚本在 clone 后应用
 * packaging/engine/patches/native-linux-macos.patch：
 *   - Python 改为链接 Linux/macOS 的 libpython3.12
 *   - PythonHome 改为可执行文件旁的 python312/
 *   - 修 Linux 大小写/枚举告警/控制台函数
 *   - 注入 $ORIGIN / @loader_path 的 RPATH
 *
 * Windows 不适用（继续用官方 Program.exe）。
 */
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const SRC = path.join(CACHE, "ntvector-src");
const BUILD = path.join(CACHE, "ntvector-build");
const PY = path.join(CACHE, "python312");
const OUT = path.join(ROOT, "netease-bot", "ntvector-native");
const ZIP = path.join(ROOT, "vendor", "ntvector", "NTVector.Official.version.V1.1.1.zip");
const PATCH = path.join(ROOT, "packaging", "engine", "patches", "native-linux-macos.patch");

const SRC_REPO = "https://github.com/lurete-cn/NTvector";
const SRC_COMMIT = "ce743787b83944cf39649041f9011919763b41ba";
const PY_RELEASE = "20261110";
const PY_VERSION = "3.12.16";

const args = process.argv.slice(2);
const clean = args.includes("--clean");

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} 退出码 ${r.status}`);
}

function has(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

function pythonAsset() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  const target = map[key];
  if (!target) throw new Error(`原生引擎暂不支持 ${key}（支持 linux/macOS x64/arm64）`);
  const name = `cpython-${PY_VERSION}+${PY_RELEASE}-${target}-install_only.tar.gz`;
  return {
    name,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${encodeURIComponent(name).replace(/%2B/g, "%2B")}`,
  };
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return;
  console.log(`下载 ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

function ensureSource() {
  if (clean) rm(SRC);
  if (!fs.existsSync(path.join(SRC, "CMakeLists.txt"))) {
    rm(SRC);
    fs.mkdirSync(CACHE, { recursive: true });
    console.log("clone NTvector（浅克隆）…");
    run("git", ["clone", "--depth", "1", SRC_REPO, SRC]);
  }
  const head = spawnSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  if (head !== SRC_COMMIT) {
    console.log(`切换到固定提交 ${SRC_COMMIT.slice(0, 8)}…`);
    run("git", ["-C", SRC, "fetch", "--depth", "1", "origin", SRC_COMMIT]);
    run("git", ["-C", SRC, "checkout", "-f", SRC_COMMIT]);
  }
  // Linux 大小写敏感：上游 #include "SLikeNet/..."，实际目录是 slikenet
  const inc = path.join(SRC, "application", "include", "SLikeNet-master", "Source", "include");
  const link = path.join(inc, "SLikeNet");
  if (!fs.existsSync(link)) fs.symlinkSync("slikenet", link);

  const check = spawnSync("git", ["-C", SRC, "apply", "--reverse", "--check", PATCH], { encoding: "utf8" });
  if (check.status !== 0) {
    console.log("应用原生平台补丁…");
    run("git", ["-C", SRC, "apply", "--whitespace=nowarn", PATCH]);
  }
}

async function ensurePython() {
  if (clean) rm(PY);
  if (fs.existsSync(path.join(PY, "lib", "python3.12")) && fs.existsSync(path.join(PY, "include", "python3.12"))) return;
  const asset = pythonAsset();
  const tar = path.join(CACHE, asset.name);
  await download(asset.url, tar);
  rm(PY);
  fs.mkdirSync(PY, { recursive: true });
  run("tar", ["-xzf", tar, "-C", PY, "--strip-components=1"]);
}

function trimPython(root) {
  // 只留解释器 + 标准库 + 扩展模块；tkinter/tcl/test/idle 都不需要
  for (const rel of [
    "bin",
    "share",
    "include",
    "lib/pkgconfig",
    "lib/python3.12/test",
    "lib/python3.12/idlelib",
    "lib/python3.12/tkinter",
    "lib/python3.12/turtledemo",
    "lib/python3.12/ensurepip",
    "lib/python3.12/lib2to3",
    "lib/python3.12/pydoc_data",
    "lib/python3.12/site-packages/pip",
  ]) {
    rm(path.join(root, rel));
  }
  for (const entry of fs.readdirSync(path.join(root, "lib"))) {
    if (/^(tcl|tk|itcl|thread)/i.test(entry)) rm(path.join(root, "lib", entry));
  }
  for (const entry of fs.readdirSync(path.join(root, "lib"))) {
    if (/^lib(tcl|tk)/i.test(entry)) rm(path.join(root, "lib", entry));
  }
}

function extractRuntimeAssets() {
  if (!fs.existsSync(ZIP)) throw new Error(`缺少 ${path.relative(ROOT, ZIP)}`);
  const zip = new AdmZip(ZIP);
  const wanted = ["client_cfg.json", "model.json", "skin.png", "skin_data.json"];
  for (const name of wanted) {
    const entry = zip.getEntry(`Vector/${name}`);
    if (entry) fs.writeFileSync(path.join(OUT, name), entry.getData());
  }
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith("Vector/source/") || entry.isDirectory) continue;
    const rel = entry.entryName.slice("Vector/".length);
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
  // 反作弊链路依赖的纯 Python 包（Windows 包里带，Linux/mac 直接复用）
  const site = path.join(OUT, "python312", "lib", "python3.12", "site-packages");
  fs.mkdirSync(site, { recursive: true });
  for (const entry of zip.getEntries()) {
    const m = /^Vector\/python312\/Lib\/site-packages\/([^/]+\.py)$/.exec(entry.entryName);
    if (m) fs.writeFileSync(path.join(site, m[1]), entry.getData());
  }
}

function installBridge() {
  const bridgeSrc = path.join(ROOT, "packaging", "netease-bot", "bridge", "cubeloom_bridge");
  copyDir(bridgeSrc, path.join(OUT, "scripts", "cubeloom_bridge"));
  const cfgPath = path.join(OUT, "scripts", "cubeloom_bridge", "cubeloom_bridge.json");
  const existing = path.join(ROOT, "netease-bot", "ntvector", "scripts", "cubeloom_bridge", "cubeloom_bridge.json");
  let token = "";
  try {
    token = String(JSON.parse(fs.readFileSync(existing, "utf8")).token || "");
  } catch {}
  if (!token) token = crypto.randomBytes(12).toString("base64url");
  const cfg = { host: "127.0.0.1", port: 17999, token, protocol: 860, gameVersion: "1.21.120" };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function stage() {
  rm(OUT);
  fs.mkdirSync(OUT, { recursive: true });
  const binary = path.join(BUILD, "application", "Program");
  if (!fs.existsSync(binary)) throw new Error("构建没有产出 application/Program");
  fs.copyFileSync(binary, path.join(OUT, "Program"));
  fs.chmodSync(path.join(OUT, "Program"), 0o755);

  copyDir(PY, path.join(OUT, "python312"));
  trimPython(path.join(OUT, "python312"));
  extractRuntimeAssets();

  if (process.platform === "linux" && has("strip")) {
    spawnSync("strip", ["--strip-unneeded", path.join(OUT, "Program")], { stdio: "ignore" });
    const lib = path.join(OUT, "python312", "lib", "libpython3.12.so.1.0");
    if (fs.existsSync(lib)) spawnSync("strip", ["--strip-unneeded", lib], { stdio: "ignore" });
  }
  installBridge();

  if (process.platform === "linux") {
    if (has("patchelf")) {
      run("patchelf", ["--set-rpath", "$ORIGIN/python312/lib", path.join(OUT, "Program")]);
    } else {
      console.log("  （没有 patchelf，保留 CMake 注入的 $ORIGIN RUNPATH）");
    }
  } else if (process.platform === "darwin") {
    // 构建时链接的绝对路径可能在临时目录；改成 @rpath + 相对 rpath
    const prog = path.join(OUT, "Program");
    const dylib = path.join(OUT, "python312", "lib", "libpython3.12.dylib");
    const deps = spawnSync("otool", ["-L", prog], { encoding: "utf8" }).stdout || "";
    for (const line of deps.split(/\r?\n/)) {
      const m = line.trim().match(/^(\/.*\/libpython3\.12\.dylib)/);
      if (m) spawnSync("install_name_tool", ["-change", m[1], "@rpath/libpython3.12.dylib", prog], { stdio: "ignore" });
    }
    spawnSync("install_name_tool", ["-id", "@rpath/libpython3.12.dylib", dylib], { stdio: "ignore" });
    spawnSync("install_name_tool", ["-add_rpath", "@loader_path/python312/lib", prog], { stdio: "ignore" });
    spawnSync("codesign", ["--force", "--sign", "-", dylib], { stdio: "ignore" });
    spawnSync("codesign", ["--force", "--sign", "-", prog], { stdio: "ignore" });
  }

  const size = spawnSync("du", ["-sh", OUT], { encoding: "utf8" }).stdout?.trim() || "";
  console.log(`\n原生引擎：${path.relative(ROOT, OUT)}  ${size}`);
}

async function main() {
  if (process.platform === "win32") {
    console.log("Windows 继续用 Program.exe，不需要原生构建");
    return;
  }
  if (!has("cmake")) throw new Error("缺少 cmake");
  if (!has("git")) throw new Error("缺少 git");
  ensureSource();
  await ensurePython();
  rm(BUILD);
  console.log("配置（Python 3.12: " + path.relative(ROOT, PY) + "）…");
  run("cmake", [
    "-S", SRC,
    "-B", BUILD,
    `-DPY312_ROOT=${PY}`,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DENABLE_NTUNISDK=OFF",
  ]);
  const jobs = Math.max(2, Math.min(6, Number(process.env.FB_ENGINE_JOBS || 4)));
  console.log(`编译（-j${jobs}）…`);
  run("cmake", ["--build", BUILD, "-j", String(jobs)]);
  stage();
}

main().catch((e) => {
  console.error(`\n原生引擎构建失败：${e?.message ?? e}`);
  process.exit(1);
});
