/**
 * 网易账号 → 房间地址 → NTvector 启动参数。
 *
 * 这里只做三件确定性的事，全部可以离线单测：
 *   1) X19 动态签名（`user-token` 头）：算法来自 VQ 1.6.2 的 X19Crypt，
 *      核心是 md5(md5(token) + body + "0eGsBkhl" + path) 再做 6 位循环移位与异或；
 *   2) 租赁服查询：`/rental-server/query/search-by-name` → `/rental-server-world-enter/get`；
 *   3) 启动引擎：把 entity_id / token / 房间地址拼成 Program.exe 的命令行参数。
 *
 * 网易登录本身需要设备指纹和风控流程，放在 Go 助手（tools/x19login）里，
 * 见 src/netease-account.ts。本模块不碰密码。
 */
import { createHash } from "node:crypto";

/** 网易登录态：entity_id（界面上的 user_id）+ token */
export type X19Credential = {
  userId: string;
  token: string;
};

export type RentalServer = {
  entityId: string;
  name: string;
  hasPwd: boolean;
  playerCount: number;
  capacity: number;
  briefSummary: string;
};

export type RentalAddress = {
  host: string;
  port: string;
};

export type ResolvedRentalRoom = {
  server: RentalServer;
  address: RentalAddress;
};

export class X19ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "", status = 0) {
    super(message);
    this.name = "X19ApiError";
    this.code = code;
    this.status = status;
  }
}

const RENTAL_HOST = "https://g79mclobt.minecraft.cn";
const NETEASE_SALT = "0eGsBkhl";

export function md5Hex(input: string | Buffer): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * 引擎参数 `--MD5Token` 要的值：Base64(MD5(token))。
 * VQ：Md5HexToBase64(ComputeDynamicToken_LoginMD5(token))。
 */
export function md5TokenBase64(token: string): string {
  if (!token) return "";
  return createHash("md5").update(token, "utf8").digest("base64");
}

/**
 * X19 动态签名（`user-token` 请求头）。
 * 与 VQ.Services.X19Crypt.ComputeDynamicToken 及 NeteaseLogin/encrypt.go 等价。
 */
export function dynamicToken(path: string, body: string, token: string): string {
  // VQ: md5hex(token) + body + salt + path.TrimEnd('?')；
  // Go 版把 path 规范成「恰好一个前导 /」，对不以 / 开头的调用方更宽容，结果一致。
  const cleanPath = "/" + path.replace(/\?+$/, "").replace(/^\/+/, "");
  const seed = md5Hex(token) + body + NETEASE_SALT + cleanPath;
  const digestHex = md5Hex(seed);

  const bits: string[] = [];
  for (const byte of Buffer.from(digestHex, "utf8")) {
    bits.push(byte.toString(2).padStart(8, "0"));
  }
  const allBits = bits.join("");
  const rotated = allBits.slice(6) + allBits.slice(0, 6);

  const out = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      if (rotated[i * 8 + (7 - j)] === "1") b |= 1 << j;
    }
    // 与 VQ/Go 一致：异或的是「十六进制字符的 ASCII 码」，不是 nibble 数值
    out[i] = digestHex.charCodeAt(i) ^ b;
  }
  return out.toString("base64").replace(/\+/g, "m").replace(/\//g, "o") + "1";
}

type FetchLike = typeof fetch;

export type X19PostOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  host?: string;
};

/**
 * 带 `user-id` / `user-token` 的 JSON POST。
 * 返回已解析的 JSON；HTTP 非 2xx 或 `code != 0` 抛 X19ApiError。
 */
export async function x19Post<T = any>(
  path: string,
  body: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<T> {
  const host = (opts.host || RENTAL_HOST).replace(/\/+$/, "");
  const userId = String(cred.userId || "").trim();
  const token = String(cred.token || "");
  if (!userId || !token) throw new X19ApiError("缺少登录态（user_id / token）");

  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(host + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-id": userId,
      "user-token": dynamicToken(path, body, token),
    },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = text.trim().slice(0, 80).replace(/\s+/g, " ");
    throw new X19ApiError(
      `网易接口 ${path} 返回 HTTP ${res.status}${hint ? `：${hint}` : ""}`,
      String(res.status),
      res.status
    );
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new X19ApiError(`网易接口 ${path} 返回的不是 JSON：${text.slice(0, 120)}`, "bad-json", res.status);
  }
  const code = data?.code;
  if (code !== undefined && String(code) !== "0") {
    const message = String(data?.message || data?.msg || data?.errmsg || `code=${code}`);
    throw new X19ApiError(`网易接口 ${path} 失败：${message}`, String(code), res.status);
  }
  return data as T;
}

