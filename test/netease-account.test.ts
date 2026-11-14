/**
 * 登录助手驱动层：用一个假 x19login（shell 脚本）验证
 * 事件推进（notice → sms_required → result）、错误透传、取消与超时。
 * 真实登录需要网易账号/短信，不在单测范围内。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X19LoginSession, isMainlandPhone, normalizeLoginAccount, resolveX19LoginBinary } from "../src/netease-account";

const isWin = process.platform === "win32";

function fakeHelper(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubeloom-x19-"));
  const file = path.join(dir, "x19login");
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

async function waitFor(session: X19LoginSession, status: string, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (session.state.status === status) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`等不到状态 ${status}，当前 ${session.state.status}（${session.state.error}）`);
}

test("登录事件流：短信验证码 → token", { skip: isWin }, async () => {
  const helper = fakeHelper(
    [
      "#!/bin/sh",
      "read line",
      'echo \'{"event":"notice","message":"设备指纹已注册"}\'',
      'echo \'{"event":"sms_required","upstream":false,"phone":"138****0000"}\'',
      "read code",
      'case "$code" in *"123456"*) ;; *) echo \'{"event":"error","message":"验证码不对"}\'; exit 1;; esac',
      'echo \'{"event":"result","entity_id":987654321,"token":"tok-abc","name":"小皮"}\'',
      "",
    ].join("\n")
  );
  process.env.FB_X19LOGIN = helper;
  assert.equal(resolveX19LoginBinary(), helper);

  const session = new X19LoginSession({ mode: "sms", account: "13800000000" }, { timeoutMs: 8000 });
  await waitFor(session, "need_sms");
  assert.equal(session.state.sms?.phone, "138****0000");
  assert.ok(session.state.notices.includes("设备指纹已注册"));
  assert.equal(session.submitCode("123456"), true);
  const state = await session.wait(5000);
  assert.equal(state.status, "ok");
  assert.equal(state.entityId, "987654321");
  assert.equal(state.name, "小皮");
  assert.equal(state.token, "tok-abc");
  delete process.env.FB_X19LOGIN;
});

test("登录错误：助手报错后状态为 error，并且不回显密码", { skip: isWin }, async () => {
  const helper = fakeHelper(
    [
      "#!/bin/sh",
      "read line",
      'case "$line" in *sekret*) echo \'{"event":"error","message":"账号或密码错误"}\'; exit 1;; esac',
      'echo \'{"event":"error","message":"参数不对"}\'',
      "",
    ].join("\n")
  );
  process.env.FB_X19LOGIN = helper;
  const session = new X19LoginSession({ mode: "email", account: "a@b.com", password: "sekret" }, { timeoutMs: 5000 });
  const state = await session.wait(5000);
  assert.equal(state.status, "error");
  assert.match(state.error, /账号或密码错误/);
  assert.ok(!state.error.includes("sekret"));
  delete process.env.FB_X19LOGIN;
});

test("取消登录会杀掉助手进程", { skip: isWin }, async () => {
  const helper = fakeHelper(
    ["#!/bin/sh", "read line", 'echo \'{"event":"sms_required","upstream":false,"phone":"1"}\'', "sleep 30", ""].join("\n")
  );
  process.env.FB_X19LOGIN = helper;
  const session = new X19LoginSession({ mode: "sms", account: "13800000000" }, { timeoutMs: 10000 });
  await waitFor(session, "need_sms");
  session.cancel();
  assert.equal(session.state.status, "cancelled");
  const state = await session.wait(1000);
  assert.equal(state.status, "cancelled");
  delete process.env.FB_X19LOGIN;
});

test("手机号归一化：去 +86 / 空格 / 横线，只认 11 位大陆号码", () => {
  const cases: Array<[string, string]> = [
    ["13800000000", "13800000000"],
    [" 138 0000 0000 ", "13800000000"],
    ["+86 138-0000-0000", "13800000000"],
    ["0086 13800000000", "13800000000"],
    ["86 13800000000", "13800000000"],
    ["013800000000", "13800000000"],
    ["demo@163.com", "demo@163.com"],
    ["  demo@163.com  ", "demo@163.com"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLoginAccount(input), expected, input);
  }
  assert.equal(isMainlandPhone("13800000000"), true);
  assert.equal(isMainlandPhone("1380000000"), false);
  assert.equal(isMainlandPhone("+8613800000000"), false);
});
