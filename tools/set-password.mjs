#!/usr/bin/env node
// 生成 / 更新管理页登录口令（只保存 scrypt 哈希，不保存明文）
//
// 用法：
//   node tools/set-password.mjs '我的口令'
//   echo -n '我的口令' | node tools/set-password.mjs --stdin
//   node tools/set-password.mjs --stdin --auth-file /tmp/auth.json   # 指定写入位置（也可用 FB_ADMIN_AUTH_FILE）
//   node tools/set-password.mjs --rotate-secret                      # 只轮换 secret/epoch（吊销所有会话，不改口令）
//
// 写入契约（P1-10）：
//   · 同目录临时文件 → fsync → rename 覆盖，权限 0600；
//   · 任何一步失败都删掉临时文件，绝不留下半截 / 非法的 auth.json；
//   · 写之前先校验参数（口令长度、目标路径），校验不过不碰磁盘。
//
// 轮换契约（P1-11）：每次成功写入都会生成**新的 secret** 并把 `epoch` 加一，
//   两者都参与 Cookie 的 HMAC，所以旧 Cookie 立即失效（面板需重启或调用 POST /api/auth/revoke 生效）。
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = path.join(ROOT, "admin");

/** 默认写入位置；面板读取同一路径（可用 FB_ADMIN_AUTH_FILE 覆盖） */
export const DEFAULT_AUTH_FILE = path.join(ADMIN_DIR, "auth.json");

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 1024;
export const DEFAULT_SESSION_HOURS = 12;

const USAGE = [
  "用法：",
  "  node tools/set-password.mjs '我的口令'",
  "  echo -n '我的口令' | node tools/set-password.mjs --stdin",
  "选项：",
  "  --stdin                 从标准输入读口令（脚本/CI 用）",
  "  --auth-file <路径>      写入指定位置（默认 admin/auth.json）",
  "  --rotate-secret         只换 secret 与 epoch，保留当前口令（吊销所有会话）",
].join("\n");

/** 目标文件：--auth-file > FB_ADMIN_AUTH_FILE > admin/auth.json */
export function resolveAuthFile(explicit, env = process.env) {
  const candidate = String(explicit || env.FB_ADMIN_AUTH_FILE || "").trim();
  if (!candidate) return DEFAULT_AUTH_FILE;
  return path.resolve(candidate);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** epoch 归一化：缺省/非法一律当 0（兼容没有 epoch 字段的旧 auth.json） */
export function normalizeEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizeSessionHours(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_HOURS;
}

export function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

/** 参数校验：不通过就返回原因，调用方在写盘前退出 */
export function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "口令不能为空（至少 6 位）" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `口令至少 ${MIN_PASSWORD_LENGTH} 位（当前 ${password.length} 位）` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `口令过长（上限 ${MAX_PASSWORD_LENGTH} 字符）` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(password)) {
    return { ok: false, error: "口令包含控制字符，请换一个" };
  }
  return { ok: true };
}

