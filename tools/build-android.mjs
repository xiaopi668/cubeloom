#!/usr/bin/env node
/**
 * 构建 Android debug APK：
 *   1. 准备 build/mobile/nodejs-project（没有就先跑 tools/build.mjs）
 *   2. 取 nodejs-mobile 的 libnode.so（Node 18.20.4）+ 头文件
 *   3. 把 assets / jniLibs 塞进 packaging/android
 *   4. gradle assembleDebug，产物复制到 dist-app/
 *
 * 前置：
 *   - Android SDK（platform 36）+ NDK 27.0.12077973 + CMake 3.22.1
 *   - Gradle 8.13（或用 packaging/android/gradlew）
 *   - 首次会从 npm 下载 nodejs-mobile-react-native（约 100MB，缓存到 build/cache）
 */
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = path.join(ROOT, "packaging", "android");
const APP = path.join(ANDROID, "app");
const ASSETS = path.join(APP, "src", "main", "assets", "nodejs-project");
const CPP = path.join(APP, "src", "main", "cpp");
const JNI = path.join(APP, "src", "main", "jniLibs");
const CACHE = path.join(ROOT, "build", "cache");
const NMJ = path.join(CACHE, "nodejs-mobile");
const ABI = ["arm64-v8a", "x86_64"];
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 退出码 ${r.status}`);
}

function ensureMobileBuild() {
  const src = path.join(ROOT, "build", "mobile", "nodejs-project");
  if (!fs.existsSync(path.join(src, "admin-server.cjs"))) {
    console.log("构建 mobile bundle …");
    run(process.execPath, [path.join(ROOT, "tools", "build.mjs")], { env: { ...process.env, FB_SKIP_X19LOGIN: "1" } });
  }
  fs.rmSync(ASSETS, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(ASSETS), { recursive: true });
  fs.cpSync(src, ASSETS, { recursive: true });
  console.log("assets/nodejs-project 就绪");
}

function ensureNodejsMobile() {
  const pkgDir = path.join(NMJ, "package");
  const so = path.join(pkgDir, "android", "libnode", "bin", "arm64-v8a", "libnode.so");
  if (fs.existsSync(so)) return pkgDir;
  fs.mkdirSync(NMJ, { recursive: true });
  console.log("下载 nodejs-mobile-react-native@18.20.4（首次约 100MB）…");
  run("npm", ["pack", "nodejs-mobile-react-native@18.20.4", "--pack-destination", NMJ]);
  const tgz = fs.readdirSync(NMJ).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack 没有产出 tgz");
  // npm pack 是 gzip tar；用系统 tar（Windows 10+/macOS/Linux 都有 bsdtar）
  run("tar", ["-xzf", path.join(NMJ, tgz), "-C", NMJ]);
  if (!fs.existsSync(so)) throw new Error("解压后仍缺少 libnode.so");
  return pkgDir;
}

function prepareNative(pkgDir) {
  fs.rmSync(path.join(CPP, "libnode"), { recursive: true, force: true });
  fs.cpSync(path.join(pkgDir, "android", "libnode", "include"), path.join(CPP, "libnode", "include"), {
    recursive: true,
  });
  fs.rmSync(JNI, { recursive: true, force: true });
  for (const abi of ABI) {
    const from = path.join(pkgDir, "android", "libnode", "bin", abi, "libnode.so");
    if (!fs.existsSync(from)) throw new Error(`缺少 ${abi} 的 libnode.so`);
    const to = path.join(JNI, abi, "libnode.so");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log("libnode.so 与头文件就绪（" + ABI.join(", ") + "）");
}

function writeLocalProperties() {
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME ||
    path.join(process.env.HOME || "", "Android", "Sdk");
  fs.writeFileSync(path.join(ANDROID, "local.properties"), `sdk.dir=${sdk}\n`);
}

const ENGINE_STAGE = path.join(ROOT, "packaging", "engine", "android");
const ENGINE_ABIS = ["arm64-v8a", "x86_64"];

/** 把 npm run build:engine:android 的产物复制进 jniLibs（prepareNative 会清空 jniLibs） */
function installEngineLibs() {
  let installed = 0;
  for (const abi of ENGINE_ABIS) {
    const src = path.join(ENGINE_STAGE, abi);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(JNI, abi);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (!name.endsWith(".so")) continue;
      fs.copyFileSync(path.join(src, name), path.join(dst, name));
      installed++;
    }
  }
  if (installed) console.log(`已加入 Android 原生引擎（${installed} 个 .so）`);
  else console.warn("  [engine] 没有原生引擎产物；APK 只能远程模式（先跑 npm run build:engine:android）");
}

function ensureReleaseKeystore() {
  if (process.env.CUBELOOM_KEYSTORE) return;
  const ks = path.join(ANDROID, "cubeloom-release.keystore");
  if (fs.existsSync(ks)) return;
  console.log("生成本地 release keystore（cubeloom-release.keystore，已 gitignore）…");
  run("keytool", [
    "-genkeypair", "-v", "-keystore", ks, "-alias", "cubeloom",
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
    "-storepass", "cubeloom", "-keypass", "cubeloom",
    "-dname", "CN=Cubeloom, OU=Cubeloom, O=Cubeloom, C=CN",
  ]);
}

function build() {
  const release = !process.argv.includes("--debug");
  if (release) ensureReleaseKeystore();
  const gradle = process.env.GRADLE_BIN || path.join(ANDROID, "gradlew");
  const cmd = fs.existsSync(gradle) ? gradle : "gradle";
  const task = release ? "assembleRelease" : "assembleDebug";
  const args = [task, "--no-daemon", "-q"];
  console.log(`运行 ${cmd} ${task} …`);
  run(cmd, args, { cwd: ANDROID });
  const variant = release ? "release" : "debug";
  const apk = path.join(APP, "build", "outputs", "apk", variant, `app-${variant}.apk`);
  if (!fs.existsSync(apk)) throw new Error(`没有找到 app-${variant}.apk`);
  const out = path.join(ROOT, "dist-app", `Cubeloom-Android-${pkg.version}-${variant}.apk`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(apk, out);
  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`\nAPK: ${path.relative(ROOT, out)}（${size} MB）`);
}

ensureMobileBuild();
const pkgDir = ensureNodejsMobile();
prepareNative(pkgDir);
installEngineLibs();
writeLocalProperties();
build();
