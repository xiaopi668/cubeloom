/**
 * 托管机器人进程（FB_NETEASE_BOT_CMD）回归。
 * 用一个只创建 UNIX socket 的假机器人验证：启动、就绪探测、异常重启、退出收尾。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagedBot } from "../src/netease-bot";

const isWin = process.platform === "win32";
const tmp = (name: string) => path.join(os.tmpdir(), `cubeloom-bot-${process.pid}-${name}.sock`);

function fakeBotCommand(socketPath: string): string {
  // 创建 UNIX socket 并保持运行；不依赖项目代码
  const script = `const fs=require('fs'),net=require('net');const p=${JSON.stringify(socketPath)};try{fs.unlinkSync(p)}catch{};net.createServer(s=>s.end()).listen(p);setInterval(()=>{},1000)`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

test("托管机器人：启动 → socket 就绪 → stop 收尾", { skip: isWin }, async () => {
  const sock = tmp("ready");
  const logs: string[] = [];
  const bot = new ManagedBot({ command: fakeBotCommand(sock), socketPath: sock, onLog: (l) => logs.push(l) });
  bot.start();
  const ready = await bot.waitReady(5000);
  assert.equal(ready, true, `socket 应该出现；日志：${logs.join(" | ")}`);
  assert.equal(bot.status.running, true);
  assert.ok(bot.status.pid);
  bot.stop();
  assert.equal(bot.status.running, false);
  try { fs.unlinkSync(sock); } catch {}
});

test("崩溃后自动重启（可在 stop 后停止重启）", { skip: isWin }, async () => {
  const sock = tmp("crash");
  const bot = new ManagedBot({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
    socketPath: sock,
    restartDelayMs: 100,
    onLog: () => {},
  });
  bot.start();
  await new Promise((r) => setTimeout(r, 700));
  const restarts = bot.status.restarts;
  assert.ok(restarts >= 1, `应该至少重启一次，实际 ${restarts}`);
  bot.stop();
  const after = bot.status.restarts;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bot.status.restarts, after, "stop 之后不应再重启");
});

test("没有 socket 路径时 waitReady 直接通过", async () => {
  const bot = new ManagedBot({ command: "true", socketPath: "", onLog: () => {} });
  assert.equal(await bot.waitReady(100), true);
  bot.stop();
});
