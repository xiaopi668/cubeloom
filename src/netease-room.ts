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

/** 联机大厅走 apigateway；房间搜索仍走 mclobt */
const LOBBY_HOST = "https://g79apigatewayobt.minecraft.cn";
export const DEFAULT_LOBBY_VERSION = "1.21.130";

/** 网易当前版本（PE/PC）会随更新变化；缓存 10 分钟，失败/异常时回退到 DEFAULT_LOBBY_VERSION */
let peVersionCache: { version: string; at: number } | null = null;
const PE_VERSION_TTL = 10 * 60_000;

export async function currentPeVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  if (peVersionCache && Date.now() - peVersionCache.at < PE_VERSION_TTL) return peVersionCache.version;
  try {
    const res = await fetchImpl("https://www.vtbot.cn/status/MCVersion.json", {
      signal: AbortSignal.timeout(5000),
      headers: { "user-agent": "Cubeloom" },
    });
    if (res.ok) {
      const data: any = await res.json();
      const version = String(data?.pe ?? "").trim();
      if (/^\d+\.\d+\.\d+$/.test(version)) {
        peVersionCache = { version, at: Date.now() };
        return version;
      }
    }
  } catch {
    /* 回退 */
  }
  return DEFAULT_LOBBY_VERSION;
}

/** 测试用：清掉版本缓存 */
export function resetPeVersionCache(): void {
  peVersionCache = null;
}

export type LobbyRoom = {
  entityId: string;
  name: string;
  hasPwd: boolean;
  playerCount: number;
  maxCount: number;
  version: string;
  lobbyManifestVersion: string;
};

/** 联机大厅：按房间号/名称搜索 */
export async function searchLobbyRooms(
  keyword: string,
  cred: X19Credential,
  opts: X19PostOptions & { version?: string } = {}
): Promise<LobbyRoom[]> {
  const version = opts.version || (await currentPeVersion(opts.fetchImpl || fetch));
  const body = JSON.stringify({
    room_name: String(keyword || "").trim(),
    res_id: "",
    version,
    offset: 0,
    length: 50,
  });
  const data = await x19Post<any>("/online-lobby-room/query/search-by-name", body, cred, opts);
  const list: any[] = Array.isArray(data?.entities) ? data.entities : [];
  return list
    .map((item) => {
      const members = Array.isArray(item?.member_uids) ? item.member_uids : [];
      return {
        entityId: String(item?.entity_id ?? ""),
        name: String(item?.room_name ?? ""),
        hasPwd: Number(item?.password ?? 0) === 1 || item?.password === true,
        playerCount: members.length,
        maxCount: Number(item?.max_count ?? 0) || 0,
        version: String(item?.version ?? ""),
        lobbyManifestVersion: String(item?.lobby_manifest_version ?? ""),
      };
    })
    .filter((r) => !!r.entityId);
}

