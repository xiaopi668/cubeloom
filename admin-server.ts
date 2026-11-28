/**
 * Cubeloom 网页管理端
 * - 启动/停止/重启 WS 服务（子进程）
 * - 直接读取 logs/*.log 日志文件并实时推送到网页（SSE tail -f），不需要手动写日志
 * - 通过本机控制接口执行沙箱代码 / 发送原生命令
 * - 全黑白配色界面（admin/index.html）
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as readline from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  detectLoginInput,
  fetch4399Captcha,
  login4399WithCookie,
  login4399WithPassword,
  wrapSauth,
} from "./src/login-4399";
import {
  X19LoginSession,
  isMainlandPhone,
  normalizeLoginAccount,
  resolveX19LoginBinary,
  type X19LoginRequest,
} from "./src/netease-account";
import {
  buildEngineArgs,
  redactEngineArgs,
  joinRealmsByCode,
  listRealms,
  resolveLobbyAddress,
  resolveLobbyRoom,
  peCredential,
  purchaseComponentManually,
  resolvePeLocalRoom,
  resolveRealmsAddress,
  resolveRentalRoom,
  searchLobbyRooms,
  searchLobbyRoomsByResId,
  searchRentalServers,
  fetchZoneOwnership,
  isPeSessionStaleError,
  hasPeSession,
  isValidPeUserId,
  type LobbyRoom,
  type PurchaseOutcome,
} from "./src/netease-room";

const APP_NAME = "Cubeloom";
const IS_WIN = process.platform === "win32";

/** 网易版（机器人事件桥）服务端口（仅本机） */
const NETEASE_PORT = Number(process.env.FB_NETEASE_PORT || 11454);

/** ===== 本机/网络信息（供后台展示） ===== */
const SYS = {
  hostname: os.hostname(),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  nodeVersion: process.version,
  cpus: os.cpus().length,
  memTotal: os.totalmem(),
  localIps: (() => {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
      }
    }
    return out;
  })(),
  publicIp: "",
  publicIpAt: 0,
};

/** ===== 路径与端口 ===== */
const ROOT = (() => {
  // 打包运行时（Electron / 便携版）把可写根目录指到 userData；静态资源仍在 app 目录
  const forced = (process.env.FB_APP_ROOT || "").trim();
  if (forced) return path.resolve(forced);
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "main.ts"))) return cwd;
  return path.dirname(path.resolve(process.argv[1] ?? "."));
})();
const ADMIN_DIR = path.join(ROOT, "admin");
/** 网易机器人运行目录（打包时复制到 userData，开发时在仓库 netease-bot/） */
const NETEASE_BOT_DIR = (process.env.FB_NETEASE_BOT_DIR || path.join(ROOT, "netease-bot")).trim();
const NETEASE_CORE_DIR = path.join(NETEASE_BOT_DIR, "ntvector");
/** 原生引擎目录（Linux/macOS 本地编译，不走 Wine） */
const NETEASE_NATIVE_DIR = path.join(NETEASE_BOT_DIR, "ntvector-native");
const NETEASE_MC_CFG = path.join(NETEASE_CORE_DIR, "mc.cfg");
/** 账号模式配置（只存账号/房间，不存密码；0600） */
const NETEASE_ACCOUNT_CFG = path.join(NETEASE_BOT_DIR, "account.json");
/** 保存的登录态（entity_id + token，0600），用于重启后免登录 */
const NETEASE_SESSION_FILE = path.join(NETEASE_BOT_DIR, "session.json");
/** 登录时用的 sauth（0600）：只用于换 PE 通道 token，面板不显示、不导出 */
const NETEASE_SAUTH_FILE = path.join(NETEASE_BOT_DIR, "sauth.json");
/** 购买限流冷却文件（由 src/netease-room.ts 读写，重启 App 也不重置） */
process.env.FB_PURCHASE_COOLDOWN_FILE = path.join(NETEASE_BOT_DIR, "purchase-cooldown.json");
/** 网易“快速匹配过于频繁”的持久冷却（重启 App 也不能绕过去继续打接口） */
const LOBBY_COOLDOWN_FILE = path.join(NETEASE_BOT_DIR, "lobby-cooldown.json");

function lobbyCooldownLeft(): number {
  const raw = readJsonFile(LOBBY_COOLDOWN_FILE) || {};
  const until = Number(raw.until ?? 0) || 0;
  return Math.max(0, until - Date.now());
}

function setLobbyCooldown(ms: number): void {
  try {
    writeFileAtomic(LOBBY_COOLDOWN_FILE, JSON.stringify({ until: Date.now() + ms, at: Date.now() }, null, 2) + "\n");
  } catch {}
}

function clearLobbyCooldown(): void {
  try {
    fs.rmSync(LOBBY_COOLDOWN_FILE, { force: true });
  } catch {}
}

function noteLobbyRateLimitError(e: any): void {
  if (/频繁|稍后重试|rate.?limit/i.test(String(e?.message ?? e))) {
    setLobbyCooldown(10_000);
  }
}
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const ADMIN_LOG = path.join(LOG_DIR, "admin.log");

const ADMIN_PORT = Number(process.env.FB_ADMIN_PORT ?? 11452);
/** 局域网访问开关（面板里可切换；重启后生效）。写 { "host": "0.0.0.0" } 即开放。 */
const ADMIN_NETWORK_FILE = path.join(ROOT, "network.json");
function readAdminNetworkHost(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(ADMIN_NETWORK_FILE, "utf8"));
    return String(cfg?.host ?? "").trim();
  } catch {
    return "";
  }
}
const ADMIN_HOST = (process.env.FB_ADMIN_HOST || readAdminNetworkHost() || "127.0.0.1").trim();
const WS_PORT = Number(process.env.FB_WS_PORT ?? 11451);
const CONTROL_PORT = Number(process.env.FB_CONTROL_PORT ?? 11453);
const WS_VERSION = Number(process.env.FB_WS_VERSION ?? 17104896);
/** 版本号：Electron 主进程会传 FB_APP_VERSION；纯 node 启动时留空 */
const APP_VERSION = String(process.env.FB_APP_VERSION ?? "").trim();
// 对外公布给游戏用的 WS 地址（留空则按页面访问的域名自动生成）
const PUBLIC_WS_URL = (process.env.FB_PUBLIC_WS_URL || "").trim().replace(/\/$/, "");
const WEB_STARTED_AT = Date.now();

/** ===== 登录口令（只保存哈希，不保存明文） =====
 *  admin/auth.json 存在则启用密码登录。
 *  格式：{ "passwordHash": "scrypt$N$r$p$saltB64$keyB64", "secret": "...", "sessionHours": 12, "epoch": 0 }
 *
 *  启动策略（P1-10，fail-closed）：
 *   · 文件存在且可解析        → 启用口令登录；
 *   · 文件不存在 + 绑回环     → 本机开发模式（无口令，打日志说明）；
 *   · 文件不存在 + 绑非回环   → 拒绝启动（除非 FB_ADMIN_ALLOW_NO_AUTH=1 显式自担风险）；
 *   · 文件存在但解析失败/缺字段 → 拒绝启动（不允许静默退化成无鉴权）。
 *
 *  会话签名（P1-11）：HMAC(secret, "<exp>.<epoch>")，epoch 来自 auth.json。
 *  改口令时 set-password 会轮换 secret 并把 epoch 加一，旧 Cookie 立即失效。
 */
const AUTH_FILE = (() => {
  const override = String(process.env.FB_ADMIN_AUTH_FILE || "").trim();
  return override ? path.resolve(override) : path.join(ADMIN_DIR, "auth.json");
})();

export type AuthConfig = { passwordHash: string; secret: string; sessionHours?: number; epoch?: number };
let auth: AuthConfig | null = null;

/** 是否允许"非回环 + 无口令"启动（显式自担风险） */
const ALLOW_NO_AUTH = String(process.env.FB_ADMIN_ALLOW_NO_AUTH || "").trim() === "1";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const key = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** epoch 归一化：缺省/非法一律当 0（兼容没有 epoch 字段的旧 auth.json） */
export function normalizeEpoch(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function authEpoch(config: AuthConfig | null): number {
  return normalizeEpoch(config?.epoch);
}

/** 绑定地址是否回环（127.0.0.0/8、::1、localhost） */
export function isLoopbackBindHost(host: string | undefined): boolean {
  const raw = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!raw) return false;
  if (raw === "localhost" || raw === "::1" || raw === "0:0:0:0:0:0:0:1" || raw === "::ffff:127.0.0.1") return true;
  return /^127\./.test(raw);
}

/** 校验并归一化 auth.json 的内容；不合法返回 null */
export function normalizeAuthConfig(parsed: any): AuthConfig | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const passwordHash = typeof parsed.passwordHash === "string" ? parsed.passwordHash.trim() : "";
  const secret = typeof parsed.secret === "string" ? parsed.secret.trim() : "";
  if (!passwordHash || !secret) return null;
  if (!/^scrypt\$/.test(passwordHash)) return null;
  const hours = Number(parsed.sessionHours);
  return {
    passwordHash,
    secret,
    sessionHours: Number.isFinite(hours) && hours > 0 ? hours : 12,
    epoch: normalizeEpoch(parsed.epoch),
  };
}

export type AuthStartup =
  | { mode: "password"; config: AuthConfig }
  | { mode: "open"; reason: "loopback" | "forced"; message: string }
  | { mode: "fatal"; message: string };

/**
 * 启动时的认证判定（纯逻辑 + 一次读文件），失败时把"为什么"和"怎么修"写清楚。
 * 由 startServer() 调用；测试用临时文件直接调。
 */
/** 把损坏的口令文件挪走（回环模式下自愈；非回环仍然 fail-closed） */
function quarantineAuthFile(authFile: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = `${authFile}.broken-${stamp}`;
  try {
    fs.renameSync(authFile, dst);
    return dst;
  } catch {
    try {
      fs.rmSync(authFile, { force: true });
      return "(已删除)";
    } catch {
      return "(无法移动)";
    }
  }
}

export function loadAuthStartup(authFile: string, bindHost: string, allowNoAuth: boolean): AuthStartup {
  const rel = path.basename(authFile);
  let raw: string;
  try {
    raw = fs.readFileSync(authFile, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      if (isLoopbackBindHost(bindHost)) {
        const moved = quarantineAuthFile(authFile);
        return {
          mode: "open",
          reason: "loopback",
          message: `读取口令文件失败（${e?.message ?? e}），已把它挪到 ${moved}；面板只绑定回环 ${bindHost}，按无口令模式启动`,
        };
      }
      return {
        mode: "fatal",
        message: [
          `读取口令文件失败：${authFile}（${e?.message ?? e}）`,
          ` 解决方式：检查文件权限，或删除它后运行 npm run set-password 重建。`,
        ].join("\n"),
      };
    }
    // 文件不存在
    if (isLoopbackBindHost(bindHost)) {
      return {
        mode: "open",
        reason: "loopback",
        message: `未设置管理页口令（${rel} 不存在）：面板只绑定回环 ${bindHost}，按本机开发模式运行（外部无法访问）`,
      };
    }
    if (allowNoAuth) {
      return {
        mode: "open",
        reason: "forced",
        message:
          `[警告] FB_ADMIN_ALLOW_NO_AUTH=1：面板绑定在非回环地址 ${bindHost} 且没有口令，` +
          `局域网/公网内任何人都能执行沙箱代码（等效于远程命令执行）`,
      };
    }
    return {
      mode: "fatal",
      message: [
        `面板绑定在非回环地址 ${bindHost}，但 ${authFile} 不存在 → 拒绝启动（不静默降级成无鉴权面板）。`,
        ` 解决方式一（推荐）：npm run set-password        # 设置管理页口令，然后重新启动面板`,
        ` 解决方式二：FB_ADMIN_ALLOW_NO_AUTH=1 npm run admin   # 显式接受"任何人可执行沙箱代码"的风险`,
        ` 只想本机开发：FB_ADMIN_HOST=127.0.0.1 npm run admin  # 退回回环绑定，无需口令`,
      ].join("\n"),
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e: any) {
    if (isLoopbackBindHost(bindHost)) {
      const moved = quarantineAuthFile(authFile);
      return {
        mode: "open",
        reason: "loopback",
        message: `${authFile} 解析失败（${e?.message ?? e}），已挪到 ${moved}；面板只绑定回环 ${bindHost}，按无口令模式启动（重新设置口令请运行 npm run set-password）`,
      };
    }
    return {
      mode: "fatal",
      message: [
        `${authFile} 解析失败（${e?.message ?? e}）→ 拒绝启动：损坏的口令文件会让面板退化成无鉴权。`,
        ` 解决方式：备份后删除该文件，再运行 npm run set-password 重建（会写入新的口令哈希 + secret + epoch）。`,
      ].join("\n"),
    };
  }
  const config = normalizeAuthConfig(parsed);
  if (!config) {
    if (isLoopbackBindHost(bindHost)) {
      const moved = quarantineAuthFile(authFile);
      return {
        mode: "open",
        reason: "loopback",
        message: `${authFile} 内容不完整，已挪到 ${moved}；面板只绑定回环 ${bindHost}，按无口令模式启动（重新设置口令请运行 npm run set-password）`,
      };
    }
    return {
      mode: "fatal",
      message: [
        `${authFile} 内容不完整（缺少 passwordHash / secret，或哈希格式不是 scrypt）→ 拒绝启动。`,
        ` 解决方式：运行 npm run set-password 重新生成（会覆盖写入完整配置）。`,
      ].join("\n"),
    };
  }
  return { mode: "password", config };
}

const SESSION_SECONDS = () => Math.max(1, Number(auth?.sessionHours ?? 12)) * 3600;

/** 会话 token：`<exp>.<epoch>.<hmac>`，epoch 混进 HMAC（缺 epoch 的旧配置按 0 处理） */
export function signSessionToken(config: AuthConfig, exp: number, epoch = authEpoch(config)): string {
  const mac = crypto.createHmac("sha256", config.secret).update(`${exp}.${epoch}`).digest("base64url");
  return `${exp}.${epoch}.${mac}`;
}

export type SessionCheck =
  | { ok: true; exp: number; epoch: number }
  | { ok: false; reason: "no-auth" | "malformed" | "epoch" | "bad-mac" | "expired" };

export function verifySessionToken(config: AuthConfig | null, raw: string | undefined, now = Date.now()): SessionCheck {
  if (!config || !raw) return { ok: false, reason: "no-auth" };
  const parts = raw.split(".");
  // 旧格式（两段，无 epoch）一律拒绝：口径与"轮换 secret 即失效"一致
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const exp = Number(parts[0]);
  const epoch = Number(parts[1]);
  const mac = parts[2];
  if (!Number.isFinite(exp) || !Number.isFinite(epoch) || !mac) return { ok: false, reason: "malformed" };
  const current = authEpoch(config);
  if (Math.floor(epoch) !== current) return { ok: false, reason: "epoch" };
  const expected = crypto.createHmac("sha256", config.secret).update(`${exp}.${current}`).digest("base64url");
  if (mac.length !== expected.length) return { ok: false, reason: "bad-mac" };
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return { ok: false, reason: "bad-mac" };
  } catch {
    return { ok: false, reason: "bad-mac" };
  }
  if (exp * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true, exp, epoch: current };
}

