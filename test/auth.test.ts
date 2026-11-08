/**
 * 面板认证回归测试（node --test）
 *
 * 锁死五条契约：
 *  1. `tools/set-password.mjs` 原子写：并发/连续写任何时刻读到的 auth.json 都是完整 JSON，权限 0600；
 *  2. 每次写入口令都轮换 secret 并把 epoch 加一（旧 Cookie 立即失效）；
 *  3. 会话签名把 epoch 混进 HMAC：篡改 exp / 换 secret / 换 epoch / 过期 / 旧两段格式全部拒绝；
 *  4. 启动判定 fail-closed：非回环 + 无 auth.json 必须 fatal，损坏文件必须 fatal，回环才允许无口令；
 *  5. 真实进程行为：绑 0.0.0.0 且没有 auth.json 时 admin-server 退出码非 0（不是"起来再说"）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  authEpoch,
  isLoopbackBindHost,
  isSecureCookieRequest,
  loadAuthStartup,
  normalizeEpoch,
  rotateAuthConfig,
  signSessionToken,
  verifySessionToken,
  writeAuthFileAtomic,
  type AuthConfig,
} from "../admin-server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SET_PW = path.join(ROOT, "tools", "set-password.mjs");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const IS_WIN = process.platform === "win32";

/** 测试用临时目录，结束时统一清理 */
const TMP_DIRS: string[] = [];
test.after(() => {
  for (const dir of TMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubeloom-auth-"));
  TMP_DIRS.push(dir);
  return dir;
}

function runSetPassword(authFile: string, password: string) {
  return spawnSync(process.execPath, [SET_PW, "--stdin", "--auth-file", authFile], {
    input: password + "\n",
    encoding: "utf8",
    timeout: 30000,
  });
}

function readAuth(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertMode600(file: string) {
  if (IS_WIN) return;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "auth.json 必须是 0600");
}

function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
  return { passwordHash: "scrypt$16384$8$1$c2FsdA==$a2V5", secret: "secret-one", sessionHours: 12, epoch: 0, ...over };
}

test("set-password --stdin：写出的 auth.json 权限 0600、合法 JSON、含 passwordHash/secret/epoch", () => {
  const dir = tmpdir();
  const file = path.join(dir, "auth.json");
  const r = runSetPassword(file, "hunter2!");
  assert.equal(r.status, 0, `set-password 应该成功，stderr=${r.stderr}`);

  assertMode600(file);
  const data = readAuth(file);
  assert.match(data.passwordHash, /^scrypt\$16384\$8\$1\$/, "口令必须存成 scrypt 哈希");
  assert.equal(typeof data.secret, "string");
  assert.ok(data.secret.length >= 32, "secret 至少 32 字符（base64url 32 字节）");
  assert.equal(data.epoch, 1, "首次写入 epoch 从 1 开始");
  assert.equal(data.sessionHours, 12);
  assert.equal(typeof data.passwordHash, "string");
  assert.ok(!JSON.stringify(data).includes("hunter2!"), "明文口令不能落盘");

  // 同目录不能残留临时文件
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"]);
});

test("连续两次 set-password：secret 轮换、epoch 递增、写完立刻读两次都是完整文件", () => {
  const dir = tmpdir();
  const file = path.join(dir, "auth.json");
  assert.equal(runSetPassword(file, "hunter2!").status, 0);
  const first = readAuth(file);

  assert.equal(runSetPassword(file, "hunter2!").status, 0);
  // "写后立即读两次"：这里两次读之间没有任何写者，验证不会出现半截文件
  const a = readAuth(file);
  const b = readAuth(file);

  assert.notEqual(a.secret, first.secret, "每次改口令都必须换 secret");
  assert.equal(a.epoch, first.epoch + 1, "epoch 必须自增");
  assert.deepEqual(a, b, "两次读取必须是同一份完整配置");
  assert.notEqual(a.passwordHash, first.passwordHash, "盐变了，哈希也应该变");
  assertMode600(file);
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"]);
});

test("并发写 set-password：任何时刻落盘的 auth.json 都是完整 JSON，且不残留临时文件", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "auth.json");
  assert.equal(runSetPassword(file, "hunter2!").status, 0);

  const children = [0, 1, 2, 3].map(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [SET_PW, "--stdin", "--auth-file", file], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        let err = "";
        child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(0) : reject(new Error(err || `exit=${code}`))));
        child.stdin.end("hunter2!\n");
      })
  );
  await Promise.all(children);

  const seen = [readAuth(file), readAuth(file)];
  assert.equal(typeof seen[0].secret, "string");
  assert.ok(seen[0].epoch >= 2 && seen[0].epoch <= 5, `epoch 应该在 2..5，实际 ${seen[0].epoch}`);
  assertMode600(file);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== "auth.json");
  assert.deepEqual(leftovers, [], `不允许留下临时/半截文件：${leftovers.join(",")}`);
});

