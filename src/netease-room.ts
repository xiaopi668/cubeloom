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
import * as fs from "node:fs";
import * as path from "node:path";

/** 网易登录态：entity_id（界面上的 user_id）+ token */
export type X19Credential = {
  userId: string;
  token: string;
  /**
   * PE 通道登录态（基岩版）。
   *
   * g79 的 PE 接口（`/pe-purchase-item/`、`/pe-user-item-purchase`）只认 PE 通道的
   * entity_id + token，拿 PC 的 x19 token 去调只会回「参数错误」，所以要单独带一份。
   */
  peUserId?: string;
  peToken?: string;
};

/**
 * PE entity id 是否可用。
 *
 * `"0"` / 空都要当成「没有」：PE 认证失败时 Go 助手会回 `pe_entity_id: 0`，
 * 这种半套凭据配着 PE token 去打接口，只会得到「参数错误」或「另一处登录」。
 */
export function isValidPeUserId(peUserId: string | undefined): boolean {
  const v = String(peUserId ?? "").trim();
  return !!v && v !== "0" && /^\d+$/.test(v);
}

/** 这个凭据是不是一套可用的 PE 登录态（PE entity + PE token 都在） */
export function hasPeSession(cred: X19Credential): boolean {
  return !!String(cred.peToken || "").trim() && isValidPeUserId(cred.peUserId);
}

/** 取 PE 通道的登录态：没有 PE token（或 PE entity 无效）时退回 PC 的（老账号/未做 PE 认证） */
export function peCredential(cred: X19Credential): X19Credential {
  const token = String(cred.peToken || "").trim();
  if (!token || !isValidPeUserId(cred.peUserId)) return { userId: cred.userId, token: cred.token };
  return { userId: String(cred.peUserId).trim(), token };
}

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

/**
 * PE 通道 token 失效。
 *
 * 实测（2026-11 / 网易 g79）：`/pe-authentication` 每成功一次，同一账号之前拿到的 PE
 * token 立刻作废，再用旧 token 打 PE 接口就回「您的帐号在另一处登录」。这和「有人在你
 * 手机上开着游戏」是一模一样的报错，所以**不能**把它当成会话冲突去等冷却，必须刷新
 * 一次 PE 登录态再重试。VQ 每次启动都重做 PE 登录（MKeyService.PeLoginWithSauthAsync），
 * 正是为了绕开这一点。
 */
export const PE_SESSION_STALE = "pe-session-stale";
/** 商品不存在（网易 code=16「目标找不到」）：说明这个 ID 不是可领取的组件，换下一个候选 */
export const ITEM_NOT_FOUND = "item-not-found";
/** 商品已经拥有（网易 code=502「物品已经获得」）：视为成功，不再重复下单 */
export const ITEM_ALREADY_OWNED = "item-already-owned";

/** 这个错误是不是「PE 登录态过期」 */
export function isPeSessionStaleError(e: unknown): boolean {
  if (String((e as any)?.code ?? "") === PE_SESSION_STALE) return true;
  return /另一处登录|其他地方登录|另一地登录/.test(String((e as any)?.message ?? e));
}

/** 这个错误是不是「这个 ID 没有对应商品」 */
export function isItemNotFoundError(e: unknown): boolean {
  if (String((e as any)?.code ?? "") === ITEM_NOT_FOUND) return true;
  return /目标找不到|商品不存在|商品已下架|item.?not.?found/i.test(String((e as any)?.message ?? e));
}

/** 这个错误是不是「已经拥有」（内部 code / 网易 502 / 文案三种都认） */
export function isAlreadyOwnedError(e: unknown): boolean {
  const code = String((e as any)?.code ?? "");
  if (code === ITEM_ALREADY_OWNED || code === "502") return true;
  return /物品已经获得|已经拥有|已拥有/.test(String((e as any)?.message ?? e));
}

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
  /** 这些业务 code 不抛错，交给调用方处理（例如进房 501 = 组件未购买） */
  allowCodes?: string[];
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
  if (code !== undefined && String(code) !== "0" && !opts.allowCodes?.includes(String(code))) {
    const message = String(data?.message || data?.msg || data?.errmsg || `code=${code}`);
    throw new X19ApiError(`网易接口 ${path} 失败：${message}`, String(code), res.status);
  }
  return data as T;
}