/** 当前进程使用的会话签名（路由里用） */
function signSession(exp: number): string {
  return signSessionToken(auth!, exp);
}

function isValidSession(raw: string | undefined): boolean {
  return verifySessionToken(auth, raw).ok;
}

/** 请求是否来自 https（含反代）→ Cookie 需要 Secure；FB_ADMIN_COOKIE_SECURE=1 强制开启 */
export function isSecureCookieRequest(
  req: { headers: NodeJS.Dict<string | string[]>; socket?: unknown },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (String(env.FB_ADMIN_COOKIE_SECURE || "").trim() === "1") return true;
  const proto = req.headers["x-forwarded-proto"];
  const first = String(Array.isArray(proto) ? proto[0] : proto ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (first === "https") return true;
  const sock = req.socket as { encrypted?: boolean } | undefined;
  return sock?.encrypted === true;
}

function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `cq_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** 轮换后的配置：新 secret + epoch 加一，口令哈希不变 */
export function rotateAuthConfig(config: AuthConfig): AuthConfig {
  return { ...config, secret: crypto.randomBytes(32).toString("base64url"), epoch: authEpoch(config) + 1 };
}

/**
 * 原子写 auth.json：同目录临时文件（wx + 0600）→ fsync → rename → 目录 fsync。
 * 失败时删除临时文件并抛出；rename 之前不会破坏原文件。
 */
export function writeAuthFileAtomic(file: string, config: AuthConfig): string {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const payload = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");
  let fd: number | undefined;
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
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {}
    return target;
  } catch (e: any) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw new Error(`写入 ${target} 失败：${e?.message ?? e}`);
  }
}

/** 轮换磁盘上的 secret：优先以文件现状为基准（避免把刚被 set-password 改过的口令写回旧哈希） */
export function rotateAuthFile(file: string, fallback: AuthConfig): AuthConfig {
  let base = fallback;
  try {
    const parsed = normalizeAuthConfig(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
    if (parsed) base = parsed;
  } catch {}
  const next = rotateAuthConfig(base);
  writeAuthFileAtomic(file, next);
  return next;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** 暴力破解防护：同一 IP 5 分钟内失败 8 次锁定 5 分钟 */
const loginFails = new Map<string, { count: number; firstAt: number; until: number }>();

function loginLockLeft(ip: string): number {
  const f = loginFails.get(ip);
  if (!f) return 0;
  if (f.until && Date.now() < f.until) return f.until - Date.now();
  if (Date.now() - f.firstAt > 5 * 60 * 1000) loginFails.delete(ip);
  return 0;
}

function recordLoginFail(ip: string) {
  const now = Date.now();
  const f = loginFails.get(ip) ?? { count: 0, firstAt: now, until: 0 };
  f.count += 1;
  if (f.count >= 8) {
    f.until = now + 5 * 60 * 1000;
    f.count = 0;
    f.firstAt = now;
  }
  loginFails.set(ip, f);
}

function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

/** ===== 时间：统一按 UTC+8 输出 ===== */
const TZ_OFFSET_MS = 8 * 3600 * 1000;
function isoUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace("Z", "+08:00");
}
function clockUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 19);
}

/** ===== 管理端自身日志（直接写 logs/admin.log） ===== */
function log(text: string) {
  try {
    fs.appendFileSync(ADMIN_LOG, `[${isoUtc8()}] [admin] ${text}\n`);
  } catch {}
  console.log(`[${clockUtc8()}] ${text}`);
}

/** ===== 日志文件工具 ===== */
function listLogFiles(): { name: string; size: number; mtime: number }[] {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

/** 读取文件末尾若干行（最多读 512KB） */
function readTailLines(file: string, maxLines: number): string[] {
  const full = path.join(LOG_DIR, file);
  let fd: number;
  try {
    const st = fs.statSync(full);
    fd = fs.openSync(full, "r");
    const maxBytes = 512 * 1024;
    const len = Math.min(st.size, maxBytes);
    if (len === 0) {
      fs.closeSync(fd);
      return [];
    }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (len < st.size) lines.shift(); // 首行可能是半行
    return lines.filter((l) => l.trim().length > 0).slice(-maxLines);
  } catch {
    return [];
  }
}

type FileOffset = { size: number; partial: string };
type SseClient = { res: ServerResponse; source: string; offsets: Map<string, FileOffset> };

const sseClients = new Set<SseClient>();

/** 从上次偏移量继续读取新增内容，按行返回 */
function tailNew(file: string, offsets: Map<string, FileOffset>): string[] {
  const full = path.join(LOG_DIR, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return [];
  }
  let cur = offsets.get(file);
  if (!cur) {
    cur = { size: st.size, partial: "" };
    offsets.set(file, cur);
    return [];
  }
  if (st.size < cur.size) {
    // 文件被清空/轮转，从头再来
    cur.size = 0;
    cur.partial = "";
  }
  if (st.size === cur.size) return [];
  const len = st.size - cur.size;
  const buf = Buffer.alloc(len);
  let fd: number;
  try {
    fd = fs.openSync(full, "r");
    fs.readSync(fd, buf, 0, len, cur.size);
    fs.closeSync(fd);
  } catch {
    return [];
  }
  cur.size = st.size;
  const parts = (cur.partial + buf.toString("utf8")).split(/\r?\n/);
  cur.partial = parts.pop() ?? "";
  return parts.filter((l) => l.trim().length > 0);
}

/** 每 300ms 把日志文件的新增行推给所有 SSE 客户端 */
const sseTicker = setInterval(() => {
  if (!sseClients.size) return;
  const files = listLogFiles().map((f) => f.name);
  for (const client of [...sseClients]) {
    const targets = client.source === "all" ? files : files.filter((f) => f === client.source);
    for (const file of targets) {
      for (const text of tailNew(file, client.offsets)) {
        try {
          client.res.write(`data: ${JSON.stringify({ file, text })}\n\n`);
        } catch {
          sseClients.delete(client);
          break;
        }
      }
    }
  }
}, 300);
// 被测试 import 时不要让定时器拖住事件循环
sseTicker.unref?.();

/** ===== WS 子进程管理 ===== */
let wsChild: ChildProcess | null = null;
/** 移动端（Android）没有 spawn 子进程的能力：WS 服务以同进程方式加载 */
let wsInProcess = false;
let wsStartedAt = 0;
let lastWsExit: { code: number | null; at: number } | null = null;

function pipeChild(d: Buffer, isErr: boolean) {
  // WS 服务自己会写 logs/ws.log，这里只负责把输出同步显示到控制台窗口
  const text = d.toString("utf8");
  process.stdout.write(isErr ? text : text);
}

function spawnWs(): boolean {
  if (wsChild || wsInProcess) return false;
  // 打包运行时（Electron/便携版）没有 tsx，也没有 main.ts：直接跑预编译的 server/main.cjs
  const packagedEntry = (process.env.FB_WS_ENTRY || "").trim();
  // Android / nodejs-mobile 不能 spawn 新的 Node 进程：同进程 require 预编译的 main.cjs
  if (process.env.FB_WS_INPROCESS === "1") {
    if (!packagedEntry) {
      log("[ERROR] FB_WS_INPROCESS=1 但没有设置 FB_WS_ENTRY");
      return false;
    }
    try {
      const entry = path.resolve(packagedEntry);
      const req = typeof require === "function" ? require : createRequire(path.join(ROOT, "noop.js"));
      req(entry);
      wsInProcess = true;
      wsStartedAt = Date.now();
      log("WS 服务已同进程启动（移动端模式）");
      return true;
    } catch (e: any) {
      log(`[ERROR] 同进程启动 WS 失败：${e?.message ?? e}`);
      return false;
    }
  }
  let cmd: string;
  let args: string[];
  if (packagedEntry) {
    const entry = path.resolve(packagedEntry);
    if (!fs.existsSync(entry)) {
      log(`[ERROR] 找不到打包后的 WS 入口：${entry}`);
      return false;
    }
    cmd = process.execPath;
    args = [entry];
  } else {
    const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    if (!fs.existsSync(tsxCli)) {
      log(`[ERROR] 找不到 tsx：${tsxCli}，请先运行 npm install`);
      return false;
    }
    cmd = process.execPath;
    args = [tsxCli, "main.ts"];
  }
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // 用 Electron 自带 Node 跑子进程时必需；普通 node 会忽略
      FB_WS_PORT: String(WS_PORT),
      FB_CONTROL_PORT: String(CONTROL_PORT),
      FB_WS_VERSION: String(WS_VERSION),
    },
    windowsHide: true,
    detached: !IS_WIN, // Linux 下单独进程组，便于整组结束
    stdio: ["ignore", "pipe", "pipe"],
  });
  wsChild = child;
  wsStartedAt = Date.now();
  log(`启动 WS 服务（PID ${child.pid}）`);
  child.stdout?.on("data", (d: Buffer) => pipeChild(d, false));
  child.stderr?.on("data", (d: Buffer) => pipeChild(d, true));
  child.on("exit", (code) => {
    lastWsExit = { code, at: Date.now() };
    log(`WS 服务已退出（code=${code}）`);
    wsChild = null;
  });
  return true;
}

/** 结束进程（Windows 用 taskkill /T；Linux 用进程组） */
function killTree(pid: number) {
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function stopWs(): boolean {
  if (wsInProcess) {
    log("移动端 WS 与面板同进程，无法单独停止");
    return false;
  }
  if (!wsChild?.pid) return false;
  const pid = wsChild.pid;
  log(`停止 WS 服务（PID ${pid}）`);
  killTree(pid);
  wsChild = null;
  return true;
}

function killWsOnExit() {
  if (wsChild?.pid) {
    try {
      killTree(wsChild.pid);
    } catch {}
  }
}

/** 只在真正跑服务时挂进程钩子（被测试 import 时保持无副作用） */
function installProcessHooks() {
  process.on("exit", killWsOnExit);
  process.on("SIGINT", () => {
    log("收到退出信号，正在关闭");
    killWsOnExit();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killWsOnExit();
    process.exit(0);
  });
}

/** ===== 与控制接口通信 ===== */
async function refreshPublicIp() {
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        SYS.publicIp = ip;
        SYS.publicIpAt = Date.now();
      }
    }
  } catch {}
}

async function controlFetch(pathname: string, init?: RequestInit, timeout = 2500): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 反代到网易版服务（未启动时返回 null） */
async function neteaseFetch(pathname: string, init?: RequestInit, timeout = 60000): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${NETEASE_PORT}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function wsStatus(): Promise<any | null> {
  const first = await controlFetch("/status", { method: "GET" }, 1500);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 250));
  return controlFetch("/status", { method: "GET" }, 1500);
}

async function waitForWs(timeoutMs = 8000): Promise<any | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await wsStatus();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** ===== 网易版服务 + 机器人托管 ===== */
let neteaseChild: ChildProcess | null = null;
let neteaseStartedAt = 0;
/** Android：没有独立 Node 进程可 fork，netease-service 在 admin-server 进程内启动 */
let neteaseInProcess = false;

function readJsonFile(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写（tmp + fsync + rename + 0600），口令/账号文件都用它 */
function writeFileAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** Wine：Linux/macOS 上跑 Windows 引擎（Program.exe）的唯一实用方式 */
type WineInfo = { bin: string; version: string };
let wineInfoCache: WineInfo | null | undefined;

/** macOS 上常见发行版的固定路径（WineHQ / CrossOver / Whisky） */
const MAC_WINE_PATHS = [
  "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64",
  "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine",
  "/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine64",
  "/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine",
  "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine",
  "/Applications/Whisky.app/Contents/Resources/wine/bin/wine64",
];

function wineInfo(): WineInfo | null {
  if (IS_WIN) return null;
  if ((process.env.FB_NETEASE_NO_WINE || "") === "1") return null;
  if (wineInfoCache !== undefined) return wineInfoCache;
  const forced = (process.env.FB_WINE || "").trim();
  const candidates = forced
    ? [forced]
    : process.platform === "darwin"
      ? [...MAC_WINE_PATHS, "wine64", "wine"]
      : ["wine", "wine64", "/usr/bin/wine", "/usr/local/bin/wine", "/opt/wine-stable/bin/wine"];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      if (r.status === 0) {
        wineInfoCache = { bin, version: out.split(/\r?\n/)[0] || "wine" };
        return wineInfoCache;
      }
    } catch {
      /* 继续找 */
    }
  }
  wineInfoCache = null;
  return null;
}

function wineBinary(): string | null {
  return wineInfo()?.bin ?? null;
}

/** 面板显示的运行环境：Windows 原生 / Linux+Wine / macOS+Wine / 缺少 Wine */
function engineEnvSnapshot() {
  if (IS_WIN) {
    return { platform: "windows", native: true, engine: "native", wine: null as null | { path: string; version: string } };
  }
  if (hasNativeEngine()) {
    return { platform: process.platform, native: true, engine: "native", wine: null };
  }
  const w = wineInfo();
  return {
    platform: process.platform,
    native: false,
    engine: w ? "wine" : "none",
    wine: w ? { path: w.bin, version: w.version } : null,
  };
}

/** 把「引擎 argv」包成当前平台能执行的形式：Windows 直接跑，其他平台套 wine */
function engineArgvWithWine(argv: string[]): string[] | null {
  if (IS_WIN || hasNativeEngine()) return argv;
  const wine = wineBinary();
  if (!wine) return null;
  return [wine, ...argv];
}

function neteaseBotCommand(): string | null {
  const forced = (process.env.FB_NETEASE_BOT_CMD || "").trim();
  if (forced) return forced;
  if (hasNativeEngine()) {
    // cfg 模式：把面板保存的 mc.cfg 同步到原生引擎目录
    try {
      if (fs.existsSync(NETEASE_MC_CFG)) fs.copyFileSync(NETEASE_MC_CFG, path.join(NETEASE_NATIVE_DIR, "mc.cfg"));
    } catch {}
    return `"${engineExe()}" --config mc.cfg --logger --no-ui`;
  }
  const exe = path.join(NETEASE_CORE_DIR, "Program.exe");
  if (!fs.existsSync(exe)) {
    const script = path.join(NETEASE_BOT_DIR, IS_WIN ? "start-bot.bat" : "start-bot.sh");
    return fs.existsSync(script) ? script : null;
  }
  if (IS_WIN) {
    const bat = path.join(NETEASE_BOT_DIR, "start-bot.bat");
    if (fs.existsSync(bat)) return bat;
    return `"${exe}" --config mc.cfg --logger --no-ui`;
  }
  // 非 Windows：启动脚本里也是 ./Program.exe，直接套 wine 更可靠
  const wine = wineBinary();
  if (wine) {
    return `WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= "${wine}" "${exe}" --config mc.cfg --logger --no-ui`;
  }
  const sh = path.join(NETEASE_BOT_DIR, "start-bot.sh");
  return fs.existsSync(sh) ? sh : null;
}

/** ===== 网易账号模式：账号登录 → 房间解析 → 引擎 argv =====
 *
 * 与 mc.cfg 模式并存：
 *   · 账号模式：面板里填网易账号/密码 + 房间号，登录换 token，查房间地址，
 *     直接以 argv 启动 Program.exe（不经 shell，不怕昵称里的空格/引号）；
 *   · mc.cfg 模式：老路子，读启动器导出的 mc.cfg。
 * 账号密码只用于换 token，不落盘；token 只在内存里，进程退出即失效。
 */
type AccountCfg = {
  account: string;
  room: string;
  roomPassword: string;
  /** rental / lobby / realms / local */
  roomKind: string;
  /** 本地联机：房间号（直接进房，不是 IP） */
  localRoom: string;
  localPassword: string;
  /** 本地联机房间绑定的组件 ID（可选；进房 501 时用它领取） */
  localResId: string;
  /** 手动领取用的组件 ID（面板上那一格） */
  componentId: string;
  lobbyVersion: string;
  displayName: string;
  /** 可选：覆盖引擎版本号 / 协议（默认用 VQ PE 的 3.8.x 与引擎内置协议） */
  engineVersion: string;
  patchVersion: string;
  protocol: string;
};
type X19Cred = {
  entityId: string;
  name: string;
  token: string;
  /** PE 通道（基岩版）登录态：PE 接口只认它，缺了只能回退 PC token */
  peEntityId: string;
  peToken: string;
  /**
   * PE token 拿到的时刻。
   *
   * 必须记：网易每做一次 `/pe-authentication`，同一账号**之前**的 PE token 立刻失效，
   * 再用旧的就回「您的帐号在另一处登录」。不记时间就没法判断手里的 token 是不是已经被
   * 自己下一次登录顶掉了（这正是「领组件一直失败」的根因，见 docs/组件领取排查.md）。
   */
  peTokenAt?: number;
  at: number;
  expiresAt: number;
};

/** X19Cred → 接口层凭据（带上 PE 通道 token） */
function credOf(cred: X19Cred): { userId: string; token: string; peUserId: string; peToken: string } {
  return {
    userId: cred.entityId,
    token: cred.token,
    peUserId: cred.peEntityId || cred.entityId,
    peToken: cred.peToken,
  };
}

/** token 保守按 6 小时算；过期就让用户重新登录，避免半夜掉线还查不出原因 */
const X19_TOKEN_TTL = 6 * 3600_000;
let x19Session: X19LoginSession | null = null;
let x19Cred: X19Cred | null = null;

function readAccountCfg(): AccountCfg {
  const raw = readJsonFile(NETEASE_ACCOUNT_CFG) || {};
  return {
    account: String(raw.account ?? ""),
    room: String(raw.room ?? ""),
    roomPassword: String(raw.roomPassword ?? ""),
    roomKind: ["lobby", "realms", "local"].includes(String(raw.roomKind ?? "")) ? String(raw.roomKind) : "rental",
    localRoom: String(raw.localRoom ?? raw.localHost ?? ""),
    localPassword: String(raw.localPassword ?? ""),
    localResId: String(raw.localResId ?? ""),
    componentId: String(raw.componentId ?? raw.localResId ?? ""),
    lobbyVersion: String(raw.lobbyVersion ?? ""),
    displayName: String(raw.displayName ?? ""),
    engineVersion: String(raw.engineVersion ?? ""),
    patchVersion: String(raw.patchVersion ?? ""),
    protocol: String(raw.protocol ?? ""),
  };
}

function saveAccountCfg(patch: Partial<AccountCfg>): AccountCfg {
  const next = { ...readAccountCfg(), ...patch };
  try {
    writeFileAtomic(NETEASE_ACCOUNT_CFG, JSON.stringify(next, null, 2) + "\n");
  } catch (e: any) {
    log(`保存账号配置失败：${e?.message ?? e}`);
  }
  return next;
}

function activeLoginStatus(): string {
  return x19Session?.state.status ?? "idle";
}

function loginSnapshot() {
  const s = x19Session;
  return {
    status: s?.state.status ?? "idle",
    entityId: x19Cred?.entityId ?? s?.state.entityId ?? "",
    name: x19Cred?.name || s?.state.name || "",
    error: s?.state.error ?? "",
    sms: s?.state.sms ?? null,
    notices: s?.state.notices.slice(-20) ?? [],
    expiresAt: x19Cred?.expiresAt ?? 0,
    /** PE 通道是否就绪（PE 接口只有 PE token 能用） */
    pe: !!x19Cred && hasPeSession(credOf(x19Cred)),
    peEntityId: x19Cred?.peEntityId ?? "",
    /** 手里的 PE token 多少秒前拿的；-1 = 没有。超过 PE_TOKEN_TTL 就该刷新了 */
    peAgeSec: (() => {
      if (!x19Cred?.peToken) return -1;
      const age = peTokenAgeMs();
      // 没有 peTokenAt（旧版 session.json）时算「很旧」，让前端提示刷新
      return Number.isFinite(age) ? Math.round(age / 1000) : PE_TOKEN_TTL / 1000;
    })(),
    saved: !!readSessionFile(),
    binary: !!resolveX19LoginBinary(),
  };
}

type SavedSession = {
  v: number;
  entityId: string;
  token: string;
  name: string;
  /** PE 通道登录态（没有就留空） */
  peEntityId?: string;
  peToken?: string;
  /** PE token 的取得时间（用来判断是不是已经被下一次 PE 登录顶掉了） */
  peTokenAt?: number;
  savedAt: number;
  expiresAt: number;
};

function saveSessionFile(cred: X19Cred) {
  const saved: SavedSession = {
    v: 3,
    entityId: cred.entityId,
    token: cred.token,
    name: cred.name,
    peEntityId: cred.peEntityId || "",
    peToken: cred.peToken || "",
    peTokenAt: Number(cred.peTokenAt ?? 0) || 0,
    savedAt: Date.now(),
    expiresAt: cred.expiresAt,
  };
  try {
    writeFileAtomic(NETEASE_SESSION_FILE, JSON.stringify(saved, null, 2) + "\n");
    log(`网易登录态已保存：${path.relative(ROOT, NETEASE_SESSION_FILE)}（0600）`);
  } catch (e: any) {
    log(`保存登录态失败：${e?.message ?? e}`);
  }
}

function readSessionFile(): SavedSession | null {
  const raw = readJsonFile(NETEASE_SESSION_FILE);
  if (!raw || typeof raw !== "object") return null;
  const entityId = String(raw.entityId ?? raw.entity_id ?? "").trim();
  const token = String(raw.token ?? "").trim();
  if (!entityId || !token) return null;
  return {
    v: Number(raw.v ?? 1) || 1,
    entityId,
    token,
    name: String(raw.name ?? ""),
    peEntityId: String(raw.peEntityId ?? ""),
    peToken: String(raw.peToken ?? ""),
    peTokenAt: Number(raw.peTokenAt ?? 0) || 0,
    savedAt: Number(raw.savedAt ?? raw.saved_at ?? 0) || 0,
    expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0) || 0,
  };
}

function saveSauthFile(sauth: string, account = "") {
  const raw = String(sauth ?? "").trim();
  if (!raw) return;
  try {
    writeFileAtomic(
      NETEASE_SAUTH_FILE,
      JSON.stringify({ v: 2, sauth: raw, account: String(account ?? ""), savedAt: Date.now() }, null, 2) + "\n"
    );
  } catch (e: any) {
    log(`保存 sauth 失败（PE 通道将无法单独刷新）：${e?.message ?? e}`);
  }
}

/**
 * 读 sauth。带上它属于哪个账号：切账号（例如导入别人的登录态）后如果还拿旧 sauth
 * 去换 PE token，会登进另一个账号，必须挡住。
 */
function readSauthFile(): { sauth: string; account: string } {
  const raw = readJsonFile(NETEASE_SAUTH_FILE) || {};
  return { sauth: String(raw.sauth ?? "").trim(), account: String(raw.account ?? "") };
}

function clearSauthFile() {
  try {
    fs.rmSync(NETEASE_SAUTH_FILE, { force: true });
  } catch {}
}

function clearSessionFile() {
  try {
    fs.rmSync(NETEASE_SESSION_FILE, { force: true });
    fs.rmSync(NETEASE_SAUTH_FILE, { force: true });
  } catch {}
}

/** 用保存的 token 换新 token；成功返回 true */
async function refreshCred(cred: X19Cred): Promise<boolean> {
  const session = new X19LoginSession(
    { mode: "refresh", entityId: cred.entityId, token: cred.token },
    { onLog: (line) => log(line), timeoutMs: 30_000 }
  );
  const state = await session.wait(35_000);
  if (state.status !== "ok" || !state.token) {
    log(`刷新登录态失败：${state.error || state.status}`);
    return false;
  }
  x19Cred = {
    entityId: state.entityId || cred.entityId,
    name: state.name || cred.name,
    token: state.token,
    // 刷新只换 x19 token，PE 通道的登录态沿用上一次登录的结果
    peEntityId: cred.peEntityId,
    peToken: cred.peToken,
    at: Date.now(),
    expiresAt: Date.now() + X19_TOKEN_TTL,
  };
  saveSessionFile(x19Cred);
  log(`网易登录态已刷新：${x19Cred.name || "（无昵称）"}（uid ${x19Cred.entityId}）`);
  return true;
}

/** 操作前确保 token 可用：过期就自动刷新一次 */
async function ensureCred(): Promise<X19Cred> {
  if (!x19Cred) throw new Error("请先登录网易账号（或导入登录态）");
  if (Date.now() <= x19Cred.expiresAt) return x19Cred;
  const ok = await refreshCred(x19Cred);
  if (!ok) {
    throw new Error("登录态刷新失败（网络或 token 失效），可点「刷新登录态」重试或重新登录");
  }
  return x19Cred;
}

function restoreSavedSession() {
  const saved = readSessionFile();
  if (!saved) return;
  const savedAt = saved.savedAt || 0;
  // 设备时钟错过一次就可能写进离谱的 expiresAt，这里按 savedAt 收口，避免「永不过期」的假象
  const maxExpiry = (savedAt || Date.now()) + X19_TOKEN_TTL;
  const rawExpiry = saved.expiresAt || maxExpiry;
  const expiresAt = Math.min(rawExpiry, maxExpiry + 60_000);
  x19Cred = {
    entityId: saved.entityId,
    name: saved.name,
    token: saved.token,
    peEntityId: saved.peEntityId || "",
    peToken: saved.peToken || "",
    peTokenAt: saved.peTokenAt || 0,
    at: savedAt || Date.now(),
    expiresAt,
  };
  // token 还新鲜就别每次启动都刷新：refresh 会把同一账号在别处的会话顶掉
  if (expiresAt && Date.now() < expiresAt - 10 * 60_000) {
    const leftMin = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    log(`使用保存的网易登录态（uid ${saved.entityId}，约剩 ${leftMin} 分钟，暂不刷新）`);
    return;
  }
  log(`发现已保存的网易登录态（uid ${saved.entityId}），正在刷新…`);
  refreshCred(x19Cred).then((ok) => {
    if (!ok) {
      const stillValid = x19Cred && Date.now() < x19Cred.expiresAt;
      log(
        stillValid
          ? "刷新登录态失败，但保存的 token 还没过期，先继续使用；需要时点「刷新登录态」"
          : "保存的登录态已过期且刷新失败，请重新登录"
      );
    }
  });
}

/**
 * PE token 保鲜期。
 *
 * 别设太短：`/pe-authentication` 本身有登录频控（实测连续登录十来次就回「操作过于频繁，
 * 请稍后重试」）。30 分钟 + 撞到「另一处登录」时按需刷新，已经够用，也不至于把自己限流。
 */
const PE_TOKEN_TTL = 30 * 60_000;
/**
 * 网易登录频控后的冷却（「操作过于频繁」）。
 *
 * 必须落盘：网易这个惩罚期实测超过 10 分钟，重启 App 就清掉内存冷却的话，
 * 下一次点击又会去撞，只会把惩罚期越拖越长。
 */
const AUTH_COOLDOWN_FILE = path.join(NETEASE_BOT_DIR, "auth-cooldown.json");
/**
 * 冷却要按账号记：同一台机器换账号登录时，旧账号撞出来的频控不该把新账号也锁 20 分钟。
 */
type AuthCooldown = { until: number; account: string };
let authCooldown: AuthCooldown = (() => {
  const raw = readJsonFile(AUTH_COOLDOWN_FILE) || {};
  return {
    until: Math.max(0, Number(raw.until ?? 0) || 0),
    account: String(raw.account ?? ""),
  };
})();
/** 最近一次刷新登录态的真实失败原因（面板/接口报错用它，不再一律写成「频控」） */
let lastAuthError = "";
/** 刷新并发去重：同时点两次按钮不该发两次登录请求 */
let authRefreshPromise: Promise<boolean> | null = null;

/** 当前账号还剩多少冷却（换账号就忽略旧账号的冷却） */
function authCooldownLeft(): number {
  const cur = String(x19Cred?.entityId ?? "");
  if (authCooldown.account && cur && authCooldown.account !== cur) return 0;
  return Math.max(0, authCooldown.until - Date.now());
}

function clearAuthCooldown(): void {
  authCooldown = { until: 0, account: "" };
  lastAuthError = "";
  try {
    fs.rmSync(AUTH_COOLDOWN_FILE, { force: true });
  } catch {}
}

/** 手里的 PE token 有多旧（毫秒）；没有 token 时是 Infinity */
function peTokenAgeMs(): number {
  const at = Number(x19Cred?.peTokenAt ?? 0) || 0;
  return at ? Date.now() - at : Number.POSITIVE_INFINITY;
}

/**
 * 用保存的 sauth 重新登录一次：**同时**换新的 x19 token 和 PE 通道 token。
 *
 * 两个理由：
 *   1) `/pe-authentication` 每成功一次，同账号之前的 PE token 立刻作废（再用就回
 *      「您的帐号在另一处登录」），所以「手里有 peToken」不等于「peToken 还能用」；
 *   2) 实测做 PE 认证会把同一个账号的 x19 会话挤掉——之后 PC 接口一律「请先登录」，
 *      而且 `mode=refresh` 救不回来（旧 token 已经被服务端丢弃）。sauth 是长期凭据，
 *      只有它能无密码把两边一起换新，所以统一走这一条路。
 *
 * 对应 Go 侧：`neteasex19.LoginBySauth`（VQ 的 MKeyService.PeLoginWithSauthAsync 同源）。
 */
/** 记一次登录频控冷却（落盘，重启也生效） */
function setAuthCooldown(ms: number, reason = ""): void {
  authCooldown = { until: Date.now() + ms, account: String(x19Cred?.entityId ?? "") };
  if (reason) lastAuthError = reason;
  try {
    writeFileAtomic(
      AUTH_COOLDOWN_FILE,
      JSON.stringify({ ...authCooldown, reason, at: Date.now() }, null, 2) + "\n"
    );
  } catch {}
}

async function refreshCredsWithSauth(reason: string): Promise<boolean> {
  if (authRefreshPromise) return authRefreshPromise;
  const waitLeft = authCooldownLeft();
  if (waitLeft > 0) {
    log(`网易登录频控冷却中，还有 ${Math.ceil(waitLeft / 1000)} 秒，先不重登`);
    return false;
  }
  const saved = readSauthFile();
  const sauth = saved.sauth;
  if (!sauth) {
    lastAuthError = "本机没有保存 sauth（用账号密码登录一次即可拿到）";
    log("没有保存 sauth，无法刷新登录态（重新用账号密码登录一次即可拿到）");
    return false;
  }
  if (saved.account && x19Cred?.entityId && saved.account !== x19Cred.entityId) {
    lastAuthError = `本机保存的 sauth 属于另一个账号（${saved.account}），不能用来给 ${x19Cred.entityId} 换 PE token`;
    log(lastAuthError);
    return false;
  }
  log(`用 sauth 重新登录（${reason}）…`);
  authRefreshPromise = (async () => {
    const session = new X19LoginSession(
      { mode: "sauth", sauth, pe: true, emitSauth: true },
      { onLog: (line) => log(line), timeoutMs: 90_000 }
    );
    const state = await session.wait(95_000);
    if (state.status !== "ok" || !state.token) {
      const msg = state.error || state.status;
      lastAuthError = msg;
      if (/频繁|稍后重试|操作过于频繁/.test(msg)) setAuthCooldown(20 * 60_000, msg);
      log(`sauth 重新登录失败：${msg}`);
      return false;
    }
    // PE 那次登录可能被网易限流（PC 登录仍然有效）：这时**不能**把旧的 PE token 留着当有效，
    // 否则下一次 PE 请求一定回「您的帐号在另一处登录」，比没有 token 更难排查。
    const peToken = String(state.peToken || "");
    // PE 那一步失败时 status 仍然是 ok（PC 登录成功），原因在 pe_error / notices 里。
    // 这里不挑原因：刚刚重新登录过却拿不到 PE token，基本只有两种可能——网易登录频控，
    // 或者 PE 侧在维护。两种情况下继续点都只会加深惩罚，所以统一放一段冷却。
    if (!peToken) {
      const peMsg = [state.peError, ...(state.notices || [])].join(" ").trim();
      lastAuthError = peMsg || "PE 认证没有返回 token";
      log(`PE 通道没拿到：${peMsg || "原因未知"}（冷却 20 分钟后再试）`);
      setAuthCooldown(20 * 60_000, lastAuthError);
    }
    x19Cred = {
      entityId: state.entityId || x19Cred?.entityId || "",
      name: state.name || x19Cred?.name || "",
      token: state.token,
      peEntityId: peToken ? state.peEntityId || String(x19Cred?.peEntityId ?? "") : "",
      peToken,
      peTokenAt: peToken ? Date.now() : 0,
      at: Date.now(),
      expiresAt: Date.now() + X19_TOKEN_TTL,
    };
    saveSessionFile(x19Cred);
    // 这次能登进去说明频控已经解除，清掉落盘的冷却
    if (peToken) clearAuthCooldown();
    else {
      authCooldown = { until: authCooldown.until, account: authCooldown.account };
    }
    log(
      `登录态已刷新：uid ${x19Cred.entityId}` +
        (peToken
          ? `，PE 通道就绪（uid ${x19Cred.peEntityId || x19Cred.entityId}）`
          : "；PE 通道这次没刷出来（可能被登录频控），需要时再点「PE 通道登录」")
    );
    return true;
  })().finally(() => {
    authRefreshPromise = null;
  });
  return authRefreshPromise;
}

/**
 * 做 PE 通道的事之前调一次：没有 PE token / token 太旧就换新的。
 *
 * 不这么做的话，第一次 PE 请求一定会死在「另一处登录」上，而购买接口有限流，
 * 白打一次很亏。
 */
async function ensurePeCred(): Promise<void> {
  if (!x19Cred) return;
  const usable = !!String(x19Cred.peToken || "").trim() && isValidPeUserId(x19Cred.peEntityId);
  if (usable && peTokenAgeMs() < PE_TOKEN_TTL) return;
  // 引擎/机器人在跑的时候不主动刷新：PE token 一换，正在进行的会话可能被踢
  if (neteaseChild) {
    log("引擎正在运行，跳过主动刷新 PE 通道（需要时点「PE 通道登录」）");
    return;
  }
  await refreshCredsWithSauth(
    !String(x19Cred.peToken || "").trim()
      ? "还没有 PE token"
      : !isValidPeUserId(x19Cred.peEntityId)
        ? "PE entity 无效（pe_entity_id=0）"
        : "PE token 已旧"
  );
}

/** 网易的「登录态没了」类报错（x19 被挤掉 / PE token 被顶掉） */
function isAuthExpiredError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  return /请先登录|未登录|登录态|token.*(失效|无效|过期)|unauthorized/i.test(msg);
}

/**
 * 撞到「登录态没了」就刷新一次再重试（同一次操作最多重试一次）：
 *   - PE token 被顶掉（您的帐号在另一处登录）→ sauth 重登
 *   - x19 token 被 PE 认证挤掉（请先登录）→ sauth 重登
 * 重试前那次请求都没有产生订单/房间席位，所以不会重复下单。
 */
async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const stalePe = isPeSessionStaleError(e);
    const expired = isAuthExpiredError(e);
    if (!stalePe && !expired) throw e;
    // 冷却期里重登只会加深网易的惩罚：直接把「等多久」告诉用户，别再打接口
    const left = authCooldownLeft();
    if (left > 0) {
      throw new Error(
        `网易要求重新登录（${String(e?.message ?? e)}），但刚才登录被频控过，` +
          `请 ${Math.max(1, Math.ceil(left / 60_000))} 分钟后再试`
      );
    }
    const ok = await refreshCredsWithSauth(stalePe ? "PE token 被顶掉（另一处登录）" : "登录态被挤掉（请先登录）");
    if (!ok) throw e;
    return fn();
  }
}

/** 把「请先登录 / token 无效」翻成人话，提示重新登录 */
function decorateAuthError(e: any): Error {
  const msg = String(e?.message ?? e);
  if (/请先登录|未登录|token.*(失效|无效|过期)|login/i.test(msg)) {
    return new Error(`${msg}（登录态已失效：在面板上重新登录一次网易账号）`);
  }
  return e instanceof Error ? e : new Error(msg);
}

function requireCred(): X19Cred {
  if (!x19Cred) throw new Error("请先登录网易账号");
  if (Date.now() > x19Cred.expiresAt) {
    throw new Error("网易登录已过期，正在刷新或请重新登录");
  }
  return x19Cred;
}

function startX19Login(input: any) {
  const busy = x19Session && ["starting", "need_sms", "need_upstream", "need_password"].includes(x19Session.state.status);
  if (busy) return { ok: false, error: "已有一次登录正在进行，请先完成或取消" };

  // 手机号统一成 11 位（去 +86/空格/横线）；邮箱只 trim
  const account = normalizeLoginAccount(String(input?.account ?? ""));
  const password = String(input?.password ?? "");
  let mode = String(input?.mode ?? "").trim() as X19LoginRequest["mode"];
  if (mode !== "email" && mode !== "phone" && mode !== "sms" && mode !== "sauth") {
    mode = account.includes("@") ? "email" : isMainlandPhone(account) ? "phone" : "sms";
  }
  if (mode === "phone" && !isMainlandPhone(account)) {
    return { ok: false, error: "手机号登录需要 11 位大陆号码（不带 +86）" };
  }
  if (mode !== "sauth" && !account) return { ok: false, error: "请填写网易邮箱或手机号" };
  if ((mode === "email" || mode === "phone") && !password) return { ok: false, error: "请填写密码" };
  if (!resolveX19LoginBinary()) {
    return { ok: false, error: "缺少登录助手 x19login，请先运行 npm run build:x19login" };
  }

  log(`发起网易登录（${mode}${mode === "sms" ? "" : "，账号已脱敏"}）`);
  x19Session = new X19LoginSession(
    {
      mode,
      account,
      password,
      sauth: String(input?.sauth ?? "") || undefined,
      pe: input?.pe === true,
      emitSauth: true,
    },
    { onLog: (line) => log(line) }
  );
  x19Session.wait().then((state) => {
    if (state.status !== "ok") return;
    x19Cred = {
      entityId: state.entityId,
      name: state.name,
      token: state.token,
      peEntityId: state.peEntityId,
      peToken: state.peToken,
      at: Date.now(),
      expiresAt: Date.now() + X19_TOKEN_TTL,
    };
    saveAccountCfg({ account });
    saveSessionFile(x19Cred);
    if (state.sauth) saveSauthFile(state.sauth, state.entityId || "");
    // 刚登录成功：旧账号/旧会话留下的登录频控冷却作废
    clearAuthCooldown();
    log(`网易账号已登录：${state.name || "（无昵称）"}（uid ${state.entityId}）`);
    if (x19Cred.peToken) log(`PE 通道已就绪（uid ${x19Cred.peEntityId || x19Cred.entityId}），可领取联机大厅组件`);
    else if (state.peError) log(`PE 通道未就绪：${state.peError}`);
  });
  return { ok: true, login: loginSnapshot() };
}

/**
 * 用一段 sauth 跑 x19 登录助手，成功后更新内存凭据与 session.json。
 * 4399 登录和 cookie 登录都走这里（助手本身对渠道服/官服一视同仁）。
 */
async function finishLoginWithSauth(
  sauthText: string,
  sourceLabel: string
): Promise<{ ok: boolean; error?: string; login?: any }> {
  if (!resolveX19LoginBinary()) {
    return { ok: false, error: "缺少登录助手 x19login，请先运行 npm run build:x19login" };
  }
  if (x19Session && ["starting", "need_sms", "need_upstream", "need_password"].includes(x19Session.state.status)) {
    x19Session.cancel();
    x19Session = null;
  }
  log(`发起 ${sourceLabel} 登录（sauth → x19 助手）…`);
  const session = new X19LoginSession(
    { mode: "sauth", sauth: sauthText, pe: false, emitSauth: true },
    { onLog: (line) => log(line), timeoutMs: 120_000 }
  );
  const state = await session.wait(125_000);
  if (state.status !== "ok" || !state.token) {
    return { ok: false, error: state.error || `登录失败（${state.status}）` };
  }
  x19Cred = {
    entityId: state.entityId,
    name: state.name,
    token: state.token,
    peEntityId: "",
    peToken: "",
    peTokenAt: 0,
    at: Date.now(),
    expiresAt: Date.now() + X19_TOKEN_TTL,
  };
  saveSessionFile(x19Cred);
  if (state.sauth) saveSauthFile(state.sauth, state.entityId || "");
  clearAuthCooldown();
  log(`登录成功（${sourceLabel}）：${state.name || "（无昵称）"}（uid ${state.entityId}）`);
  return { ok: true, login: loginSnapshot() };
}

function submitX19Login(body: any) {
  if (!x19Session) return { ok: false, error: "没有进行中的登录" };
  let accepted = false;
  if (body?.code) accepted = x19Session.submitCode(String(body.code));
  else if (body?.ack) accepted = x19Session.ackUpstream();
  else if (body?.password) accepted = x19Session.submitPassword(String(body.password));
  else return { ok: false, error: "缺少 code / ack / password" };
  if (!accepted) return { ok: false, error: `当前状态（${x19Session.state.status}）不接受这个输入` };
  return { ok: true, login: loginSnapshot() };
}

function cancelX19Login() {
  x19Session?.cancel();
  x19Session = null;
  return { ok: true, login: loginSnapshot() };
}

function logoutX19() {
  x19Session?.cancel();
  x19Session = null;
  x19Cred = null;
  clearSessionFile();
  clearAuthCooldown();
  log("已退出网易账号登录态，并清除本地保存（含 sauth 与登录频控冷却）");
  return { ok: true };
}

/**
 * 领完组件后自动重试一次进房（只取地址，不启动引擎；失败不抛给调用方）。
 *
 * 这些接口分属「购买」和「大厅进房」两类，中间停一下，别让网易把两次请求当成连点。
 */
async function retryEnterAfterClaim(): Promise<{ ok: boolean; host?: string; port?: string; error?: string }> {
  const cfg = readAccountCfg();
  if (cfg.roomKind !== "lobby" && cfg.roomKind !== "local") {
    return { ok: false, error: "当前房间类型不是联机大厅/本地联机，跳过重试" };
  }
  const room = String(cfg.roomKind === "local" ? cfg.localRoom : cfg.room).trim();
  if (!room) return { ok: false, error: "还没有填房间号，跳过重试" };
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const resolved = await resolveRoomForPanel({});
    clearLobbyCooldown();
    log(`领取后重试进房成功：${resolved.host}:${resolved.port}`);
    return { ok: true, host: resolved.host, port: resolved.port };
  } catch (e: any) {
    noteLobbyRateLimitError(e);
    return { ok: false, error: decorateAuthError(e).message };
  }
}

/** 房间号/名称 → 地址（面板上的「测试」和启动都用它） */
async function resolveRoomForPanel(body: any) {
  const cfg = readAccountCfg();
  const keyword = String(body?.keyword ?? cfg.room ?? "").trim();
  const password = String(body?.roomPassword ?? cfg.roomPassword ?? "");
  const rawKind = String(body?.roomKind ?? cfg.roomKind ?? "rental");
  const kind = ["lobby", "realms", "local"].includes(rawKind) ? rawKind : "rental";

  const cred = await ensureCred();
  /**
   * 联机大厅 / 本地联机默认走 PE 通道。
   *
   * 实测（2026-11-15）：同一个网易账号，联机专区商品的归属记在 PE entity 上——
   * 领取走 PE 商城（channel_id=5），进房也得用 PE 凭据，否则同一间房仍回 501。
   * `channel=pc` 保留成排查开关（强制用 PC 登录态打大厅接口）。
   */
  const channel = String(body?.channel ?? "").trim().toLowerCase();
  const baseCred = credOf(cred);
  if (channel !== "pc" && (kind === "lobby" || kind === "local")) await ensurePeCred();
  // 注意：这里要传「完整凭据」（含 peToken），通道选择交给 resolveLobbyAddress/enterPeRoom
  const lobbyCred =
    channel === "pc" ? { userId: baseCred.userId, token: baseCred.token } : baseCred;

  if (kind === "local") {
    const room = String(body?.localRoom ?? cfg.localRoom ?? keyword ?? "").trim();
    if (!/^\d{4,8}$/.test(room)) throw new Error("请填写 4–8 位本地联机房间号");
    const passcode = String(body?.localPassword ?? cfg.localPassword ?? password ?? "");
    let address: Awaited<ReturnType<typeof resolvePeLocalRoom>>;
    try {
      address = await resolvePeLocalRoom(room, passcode, lobbyCred, {
        componentId: String(body?.localResId ?? cfg.componentId ?? cfg.localResId ?? ""),
      });
    } catch (e: any) {
      noteLobbyRateLimitError(e);
      throw new Error(`本地联机房间号 ${room} 解析失败：${e?.message ?? e}`);
    }
    clearLobbyCooldown();
    return {
      kind,
      entityId: room,
      name: `本地联机 ${room}`,
      hasPwd: false,
      playerCount: 0,
      capacity: 0,
      host: address.host,
      port: address.port,
    };
  }

  if (kind === "realms") {
    if (!keyword) throw new Error("请填写山头服 ID 或邀请码");
    const address = await resolveRealmsAddress(keyword, credOf(cred));
    return {
      kind,
      entityId: keyword,
      name: keyword,
      hasPwd: false,
      playerCount: 0,
      capacity: 0,
      host: address.host,
      port: address.port,
    };
  }

  if (kind === "lobby") {
    const cred2 = lobbyCred;
    // 面板搜索选中后带的是 entityId：直接进房，不再按名字搜索
    const selectedId = String(body?.roomEntityId ?? "").trim();
    if (selectedId && (!keyword || keyword === selectedId)) {
      const room: LobbyRoom = {
        entityId: selectedId,
        name: String(body?.roomName ?? selectedId),
        hasPwd: !!String(password ?? ""),
        playerCount: 0,
        maxCount: 0,
        version: "",
        lobbyManifestVersion: String(body?.lobbyManifestVersion ?? ""),
        resId: String(body?.resId ?? ""),
      };
      log(
        `联机大厅直连：${room.name}（${room.entityId}）res_id=${room.resId || "(空，用数字房间号)"}`
      );
      let address: Awaited<ReturnType<typeof resolveLobbyAddress>>;
      try {
        address = await resolveLobbyAddress(room, password, cred2);
      } catch (e: any) {
        noteLobbyRateLimitError(e);
        throw e;
      }
      clearLobbyCooldown();
      return {
        kind,
        entityId: room.entityId,
        resId: room.resId,
        name: room.name,
        hasPwd: room.hasPwd,
        playerCount: 0,
        capacity: 0,
        host: address.host,
        port: address.port,
      };
    }
    let resolved: Awaited<ReturnType<typeof resolveLobbyRoom>>;
    try {
      resolved = await resolveLobbyRoom(keyword, password, cred2, {
        version: String(body?.lobbyVersion ?? cfg.lobbyVersion ?? "") || undefined,
      });
    } catch (e: any) {
      noteLobbyRateLimitError(e);
      throw e;
    }
    clearLobbyCooldown();
    return {
      kind,
      entityId: resolved.server.entityId,
      resId: resolved.server.resId,
      name: resolved.server.name,
      hasPwd: resolved.server.hasPwd,
      playerCount: resolved.server.playerCount,
      capacity: resolved.server.maxCount,
      host: resolved.address.host,
      port: resolved.address.port,
    };
  }

  const resolved = await resolveRentalRoom(keyword, password, credOf(cred));
  return {
    kind,
    entityId: resolved.server.entityId,
    name: resolved.server.name,
    hasPwd: resolved.server.hasPwd,
    playerCount: resolved.server.playerCount,
    capacity: resolved.server.capacity,
    host: resolved.address.host,
    port: resolved.address.port,
  };
}

/** 打包/Android 可通过 FB_NETEASE_ENGINE 指定引擎可执行文件（Android 必须放 nativeLibraryDir） */
const FORCED_ENGINE = (process.env.FB_NETEASE_ENGINE || "").trim();

function hasNativeEngine(): boolean {
  if (FORCED_ENGINE) return fs.existsSync(FORCED_ENGINE);
  if (IS_WIN) return false;
  return fs.existsSync(path.join(NETEASE_NATIVE_DIR, "Program"));
}

/** 引擎目录：优先原生构建，其次 Windows 包 */
function engineDir(): string {
  return hasNativeEngine() ? NETEASE_NATIVE_DIR : NETEASE_CORE_DIR;
}

/** 桥配置跟着引擎目录走（两个引擎各有一份 token） */
function bridgeCfgPath(): string {
  return path.join(engineDir(), "scripts", "cubeloom_bridge", "cubeloom_bridge.json");
}

function engineExe(): string {
  if (FORCED_ENGINE) return FORCED_ENGINE;
  return hasNativeEngine()
    ? path.join(NETEASE_NATIVE_DIR, "Program")
    : path.join(NETEASE_CORE_DIR, "Program.exe");
}

/** 启动网易服务；账号模式返回额外信息（房间/地址） */
async function startNetease(body: any): Promise<{ ok: boolean; error?: string; mode?: string; room?: any }> {
  if (neteaseChild) return { ok: false, error: "网易版服务已在运行" };
  const requested = String(body?.mode ?? "").trim();
  const cfg = readAccountCfg();
  const keyword = String(body?.keyword ?? cfg.room ?? "").trim();
  const useAccount = requested === "account" || (requested !== "cfg" && !!x19Cred && !!keyword);

  if (!useAccount) {
    const r = spawnNetease();
    return r.ok ? { ok: true, mode: "cfg" } : r;
  }

  const kindHint = String(body?.roomKind ?? cfg.roomKind ?? "rental");
  if (kindHint !== "local") {
    try {
      await ensureCred();
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  if (!fs.existsSync(engineExe())) {
    return { ok: false, error: `找不到引擎：${engineExe()}（先运行 npm run setup:netease-bot）` };
  }
  if (!IS_WIN && !hasNativeEngine() && !wineBinary()) {
    return {
      ok: false,
      error: "Linux/macOS 上运行网易引擎需要 wine（sudo apt install wine / brew install --cask wine-stable），或改用 Windows",
    };
  }
  const bridgeCfg = readJsonFile(bridgeCfgPath()) || {};
  if (!String(bridgeCfg.token || "").trim()) {
    return { ok: false, error: "缺少事件桥 token：先运行 npm run setup:netease-bot 生成" };
  }
  let room: any;
  try {
    room = await withAuthRetry(() => resolveRoomForPanel(body));
  } catch (e: any) {
    return { ok: false, error: decorateAuthError(e).message };
  }
  const cred = requireCred();
  const serverKind =
    room.kind === "lobby" || room.kind === "local"
      ? "LobbyGame"
      : room.kind === "realms"
        ? "DomainGame"
        : "RentalGame";
  /**
   * 启动引擎用哪套账号。
   *
   * 联机大厅/本地联机走 PE 通道，所以 `--UserID/--MD5Token` 也必须是 PE 的 entity + token：
   * VQ 的 PE 模式就是这么做的（`MKeyService.PeLoginWithSauthAsync` 把 `Account` 整体换成
   * PE 账号，`LaunchProgram` 再从 `Account` 取 UserID/Token，并加 `--g79`）。
   * 租赁服/山头服仍用 PC 登录态（它们本来就是 x19 那套接口）。
   */
  const usePeForLaunch = (room.kind === "lobby" || room.kind === "local") && hasPeSession(credOf(cred));
  const launchCred = usePeForLaunch
    ? peCredential(credOf(cred))
    : { userId: cred.entityId, token: cred.token };
  /**
   * --NeteaseServerID 用什么 ID（VQ LaunchPage）：
   *   联机大厅 PE 账号 → 房间 entityId；PC 账号 → 房间 resId（专区物品 ID）。
   * 传错会进不去/进错服，所以按实际启动用的通道来取。
   */
  const engineServerId =
    room.kind === "lobby" && !usePeForLaunch
      ? String(room.resId || room.entityId)
      : String(room.entityId);
  let argv: string[];
  try {
    argv = [
      engineExe(),
      ...buildEngineArgs({
        userId: launchCred.userId,
        token: launchCred.token,
        entityId: engineServerId,
        serverKind,
        host: room.host,
        port: room.port,
        displayName: cfg.displayName || cred.name || "Cubeloom",
        pluginDir: path.join(engineDir(), "scripts"),
        engineVersion: cfg.engineVersion || undefined,
        patchVersion: cfg.patchVersion || undefined,
        extraArgs: cfg.protocol ? ["--protocol", cfg.protocol] : undefined,
      }),
    ];
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  if (room.kind === "local") {
    saveAccountCfg({
      localRoom: String(body?.localRoom ?? cfg.localRoom ?? keyword ?? "").trim(),
      localPassword: String(body?.localPassword ?? cfg.localPassword ?? body?.roomPassword ?? ""),
    });
  } else if (room.kind !== "realms") {
    saveAccountCfg({ room: keyword, roomPassword: String(body?.roomPassword ?? cfg.roomPassword ?? "") });
  }
  const fullArgv = engineArgvWithWine(argv);
  if (!fullArgv) return { ok: false, error: "找不到 wine，无法在非 Windows 平台启动引擎" };
  const kindLabel =
    room.kind === "local" ? "本地联机" : room.kind === "lobby" ? "联机大厅" : room.kind === "realms" ? "山头服" : "租赁服";
  log(`账号模式启动：${kindLabel} ${room.name}（${room.entityId}）→ ${room.host}:${room.port}`);
  log(`引擎参数：${redactEngineArgs(fullArgv.slice(IS_WIN ? 1 : 2)).join(" ")}`);
  const r = spawnNetease(fullArgv);
  return r.ok ? { ok: true, mode: "account", room } : r;
}

function neteaseEntry(): { cmd: string; args: string[] } | null {
  const packaged = (process.env.FB_NETEASE_ENTRY || "").trim();
  if (packaged && fs.existsSync(packaged)) return { cmd: process.execPath, args: [packaged] };
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(path.join(ROOT, "netease-service.ts")) && fs.existsSync(tsxCli)) {
    return { cmd: process.execPath, args: [tsxCli, "netease-service.ts"] };
  }
  return null;
}

function spawnNetease(botArgv?: string[]): { ok: boolean; error?: string } {
  if (neteaseChild) return { ok: false, error: "网易版服务已在运行" };

  if (process.env.FB_NETEASE_INPROCESS === "1") {
    try {
      const bridge = readJsonFile(bridgeCfgPath()) || {};
      process.env.FB_NETEASE_PORT = String(NETEASE_PORT);
      process.env.FB_NETEASE_HOST = "127.0.0.1";
      process.env.FB_NETEASE_SOCKET = "tcp://127.0.0.1:17999";
      process.env.FB_NETEASE_TOKEN = String(bridge.token || "");
      process.env.FB_LOG_DIR = LOG_DIR;
      if (botArgv?.length) process.env.FB_NETEASE_BOT_ARGV = JSON.stringify(botArgv);
      const entry = (process.env.FB_NETEASE_ENTRY || "").trim() || path.join(process.cwd(), "netease-service.cjs");
      if (!fs.existsSync(entry)) return { ok: false, error: `找不到 ${entry}` };
      const req = createRequire(path.join(ROOT, "noop.cjs"));
      const mod = req(entry);
      if (typeof mod?.startService === "function") mod.startService();
      neteaseInProcess = true;
      // 用当前进程占位，避免 UI 认为未启动；stop 时特殊处理
      neteaseChild = { pid: process.pid } as unknown as ChildProcess;
      neteaseStartedAt = Date.now();
      log("网易版服务已在本进程内启动（Android）");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `进程内启动失败：${e?.message ?? e}` };
    }
  }

  const entry = neteaseEntry();
  if (!entry) return { ok: false, error: "找不到 netease-service（开发模式需要 tsx，打包版需要 server/netease-service.cjs）" };
  const bridge = readJsonFile(bridgeCfgPath()) || {};
  const token = String(bridge.token || "");
  const botCmd = neteaseBotCommand();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FB_NETEASE_PORT: String(NETEASE_PORT),
    FB_NETEASE_HOST: "127.0.0.1",
    FB_NETEASE_SOCKET: "tcp://127.0.0.1:17999",
    FB_NETEASE_TOKEN: token,
    FB_LOG_DIR: LOG_DIR,
    // Program.exe 必须在本体目录里跑（python312 / scripts 都是相对路径）
    FB_NETEASE_BOT_CWD: engineDir(),
  };
  if (!IS_WIN) {
    env.WINEDEBUG = process.env.WINEDEBUG || "-all";
    // 避免首次运行弹出 Wine Mono/Gecko 安装框（引擎不需要 .NET/Gecko）
    env.WINEDLLOVERRIDES = process.env.WINEDLLOVERRIDES || "mscoree,mshtml=";
    if (process.env.WINEPREFIX) env.WINEPREFIX = process.env.WINEPREFIX;
  }
  delete env.FB_NETEASE_BOT_CMD;
  delete env.FB_NETEASE_BOT_ARGV;
  if (botArgv?.length) env.FB_NETEASE_BOT_ARGV = JSON.stringify(botArgv);
  else if (botCmd) env.FB_NETEASE_BOT_CMD = botCmd;
  const child = spawn(entry.cmd, entry.args, {
    cwd: ROOT,
    env,
    windowsHide: true,
    detached: !IS_WIN,
    stdio: ["ignore", "pipe", "pipe"],
  });
  neteaseChild = child;
  neteaseStartedAt = Date.now();
  log(`启动网易版服务（PID ${child.pid}${botArgv?.length ? "，托管机器人（账号模式）" : botCmd ? "，托管机器人" : ""}）`);
  child.stdout?.on("data", (d: Buffer) => pipeChild(d, false));
  child.stderr?.on("data", (d: Buffer) => pipeChild(d, true));
  child.on("exit", (code) => {
    log(`网易版服务已退出（code=${code}）`);
    neteaseChild = null;
  });
  return { ok: true };
}

function stopNetease(): boolean {
  if (neteaseInProcess) {
    try {
      const entry = (process.env.FB_NETEASE_ENTRY || "").trim() || path.join(process.cwd(), "netease-service.cjs");
      const req = createRequire(path.join(ROOT, "noop.cjs"));
      const mod = req(entry);
      mod?.stopService?.();
    } catch {}
    neteaseInProcess = false;
    neteaseChild = null;
    log("网易版服务已停止（进程内）");
    return true;
  }
  if (!neteaseChild?.pid) return false;
  const pid = neteaseChild.pid;
  log(`停止网易版服务（PID ${pid}）`);
  try {
    if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    try { neteaseChild.kill("SIGTERM"); } catch {}
  }
  neteaseChild = null;
  return true;
}

async function waitForNetease(timeoutMs = 15000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await neteaseFetch("/health", { method: "GET" }, 1500);
    if (r?.ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** ===== HTTP 工具 ===== */
function sendJson(res: ServerResponse, code: number, data: unknown) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req: IncomingMessage, limit = 1 << 20): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("上传内容过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e}`));
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 面板请求守卫：挡 CSRF 与 DNS rebinding。
 *
 * 面板可能被显式配置成对局域网开放（FB_ADMIN_HOST=0.0.0.0），所以 Host 白名单
 * 是"回环 + 本机网卡 IP 字面量 + localhost"；域名形式一律拒绝——那是 rebinding。
 * 写操作必须是 application/json；带 Origin 时必须与 Host 同源。
 */
