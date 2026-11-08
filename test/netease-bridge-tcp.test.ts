/**
 * 事件桥 TCP 地址支持（tcp://host:port）+ 基本握手/指令回执。
 * 用一个本地 TCP 假桥验证，不依赖机器人本体。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { NeteaseBridge, parseTcpEndpoint } from "../src/netease-bridge";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("parseTcpEndpoint 只认 tcp://host:port", () => {
  assert.deepEqual(parseTcpEndpoint("tcp://127.0.0.1:17999"), { host: "127.0.0.1", port: 17999 });
  assert.deepEqual(parseTcpEndpoint("tcp://[::1]:18000"), { host: "::1", port: 18000 });
  assert.equal(parseTcpEndpoint("/tmp/bot.sock"), null);
  assert.equal(parseTcpEndpoint("tcp://127.0.0.1"), null);
  assert.equal(parseTcpEndpoint("tcp://127.0.0.1:99999"), null);
});

test("TCP 事件桥：hello → auth → auth_ok，pos / command 回执正常", async () => {
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.write(JSON.stringify({ type: "hello", protocol: 860, gameVersion: "1.21.120" }) + "\n");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "auth") {
          sock.write(JSON.stringify({ type: "auth_ok", protocol: 860, gameVersion: "1.21.120" }) + "\n");
        } else if (msg.type === "command") {
          const data = msg.cmd === "pos" ? { x: 100, y: 64, z: -20 } : { statusCode: 0 };
          sock.write(JSON.stringify({ type: "result", id: msg.id, ok: true, data }) + "\n");
        }
      }
    });
  });
  const port = await listen(server);
  const bridge = new NeteaseBridge({ socketPath: `tcp://127.0.0.1:${port}`, token: "t" });
  try {
    bridge.connect();
    await waitFor(() => bridge.isConnected);
    const pos = await bridge.getPosition();
    assert.deepEqual(pos, { x: 100, y: 64, z: -20 });
    const r = await bridge.command("say hi");
    assert.equal(r.ok, true);
  } finally {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