/**
 * 按 **联机专区组件 ID（res_id）** 列出房间。
 *
 * 协议来源：攻击器 Crow-Brother-Ads 的 `Attack/Program.cs`：
 *   POST {g79apigateway}/online-lobby-room/query/list-room-by-res-id
 *   {"lobby_manifest_version":"","length":10000,"version":<pe 版本>,"with_friend":true,"offset":0,"res_id":"<id>"}
 * 拿到的是「绑了这个专区/组件的所有房间」，适合已知组件 ID 但不知道房间号时用。
 */
export async function searchLobbyRoomsByResId(
  resId: string,
  cred: X19Credential,
  opts: X19PostOptions & { version?: string; length?: number } = {}
): Promise<LobbyRoom[]> {
  const id = String(resId || "").trim();
  if (!id) throw new X19ApiError("请填写联机专区组件 ID（res_id）");
  const version = opts.version || (await currentPeVersion(opts.fetchImpl || fetch));
  const body = JSON.stringify({
    lobby_manifest_version: "",
    length: Math.max(1, Math.min(10000, Math.trunc(opts.length ?? 200))),
    version,
    with_friend: true,
    offset: 0,
    res_id: id,
  });
  const data = await x19Post<any>("/online-lobby-room/query/list-room-by-res-id", body, cred, {
    ...opts,
    host: LOBBY_HOST,
  });
  return parseLobbyRooms(data);
}

/** 把大厅房列表响应转成 LobbyRoom[]（搜索 / 按 res_id 列表共用） */
function parseLobbyRooms(data: any): LobbyRoom[] {
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
        resId: String(item?.res_id ?? ""),
      };
    })
    .filter((r) => !!r.entityId);
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
/** 网易“快速匹配过于频繁”冷却：避免连续点启动把账号打进小黑屋 */
let lobbyCooldownUntil = 0;
/** 购买接口单独的冷却：enter 10 秒，购买被限流通常要等更久 */
let purchaseCooldownUntil = 0;

function purchaseCooldownFile(): string {
  return String(process.env.FB_PURCHASE_COOLDOWN_FILE || "").trim();
}

function readPurchaseCooldown(): number {
  const file = purchaseCooldownFile();
  if (!file) return purchaseCooldownUntil;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const until = Number(raw?.until ?? 0) || 0;
    return Math.max(purchaseCooldownUntil, until);
  } catch {
    return purchaseCooldownUntil;
  }
}

function writePurchaseCooldown(until: number): void {
  purchaseCooldownUntil = until;
  const file = purchaseCooldownFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ until, at: Date.now() }, null, 2) + "\n", { mode: 0o600 });
  } catch {}
}