const LOCAL_HOST_NAMES: Set<string> = (() => {
  const set = new Set<string>(["localhost", "::1", "0:0:0:0:0:0:0:1", "127.0.0.1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a?.address) set.add(a.address.toLowerCase());
    }
  }
  const configured = String(process.env.FB_ADMIN_HOST || "").trim().toLowerCase();
  if (configured && !/^\d+\.\d+\.\d+\.\d+$/.test(configured) && configured !== "::") set.add(configured);
  return set;
})();

/** 从 Host 头取出主机名：兼容 127.0.0.1:11452 / [::1]:11452 / host:port */
function hostNameOf(host: string): string {
  const raw = host.trim().toLowerCase();
  try {
    return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw.replace(/^\[|\]$/g, "");
  }
}

function isLocalHostName(name: string): boolean {
  const n = name.toLowerCase().replace(/%.*$/, "");
  if (LOCAL_HOST_NAMES.has(n)) return true;
  return /^127\./.test(n) || n.endsWith(".localhost");
}

function requestGuard(req: IncomingMessage): { status: number; error: string } | null {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return { status: 415, error: "接口只接受 application/json" };
    }
  }
  const host = String(req.headers.host || "").toLowerCase();
  const hostName = hostNameOf(host);
  if (host && !isLocalHostName(hostName)) {
    return { status: 403, error: "已拒绝非本机地址访问（域名访问被禁止）" };
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(String(origin)).host.toLowerCase();
    } catch {
      originHost = "-";
    }
    if (originHost !== host) return { status: 403, error: "已拒绝跨站请求" };
  }
  return null;
}