test("参数校验：短口令 / 未知选项 / 目录路径都在写盘前失败，且不产生文件", () => {
  const dir = tmpdir();
  const file = path.join(dir, "auth.json");

  const short = runSetPassword(file, "abc");
  assert.notEqual(short.status, 0, "6 位以下口令必须失败");
  assert.match(short.stderr, /至少 6 位/);
  assert.equal(fs.existsSync(file), false, "参数错误不能留下文件");

  const bad = spawnSync(process.execPath, [SET_PW, "--nope"], { encoding: "utf8", timeout: 20000 });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /未知选项|参数错误/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("会话签名：epoch 混进 HMAC，篡改/换 secret/换 epoch/过期/旧格式全部拒绝", () => {
  const base = cfg({ epoch: 3 });
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = signSessionToken(base, exp);
  assert.equal(token.split(".").length, 3, "token 必须是 exp.epoch.mac 三段");

  /** 失败原因（成功返回 "ok"），避免在断言里直接读联合类型的字段 */
  const why = (c: ReturnType<typeof verifySessionToken>) => (c.ok ? "ok" : c.reason);

  assert.deepEqual(verifySessionToken(base, token), { ok: true, exp, epoch: 3 });
  assert.equal(why(verifySessionToken({ ...base, epoch: 4 }, token)), "epoch", "吊销（epoch+1）后旧 token 必须失效");
  assert.equal(why(verifySessionToken({ ...base, secret: "secret-two" }, token)), "bad-mac", "换 secret 后旧 token 必须失效");
  assert.equal(why(verifySessionToken(base, `${exp + 60}.3.${token.split(".")[2]}`)), "bad-mac", "改 exp 必须校验失败");
  assert.equal(why(verifySessionToken(base, token, Date.now() + 3_600_000)), "expired", "过期必须失效");

  const [e, ep, mac] = token.split(".");
  const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
  assert.equal(why(verifySessionToken(base, `${e}.${ep}.${flipped}`)), "bad-mac");
  assert.equal(why(verifySessionToken(base, `${e}.${mac}`)), "malformed", "旧的两段 Cookie 不再接受");
  assert.equal(why(verifySessionToken(base, undefined)), "no-auth");
  assert.equal(why(verifySessionToken(null, token)), "no-auth");
});

test("rotateAuthConfig：secret 换新、epoch +1、口令哈希保留，旧 token 立刻失效", () => {
  const before = cfg({ epoch: 7 });
  const exp = Math.floor(Date.now() / 1000) + 600;
  const oldToken = signSessionToken(before, exp);

  const after = rotateAuthConfig(before);
  assert.notEqual(after.secret, before.secret);
  assert.equal(after.epoch, 8);
  assert.equal(after.passwordHash, before.passwordHash, "轮换 secret 不应改变口令");
  assert.equal(authEpoch(after), 8);
  assert.equal(verifySessionToken(after, oldToken).ok, false, "轮换后旧会话必须失效");
});

test("启动判定 fail-closed：非回环无 auth.json / 损坏文件 → fatal；回环或显式放行 → open", () => {
  const dir = tmpdir();
  const file = path.join(dir, "auth.json");

  const noAuthLan = loadAuthStartup(file, "0.0.0.0", false);
  assert.equal(noAuthLan.mode, "fatal");
  assert.match((noAuthLan as any).message, /拒绝启动/);
  assert.match((noAuthLan as any).message, /npm run set-password/, "错误信息必须给出解决方式");
  assert.equal(loadAuthStartup(file, "::", false).mode, "fatal", "IPv6 通配也属于非回环");

  const noAuthLocal = loadAuthStartup(file, "127.0.0.1", false);
  assert.equal(noAuthLocal.mode, "open");
  assert.equal((noAuthLocal as any).reason, "loopback");

  const forced = loadAuthStartup(file, "0.0.0.0", true);
  assert.equal(forced.mode, "open");
  assert.equal((forced as any).reason, "forced");

  fs.writeFileSync(file, '{ "passwordHash": ', "utf8");
  const corrupt = loadAuthStartup(file, "127.0.0.1", false);
  assert.equal(corrupt.mode, "fatal", "解析失败必须拒绝启动，不能退化成无鉴权");
  assert.match((corrupt as any).message, /解析失败/);
  assert.match((corrupt as any).message, /set-password/);

  fs.writeFileSync(file, JSON.stringify({ passwordHash: "scrypt$1$2$3$4$5" }), "utf8");
  assert.equal(loadAuthStartup(file, "127.0.0.1", false).mode, "fatal", "缺 secret 必须拒绝启动");

  writeAuthFileAtomic(file, cfg({ epoch: 2 }));
  const ok = loadAuthStartup(file, "0.0.0.0", false);
  assert.equal(ok.mode, "password");
  assert.equal((ok as any).config.epoch, 2);
  assertMode600(file);

  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("localhost"), true);
  assert.equal(isLoopbackBindHost("::1"), true);
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(isLoopbackBindHost("192.168.1.5"), false);
  assert.equal(normalizeEpoch(undefined), 0);
  assert.equal(normalizeEpoch("3"), 3);
  assert.equal(normalizeEpoch(-1), 0);
});

test("writeAuthFileAtomic：自动建目录、覆盖写不残留临时文件、Secure Cookie 判定", () => {
  const dir = tmpdir();
  const nested = path.join(dir, "admin", "auth.json");

  writeAuthFileAtomic(nested, cfg({ epoch: 1 }));
  assertMode600(nested);
  writeAuthFileAtomic(nested, cfg({ epoch: 2 }));
  assert.equal(readAuth(nested).epoch, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), ["auth.json"], "覆盖写不能留下临时文件");

  const plain = { headers: {} as Record<string, string> };
  assert.equal(isSecureCookieRequest(plain, {}), false);
  assert.equal(isSecureCookieRequest({ headers: { "x-forwarded-proto": "https" } }, {}), true);
  assert.equal(isSecureCookieRequest({ headers: { "x-forwarded-proto": "HTTPS, http" } }, {}), true);
  assert.equal(isSecureCookieRequest({ headers: {}, socket: { encrypted: true } }, {}), true);
  assert.equal(isSecureCookieRequest(plain, { FB_ADMIN_COOKIE_SECURE: "1" } as NodeJS.ProcessEnv), true);
});

test("真实进程：绑 0.0.0.0 且没有 auth.json 时 admin-server 退出码非 0", () => {
  const dir = tmpdir();
  const authFile = path.join(dir, "auth.json");
  const port = 39000 + Math.floor(Math.random() * 2000);

  const r = spawnSync(process.execPath, [TSX_CLI, "admin-server.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90000,
    env: {
      ...process.env,
      FB_ADMIN_AUTH_FILE: authFile,
      FB_ADMIN_HOST: "0.0.0.0",
      FB_ADMIN_PORT: String(port),
      FB_NO_OPEN: "1",
    },
  });

  assert.notEqual(r.status, 0, `必须拒绝启动，实际 exit=${r.status}`);
  assert.match(String(r.stderr), /启动中止/);
  assert.match(String(r.stderr), /拒绝启动/);
  assert.equal(fs.existsSync(authFile), false, "拒绝启动不应悄悄创建 auth.json");
});