/** 读取现有配置：不存在 → exists:false；损坏 → ok:false（调用方可覆盖重建） */
export function readExistingAuth(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false };
    return { exists: true, ok: false, error: e && e.message ? e.message : String(e) };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, ok: false, error: "内容不是 JSON 对象" };
    }
    return { exists: true, ok: true, config: parsed };
  } catch (e) {
    return { exists: true, ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 新配置：换口令 + 换 secret + epoch 自增（旧 Cookie 立刻失效） */
export function buildAuthConfig(password, existing = {}) {
  const base = existing && typeof existing === "object" ? existing : {};
  return {
    passwordHash: hashPassword(password),
    secret: newSecret(),
    sessionHours: normalizeSessionHours(base.sessionHours),
    epoch: normalizeEpoch(base.epoch) + 1,
  };
}

/** 只轮换 secret/epoch，保留口令哈希 */
export function rotateAuthConfig(existing = {}) {
  if (!existing || typeof existing.passwordHash !== "string" || !existing.passwordHash) {
    throw new Error("现有 auth.json 没有 passwordHash，无法只轮换 secret：请重新设置口令");
  }
  return {
    ...existing,
    secret: newSecret(),
    sessionHours: normalizeSessionHours(existing.sessionHours),
    epoch: normalizeEpoch(existing.epoch) + 1,
  };
}

/**
 * 原子写：同目录临时文件（wx + 0600）→ write → fsync → rename → 目录 fsync。
 * 失败时删除临时文件并抛出；目标文件保持写入前的内容（rename 之前不会动它）。
 */
export function writeAuthFileAtomic(file, config) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const payload = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    let off = 0;
    while (off < payload.length) off += fs.writeSync(fd, payload, off, payload.length - off, off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {}
    // 目录项也落盘，避免断电后 rename 丢失（失败不影响正确性）
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {}
    return target;
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw new Error(`写入 ${target} 失败：${e && e.message ? e.message : e}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("请输入新的管理页口令：", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** 解析参数（纯函数，方便测试） */
export function parseArgs(argv) {
  const out = { stdin: false, rotate: false, help: false, authFile: "", password: "" };
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdin") out.stdin = true;
    else if (a === "--rotate-secret") out.rotate = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--auth-file") {
      out.authFile = argv[++i] ?? "";
      if (!out.authFile) return { ...out, error: "--auth-file 缺少路径" };
    } else if (a.startsWith("--auth-file=")) out.authFile = a.slice("--auth-file=".length);
    else if (a.startsWith("--")) return { ...out, error: `未知选项：${a}` };
    else if (!out.password) out.password = a;
    else extra.push(a);
  }
  if (!out.help && extra.length) return { ...out, error: `多余的参数：${extra.join(" ")}（口令含空格请用引号包起来）` };
  return out;
}

/** 主流程；返回退出码（不直接 process.exit，便于测试与嵌入） */
export async function main(argv, io = {}) {
  const stdout = io.stdout || ((t) => process.stdout.write(t + "\n"));
  const stderr = io.stderr || ((t) => process.stderr.write(t + "\n"));
  const args = parseArgs(argv);
  if (args.error) {
    stderr(`参数错误：${args.error}`);
    stderr(USAGE);
    return 2;
  }
  if (args.help) {
    stdout(USAGE);
    return 0;
  }
  if (!args.rotate && args.stdin && args.password) {
    stderr("参数错误：--stdin 与命令行口令不能同时给");
    return 2;
  }

  const authFile = resolveAuthFile(args.authFile);
  if (args.authFile) {
    const looksLikeDir = args.authFile.endsWith("/") || args.authFile.endsWith("\\");
    if (looksLikeDir) {
      stderr(`参数错误：--auth-file 需要文件路径，收到目录：${args.authFile}`);
      return 2;
    }
  }

  const existing = readExistingAuth(authFile);
  if (existing.exists && !existing.ok) {
    stderr(`[警告] 现有 ${authFile} 解析失败（${existing.error}），将覆盖重建`);
  }
  const base = existing.ok ? existing.config : {};

  if (args.rotate) {
    let config;
    try {
      config = rotateAuthConfig(base);
    } catch (e) {
      stderr(e && e.message ? e.message : String(e));
      return 1;
    }
    writeAuthFileAtomic(authFile, config);
    stdout(`已轮换 secret：${authFile}（权限 0600，epoch=${config.epoch}）`);
    stdout("旧的登录 Cookie 全部失效；面板正在运行时需重启面板或在面板里调用 POST /api/auth/revoke 才会读到新 secret。");
    return 0;
  }

  const password = args.stdin ? await readStdin() : args.password || (await promptPassword());
  const check = validatePassword(password);
  if (!check.ok) {
    stderr(check.error);
    return 2;
  }

  const config = buildAuthConfig(password, base);
  writeAuthFileAtomic(authFile, config);
  stdout(`已写入 ${authFile}（权限 0600）`);
  stdout(`口令哈希：${config.passwordHash.slice(0, 40)}…（scrypt，不可逆）`);
  stdout(`secret 已轮换 · epoch=${config.epoch} · 旧 Cookie 立即失效`);
  if (!existing.ok) stdout("（原文件不存在或已损坏，本次为全新写入）");
  stdout("面板正在运行时需重启面板（npm run admin）才会读到新口令；也可在面板里调用 POST /api/auth/revoke 立即踢掉所有会话。");
  return 0;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`${e && e.message ? e.message : e}\n`);
      process.exitCode = 1;
    });
}