/** 测试用：清掉冷却 */
export function resetLobbyCooldown(): void {
  lobbyCooldownUntil = 0;
  purchaseCooldownUntil = 0;
  const file = purchaseCooldownFile();
  if (file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function assertPurchaseCooldown(): void {
  const left = readPurchaseCooldown() - Date.now();
  if (left > 0) {
    throw new X19ApiError(
      `组件购买接口被限流，请 ${Math.ceil(left / 1000)} 秒后再试；也可以先在网易客户端进一次房间领取组件`,
      "purchase-rate-limit"
    );
  }
}

function notePurchaseRateLimit(message: string): void {
  if (/购买太频繁|购买频繁|频繁|rate.?limit/i.test(message)) {
    writePurchaseCooldown(Date.now() + 30 * 60_000);
  }
}

function assertLobbyCooldown(): void {
  const left = lobbyCooldownUntil - Date.now();
  if (left > 0) {
    throw new X19ApiError(`网易提示操作过于频繁，请 ${Math.ceil(left / 1000)} 秒后再试`, "rate-limit");
  }
}

function noteLobbyRateLimit(message: string): void {
  if (/频繁|太快|稍后重试|rate.?limit/i.test(message)) {
    lobbyCooldownUntil = Date.now() + 10_000;
  }
}

/** PC 网关：PC 购买接口用 x19apigateway，不是 g79mclobt */
const PC_GATEWAY = "https://x19apigatewayobt.nie.netease.com";
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
  /** 房间绑定的组件/资源 ID（带 mod 的房间才会有） */
  resId: string;
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
  return parseLobbyRooms(data);
}

/** 房间组件 ID：res_id 优先；没有就退回数字房间号，最后才是实体 ID */
export function lobbyComponentId(room: LobbyRoom): string {
  const resId = String(room.resId || "").trim();
  if (resId) return resId;
  const name = String(room.name || "").trim();
  if (/^\d{4,10}$/.test(name)) return name;
  return String(room.entityId || "").trim();
}

/**
 * 领取房间绑定的组件（房间 → 组件 ID → 购买）。
 *
 * 组件 ID 的真实来源是房间的 `res_id`（联机专区商品 ID，例如 4659475350398889607），
 * 不是房间号。候选顺序：调用方给的 preferredId（501/房间列表里的 res_id）→ room.resId →
 * 房间号（VQ 对本地联机房间就是拿房间号当 item_id 赌一把）。
 *
 * 实测：联机专区是 PE 商城商品（channel_id=5），所以**先 PE 再 PC**；
 * 一个候选 ID 打不通（PE/PC 都回「目标找不到」）才换下一个候选。
 * 一旦 PE 回「另一处登录」（PE token 失效）立刻停手抛 PE_SESSION_STALE：
 * 这时继续换候选/换通道只会白白多发购买请求，而购买接口是有限流的。
 * 502「物品已经获得」按成功处理，不再换候选。
 */
export async function purchaseLobbyComponent(
  room: LobbyRoom,
  cred: X19Credential,
  opts: X19PostOptions = {},
  preferredId = ""
): Promise<string> {
  assertPurchaseCooldown();
  const ids: string[] = [];
  const push = (v: string) => {
    const s = String(v || "").trim();
    if (s && !ids.includes(s)) ids.push(s);
  };
  push(preferredId);
  push(room.resId);
  // 本地联机房间只有房间号可用（VQ 也是拿房间号当 item_id 去试）
  const name = String(room.name || "").trim();
  if (/^\d{4,10}$/.test(name)) push(name);
  // 房间实体 ID 不再当候选：雪花 ID 一定不是商品 ID（实测只会回「目标找不到」，白打一次购买请求）

  const errors: string[] = [];
  for (const id of ids) {
    try {
      await purchaseComponentManually(id, cred, opts);
      return id;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/频繁|rate.?limit/i.test(msg)) {
        notePurchaseRateLimit(msg);
        throw e;
      }
      // PE 登录态失效：刷新后才能继续，换候选 ID 没有意义
      if (isPeSessionStaleError(e)) throw e;
      errors.push(`${id}：${msg}`);
    }
  }
  throw new X19ApiError(
    `领取组件失败（尝试 ${ids.join(" / ")}）：${errors.join("；")}。` +
      "这个房间绑的是联机专区组件：「联机专区」是 PE 商城商品（channel_id=5），必须在 PE 通道下领取，" +
      "PC 商城查不到它（目标找不到）。如果一直提示「您的帐号在另一处登录」，说明本地存的 PE 登录态过期了，" +
      "在面板点「刷新 PE 通道」再点一次「领取组件」即可。"
  );
}

/** 进房/取地址用哪套凭据 */
export type LobbyChannel = "pe" | "pc";

/**
 * 通道顺序：有 PE token 就先 PE。
 *
 * 实测（2026-11-15，uid 955512087 / PE entity 3102995735）：
 * 同一个网易账号，联机专区商品的归属记在 **PE entity** 上——
 *   PE 凭据 + 已领取的专区 → `/online-lobby-room-enter` code=0；
 *   PC 凭据 + 同一个已领取的专区 → 仍然 code=501「物品还未获得」。
 * 所以联机大厅必须先用 PE 通道进；PC 通道留作退路（PC 侧专区物品/没有 PE 登录态时）。
 */
export function lobbyChannelOrder(cred: X19Credential): LobbyChannel[] {
  const order: LobbyChannel[] = [];
  if (hasPeSession(cred)) order.push("pe");
  if (String(cred.token || "").trim()) order.push("pc");
  return order.length ? order : ["pc"];
}

/** 取某个通道对应的 cred */
export function credForLobbyChannel(cred: X19Credential, channel: LobbyChannel): X19Credential {
  return channel === "pe" ? peCredential(cred) : { userId: cred.userId, token: cred.token };
}