/** ===== 路由 ===== */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;

  try {
    const blocked = requestGuard(req);
    if (blocked) return sendJson(res, blocked.status, { ok: false, error: blocked.error });

    // 健康检查：桌面端用它判断「端口上跑的是不是 Cubeloom」，不走鉴权、不泄露信息
    if (p === "/api/ping") {
      return sendJson(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION, pid: process.pid, uptime: process.uptime() });
    }

    // ---- 登录校验（admin/auth.json 存在时启用；口令只存 scrypt 哈希） ----
    if (auth) {
      const authed = isValidSession(readCookie(req, "cq_session"));
      // 静态资源（logo / 图标）与登录页本身无需登录，否则登录页也加载不出图标
      const isPublic = p.startsWith("/assets/") || p === "/polish.css" || p === "/snowluma.css" || p === "/snowluma.js" || p === "/pixelart.js" || p === "/astrbot.css" || p === "/pixeltext.js" || p === "/favicon.ico";
      if (isPublic) {
        // 落到后面的静态资源处理
      } else if (req.method === "POST" && p === "/api/login") {
        const ip = clientIp(req);
        const left = loginLockLeft(ip);
        if (left > 0) {
          return sendJson(res, 429, {
            ok: false,
            error: `尝试次数过多，请 ${Math.ceil(left / 60000)} 分钟后再试`,
          });
        }
        const body = await readJson(req);
        const password = String(body.password ?? "");
        if (!verifyPassword(password, auth.passwordHash)) {
          recordLoginFail(ip);
          log(`[WARN] 管理页登录失败：${ip}`);
          return sendJson(res, 401, { ok: false, error: "密码错误" });
        }
        loginFails.delete(ip);
        const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS();
        res.setHeader(
          "set-cookie",
          sessionCookie(signSession(exp), SESSION_SECONDS(), isSecureCookieRequest(req))
        );
        log(`管理页登录成功：${ip}${isSecureCookieRequest(req) ? "（Secure Cookie）" : ""}`);
        return sendJson(res, 200, { ok: true });
      }

      if (!isPublic) {
        if (req.method === "POST" && p === "/api/logout") {
          res.setHeader("set-cookie", sessionCookie("", 0, isSecureCookieRequest(req)));
          log(`管理页退出登录：${clientIp(req)}`);
          return sendJson(res, 200, { ok: true });
        }

        if (!authed) {
          if (p.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "未登录" });
          if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/login")) {
            try {
              const page = await fs.promises.readFile(path.join(ADMIN_DIR, "login.html"));
              res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
              return res.end(page);
            } catch {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              return res.end("缺少 admin/login.html");
            }
          }
          res.writeHead(302, { location: "/" });
          return res.end();
        }

        // ---- 吊销所有会话（需已登录）：轮换 secret + epoch，当前 Cookie 立刻失效 ----
        if (req.method === "POST" && p === "/api/auth/revoke") {
          try {
            auth = rotateAuthFile(AUTH_FILE, auth);
            res.setHeader("set-cookie", sessionCookie("", 0, isSecureCookieRequest(req)));
            log(`[WARN] 管理页会话已全部吊销（epoch=${authEpoch(auth)}，操作者 ${clientIp(req)}）`);
            return sendJson(res, 200, {
              ok: true,
              epoch: authEpoch(auth),
              note: "所有会话（含当前）已失效，请用新口令重新登录",
            });
          } catch (e: any) {
            log(`[ERROR] 轮换 secret 失败：${e?.message ?? e}`);
            return sendJson(res, 500, { ok: false, error: `轮换 secret 失败：${e?.message ?? e}` });
          }
        }
      }
    }

    // ---- 静态页面 ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = await fs.promises.readFile(path.join(ADMIN_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && p === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && p === "/polish.css") {
      try {
        const css = await fs.promises.readFile(path.join(ADMIN_DIR, "polish.css"));
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
        return res.end(css);
      } catch {
        res.writeHead(404);
        return res.end("missing admin/polish.css");
      }
    }
    if (req.method === "GET" && (p === "/snowluma.css" || p === "/snowluma.js" || p === "/pixelart.js" || p === "/astrbot.css" || p === "/pixeltext.js")) {
      try {
        const name = p.slice(1);
        const buf = await fs.promises.readFile(path.join(ADMIN_DIR, name));
        res.writeHead(200, {
          "content-type": name.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(buf);
      } catch {
        res.writeHead(404);
        return res.end("missing " + p);
      }
    }
    if (req.method === "GET" && p.startsWith("/assets/")) {
      const rel = path.normalize(p.replace(/^\/+/, "")).replace(/^([.][.][\\/])+/, "");
      const file = path.join(ADMIN_DIR, rel);
      if (!file.startsWith(ADMIN_DIR)) {
        res.writeHead(403);
        return res.end();
      }
      try {
        const data = await fs.promises.readFile(file);
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    // ---- 状态 ----
    if (req.method === "GET" && p === "/api/status") {
      const ws = await wsStatus();
      return sendJson(res, 200, {
        app: APP_NAME,
        auth: !!auth,
        serverNow: Date.now(),
        web: {
          port: ADMIN_PORT,
          pid: process.pid,
          startedAt: WEB_STARTED_AT,
          uptime: Date.now() - WEB_STARTED_AT,
          ownsWs: !!wsChild || wsInProcess,
          hostname: SYS.hostname,
          platform: SYS.platform,
          nodeVersion: SYS.nodeVersion,
          localIps: SYS.localIps,
          publicIp: SYS.publicIp,
          cpus: SYS.cpus,
          memTotal: SYS.memTotal,
        },
        ws: ws
          ? { ...ws, owned: !!wsChild || wsInProcess, startedAt: wsStartedAt || ws.startedAt }
          : {
              running: false,
              port: WS_PORT,
              error: lastWsExit ? `WS 服务已退出（code=${lastWsExit.code}）` : "WS 服务未运行",
              owned: !!wsChild || wsInProcess,
            },
        config: {
          wsPort: WS_PORT,
          controlPort: CONTROL_PORT,
          adminPort: ADMIN_PORT,
          wsVersion: WS_VERSION,
          publicWsUrl: PUBLIC_WS_URL,
        },
      });
    }

    // ---- 执行代码 ----
    if (req.method === "POST" && p === "/api/command") {
      const body = await readJson(req);
      const code = String(body.code ?? "").trim();
      if (!code) return sendJson(res, 400, { ok: false, error: "code 不能为空" });
      const r = await controlFetch("/eval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法执行" });
      return sendJson(res, 200, r);
    }

    // ---- 像素画：像素矩阵 → 结构 ----
    if (req.method === "POST" && p === "/api/pixelart/prepare") {
      const body = await readJson(req, 64 << 20);
      const r = await controlFetch("/pixelart/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法生成像素画" });
      return sendJson(res, 200, r);
    }

    // ---- 结构导入（.mcstructure）----
    if (req.method === "POST" && p === "/api/structure/prepare") {
      const body = await readJson(req, 96 << 20);
      const name = String(body.name ?? "structure");
      const data = String(body.data ?? "");
      if (!data) return sendJson(res, 400, { ok: false, error: "缺少文件数据" });
      const r = await controlFetch(
        "/structure/prepare",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, data }) },
        60000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`结构已解析：${r.structure?.name}（${r.structure?.total} 方块）`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/build") {
      const body = await readJson(req);
      const offsetY = Number(body.offsetY ?? 0) || 0;
      const r = await controlFetch(
        "/structure/build",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offsetY }) },
        15000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始导入结构：${r.name}（${r.total} 方块 / ${r.commands} 条命令）`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/verify") {
      const body = await readJson(req);
      const deep = !!body.deep;
      const r = await controlFetch(
        "/structure/verify",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deep }) },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始完整性检查（${deep ? "深度" : "快速"}）`);
      return sendJson(res, 200, r);
    }
    if (req.method === "POST" && p === "/api/structure/rebuild") {
      const r = await controlFetch(
        "/structure/rebuild",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        15000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始补建未完成方块：${r.commands} 条命令 / ${r.blocks} 方块`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/cancel") {
      const r = await controlFetch(
        "/structure/cancel",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log("已取消结构导入");
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/repair") {
      const body = await readJson(req, 96 << 20);
      const name = String(body.name ?? "structure");
      const data = String(body.data ?? "");
      if (!data) return sendJson(res, 400, { ok: false, error: "缺少文件数据" });
      const r = await controlFetch(
        "/structure/repair",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, data }) },
        60000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) {
        log(`结构修补完成：${r.structure?.name}（${r.fixed ? r.issues.length + " 处修复" : "无需修复"}）`);
      }
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/clear") {
      const r = await controlFetch(
        "/structure/clear",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.removed) log(`已移除待生成的结构：${r.removed}`);
      return sendJson(res, 200, r);
    }

    // ---- 玩家信息（向游戏查询） ----
    if (req.method === "POST" && p === "/api/player") {
      const r = await controlFetch(
        "/player",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        6000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      return sendJson(res, 200, r);
    }

    // ---- 发送原生命令 ----
    if (req.method === "POST" && p === "/api/send") {      const body = await readJson(req);
      const command = String(body.command ?? "").trim();
      if (!command) return sendJson(res, 400, { ok: false, error: "command 不能为空" });
      const r = await controlFetch("/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法发送" });
      return sendJson(res, 200, r);
    }

    // ---- 设置默认方块 ----
    if (req.method === "POST" && p === "/api/setting") {
      const body = await readJson(req);
      const block = String(body.block ?? "").trim();
      if (!block) return sendJson(res, 400, { ok: false, error: "block 不能为空" });
      const r = await controlFetch("/block", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ block }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      return sendJson(res, 200, r);
    }

    // ---- WS 服务启停 ----
    if (req.method === "POST" && p === "/api/ws/action") {
      const body = await readJson(req);
      const action = String(body.action ?? "");
      const running = !!(await wsStatus());

      if (action === "start") {
        if (running) return sendJson(res, 200, { ok: false, error: "WS 服务已在运行" });
        spawnWs();
        const up = await waitForWs();
        return sendJson(res, 200, up ? { ok: true, running: true } : { ok: false, error: "WS 服务启动超时，请看日志" });
      }
      if (action === "stop") {
        if (!running && !wsChild) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
        if (!stopWs()) {
          return sendJson(res, 200, {
            ok: false,
            error: "这个 WS 服务不是网页管理端启动的，请用 stop.bat 或关闭它的窗口",
          });
        }
        await new Promise((r) => setTimeout(r, 500));
        return sendJson(res, 200, { ok: true, running: !!(await wsStatus()) });
      }
      if (action === "restart") {
        const stopped = stopWs();
        if (!stopped && running) {
          return sendJson(res, 200, {
            ok: false,
            error: "这个 WS 服务不是网页管理端启动的，无法重启（请用 stop.bat 后重新启动）",
          });
        }
        await new Promise((r) => setTimeout(r, 700));
        spawnWs();
        const up = await waitForWs();
        return sendJson(res, 200, up ? { ok: true, running: true } : { ok: false, error: "WS 服务重启超时，请看日志" });
      }
      return sendJson(res, 400, { ok: false, error: `未知 action: ${action}` });
    }

    // ---- 日志文件列表 ----
    // ---- 山头服：列表 / 邀请码加入 ----
    if (p === "/api/netease-service/realms" && req.method === "POST") {
      const body = await readJson(req);
      try {
        await ensureCred();
        const cred = requireCred();
        const action = String(body?.action ?? "list");
        if (action === "join") {
          const code = String(body?.code ?? "").trim();
          if (!code) return sendJson(res, 200, { ok: false, error: "请填写邀请码" });
          await joinRealmsByCode(code, credOf(cred));
        }
        const realms = await listRealms(credOf(cred));
        return sendJson(res, 200, { ok: true, realms });
      } catch (e: any) {
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    // ---- 局域网 / 手机访问开关（写 network.json，重启后生效）----
    if (p === "/api/admin/lan" && req.method === "GET") {
      const enabled = ADMIN_HOST === "0.0.0.0" || ADMIN_HOST === "::";
      return sendJson(res, 200, {
        ok: true,
        enabled,
        host: ADMIN_HOST,
        port: ADMIN_PORT,
        auth: !!auth,
        ips: SYS.localIps,
        file: ADMIN_NETWORK_FILE,
        note: enabled ? "" : "开启后需重启 Cubeloom 才生效",
      });
    }

    if (p === "/api/admin/lan" && req.method === "POST") {
      const ip = String(req.socket.remoteAddress || "");
      const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (!loopback) {
        return sendJson(res, 403, { ok: false, error: "只能在运行 Cubeloom 的那台电脑上开启/关闭局域网访问" });
      }
      const body = await readJson(req);
      const enabled = !!body.enabled;
      if (enabled) {
        const password = String(body.password ?? "");
        if (!auth && (password.length < 6 || password.length > 1024)) {
          return sendJson(res, 400, { ok: false, error: "开放局域网前必须设置面板口令（6–1024 位）" });
        }
        if (password) {
          if (password.length < 6 || password.length > 1024) {
            return sendJson(res, 400, { ok: false, error: "口令长度需要 6–1024 位" });
          }
          const cfg: AuthConfig = {
            passwordHash: hashPassword(password),
            secret: crypto.randomBytes(32).toString("base64"),
            sessionHours: 12,
            epoch: authEpoch(auth) + 1,
          };
          writeFileAtomic(AUTH_FILE, JSON.stringify(cfg, null, 2) + "\n");
          auth = cfg;
          log(`[WARN] 面板口令已更新（epoch=${authEpoch(cfg)}），旧会话全部失效`);
        }
        writeFileAtomic(ADMIN_NETWORK_FILE, JSON.stringify({ host: "0.0.0.0" }, null, 2) + "\n");
        const url = SYS.localIps[0] ? `http://${SYS.localIps[0]}:${ADMIN_PORT}/` : "";
        log(`[WARN] 已开启局域网访问（重启后绑定 0.0.0.0:${ADMIN_PORT}）`);
        return sendJson(res, 200, {
          ok: true,
          enabled: true,
          url,
          restart: true,
          note: "重启 Cubeloom 后生效；手机 APK 用「连接电脑/服务器」填这个地址",
        });
      }
      writeFileAtomic(ADMIN_NETWORK_FILE, JSON.stringify({ host: "127.0.0.1" }, null, 2) + "\n");
      log("已关闭局域网访问（重启后只绑定 127.0.0.1）");
      return sendJson(res, 200, { ok: true, enabled: false, restart: true, note: "重启 Cubeloom 后生效" });
    }

    // ---- 登录态：保存 / 导出 / 导入 / 刷新 ----
    if (p === "/api/netease-service/session" && req.method === "GET") {
      const saved = readSessionFile();
      return sendJson(res, 200, {
        ok: true,
        saved: saved ? { entityId: saved.entityId, name: saved.name, savedAt: saved.savedAt } : null,
        current: loginSnapshot(),
      });
    }

    if (p === "/api/netease-service/session/export" && req.method === "GET") {
      if (!x19Cred) return sendJson(res, 200, { ok: false, error: "当前没有登录态可导出" });
      return sendJson(res, 200, {
        ok: true,
        session: {
          v: 2,
          entity_id: x19Cred.entityId,
          token: x19Cred.token,
          pe_entity_id: x19Cred.peEntityId || "",
          pe_token: x19Cred.peToken || "",
          name: x19Cred.name,
          saved_at: Date.now(),
        },
      });
    }

    if (p === "/api/netease-service/session/import" && req.method === "POST") {
      const body = await readJson(req);
      const raw = body?.session ?? body;
      const entityId = String(raw?.entity_id ?? raw?.entityId ?? "").trim();
      const token = String(raw?.token ?? "").trim();
      if (!/^\d+$/.test(entityId) || token.length < 8) {
        return sendJson(res, 200, { ok: false, error: "登录态格式不对：需要 entity_id（数字）和 token" });
      }
      const prev = x19Cred;
      const cand: X19Cred = {
        entityId,
        token,
        name: String(raw?.name ?? ""),
        peEntityId: String(raw?.pe_entity_id ?? raw?.peEntityId ?? ""),
        peToken: String(raw?.pe_token ?? raw?.peToken ?? ""),
        at: Date.now(),
        expiresAt: 0,
      };
      x19Cred = cand;
      // 导入的登录态不带 sauth：清掉本机旧账号的 sauth，避免拿它去换到别的账号头上
      clearSauthFile();
      const ok = await refreshCred(cand);
      if (!ok) {
        x19Cred = prev;
        return sendJson(res, 200, { ok: false, error: "导入的登录态已失效（token 过期或被吊销），请重新登录" });
      }
      return sendJson(res, 200, { ok: true, login: loginSnapshot() });
    }

    if (p === "/api/netease-service/session/clear" && req.method === "POST") {
      clearSessionFile();
      return sendJson(res, 200, { ok: true, login: loginSnapshot() });
    }

    if (p === "/api/netease-service/session/refresh" && req.method === "POST") {
      if (!x19Cred) return sendJson(res, 200, { ok: false, error: "当前没有登录态" });
      const ok = await refreshCred(x19Cred);
      return sendJson(res, 200, ok ? { ok: true, login: loginSnapshot() } : { ok: false, error: "刷新失败，请重新登录" });
    }

    // 单独换一次 PE 通道 token（用登录时存下的 sauth，不需要再输密码）
    if (p === "/api/netease-service/session/pe" && req.method === "POST") {
      if (!x19Cred) return sendJson(res, 200, { ok: false, error: "当前没有登录态" });
      if (!readSauthFile().sauth) {
        return sendJson(res, 200, {
          ok: false,
          error: "本机没有保存 sauth（旧版本登录的登录态），请重新用账号密码登录一次，之后就能单独刷新 PE 通道",
        });
      }
      const before = !!x19Cred && hasPeSession(credOf(x19Cred));
      const ok = await refreshCredsWithSauth("面板手动刷新 PE/登录态");
      const ready = !!x19Cred && hasPeSession(credOf(x19Cred));
      if (ready) return sendJson(res, 200, { ok: true, login: loginSnapshot() });
      const left = Math.max(1, Math.ceil(authCooldownLeft() / 60_000));
      return sendJson(res, 200, {
        ok: false,
        error: ok
          ? `x19 登录态已刷新，但 PE 通道这次没拿到（网易登录频控：操作过于频繁）${left > 0 ? `，建议 ${left} 分钟后再点` : ""}`
          : before
            ? "PE 通道刷新失败，稍后再试；x19 登录态仍可用"
            : "PE 通道认证失败，请重新登录一次",
        login: loginSnapshot(),
      });
    }

    // ---- 网易版：账号登录 / 房间解析（必须在反代之前）----
    if (p === "/api/netease-service/account" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        config: readAccountCfg(),
        login: loginSnapshot(),
        engine: { installed: fs.existsSync(engineExe()), exe: engineExe() },
        env: engineEnvSnapshot(),
        canStart: !!neteaseEntry(),
      });
    }

    if (p === "/api/netease-service/account" && req.method === "POST") {
      const body = await readJson(req);
      const patch: Partial<AccountCfg> = {};
      if (typeof body.account === "string") patch.account = body.account.trim();
      if (typeof body.room === "string") patch.room = body.room.trim();
      if (typeof body.roomPassword === "string") patch.roomPassword = body.roomPassword;
      if (["rental", "lobby", "realms", "local"].includes(String(body.roomKind))) patch.roomKind = body.roomKind;
      if (typeof body.localRoom === "string") patch.localRoom = body.localRoom.trim();
      if (typeof body.localPassword === "string") patch.localPassword = body.localPassword;
      if (typeof body.lobbyVersion === "string") patch.lobbyVersion = body.lobbyVersion.trim();
      if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
      if (typeof body.engineVersion === "string") patch.engineVersion = body.engineVersion.trim();
      if (typeof body.patchVersion === "string") patch.patchVersion = body.patchVersion.trim();
      if (typeof body.protocol === "string") patch.protocol = body.protocol.trim();
      const cfg = saveAccountCfg(patch);
      log("账号配置已保存（不含密码）");
      return sendJson(res, 200, { ok: true, config: cfg });
    }

    if (p === "/api/netease-service/login" && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, startX19Login(body));
    }

    if (p === "/api/netease-service/login" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, login: loginSnapshot() });
    }

    // ---- 4399 渠道登录 / Cookie 登录 ----
    /**
     * 4399 登录：
     *   phase=captcha → 只拿验证码图片（顺便告诉前端 captchaId）
     *   其它          → 用账号密码（可带 captchaId/captchaCode）换 sauth，再走 x19 助手
     */
    if (p === "/api/netease-service/login4399" && req.method === "POST") {
      const body = await readJson(req);
      const username = String(body?.username ?? "").trim();
      const password = String(body?.password ?? "");
      if (!username) return sendJson(res, 200, { ok: false, error: "请填写 4399 账号" });
      try {
        if (String(body?.phase ?? "") === "captcha") {
          const c = await fetch4399Captcha(username);
          return sendJson(res, 200, c ? { ok: true, needCaptcha: c } : { ok: true, needCaptcha: null });
        }
        if (!password) return sendJson(res, 200, { ok: false, error: "请填写 4399 密码" });
        let sauth;
        try {
          sauth = await login4399WithPassword({
            username,
            password,
            captchaId: String(body?.captchaId ?? ""),
            captchaCode: String(body?.captchaCode ?? ""),
          });
        } catch (e: any) {
          // 需要验证码：顺手把图片取回来，前端直接显示
          if (/验证码|captcha/i.test(String(e?.message ?? e))) {
            const c = await fetch4399Captcha(username);
            if (c) {
              return sendJson(res, 200, {
                ok: false,
                error: "4399 要求输入验证码",
                needCaptcha: c,
              });
            }
          }
          throw e;
        }
        const r = await finishLoginWithSauth(wrapSauth(sauth), "4399");
        return sendJson(res, 200, { ...r, sauth });
      } catch (e: any) {
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    /**
     * Cookie 登录：
     *   · `Uauth=...; Puser=...` → 4399 渠道 cookie，先换 sauth
     *   · `{"sauth_json":...}` / 裸 sauth JSON → 网易登录态直接换 token
     */
    if (p === "/api/netease-service/login-cookie" && req.method === "POST") {
      const body = await readJson(req);
      const raw = String(body?.cookie ?? "").trim();
      const kind = detectLoginInput(raw);
      if (kind === "empty") return sendJson(res, 200, { ok: false, error: "请粘贴 cookie 或 sauth JSON" });
      if (kind === "unknown") {
        return sendJson(res, 200, {
          ok: false,
          error: "认不出这段内容：4399 cookie 需要包含 Uauth / Puser；网易登录态需要是 sauth JSON",
        });
      }
      try {
        let sauthText = raw;
        let source = "网易 sauth";
        if (kind === "cookie4399") {
          const sauth = await login4399WithCookie(raw);
          sauthText = wrapSauth(sauth);
          source = "4399 cookie";
        }
        const r = await finishLoginWithSauth(sauthText, source);
        return sendJson(res, 200, r);
      } catch (e: any) {
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    if (p === "/api/netease-service/login/input" && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, submitX19Login(body));
    }

    if (p === "/api/netease-service/login/cancel" && req.method === "POST") {
      return sendJson(res, 200, cancelX19Login());
    }

    if (p === "/api/netease-service/logout" && req.method === "POST") {
      return sendJson(res, 200, logoutX19());
    }

    /**
     * 手动领取联机专区组件。
     *
     * 只有用户点「领取组件」才会走到这里——进房流程**不会**自动领取（这是产品决定，
     * 领错/领重复由用户自己判断）。一次点击最多产生一个购买请求：
     *   1) 先查 item-channel 的 buy_state（已拥有就不下单，购买接口有限流）；
     *   2) 购买走 PE 商城；PE token 失效（「另一处登录」）时刷新一次再重试；
     *   3) 领完可选地自动重试一次进房，成功则把 host:port 一起返回，但不会再发购买请求。
     */
    if (p === "/api/netease-service/purchase" && req.method === "POST") {
      const body = await readJson(req);
      const itemId = String(body?.itemId ?? "").trim();
      if (!itemId) return sendJson(res, 200, { ok: false, error: "请填写组件 ID" });
      try {
        await ensureCred();
        // PE 通道保鲜：保证第一次购买请求不是死在过期 token 上（那会白烧一次限流额度）
        await ensurePeCred();

        // 联机专区是 PE 商城商品：PE 不可用时只能走 PC（一定「目标找不到」），
        // 所以先尽力把 PE 通道刷出来，失败时在报错里说清楚原因。
        if (!hasPeSession(credOf(requireCred()))) {
          await refreshCredsWithSauth("领取联机专区组件需要 PE 通道");
        }

        let alreadyOwned = false;
        try {
          const owned = await withAuthRetry(() => fetchZoneOwnership([itemId], credOf(requireCred())));
          alreadyOwned = owned.get(itemId) === true;
        } catch (e: any) {
          if (isPeSessionStaleError(e)) throw e;
          // 查不到归属不影响领取，继续走购买
          log(`查询组件归属失败（继续领取）：${String(e?.message ?? e)}`);
        }

        let outcome: PurchaseOutcome | null = null;
        if (alreadyOwned) {
          log(`组件 ${itemId} 本账号已经拥有，跳过购买请求`);
        } else {
          // withAuthRetry 的重试发生在「登录态失效」这一步——那时服务端没有产生订单，
          // 所以重试不会重复下单
          outcome = await withAuthRetry(() => purchaseComponentManually(itemId, credOf(requireCred())));
          alreadyOwned = alreadyOwned || outcome.alreadyOwned;
          log(
            `已手动领取组件：${itemId}（${outcome.channel === "pe" ? "PE 商城" : "PC 商城"}` +
              `${outcome.alreadyOwned ? "，之前已拥有" : ""}）`
          );
        }
        if (String(body?.remember ?? "") !== "no") saveAccountCfg({ componentId: itemId });

        // 领完自动重试一次进房（默认开，retryEnter:false 可关）：只重试一次，不再发购买请求
        const retry = body?.retryEnter === false ? null : await retryEnterAfterClaim();
        return sendJson(res, 200, {
          ok: true,
          itemId,
          channel: outcome?.channel || (alreadyOwned ? "pe" : ""),
          alreadyOwned,
          retry,
        });
      } catch (e: any) {
        const msg = decorateAuthError(e).message;
        // 没拿到 PE 通道时补一句原因（否则「PC 商城目标找不到」会把人带偏）
        const needPe = !!x19Cred && !hasPeSession(credOf(x19Cred)) && !/PE 通道/.test(msg);
        const left = Math.max(0, Math.ceil(authCooldownLeft() / 60_000));
        const why = lastAuthError || "PE 认证没有返回 token";
        return sendJson(res, 200, {
          ok: false,
          error: needPe
            ? `${msg}（联机专区是 PE 商城商品，本次 PE 通道不可用：${why}` +
              `${left > 0 ? `；建议 ${left} 分钟后再试` : "；可以再点一次「PE 通道登录」"}）`
            : msg,
        });
      }
    }

    // 只解析房间地址，不启动引擎：面板上的「测试房间」用它，排查 501/地址问题很省事
    if (p === "/api/netease-service/probe" && req.method === "POST") {
      const body = await readJson(req);
      try {
        await ensureCred();
        const room = await withAuthRetry(() => resolveRoomForPanel(body));
        clearLobbyCooldown();
        return sendJson(res, 200, { ok: true, room, login: loginSnapshot() });
      } catch (e: any) {
        noteLobbyRateLimitError(e);
        const err = decorateAuthError(e);
        return sendJson(res, 200, { ok: false, error: err.message, login: loginSnapshot() });
      }
    }

    if (p === "/api/netease-service/rooms" && req.method === "POST") {
      const body = await readJson(req);
      try {
        await ensureCred();
        const cred = requireCred();
        const keyword = String(body?.keyword ?? "").trim();
        if (!keyword) return sendJson(res, 200, { ok: false, error: "请填写房间号或房间名" });
        const kind = String(body?.roomKind ?? "") === "lobby" ? "lobby" : "rental";
        if (kind === "lobby") {
          const cfg = readAccountCfg();
          // 支持 `res:<组件ID>` / `组件:<组件ID>`：按联机专区组件列出房间（不知道房间号时用）
          const resMatch = /^(?:res|组件)\s*[:：]\s*(\d{6,})$/i.exec(keyword);
          const list = await withAuthRetry(() =>
            resMatch
              ? searchLobbyRoomsByResId(resMatch[1], credOf(cred), {
                  version: String(body?.lobbyVersion ?? cfg.lobbyVersion ?? "") || undefined,
                })
              : searchLobbyRooms(keyword, credOf(cred), {
                  version: String(body?.lobbyVersion ?? cfg.lobbyVersion ?? "") || undefined,
                })
          );
          return sendJson(res, 200, {
            ok: true,
            rooms: list.map((r) => ({
              entityId: r.entityId,
              name: r.name,
              hasPwd: r.hasPwd,
              playerCount: r.playerCount,
              capacity: r.maxCount,
              lobbyManifestVersion: r.lobbyManifestVersion,
              resId: r.resId,
            })),
          });
        }
        const rooms = await searchRentalServers(keyword, credOf(cred));
        return sendJson(res, 200, { ok: true, rooms });
      } catch (e: any) {
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    if (p === "/api/netease-service/room" && req.method === "POST") {
      const body = await readJson(req);
      try {
        return sendJson(res, 200, { ok: true, room: await resolveRoomForPanel(body) });
      } catch (e: any) {
        const message = e?.message ?? String(e);
        log(`房间解析失败：${message}`);
        return sendJson(res, 200, { ok: false, error: message });
      }
    }

    // ---- 网易版：账号/房间配置 + 服务启停（必须在反代之前）----
    if (p === "/api/netease-service/config" && req.method === "GET") {
      const cfg = readJsonFile(NETEASE_MC_CFG);
      const bridge = readJsonFile(bridgeCfgPath()) || {};
      const template = {
        room_info: { ip: "", port: 19132 },
        player_info: { user_id: "", user_name: "", operator_name: "", token: "" },
        misc: {
          auth_server_url: "",
          launcher_port: 0,
          engine_version: "",
          patch_version: "",
          netease_sid: "",
          g79: false,
          client_data_path: "",
        },
        skin_info: { skin: "", model: "" },
      };
      return sendJson(res, 200, {
        ok: true,
        botDir: NETEASE_BOT_DIR,
        coreDir: engineDir(),
        installed: fs.existsSync(engineExe()),
        hasCfg: !!cfg,
        cfg: cfg || template,
        template: !cfg,
        bridgeToken: String(bridge.token || ""),
        botCmd: neteaseBotCommand(),
        canStart: !!neteaseEntry(),
      });
    }

    if (p === "/api/netease-service/config" && req.method === "POST") {
      const body = await readJson(req, 4 << 20);
      const cfg = body.cfg;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return sendJson(res, 400, { ok: false, error: "cfg 必须是一个 JSON 对象" });
      }
      try {
        writeFileAtomic(NETEASE_MC_CFG, JSON.stringify(cfg, null, 2) + "\n");
        log(`网易版配置已保存：${path.relative(ROOT, NETEASE_MC_CFG)}`);
        return sendJson(res, 200, { ok: true, file: NETEASE_MC_CFG });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: `写入 mc.cfg 失败：${e?.message ?? e}` });
      }
    }

    if (p === "/api/netease-service/state" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        running: !!neteaseChild,
        pid: neteaseChild?.pid ?? null,
        startedAt: neteaseStartedAt || null,
        botDir: NETEASE_BOT_DIR,
        installed: fs.existsSync(engineExe()),
        hasCfg: fs.existsSync(NETEASE_MC_CFG),
        botCmd: neteaseBotCommand(),
        canStart: !!neteaseEntry(),
        login: loginSnapshot(),
        env: engineEnvSnapshot(),
        engineInstalled: fs.existsSync(engineExe()),
      });
    }

    if (p === "/api/netease-service/action" && req.method === "POST") {
      const body = await readJson(req);
      const action = String(body.action || "");
      if (action === "start") {
        if (neteaseChild) return sendJson(res, 200, { ok: false, error: "网易版服务已在运行" });
        const r = await startNetease(body);
        if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error });
        const up = await waitForNetease();
        return sendJson(
          res,
          200,
          up
            ? { ok: true, running: true, mode: r.mode, room: r.room }
            : { ok: false, error: "网易版服务 15 秒内没有就绪，请看日志", mode: r.mode, room: r.room }
        );
      }
      if (action === "stop") {
        if (!neteaseChild) return sendJson(res, 200, { ok: false, error: "网易版服务未运行" });
        stopNetease();
        await new Promise((r) => setTimeout(r, 400));
        return sendJson(res, 200, { ok: true, running: false });
      }
      if (action === "restart") {
        stopNetease();
        await new Promise((r) => setTimeout(r, 500));
        const r = await startNetease(body);
        if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error });
        const up = await waitForNetease();
        return sendJson(
          res,
          200,
          up
            ? { ok: true, running: true, mode: r.mode, room: r.room }
            : { ok: false, error: "重启后 15 秒内没有就绪，请看日志", mode: r.mode, room: r.room }
        );
      }
      return sendJson(res, 400, { ok: false, error: `未知 action: ${action}` });
    }

    // ---- 网易版（机器人事件桥）反代 ----
    if (p.startsWith("/api/netease/")) {
      const sub = p.slice("/api/netease".length);
      if (req.method === "POST") {
        const body = await readJson(req, 96 << 20);
        const r = await neteaseFetch(sub, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r) return sendJson(res, 200, { ok: false, error: "网易版服务未启动（netease-service）" });
        return sendJson(res, 200, r);
      }
      const r = await neteaseFetch(sub, { method: "GET" }, 15000);
      if (!r) return sendJson(res, 200, { ok: false, error: "网易版服务未启动（netease-service）" });
      return sendJson(res, 200, r);
    }

    if (req.method === "GET" && p === "/api/logs/files") {
      return sendJson(res, 200, { ok: true, dir: LOG_DIR, files: listLogFiles() });
    }

    // ---- 日志文件内容（末尾 N 行） ----
    if (req.method === "GET" && p === "/api/logs/view") {
      const file = url.searchParams.get("file") ?? "ws.log";
      const lines = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 400), 1), 3000);
      if (file === "all" || !listLogFiles().some((f) => f.name === file)) {
        return sendJson(res, 200, { ok: true, file: "all", lines: listLogFiles().flatMap((f) => readTailLines(f.name, lines)) });
      }
      return sendJson(res, 200, { ok: true, file, lines: readTailLines(file, lines) });
    }

    // ---- 实时日志（直接跟随日志文件） ----
    if (req.method === "GET" && p === "/api/logs/stream") {
      const source = url.searchParams.get("file") ?? "all";
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");

      // 先补发最近的内容，再从文件末尾继续跟随
      const files = listLogFiles().map((f) => f.name).filter((f) => source === "all" || f === source);
      for (const file of files) {
        for (const text of readTailLines(file, 200)) {
          res.write(`data: ${JSON.stringify({ file, text })}\n\n`);
        }
      }
      const client: SseClient = { res, source, offsets: new Map() };
      for (const file of files) {
        try {
          const st = fs.statSync(path.join(LOG_DIR, file));
          client.offsets.set(file, { size: st.size, partial: "" });
        } catch {}
      }
      sseClients.add(client);

      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {}
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(client);
      });
      return;
    }

    // ---- 下载日志文件 ----
    if (req.method === "GET" && p === "/api/logs/download") {
      const file = url.searchParams.get("file") ?? "all";
      if (file === "all") {
        const lines = listLogFiles().flatMap((f) => readTailLines(f.name, 100000));
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${APP_NAME}-all-${Date.now()}.log"`,
        });
        return res.end(lines.join("\n"));
      }
      if (!listLogFiles().some((f) => f.name === file)) {
        return sendJson(res, 404, { ok: false, error: "日志文件不存在" });
      }
      const full = path.join(LOG_DIR, file);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${file}"`,
      });
      return fs.createReadStream(full).pipe(res);
    }

    // ---- 清空日志 ----
    if (req.method === "POST" && p === "/api/logs/clear") {
      const body = await readJson(req);
      const file = String(body.file ?? "all");
      const targets = file === "all" ? listLogFiles().map((f) => f.name) : [file];
      for (const name of targets) {
        if (!listLogFiles().some((f) => f.name === name)) continue;
        try {
          await fs.promises.writeFile(path.join(LOG_DIR, name), "");
        } catch {}
      }
      log(`日志已清空：${targets.join(", ")}`);
      return sendJson(res, 200, { ok: true, cleared: targets });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    log(`[ERROR] 请求处理失败：${e?.message ?? e}`);
    try {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    } catch {}
  }
});


