#!/usr/bin/env node
/**
 * 把仓库自带的 NTvector 官方包解压到 netease-bot/，并安装 Cubeloom 事件桥插件。
 *
 *   npm run setup:netease-bot
 *
 * 产物（全部在 .gitignore 里，账号凭据不会进版本库）：
 *   netease-bot/ntvector/             NTvector（Windows，Program.exe + Python 3.12）
 *   netease-bot/ntvector/scripts/cubeloom_bridge/   本仓库的事件桥插件
 *   netease-bot/start-bot.bat         启动脚本（给 FB_NETEASE_BOT_CMD 用）
 */
import AdmZip from "adm-zip";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = path.join(ROOT, "vendor", "ntvector", "NTVector.Official.version.V1.1.1.zip");
const OUT = path.join(ROOT, "netease-bot");
const VECTOR = path.join(OUT, "ntvector");
const force = process.argv.includes("--force");

if (!fs.existsSync(ZIP)) {
  console.error(`找不到 ${path.relative(ROOT, ZIP)}（仓库应该自带；如果是浅克隆请检查 vendor/）`);
  process.exit(1);
}
if (fs.existsSync(VECTOR) && !force) {
  console.log(`已存在 ${path.relative(ROOT, VECTOR)}，跳过解压（要覆盖加 --force）`);
} else {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("解压 NTvector …");
  new AdmZip(ZIP).extractAllTo(OUT, true);
  // zip 里是 Vector/ 目录
  const vectorDir = path.join(OUT, "Vector");
  if (fs.existsSync(vectorDir) && vectorDir !== VECTOR) {
    fs.rmSync(VECTOR, { recursive: true, force: true });
    fs.renameSync(vectorDir, VECTOR);
  }
}

// 安装事件桥插件
const pluginSrc = path.join(ROOT, "packaging", "netease-bot", "bridge", "cubeloom_bridge");
const pluginDst = path.join(VECTOR, "scripts", "cubeloom_bridge");
fs.mkdirSync(path.dirname(pluginDst), { recursive: true });
fs.cpSync(pluginSrc, pluginDst, { recursive: true });

// 生成桥配置（token 随机；端口固定 17999）
const token = crypto.randomBytes(12).toString("base64url");
const cfgPath = path.join(pluginDst, "cubeloom_bridge.json");
if (!fs.existsSync(cfgPath) || force) {
  const cfg = { host: "127.0.0.1", port: 17999, token, protocol: 860, gameVersion: "1.21.120" };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  console.log(`事件桥配置：${path.relative(ROOT, cfgPath)}（token 已生成）`);
}

// 启动脚本：Cubeloom 的 FB_NETEASE_BOT_CMD 指向它
const startBat = path.join(OUT, "start-bot.bat");
fs.writeFileSync(
  startBat,
  [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0ntvector"',
    "Program.exe --config mc.cfg --logger --no-ui",
    "pause",
    "",
  ].join("\r\n")
);
const startSh = path.join(OUT, "start-bot.sh");
fs.writeFileSync(
  startSh,
  `#!/usr/bin/env bash\n# NTvector 官方构建仅提供 Windows；Linux 请自行按 NTvector 文档构建后替换\ncd "$(dirname "$0")/ntvector"\nexec ./Program.exe --config mc.cfg --logger --no-ui\n`
);
try { fs.chmodSync(startSh, 0o755); } catch {}

console.log(`
完成。接下来：
1. 按 NTvector 官方文档填好 netease-bot/ntvector/mc.cfg（房间号 / 账号 / 皮肤）
2. 启动 Cubeloom 网易版服务：
   FB_NETEASE_BOT_CMD="$PWD/netease-bot/start-bot.bat" \\
   FB_NETEASE_SOCKET="tcp://127.0.0.1:17999" \\
   FB_NETEASE_TOKEN="$(node -e "console.log(require('${cfgPath.replace(/\\/g, "\\\\")}').token)")" \\
   npm run netease
3. 机器人账号必须是目标服的 OP（或服务器开启作弊）
`);