export type LobbyEnterResult = {
  channel: LobbyChannel;
  code: string;
  message?: string;
  /** 网易在 501 里偶尔回带的组件 ID（实测 501 的 entity 是 null，通常为空） */
  resId: string;
  raw: any;
};

/**
 * 进房（带通道回退）。
 *
 * 501 不抛错：先记下来，换下一个通道再试一次（PE 专区被 PC 账号看不见，反之亦然）。
 * 「另一处登录」直接抛 PE_SESSION_STALE——刷新 PE 登录态后由调用方重试，继续换通道没意义。
 */
async function enterLobbyRoom(
  payload: Record<string, any>,
  cred: X19Credential,
  opts: X19PostOptions
): Promise<LobbyEnterResult> {
  const body = JSON.stringify(payload);
  let notOwned: LobbyEnterResult | null = null;
  for (const channel of lobbyChannelOrder(cred)) {
    const data = await x19Post<any>("/online-lobby-room-enter", body, credForLobbyChannel(cred, channel), {
      ...opts,
      host: LOBBY_HOST,
      allowCodes: ["501"],
    });
    const code = String(data?.code ?? "0");
    const message = String(data?.message ?? "");
    const resId = String(
      data?.entity?.res_id ?? data?.entity?.item_id ?? data?.res_id ?? data?.item_id ?? data?.entities?.[0]?.res_id ?? ""
    ).trim();
    const result: LobbyEnterResult = { channel, code, message, resId, raw: data };
    if (/频繁|稍后重试|rate.?limit/i.test(message)) return result;
    if (code === "0") return result;
    if (code === "501") {
      notOwned = notOwned || result;
      continue;
    }
    return result;
  }
  return notOwned || { channel: "pc", code: "-1", message: "无响应", resId: "", raw: null };
}