/** ===== 终端 REPL（MCSManager 终端 / 直接运行时可用） ===== */
async function controlPost(pathname: string, body: any): Promise<any> {
  return controlFetch(
    pathname,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    8000
  );
}

function tailLines(file: string, count: number): string[] {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-count);
  } catch {
    return [];
  }
}

const REPL_HELP = [
  "  Cubeloom 终端命令：",
  "    help                 显示帮助",
  "    status               查看 WS 服务/游戏连接状态",
  "    player               读取游戏内玩家坐标与信息",
  "    say <文本>           以玩家身份在游戏里喊话",
  "    cmd <原版命令>       执行原版命令（可省略 /），如 cmd tp @s ~ ~10 ~",
  "    eval <JS 代码>       沙盒执行 JavaScript，如 eval 1+1、eval -pos()",
  "    start / stop / restart  启动 / 停止 / 重启 WS 服务",
  "    logs                 显示 WS 日志最后 20 行",
  "    exit                 退出并停止服务",
].join("\n");

function setupRepl() {
  // 打包运行时（Electron / 无终端）不需要 REPL
  if (process.env.FB_NO_REPL === "1") return;
  // MCSManager 等网关以管道方式提供 stdin，这里不限制 isTTY；读不到 stdin 时静默跳过
  let rl: readline.Interface;
  try {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "cq> " });
  } catch {
    return;
  }
  rl.on("close", () => {});
  const print = (text: string) => process.stdout.write(text + "\n");
  print("");
  print("  ===== Cubeloom 终端 =====（输入 help 查看命令）");
  try { rl.prompt(); } catch {}
  rl.on("line", async (line: string) => {
    const raw = line.trim();
    if (!raw) {
      try { rl.prompt(); } catch {}
      return;
    }
    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = raw.slice(parts[0].length).trim();
    try {
      if (cmd === "help" || cmd === "?") {
        print(REPL_HELP);
      } else if (cmd === "status") {
        const s = await wsStatus();
        if (!s) {
          print("WS 服务未运行");
        } else {
          print(`WS 服务：${s.running ? "运行中" : "已停止"} · 端口 ${s.port} · 会话 ${s.sessionCount ?? 0} 个`);
          if (s.active) print(`当前游戏：${s.active.address ?? "—"} · 加密 ${s.active.encrypted ? "是" : "否"}`);
          const st = s.stats || {};
          print(`统计：命令 ${st.commands ?? 0} · 方块 ${st.setblocks ?? 0} · 聊天 ${st.messages ?? 0} · 错误 ${st.errors ?? 0}`);
        }
      } else if (cmd === "player" || cmd === "pos") {
        const r = await controlPost("/player", {});
        if (r && r.ok && r.players && r.players.length) {
          const p = r.players[0];
          print(`玩家：${p.name ?? "—"} @ ${p.x ?? "?"}, ${p.y ?? "?"}, ${p.z ?? "?"}（维度 ${p.dimension ?? "?"}，朝向 ${p.yRot ?? "?"}）`);
        } else {
          print("读取失败：" + ((r && r.error) || "没有已连接的游戏"));
        }
      } else if (cmd === "say") {
        if (!arg) print("用法：say <文本>");
        else {
          const r = await controlPost("/send", { command: `say ${arg}` });
          print(r && r.ok ? "已发送" : "发送失败：" + ((r && r.error) || "未知错误"));
        }
      } else if (cmd === "cmd") {
        if (!arg) print("用法：cmd <原版命令>");
        else {
          const command = arg.startsWith("/") ? arg.slice(1) : arg;
          const r = await controlPost("/send", { command });
          print(r && r.ok ? `已发送：${command}` : "发送失败：" + ((r && r.error) || "没有已连接的游戏"));
        }
      } else if (cmd === "eval") {
        if (!arg) print("用法：eval <JS 代码>");
        else {
          const r = await controlPost("/eval", { code: arg });
          print(r && r.ok ? `结果：${r.result === undefined ? "Success" : r.result}` : "执行失败：" + ((r && r.error) || "未知错误"));
        }
      } else if (cmd === "start") {
        print(spawnWs() ? "已启动 WS 服务" : "WS 服务已在运行或启动失败");
      } else if (cmd === "stop") {
        print(stopWs() ? "已停止 WS 服务" : "WS 服务未运行");
      } else if (cmd === "restart") {
        stopWs();
        await new Promise((r) => setTimeout(r, 800));
        print(spawnWs() ? "已重启 WS 服务" : "重启失败");
      } else if (cmd === "logs") {
        const lines = tailLines(path.join(ROOT, "logs", "ws.log"), 20);
        print(lines.length ? lines.join("\n") : "（暂无日志）");
      } else if (cmd === "exit") {
        print("正在停止服务…");
        stopWs();
        setTimeout(() => process.exit(0), 600);
        return;
      } else if (raw.startsWith("/")) {
        const r = await controlPost("/send", { command: raw.slice(1) });
        print(r && r.ok ? "已发送" : "发送失败：" + ((r && r.error) || "没有已连接的游戏"));
      } else {
        print(`未知命令：${cmd}（输入 help 查看命令）`);
      }
    } catch (e: any) {
      print("错误：" + (e?.message ?? e));
    }
    try { rl.prompt(); } catch {}
  });
}