/** 联机大厅：进房 → 取服务器地址 → 退房（和 VQ 的顺序一致） */
export async function resolveLobbyAddress(
  room: LobbyRoom,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<RentalAddress> {
  const enterBody = JSON.stringify({
    room_id: room.entityId,
    password: String(password ?? ""),
    lobby_manifest_version: room.lobbyManifestVersion || "",
    check_visibilily: true,
  });
  await x19Post("/online-lobby-room-enter", enterBody, cred, { ...opts, host: LOBBY_HOST });

  let data: any;
  try {
    data = await x19Post<any>("/online-lobby-game-enter", "", cred, { ...opts, host: LOBBY_HOST });
  } finally {
    // 拿到地址后释放房间席位（VQ 也是这么做的），失败不影响进服
    const leaveBody = JSON.stringify({ room_id: room.entityId, team_quit: false });
    x19Post("/online-lobby-room-enter/leave-room", leaveBody, cred, { ...opts, host: LOBBY_HOST }).catch(() => {});
  }
  const host = String(data?.entity?.server_host ?? "").trim();
  const port = String(data?.entity?.server_port ?? "").trim();
  if (!host || !port) throw new X19ApiError("网易没有返回联机大厅地址（房间已满/密码错误/房间不存在）");
  return { host, port };
}

/** 联机大厅：搜索 + 选房 + 地址 */
export async function resolveLobbyRoom(
  keyword: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions & { version?: string } = {}
): Promise<{ server: LobbyRoom; address: RentalAddress }> {
  const list = await searchLobbyRooms(keyword, cred, opts);
  const key = String(keyword || "").trim();
  const exact = list.find((r) => r.entityId === key);
  const server = exact || (list.length === 1 ? list[0] : null);
  if (!server) {
    if (!list.length) throw new X19ApiError(`没找到联机大厅房间「${key}」`);
    const names = list.slice(0, 8).map((r) => `${r.name}（${r.entityId}）`).join("、");
    throw new X19ApiError(`「${key}」匹配到 ${list.length} 个联机大厅房间：${names}；请填完整房间号`);
  }
  if (server.hasPwd && !password) throw new X19ApiError(`联机大厅房间「${server.name}」需要密码`);
  const address = await resolveLobbyAddress(server, password, cred, opts);
  return { server, address };
}

export type RealmsServer = {
  sid: string;
  name: string;
  userId: string;
  userName: string;
  status: number;
};

/** 山头服：列出账号可见的服务器 */
export async function listRealms(cred: X19Credential, opts: X19PostOptions = {}): Promise<RealmsServer[]> {
  const data = await x19Post<any>("/domain-server/get-other-servers", "{}", cred, opts);
  const list: any[] = Array.isArray(data?.entities) ? data.entities : [];
  return list
    .map((item) => ({
      sid: String(item?.sid ?? ""),
      name: String(item?.name ?? ""),
      userId: String(item?.user_id ?? ""),
      userName: String(item?.user_name ?? ""),
      status: Number(item?.status ?? 0) || 0,
    }))
    .filter((r) => !!r.sid);
}

/** 山头服：邀请码加入 */
export async function joinRealmsByCode(code: string, cred: X19Credential, opts: X19PostOptions = {}): Promise<void> {
  const body = JSON.stringify({ code: String(code ?? "").trim() });
  await x19Post("/domain-server/join-server-with-invite-code", body, cred, opts);
}

/** 山头服：sid → 地址 */
export async function resolveRealmsAddress(
  sid: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<RentalAddress> {
  const body = JSON.stringify({ sid: String(sid ?? "").trim() });
  const data = await x19Post<any>("/domain-server/req-enter-domain-server", body, cred, opts);
  const host = String(data?.entity?.server_host ?? "").trim();
  const port = String(data?.entity?.server_port ?? "").trim();
  if (!host || !port) throw new X19ApiError("网易没有返回山头服地址（sid 不对或没有权限）");
  return { host, port };
}

/** 本地联机：解析 IP:端口（也接受 IPv6 / 只填端口时用默认主机） */
export function parseLocalEndpoint(input: { host?: string; port?: string | number; keyword?: string }): RentalAddress {
  let host = String(input.host ?? "").trim();
  let port = String(input.port ?? "").trim();
  const keyword = String(input.keyword ?? "").trim();
  if ((!host || !port) && keyword) {
    const m = keyword.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/) || keyword.match(/^([^:]+):(\d{1,5})$/);
    if (m) {
      host = m[1];
      port = m[2] || port;
    } else if (!host) {
      host = keyword;
    }
  }
  if (!host) throw new X19ApiError("请填写本地联机的主机地址（例如 192.168.1.5）");
  const p = Number(port || 19132);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new X19ApiError("端口需要在 1–65535 之间");
  return { host, port: String(p) };
}

export type EngineLaunchOptions = {
  userId: string;
  token: string;
  entityId: string;
  /** RentalGame / LobbyGame / DomainGame / LocalGame */
  serverKind?: "RentalGame" | "LobbyGame" | "DomainGame" | "LocalGame";
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