/** 联机大厅：进房 → 取服务器地址 → 退房（和 VQ 的顺序一致） */
export async function resolveLobbyAddress(
  room: LobbyRoom,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<RentalAddress> {
  assertLobbyCooldown();
  const enterPayload: Record<string, any> = {
    room_id: room.entityId,
    password: String(password ?? ""),
    lobby_manifest_version: room.lobbyManifestVersion || "",
    check_visibilily: true,
  };
  if (room.resId) enterPayload.res_id = room.resId;

  let entered: LobbyEnterResult;
  try {
    entered = await enterLobbyRoom(enterPayload, cred, opts);
  } catch (e: any) {
    noteLobbyRateLimit(String(e?.message ?? e));
    throw e;
  }
  if (/频繁|稍后重试|rate.?limit/i.test(String(entered.message ?? ""))) {
    noteLobbyRateLimit(String(entered.message ?? ""));
    throw new X19ApiError(`网易提示：${entered.message}，请稍后再试`, "rate-limit");
  }

  if (entered.code === "501") {
    // 组件不自动领取：领错/领重复都由用户自己决定，这里只把可用的组件 ID 抖出来
    const knownResId = String(entered.resId || room.resId || "").trim();
    const componentId = knownResId || room.entityId;
    // 501 的响应体里没有组件 ID（实测 entity 是 null），房间列表里的 res_id 才是它
    const howToGet = knownResId ? "" : "（这次不知道组件 ID：先在面板点「搜索房间」找到这间房，选中后组件 ID 会自动填好）";
    throw new X19ApiError(
      `联机大厅房间「${room.name || room.entityId}」绑了联机专区组件（网易回 501：物品还未获得），组件 ID：${componentId}${howToGet}。` +
        "要进这个房间，先在面板点「领取组件」（联机专区是 PE 商城商品，必须走 PE 通道领取；领取后会自动重试一次进房）",
      "501"
    );
  }
  if (entered.code !== "0") {
    const tail = entered.message ? `：${entered.message}` : "";
    throw new X19ApiError(
      `联机大厅房间「${room.name || room.entityId}」进房失败（code=${entered.code}）${tail}`,
      entered.code
    );
  }

  // 取地址/退房必须用进房成功的那套凭据，否则会被当成另一个会话
  const useCred = credForLobbyChannel(cred, entered.channel);
  const readAddress = async (): Promise<RentalAddress | null> => {
    let data: any;
    try {
      data = await x19Post<any>("/online-lobby-game-enter", "", useCred, { ...opts, host: LOBBY_HOST });
    } finally {
      const leaveBody = JSON.stringify({ room_id: room.entityId, team_quit: false });
      x19Post("/online-lobby-room-enter/leave-room", leaveBody, useCred, { ...opts, host: LOBBY_HOST }).catch(() => {});
    }
    const host = String(data?.entity?.server_host ?? "").trim();
    const port = String(data?.entity?.server_port ?? "").trim();
    return host && port ? { host, port } : null;
  };

  const address = await readAddress();
  if (!address) throw new X19ApiError("网易没有返回联机大厅地址（房间已满/密码错误/房间不存在）");
  return address;
}

/** 联机大厅：搜索 + 选房 + 地址 */
export async function resolveLobbyRoom(
  keyword: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions & { version?: string } = {}
): Promise<{ server: LobbyRoom; address: RentalAddress }> {
  const key = String(keyword || "").trim();
  // 面板选中的实体 ID 是长数字，搜索接口按房间名匹配不到，直接进房
  if (/^\d{10,}$/.test(key)) {
    const room: LobbyRoom = {
      entityId: key,
      name: key,
      hasPwd: !!password,
      playerCount: 0,
      maxCount: 0,
      version: "",
      lobbyManifestVersion: "",
      resId: key,
    };
    const address = await resolveLobbyAddress(room, password, cred, opts);
    return { server: room, address };
  }
  const list = await searchLobbyRooms(keyword, cred, opts);
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

/**
 * 本地联机：直接按房间号进房（不走搜索）。
 *
 * VQ 客户端就是这么做的（LaunchPage.OnPeRoomIdEnterClick + LobbyService.EnterRoomAsync）：
 * 本地联机房间不会出现在联机大厅的搜索结果里，但 `/online-lobby-room-enter` 直接用房间号
 * 可以进。带专区组件的房间会回 501（物品还未获得），此时由用户点「领取组件」领完再进。
 *
 * 与大厅一样先 PE 后 PC：专区归属记在 PE entity 上（实测）。
 */
export async function enterPeRoom(
  roomId: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<{ code: string; message?: string; resId: string; channel: LobbyChannel }> {
  const payload = {
    room_id: String(roomId),
    password: String(password ?? ""),
    lobby_manifest_version: "",
    check_visibilily: true,
  };
  const entered = await enterLobbyRoom(payload, cred, opts);
  if (entered.code === "501") {
    // 501 的原始响应实测是 {"code":501,"message":"物品还未获得","entity":null}，
    // 不带组件 ID；这里留一条日志，方便排查到底是哪个房间/组件
    console.warn(`[netease-room] 进房 501 原始响应：${JSON.stringify(entered.raw).slice(0, 500)}`);
  }
  return { code: entered.code, message: entered.message, resId: entered.resId, channel: entered.channel };
}

/**
 * 购买结果。
 *
 * `alreadyOwned` 来自网易 code=502「物品已经获得」——VQ 的 PurchaseComponentAsync 把 502
 * 当失败（只认 code=0），实测这条路会把「其实已经拥有了」显示成领取失败，所以这里单独区分：
 * 502 等价成功，不再下单（面板上告诉用户「已拥有」即可）。
 */
export type PurchaseOutcome = {
  channel: "pc" | "pe";
  itemId: string;
  alreadyOwned: boolean;
};

/**
 * 把购买接口的失败分类成可判断的错误。
 *
 * 网易把业务错误放在 JSON 的 code/message 里（HTTP 一律 200），x19Post 会把非 0 折叠成
 * 异常，所以这里同时接受「异常」和「原始 data」两种输入。
 * 实测的错误码（2026-11-15，PE 商城 /pe-purchase-item/）：
 *   0   领取成功
 *   502 「物品已经获得」→ 已经拥有，等价成功
 *   16  「目标找不到」→ 这个 ID 不是可领取的商品（例如把房间号当组件 ID）
 *   其它 + 「您的帐号在另一处登录」→ PE token 被顶掉
 */
function normalizePurchaseError(e: any, channel: "pc" | "pe", path: string): X19ApiError {
  const message = String(e?.message ?? e?.msg ?? e ?? "");
  const code = String(e?.code ?? "");
  if (/另一处登录|其他地方登录|另一地登录/.test(message) && channel === "pe") {
    return new X19ApiError(`PE 通道登录态已失效：${message}`, PE_SESSION_STALE);
  }
  // 去掉 x19Post 加的「网易接口 /path 失败：」前缀，统一成「PE 商城目标找不到」这种短句
  const label = channel === "pe" ? "PE 商城" : "PC 商城";
  const short = message.replace(/^网易接口 \S+ 失败：/, "");
  if (/物品已经获得|已经获得/.test(message)) return new X19ApiError(`${label}${short}`, ITEM_ALREADY_OWNED);
  if (/目标找不到|商品不存在|已下架/i.test(message)) return new X19ApiError(`${label}${short}`, ITEM_NOT_FOUND);
  if (/频繁|稍后重试|rate.?limit/i.test(message)) {
    return new X19ApiError(`领取组件被限流：${message}`, code || "rate-limit");
  }
  if (e instanceof X19ApiError) return e;
  return new X19ApiError(`网易接口 ${path} 失败：${message || `code=${code}`}`, code);
}

/**
 * PC 商城：领取组件（VQ `LobbyService.PurchaseComponentAsync(isPe:false)`）。
 *
 * 注意：联机专区（channel_id=5）是 PE 商城商品，PC 商城查不到，这里只会回 code=16
 * 「目标找不到」。它只对 PC 侧商品（channel_id=11）有意义——所以调用方（面板手动领取）
 * 会先打 PE 接口，PC 只是没有 PE 登录态时的退路。
 */
export async function purchasePcComponent(
  resId: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<PurchaseOutcome> {
  const id = String(resId);
  const numericId = /^\d{1,6}$/.test(id) ? Number(id) : id;
  const body = JSON.stringify({
    entity_id: 0,
    item_id: numericId,
    item_level: 0,
    user_id: String(cred.userId),
    purchase_time: 0,
    last_play_time: 0,
    total_play_time: 0,
    receiver_id: "",
    buy_path: "PC_H5_COMPONENT_DETAIL",
    coupon_ids: null,
    diamond: 0,
    activity_name: "",
    batch_count: 1,
  });
  let data: any;
  try {
    data = await x19Post<any>("/user-item-purchase", body, cred, {
      ...opts,
      host: PC_GATEWAY,
      allowCodes: ["502", "16"],
    });
  } catch (e: any) {
    throw normalizePurchaseError(e, "pc", "/user-item-purchase");
  }
  const code = String(data?.code ?? "0");
  if (code === "0") return { channel: "pc", itemId: id, alreadyOwned: false };
  if (code === "502") return { channel: "pc", itemId: id, alreadyOwned: true };
  if (code === "16") throw new X19ApiError(`PC 商城${data?.message || "目标找不到"}`, ITEM_NOT_FOUND);
  throw normalizePurchaseError(data, "pc", "/user-item-purchase");
}

/**
 * PE 商城：领取联机房间绑定的组件（VQ `LobbyService.PurchaseComponentAsync(isPe:true)`）。
 *
 * host 用 g79mclobt（VQ: PeWebServer），body 的 item_id 必须是 JSON 字符串——
 * VQ 用 JsonConvert.ToString 发；发成数字会被判「参数错误」。
 * 必须用 PE 通道的 user-id/user-token：用 PC token 打这个接口回「参数错误」。
 */
export async function purchasePeRoomComponent(
  resId: string,
  cred: X19Credential,
  opts: X19PostOptions & { pcFallback?: boolean } = {}
): Promise<PurchaseOutcome> {
  const id = String(resId);
  // VQ 全程按字符串发（JsonConvert.ToString）：item_id 发成数字会被判「参数错误」
  const peBody = JSON.stringify({
    item_id: id,
    expertcomment_info: {
      item_id: id,
      expertcomment_id: "0",
      video_url: "0",
      expert_id: "0",
      buy_path: `首页-联机大厅-详情页:${id}`,
      coupon_ids: [],
      cdk_code: "",
    },
  });
  // PE 接口只认 PE 通道的登录态；没有 PE token 时才退回 PC token（旧版本账号）
  const peCred = peCredential(cred);
  /**
   * host 顺序：g79mclobt（VQ 的 PeWebServer）→ g79apigateway（攻击器 Crow-Brother-Ads 用的）。
   * 两个都是网易的 PE 网关，实测都能处理 /pe-purchase-item/；某个域名抽风/被限时换一个还有机会。
   * 只在「传输层/参数类」失败时换 host——`16 目标找不到`（ID 不对）和「另一处登录」（token 过期）换 host 没用。
   */
  const HOSTS = [RENTAL_HOST, LOBBY_HOST];
  let data: any;
  let lastErr: any = null;
  for (const host of HOSTS) {
    try {
      data = await x19Post<any>("/pe-purchase-item/", peBody, peCred, {
        ...opts,
        host,
        allowCodes: ["502", "16"],
      });
      lastErr = null;
      break;
    } catch (e: any) {
      const err = normalizePurchaseError(e, "pe", "/pe-purchase-item/");
      lastErr = err;
      if (isPeSessionStaleError(err) || isItemNotFoundError(err)) break;
      // 只有「域名/网络层」失败才换 host；参数错误直接走 PC 回退，别多打一次
      const transport = /HTTP [45]|请求失败|timeout|ECONN|ENOTFOUND|socket|fetch failed/i.test(err.message);
      if (!transport) break;
    }
  }
  if (lastErr) {
    // 有些账号/服务端只认 PC 的购买接口，PE 接口会回「参数错误」
    if (opts.pcFallback !== false && /参数错误|invalid|param/i.test(lastErr.message)) {
      return purchasePcComponent(id, cred, opts);
    }
    throw lastErr;
  }
  const code = String(data?.code ?? "0");
  if (code === "0") return { channel: "pe", itemId: id, alreadyOwned: false };
  if (code === "502") return { channel: "pe", itemId: id, alreadyOwned: true };
  if (code === "16") throw new X19ApiError(`PE 商城${data?.message || "目标找不到"}`, ITEM_NOT_FOUND);
  const err = normalizePurchaseError(data, "pe", "/pe-purchase-item/");
  if (opts.pcFallback !== false && /参数错误|invalid|param/i.test(err.message)) {
    return purchasePcComponent(id, cred, opts);
  }
  throw err;
}

/**
 * 手动领一个组件 ID（面板「领取组件」按钮）。
 *
 * 顺序按实测结论定（2026-11，PC uid 955512087 / PE entity 3102995735）：
 *   1) 联机专区是 **PE 商城**商品（channel_id=5），PC 商城根本查不到它 → 先打 PE 接口；
 *   2) PE token 失效时网易回「另一处登录」→ 抛 PE_SESSION_STALE，交给调用方刷新 PE
 *      登录态后重试一次；这时**不要**接着打 PC（PC 只会「目标找不到」），白多一个购买请求；
 *   3) PE 明确回「目标找不到」（code=16）才换 PC 接口，照顾 PC 侧商品；
 *   4) 502「物品已经获得」直接算成功。
 * 全程最多 2 个购买请求，不存在重复下单。
 */
export async function purchaseComponentManually(
  id: string,
  cred: X19Credential,
  opts: X19PostOptions = {}
): Promise<PurchaseOutcome> {
  const itemId = String(id ?? "").trim();
  if (!itemId) throw new X19ApiError("请填写组件 ID");
  // 有可用的 PE 登录态就先走 PE 商城（联机专区都在 PE 商城），没有才退回 PC
  const order: Array<"pe" | "pc"> = hasPeSession(cred) ? ["pe", "pc"] : ["pc"];
  const errors: string[] = [];
  for (const channel of order) {
    try {
      if (channel === "pe") {
        return await purchasePeRoomComponent(itemId, cred, { ...opts, pcFallback: false });
      }
      return await purchasePcComponent(itemId, cred, opts);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/频繁|rate.?limit/i.test(msg)) {
        notePurchaseRateLimit(msg);
        throw e;
      }
      // PE 登录态失效：必须刷新 PE 再重试，换通道没有意义
      if (isPeSessionStaleError(e)) throw e;
      errors.push(msg);
    }
  }
  throw new X19ApiError(`组件 ${itemId} 领取失败（${errors.join("；")}）`);
}

/**
 * 查「本账号是否已拥有这些组件/专区」。
 *
 * 协议来源：VQ `LobbyService.GetZoneImagesAsync` —— `/item-channel/query/search-item-channel-list-by-id`
 * 带 `channel_id` + `item_id_list`，返回里的 `buy_state`（1=已拥有，0=未拥有）。
 * VQ 只用它取封面图（channel_id 11 = PC 商城，打 x19apigateway）；联机专区是
 * channel_id 5（PE 商城），要打 g79apigateway 并用 PE 凭据。
 *
 * 面板在发购买请求前先查一次，已经拥有就不下单（购买接口有限流，白打一次很亏）。
 */
export async function fetchZoneOwnership(
  itemIds: string[],
  cred: X19Credential,
  opts: X19PostOptions & { channelId?: number } = {}
): Promise<Map<string, boolean>> {
  const ids = [...new Set(itemIds.map((v) => String(v ?? "").trim()).filter(Boolean))];
  const out = new Map<string, boolean>();
  if (!ids.length) return out;
  const channelId = Number(opts.channelId ?? 5) || 5;
  const body = JSON.stringify({ channel_id: channelId, item_id_list: ids });
  const data = await x19Post<any>("/item-channel/query/search-item-channel-list-by-id", body, cred, {
    ...opts,
    host: channelId === 5 ? LOBBY_HOST : PC_GATEWAY,
    allowCodes: ["16"],
  });
  for (const item of Array.isArray(data?.entities) ? data.entities : []) {
    const itemId = String(item?.item_id ?? "").trim();
    if (!itemId) continue;
    out.set(itemId, Number(item?.buy_state ?? 0) === 1);
  }
  // 网易没返回的 ID 视为未拥有（例如 ID 打错、商品已下架）
  for (const id of ids) if (!out.has(id)) out.set(id, false);
  return out;
}


/**
 * PE 本地联机：房间号 → host/port。
 * 进房 →（501 时领取组件重试）→ 取游戏地址 → 退房释放席位。
 */
export async function resolvePeLocalRoom(
  roomId: string,
  password: string,
  cred: X19Credential,
  opts: X19PostOptions & { componentId?: string } = {}
): Promise<RentalAddress> {
  assertLobbyCooldown();
  const room = String(roomId || "").trim();
  if (!/^\d{4,8}$/.test(room)) throw new X19ApiError("请填写 4–8 位本地联机房间号");

  let entered;
  try {
    entered = await enterPeRoom(room, password, cred, opts);
  } catch (e: any) {
    noteLobbyRateLimit(String(e?.message ?? e));
    throw e;
  }
  // 取地址/退房跟着进房成功的通道走（PE 进就用 PE 凭据）
  const useCred = credForLobbyChannel(cred, entered.channel);
  const readAddress = async (): Promise<RentalAddress | null> => {
    let data: any;
    try {
      data = await x19Post<any>("/online-lobby-game-enter", "", useCred, { ...opts, host: LOBBY_HOST });
    } finally {
      const leaveBody = JSON.stringify({ room_id: room, team_quit: false });
      x19Post("/online-lobby-room-enter/leave-room", leaveBody, useCred, { ...opts, host: LOBBY_HOST }).catch(() => {});
    }
    const host = String(data?.entity?.server_host ?? "").trim();
    const port = String(data?.entity?.server_port ?? "").trim();
    return host && port ? { host, port } : null;
  };

  if (entered.code === "501") {
    // 不自动领取组件：只告诉用户是哪个组件，领不领、怎么领由他自己决定
    const componentId = entered.resId || String(opts.componentId ?? "").trim() || room;
    throw new X19ApiError(
      `本地联机房间 ${room} 绑了联机专区组件（网易回 501：物品还未获得），组件 ID：${componentId}。` +
        "要进这个房间，先在面板点「领取组件」（联机专区是 PE 商城商品，必须走 PE 通道领取；领取后会自动重试一次进房）",
      "501"
    );
  }

  if (entered.code !== "0") {
    const tail = entered.message ? `：${entered.message}` : "";
    throw new X19ApiError(`本地联机房间 ${room} 进房失败（code=${entered.code}）${tail}`, entered.code);
  }

  const address = await readAddress();
  if (!address) throw new X19ApiError("网易没有返回本地联机地址（房间可能已关闭/人数已满）");
  return address;
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
  /** 本地联机/NetherNet：房间号作为 host id，账号 uid 作为 from id */
  nethernet?: { hostId: string; fromId: string };
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
  if (opts.nethernet) {
    args.push("--start_nethernet", "--HostNethernetId", opts.nethernet.hostId, "--FromNethernetId", opts.nethernet.fromId);
  }
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