/** 房间号 / 房间名 → 候选租赁服（接口本身同时匹配 ID 与名称） */
export async function searchRentalServers(
  keyword: string,
  cred: X19Credential,
  opts: X19PostOptions & { offset?: number; length?: number } = {}
): Promise<RentalServer[]> {
  const name = String(keyword || "").trim();
  const body = JSON.stringify({ server_name: name, offset: opts.offset ?? 0, length: opts.length ?? 50 });
  const data = await x19Post<any>("/rental-server/query/search-by-name", body, cred, opts);
  const list: any[] = Array.isArray(data?.entities) ? data.entities : [];
  return list
    .map((item) => ({
      entityId: String(item?.entity_id ?? ""),
      name: String(item?.name ?? ""),
      hasPwd: String(item?.has_pwd ?? "") === "1" || item?.has_pwd === 1 || item?.has_pwd === true,
      playerCount: Number(item?.player_count ?? 0) || 0,
      capacity: Number(item?.capacity ?? 0) || 0,
      briefSummary: String(item?.brief_summary ?? ""),
    }))
    .filter((s) => !!s.entityId);
}

/** 房间号 + 房间密码 → mcserver_host / mcserver_port */
export async function resolveRentalAddress(
  serverId: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<RentalAddress> {
  const body = JSON.stringify({ server_id: String(serverId), pwd: String(password ?? "") });
  const data = await x19Post<any>("/rental-server-world-enter/get", body, cred, opts);
  const host = String(data?.entity?.mcserver_host ?? "").trim();
  const port = String(data?.entity?.mcserver_port ?? "").trim();
  if (!host || !port) throw new X19ApiError("网易没有返回房间地址（房间不存在、无权限或密码错误）");
  return { host, port };
}

/** 候选里挑一个：优先 entity_id 完全相等，其次唯一结果 */
export function pickRentalServer(list: RentalServer[], keyword: string): RentalServer {
  const key = String(keyword || "").trim();
  const exact = list.find((s) => s.entityId === key);
  if (exact) return exact;
  if (list.length === 1) return list[0];
  if (list.length === 0) throw new X19ApiError(`没找到房间「${key}」`);
  const names = list
    .slice(0, 8)
    .map((s) => `${s.name}（${s.entityId}）`)
    .join("、");
  throw new X19ApiError(`「${key}」匹配到 ${list.length} 个房间：${names}；请填完整房间号`);
}

/** 房间号/名称 + 密码 → 服务器 + 地址 */
export async function resolveRentalRoom(
  keyword: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<ResolvedRentalRoom> {
  const list = await searchRentalServers(keyword, cred, opts);
  const server = pickRentalServer(list, keyword);
  if (server.hasPwd && !password) {
    throw new X19ApiError(`房间「${server.name}」需要密码`);
  }
  const address = await resolveRentalAddress(server.entityId, password, cred, opts);
  return { server, address };
}

export type EngineLaunchOptions = {
  userId: string;
  token: string;
  entityId: string;
  /** RentalGame / LobbyGame / DomainGame */
  serverKind?: "RentalGame" | "LobbyGame" | "DomainGame";
  host: string;
  port: string | number;
  displayName: string;
  /** PE 通道默认开：`--g79` */
  g79?: boolean;
  engineVersion?: string;
  patchVersion?: string;
  pluginDir?: string;
  logger?: boolean;
  extraArgs?: string[];
};

export const DEFAULT_ENGINE_VERSION = "3.8.15.292807";
export const DEFAULT_PATCH_VERSION = "3.8.16.292826";
export const DEFAULT_AUTH_SERVER = "https://g79authobt.minecraft.cn";

/**
 * 拼 Program.exe 参数（顺序与 VQ 1.6.2 LaunchPage.LaunchProgram 一致）。
 * 返回不含 exe 本身的参数数组，交给 spawn 时不会经过 shell。
 */
export function buildEngineArgs(opts: EngineLaunchOptions): string[] {
  const host = String(opts.host || "").trim();
  const port = String(opts.port ?? "").trim();
  const userId = String(opts.userId || "").trim();
  if (!host || !port) throw new Error("缺少房间地址");
  if (!userId) throw new Error("缺少 user_id");

  const kind = opts.serverKind || "RentalGame";
  const displayName = String(opts.displayName || "").replace(/[\r\n]+/g, " ").trim() || "Cubeloom";
  const args: string[] = [
    "--EngineVersion", opts.engineVersion || DEFAULT_ENGINE_VERSION,
    "--PatchVersion", opts.patchVersion || DEFAULT_PATCH_VERSION,
    "--NeteaseServerID", `${opts.entityId}:${kind}`,
    "--AuthServerUrl", DEFAULT_AUTH_SERVER,
    "--ServerIP", host,
    "--ServerPort", port,
    "--DisplayName", displayName,
    "--UserID", userId,
    "--MD5Token", md5TokenBase64(opts.token),
  ];
  if (opts.g79 !== false) args.push("--g79");
  if (opts.pluginDir) args.push("--PluginDir", opts.pluginDir);
  if (opts.logger !== false) args.push("--logger");
  if (Array.isArray(opts.extraArgs)) {
    for (const a of opts.extraArgs) if (typeof a === "string" && a) args.push(a);
  }
  return args;
}

/** 给日志/面板显示用：token 只留长度，不泄露 */
export function redactEngineArgs(args: string[]): string[] {
  const out = args.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "--MD5Token") out[i + 1] = `***(${out[i + 1].length})`;
  }
  return out;
}
