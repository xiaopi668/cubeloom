#!/usr/bin/env node
/**
 * 构建 Android 原生网易引擎（arm64-v8a / x86_64）。
 *
 *   npm run build:engine:android
 *
 * 依赖：Android NDK 27、cmake、patchelf、Go（带 NDK cgo）、网络（下载 Chaquopy Python 3.12）
 * 产物：
 *   packaging/engine/android/<abi>/*.so        引擎、Python、Go 登录助手、SSL 扩展
 *   packaging/android/app/src/main/assets/engine/                 公共 Python 标准库与资源
 *   packaging/android/app/src/main/assets/engine-lib-dynload/<abi>/ ABI 专用扩展
 *
 * 之后 `npm run build:android` 会把它们塞进 APK；Java 侧从 nativeLibraryDir 执行引擎。
 */
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const SRC = path.join(CACHE, "ntvector-src");
const CHAQ = path.join(CACHE, "chaquopy");
const WRAP = path.join(CACHE, "ndk-wrap");
const STAGE = path.join(ROOT, "packaging", "engine", "android");
const ASSETS = path.join(ROOT, "packaging", "android", "app", "src", "main", "assets");
const HTTP_ASSETS = path.join(ASSETS, "engine");
const PATCH = path.join(ROOT, "packaging", "engine", "patches", "native-linux-macos.patch");
const ZIP = path.join(ROOT, "vendor", "ntvector", "NTVector.Official.version.V1.1.1.zip");

const SRC_REPO = "https://github.com/lurete-cn/NTvector";
const SRC_COMMIT = "ce743787b83944cf39649041f9011919763b41ba";
const CHAQ_BASE = "https://repo1.maven.org/maven2/com/chaquo/python/target/3.12.7-1";
const ABIS = process.argv.includes("--x86-only") ? ["x86_64"] : ["arm64-v8a", "x86_64"];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 退出码 ${r.status}`);
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
function ndkRoot() {
  // 默认 NDK；CI 请设置 ANDROID_NDK_HOME
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    path.join(process.env.HOME || "", "Android/Sdk/ndk/27.0.12077973"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, "build/cmake/android.toolchain.cmake"))) return c;
  throw new Error("找不到 Android NDK（设置 ANDROID_NDK_HOME）");
}
function abiTriple(abi) {
  return abi === "x86_64" ? "x86_64-linux-android" : "aarch64-linux-android";
}
function goArch(abi) {
  return abi === "x86_64" ? "amd64" : "arm64";
}

function ensureSource() {
  if (!fs.existsSync(path.join(SRC, "CMakeLists.txt"))) {
    fs.mkdirSync(CACHE, { recursive: true });
    console.log("clone NTvector…");
    run("git", ["clone", "--depth", "1", SRC_REPO, SRC]);
  }
  const head = spawnSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  if (head !== SRC_COMMIT) {
    run("git", ["-C", SRC, "fetch", "--depth", "1", "origin", SRC_COMMIT]);
    run("git", ["-C", SRC, "checkout", "-f", SRC_COMMIT]);
  }
  const inc = path.join(SRC, "application", "include", "SLikeNet-master", "Source", "include");
  if (!fs.existsSync(path.join(inc, "SLikeNet"))) fs.symlinkSync("slikenet", path.join(inc, "SLikeNet"));
  const rev = spawnSync("git", ["-C", SRC, "apply", "--reverse", "--check", PATCH], { encoding: "utf8" });
  if (rev.status !== 0) run("git", ["-C", SRC, "apply", "--whitespace=nowarn", PATCH]);
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return;
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function ensureChaquopy() {
  fs.mkdirSync(CHAQ, { recursive: true });
  const stdlib = path.join(CHAQ, "stdlib.zip");
  await download(`${CHAQ_BASE}/target-3.12.7-1-stdlib-pyc.zip`, stdlib);
  for (const abi of ABIS) {
    const zip = path.join(CHAQ, `${abi}.zip`);
    await download(`${CHAQ_BASE}/target-3.12.7-1-${abi}.zip`, zip);
    const dir = path.join(CHAQ, abi);
    if (!fs.existsSync(path.join(dir, "include/python3.12/Python.h"))) {
      rm(dir);
      new AdmZip(zip).extractAllTo(dir, true);
    }
  }
}

function makeWrappers(ndk) {
  rm(WRAP);
  fs.mkdirSync(WRAP, { recursive: true });
  const bin = path.join(ndk, "toolchains/llvm/prebuilt/linux-x86_64/bin");
  for (const abi of ABIS) {
    const triple = abiTriple(abi);
    const clang = path.join(bin, `${triple}24-clang`);
    for (const [name, target] of [
      [`${triple}-gcc`, clang],
      [`${triple}-g++`, path.join(bin, `${triple}24-clang++`)],
      [`${triple}-ar`, path.join(bin, "llvm-ar")],
      [`${triple}-ranlib`, path.join(bin, "llvm-ranlib")],
    ]) {
      const file = path.join(WRAP, name);
      fs.writeFileSync(file, `#!/bin/sh\nexec "${target}" "$@"\n`, { mode: 0o755 });
    }
  }
}

function preparePrefix(abi) {
  const src = path.join(CHAQ, abi);
  const prefix = path.join(CHAQ, `${abi}-prefix`);
  rm(prefix);
  fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
  copyDir(path.join(src, "include", "python3.12"), path.join(prefix, "include", "python3.12"));
  fs.copyFileSync(path.join(src, "jniLibs", abi, "libpython3.12.so"), path.join(prefix, "lib", "libpython3.12.so"));
  return prefix;
}

