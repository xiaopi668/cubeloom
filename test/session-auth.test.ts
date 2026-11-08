/**
 * 鉴权矩阵回归（P1-14）
 *
 * 反向代理/隧道会把外部连接伪装成 127.0.0.1；只靠 remoteAddress 判断回环会
 * 让这些连接免验证。这里锁死 forceAuth 的优先级。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequireAuth } from "../src/session";

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const keys = Object.keys(patch);
  const old: Record<string, string | undefined> = {};
  for (const k of keys) {
    old[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k]!;
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k]!;
    }
  }
}

test("默认：回环免验证，外部必须验证", () => {
  withEnv({ FB_ALLOW_ANON: undefined, FB_USERS_FILE: undefined, FB_REQUIRE_AUTH: undefined }, () => {
    assert.equal(resolveRequireAuth("127.0.0.1"), false);
    assert.equal(resolveRequireAuth("::1"), false);
    assert.equal(resolveRequireAuth("::ffff:127.0.0.1"), false);
    assert.equal(resolveRequireAuth("192.168.3.9"), true);
    assert.equal(resolveRequireAuth("8.8.8.8"), true);
  });
});

test("forceAuth：回环地址也必须验证（反向代理场景）", () => {
  withEnv({ FB_ALLOW_ANON: undefined, FB_USERS_FILE: undefined, FB_REQUIRE_AUTH: undefined }, () => {
    assert.equal(resolveRequireAuth("127.0.0.1", true), true);
  });
});

test("FB_ALLOW_ANON=1 是显式放开，优先于 forceAuth", () => {
  withEnv({ FB_ALLOW_ANON: "1" }, () => {
    assert.equal(resolveRequireAuth("8.8.8.8", true), false);
  });
});

test("FB_USERS_FILE / FB_REQUIRE_AUTH 仍然生效", () => {
  withEnv({ FB_USERS_FILE: "/tmp/users.json", FB_ALLOW_ANON: undefined }, () => {
    assert.equal(resolveRequireAuth("127.0.0.1"), true);
  });
  withEnv({ FB_USERS_FILE: undefined, FB_REQUIRE_AUTH: "1", FB_ALLOW_ANON: undefined }, () => {
    assert.equal(resolveRequireAuth("127.0.0.1"), true);
  });
});
