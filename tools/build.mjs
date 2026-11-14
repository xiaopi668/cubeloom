#!/usr/bin/env node
/**
 * 打包构建：把 TS 源码预编译成自包含的 CJS bundle，供 Electron / 便携版 /
 * Android（nodejs-mobile）等"没有 tsx、没有 esbuild"的运行时直接执行。
 *
 * 产物：
 *   build/server/            可直接 `node build/server/admin-server.cjs` 跑
 *   build/desktop/           Electron 应用目录（electron-builder 的 project 目录）
 *   build/portable/          server + 启动脚本（需要系统 Node ≥ 20）
 *
 * 用法：
 *   node tools/build.mjs            # 全部
 *   node tools/build.mjs --server   # 只构建 server
 */
import { buildSync } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildX19Login } from "./build-x19login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const SERVER = path.join(BUILD, "server");
const DESKTOP = path.join(BUILD, "desktop");
const PORTABLE = path.join(BUILD, "portable");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const onlyServer = process.argv.includes("--server");

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

function bundle(entry, outfile) {
  buildSync({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    // Electron 运行时由宿主提供；Node 构建里不会有 import
    // esbuild 只用于开发态的运行时打包；打包产物优先读预构建的 IIFE
    external: ["electron", "esbuild"],
    define: { "process.env.CUBELOOM_PACKAGED": '"1"' },
  });
  const size = fs.statSync(outfile).size;
  console.log(`  ${path.relative(ROOT, outfile)}  ${(size / 1024).toFixed(0)} KB`);
}

console.log("== 构建 server bundle ==");
rm(BUILD);
fs.mkdirSync(SERVER, { recursive: true });
bundle("main.ts", path.join(SERVER, "main.cjs"));
bundle("admin-server.ts", path.join(SERVER, "admin-server.cjs"));
bundle("netease-service.ts", path.join(SERVER, "netease-service.cjs"));

// 几何库 IIFE：供 sandbox-bundle 脱机加载（打包环境没有 esbuild 二进制）
const geo = buildSync({
  entryPoints: [path.join(ROOT, "node_modules", "@pureeval", "voxel-geometry", "index.js")],
  bundle: true,
  format: "iife",
  globalName: "VG",
  platform: "neutral",
  target: "es2020",
  write: false,
  logLevel: "warning",
});
fs.writeFileSync(path.join(SERVER, "voxel-geometry.iife.js"), geo.outputFiles[0].text);
console.log(`  build/server/voxel-geometry.iife.js  ${(geo.outputFiles[0].text.length / 1024).toFixed(0)} KB`);

// 网易登录助手：host 平台 + Windows（引擎是 Windows 的，Linux/macOS 桌面用户也能登录）
if (process.env.FB_SKIP_X19LOGIN === "1") {
  console.log("== 跳过网易登录助手（FB_SKIP_X19LOGIN=1）==");
} else {
  console.log("== 构建网易登录助手（Go） ==");
  buildX19Login({
    outDir: SERVER,
    targets: process.platform === "win32" ? ["host"] : ["host", "win"],
  });
}

// 面板静态资源
copyDir(path.join(ROOT, "admin"), path.join(SERVER, "admin"));

if (!onlyServer) {
  console.log("== 组装 portable ==");
  copyDir(SERVER, path.join(PORTABLE, "server"));
  copyDir(path.join(ROOT, "admin"), path.join(PORTABLE, "admin"));
  fs.copyFileSync(path.join(ROOT, "packaging", "portable", "start.sh"), path.join(PORTABLE, "start.sh"));
  fs.copyFileSync(path.join(ROOT, "packaging", "portable", "start.bat"), path.join(PORTABLE, "start.bat"));
  try { fs.chmodSync(path.join(PORTABLE, "start.sh"), 0o755); } catch {}

  console.log("== 组装 desktop（Electron） ==");
  copyDir(SERVER, path.join(DESKTOP, "server"));
  copyDir(path.join(ROOT, "admin"), path.join(DESKTOP, "admin"));
  fs.copyFileSync(
    path.join(ROOT, "packaging", "desktop", "electron-main.cjs"),
    path.join(DESKTOP, "electron-main.cjs")
  );
  // 可选：把 netease-bot/ 一起带进桌面端/便携版（没有就跳过）
  const botDir = path.join(ROOT, "netease-bot");
  if (fs.existsSync(botDir)) {
    copyDir(botDir, path.join(DESKTOP, "netease-bot"));
    copyDir(botDir, path.join(PORTABLE, "netease-bot"));
    console.log("  include netease-bot/");
  }

  const appPkg = {
    name: "cubeloom",
    productName: "Cubeloom",
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    license: pkg.license,
    main: "electron-main.cjs",
    build: {
      appId: "io.github.xiaopi668.cubeloom",
      productName: "Cubeloom",
      asar: false,
      electronVersion: process.env.ELECTRON_VERSION || "38.2.0",
      files: ["electron-main.cjs", "server/**", "admin/**", "netease-bot/**", "package.json"],
      directories: { output: "../../dist-app" },
      linux: { target: ["AppImage", "tar.gz"], category: "Utility" },
      win: { target: ["nsis", "zip"] },
      mac: { target: ["dmg", "zip"], category: "public.app-category.utilities" },
    },
  };
  fs.writeFileSync(path.join(DESKTOP, "package.json"), JSON.stringify(appPkg, null, 2) + "\n");

  // Android / nodejs-mobile 运行时是 Node 18，单独产一份 target=node18 的 bundle
  console.log("== 组装 mobile（Node 18，nodejs-mobile 用） ==");
  const MOBILE = path.join(BUILD, "mobile");
  fs.mkdirSync(path.join(MOBILE, "nodejs-project"), { recursive: true });
  for (const [entry, out] of [
    ["main.ts", "main.cjs"],
    ["admin-server.ts", "admin-server.cjs"],
  ]) {
    buildSync({
      entryPoints: [path.join(ROOT, entry)],
      outfile: path.join(MOBILE, "nodejs-project", out),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      sourcemap: false,
      legalComments: "none",
      logLevel: "warning",
      external: ["electron", "esbuild"],
    });
  }
  fs.copyFileSync(
    path.join(SERVER, "voxel-geometry.iife.js"),
    path.join(MOBILE, "nodejs-project", "voxel-geometry.iife.js")
  );
  copyDir(path.join(ROOT, "admin"), path.join(MOBILE, "nodejs-project", "admin"));
  fs.writeFileSync(
    path.join(MOBILE, "nodejs-project", "package.json"),
    JSON.stringify({ name: "cubeloom-nodejs-project", version: pkg.version, main: "admin-server.cjs" }, null, 2) + "\n"
  );
  console.log("  build/mobile/nodejs-project/   （Node 18 bundle，可直接塞进 nodejs-mobile 的 assets）");
}

console.log("\n完成：");
if (!onlyServer) {
  console.log("  build/portable/   便携版（需要系统 Node ≥ 20）");
  console.log("  build/desktop/    Electron 工程目录（见 packaging/desktop/README.md）");
}
console.log("  build/server/     纯服务端 bundle");