function buildAbi(ndk, abi) {
  const prefix = preparePrefix(abi);
  const build = path.join(CACHE, `ntvector-android-${abi}`);
  rm(build);
  console.log(`== 配置 Android ${abi} ==`);
  run("cmake", [
    "-S", SRC,
    "-B", build,
    `-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake`,
    `-DANDROID_ABI=${abi}`,
    "-DANDROID_PLATFORM=android-24",
    "-DANDROID_STL=c++_shared",
    "-DPLATFORM_ANDROID=ON",
    `-DPY312_ROOT=${prefix}`,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DENABLE_NTUNISDK=OFF",
  ], { env: { ...process.env, FB_NDK_WRAP: WRAP } });
  console.log(`== 编译 Android ${abi} ==`);
  run("cmake", ["--build", build, "-j", process.env.FB_ENGINE_JOBS || "4"]);
  const prog = path.join(build, "application", "Program");
  if (!fs.existsSync(prog)) throw new Error(`${abi}: 没有产出 Program`);
  const out = path.join(STAGE, abi);
  rm(out);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(prog, path.join(out, "libcubeloom_engine.so"));
  run("patchelf", ["--replace-needed", path.join(prefix, "lib", "libpython3.12.so"), "libpython3.12.so", path.join(out, "libcubeloom_engine.so")]);
  run("patchelf", ["--set-rpath", "$ORIGIN/python312/lib", path.join(out, "libcubeloom_engine.so")]);
  fs.copyFileSync(path.join(prefix, "lib", "libpython3.12.so"), path.join(out, "libpython3.12.so"));
  for (const lib of ["libssl_python.so", "libcrypto_python.so"]) {
    const p = path.join(CHAQ, abi, "jniLibs", abi, lib);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(out, lib));
  }
  // Go 登录助手
  const triple = abiTriple(abi);
  const bin = path.join(ndk, "toolchains/llvm/prebuilt/linux-x86_64/bin");
  run("go", ["build", "-trimpath", "-buildmode=pie", "-ldflags", "-s -w", "-o", path.join(out, "libx19login.so"), "."], {
    cwd: path.join(ROOT, "tools", "x19login"),
    env: {
      ...process.env,
      CGO_ENABLED: "1",
      GOOS: "android",
      GOARCH: goArch(abi),
      CC: path.join(bin, `${triple}24-clang`),
      CXX: path.join(bin, `${triple}24-clang++`),
    },
  });
  // ABI lib-dynload
  const dyn = path.join(ASSETS, "engine-lib-dynload", abi);
  rm(dyn);
  copyDir(path.join(CHAQ, abi, "lib-dynload", abi), dyn);
  console.log(`  ${abi} 完成`);
}

function stageCommon() {
  rm(HTTP_ASSETS);
  fs.mkdirSync(path.join(HTTP_ASSETS, "python312/lib/python3.12"), { recursive: true });
  const stdlib = path.join(CHAQ, "stdlib");
  if (!fs.existsSync(path.join(stdlib, "os.pyc"))) rm(stdlib);
  if (!fs.existsSync(stdlib)) new AdmZip(path.join(CHAQ, "stdlib.zip")).extractAllTo(stdlib, true);
  copyDir(stdlib, path.join(HTTP_ASSETS, "python312/lib/python3.12"));
  const site = path.join(HTTP_ASSETS, "python312/lib/python3.12/site-packages");
  fs.mkdirSync(site, { recursive: true });
  const zip = new AdmZip(ZIP);
  for (const entry of zip.getEntries()) {
    const m = /^Vector\/python312\/Lib\/site-packages\/([^/]+\.py)$/.exec(entry.entryName);
    if (m) fs.writeFileSync(path.join(site, m[1]), entry.getData());
  }
  for (const name of ["client_cfg.json", "model.json", "skin.png", "skin_data.json"]) {
    const e = zip.getEntry(`Vector/${name}`);
    if (e) fs.writeFileSync(path.join(HTTP_ASSETS, name), e.getData());
  }
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith("Vector/source/") || entry.isDirectory) continue;
    const rel = entry.entryName.slice("Vector/".length);
    const dest = path.join(HTTP_ASSETS, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
  const bridge = path.join(ROOT, "packaging", "netease-bot", "bridge", "cubeloom_bridge");
  copyDir(bridge, path.join(HTTP_ASSETS, "scripts", "cubeloom_bridge"));
  const cfg = { host: "127.0.0.1", port: 17999, token: "android-" + Math.random().toString(36).slice(2, 14), protocol: 860, gameVersion: "1.21.120" };
  fs.writeFileSync(path.join(HTTP_ASSETS, "scripts", "cubeloom_bridge", "cubeloom_bridge.json"), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

async function main() {
  if (process.platform !== "linux") throw new Error("Android 引擎构建目前只在 Linux 上支持（CI ubuntu）");
  if (!has("cmake") || !has("git") || !has("patchelf")) throw new Error("需要 cmake / git / patchelf");
  const ndk = ndkRoot();
  ensureSource();
  await ensureChaquopy();
  makeWrappers(ndk);
  for (const abi of ABIS) buildAbi(ndk, abi);
  stageCommon();
  console.log("\nAndroid 引擎已就绪：packaging/engine/android/<abi>");
}

main().catch((e) => {
  console.error(`Android 引擎构建失败：${e?.message ?? e}`);
  process.exit(1);
});