/**
 * 启动面板。
 * 认证判定放在 listen 之前：口径不对就打印原因并退非 0，绝不"带病开放"。
 */
function startServer() {
  const startup = loadAuthStartup(AUTH_FILE, ADMIN_HOST, ALLOW_NO_AUTH);
  if (startup.mode === "fatal") {
    for (const line of [`[${APP_NAME}] 启动中止：管理端认证配置不可用`, startup.message, ""]) {
      console.error(line);
      try {
        fs.appendFileSync(ADMIN_LOG, `[${isoUtc8()}] [admin] [FATAL] ${line}\n`);
      } catch {}
    }
    process.exit(1);
  }
  auth = startup.mode === "password" ? startup.config : null;
  if (startup.mode === "open") log(startup.message);
  installProcessHooks();
  restoreSavedSession();

  server.listen(ADMIN_PORT, ADMIN_HOST, async () => {
    log(`===== ${APP_NAME} 管理端启动 =====`);
    log(
      `网页管理页：http://${ADMIN_HOST === "0.0.0.0" ? "0.0.0.0" : ADMIN_HOST}:${ADMIN_PORT}` +
        (auth
          ? `（已启用密码登录 · epoch=${authEpoch(auth)} · Cookie 在 https/反代下自动加 Secure）`
          : "（未设置密码，本机开发模式）")
    );
    if (!auth && isLoopbackBindHost(ADMIN_HOST)) {
      log(`[提示] ${AUTH_FILE} 不存在 → 无口令模式；这是本机开发模式，面板只绑定回环地址 ${ADMIN_HOST}`);
    }
    refreshPublicIp().then(() => {
      if (SYS.publicIp) log(`公网 IP：${SYS.publicIp}（本机地址：${SYS.localIps.join("，") || "—"}）`);
    });
    setInterval(refreshPublicIp, 10 * 60 * 1000).unref?.();
    log(`WS 服务端口 ${WS_PORT}｜控制接口 ${CONTROL_PORT}｜协议版本 ${WS_VERSION}`);
    log(`日志目录：${LOG_DIR}`);
    const existing = await wsStatus();
    if (existing) {
      log("检测到已有 WS 服务在运行（外部启动），管理端仅做监控");
    } else {
      spawnWs();
    }
    log("游戏内输入：" + (PUBLIC_WS_URL ? `/connect ${PUBLIC_WS_URL}` : `/connect ws://127.0.0.1:${WS_PORT}`));
    if (process.env.FB_NO_OPEN !== "1") {
      setTimeout(() => {
        try {
          spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${ADMIN_PORT}`], {
            windowsHide: true,
            detached: true,
            stdio: "ignore",
          }).unref();
        } catch {}
      }, 800);
    }
  });
  setupRepl();
}

/** 只在"直接运行"（tsx admin-server.ts）时启动；被测试 import 时只导出纯函数 */
const IS_ENTRY = (() => {
  // 预编译成 CJS 后 import.meta.url 不存在，用显式开关判定入口
  if (process.env.FB_FORCE_ENTRY === "1") return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = typeof import.meta !== "undefined" ? import.meta.url : "";
    return !!self && self === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (IS_ENTRY) {
  process.on("uncaughtException", (e) => {
    log(`[ERROR] 未捕获异常：${e?.message ?? e}`);
  });
  startServer();
}
