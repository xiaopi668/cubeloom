/**
 * 网易版（基岩互通服）事件桥客户端 + 回读校验编排
 *
 * 通过 UNIX 域套接字连接网易机器人客户端（libclient.so + main.py）的事件桥：
 * - NDJSON 协议，一行一条 JSON
 * - 首帧鉴权：{"type":"auth","token":"..."}
 * - 指令：{"type":"command","cmd":"command","args":{"text":"/list"},"id":"..."}
 * - 事件：{"type":"event","event":"on_text","fields":{...}}
 *
 * 文件下半部分是「校验快照 + 三步校验编排」，全部是纯函数（不碰 socket、不碰
 * 全局状态），netease-service.ts 与 test/netease.test.ts 共用同一份实现：
 *   createVerifySnapshot → resolveVerifySnapshot → planVerify → runVerifyPlan → summarizeVerify
 *
 * 只依赖 Node 内置模块。
 */
import * as net from "node:net";
import { effectiveProtocolVersion, gameVersionFor } from "./netease-protocol";
import * as fs from "node:fs";
import type { ParsedStructure, StructureBlock } from "./structure";

export type BridgeResult = {
  ok: boolean;
  data?: any;
  error?: string;
  error_code?: string;
};

export type BridgeEvent = {
  type: "event";
  event: string;
  fields?: Record<string, any>;
  ts?: number;
};

export type NeteaseBridgeOptions = {
  socketPath: string;
  token?: string;
  onEvent?: (ev: BridgeEvent) => void;
  onLog?: (line: string) => void;
};

/** 解析 `tcp://host:port` 形式的事件桥地址；不是 TCP 返回 null */
export function parseTcpEndpoint(socketPath: string): { host: string; port: number } | null {
  const m = /^tcp:\/\/(\[[^\]]+\]|[^/:]+):(\d{1,5})$/.exec(String(socketPath || "").trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

export class NeteaseBridge {
  private opts: NeteaseBridgeOptions;
  private sock: net.Socket | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (r: BridgeResult) => void; timer: NodeJS.Timeout }>();
  private authed = false;
  /** 本次连接是否已发过 auth（hello / auth 只回一次） */
  private authSent = false;
  private connected = false;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscribed = new Set<string>();
  private lastError = "";
  /** 机器人上报的协议版本 / 游戏版本（用于兼容检查） */
  private botProtocol: number | null = null;
  private botGameVersion: string | null = null;

  constructor(opts: NeteaseBridgeOptions) {
    this.opts = opts;
  }

  get isConnected(): boolean {
    return this.connected && this.authed;
  }

  get error(): string {
    return this.lastError;
  }

  /** 机器人上报的协议信息 */
  get protocol(): { version: number | null; gameVersion: string | null; expected: number } {
    return {
      version: this.botProtocol,
      gameVersion: this.botGameVersion,
      expected: effectiveProtocolVersion(),
    };
  }

  connect(): void {
    if (this.closing) return;
    // 支持两种事件桥地址：
    //   · UNIX socket / Windows 命名管道：/path/to/bot.sock
    //   · 本机 TCP（NTvector 这类内嵌 Python 的机器人更方便）：tcp://127.0.0.1:17999
    const tcp = parseTcpEndpoint(this.opts.socketPath);
    const s = tcp ? net.connect({ host: tcp.host, port: tcp.port }) : net.connect({ path: this.opts.socketPath });
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      this.connected = true;
      this.authSent = false;
      this.buf = "";
      this.log(`已连接事件桥：${this.opts.socketPath}`);
    });
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    s.on("error", (e: any) => {
      this.lastError = String(e?.message ?? e);
      this.log(`事件桥错误：${this.lastError}`);
    });
    s.on("close", () => {
      this.connected = false;
      this.authed = false;
      this.authSent = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "事件桥已断开" });
      }
      this.pending.clear();
      if (!this.closing) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.destroy();
    } catch {}
  }

  private log(msg: string) {
    this.opts.onLog?.(msg);
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello" || msg.type === "auth") {
      if (typeof msg.protocolVersion === "number" || typeof msg.protocol === "number") {
        this.botProtocol = Number(msg.protocolVersion ?? msg.protocol);
        this.botGameVersion = typeof msg.gameVersion === "string" ? msg.gameVersion : gameVersionFor(this.botProtocol);
        this.log(`机器人协议：${this.botProtocol}（MCBE ${this.botGameVersion}）`);
      }
      // hello 和 auth 都视为握手邀请：只回一次 auth，避免重复发送
      if (!this.authSent) {
        this.authSent = true;
        this.send({
          type: "auth",
          token: this.opts.token ?? "",
          client: "Cubeloom",
          // 协议基线（参考 NTvector：898 / 1.21.130）；老版本机器人可忽略这两个字段
          protocolVersion: effectiveProtocolVersion(),
          gameVersion: gameVersionFor(effectiveProtocolVersion()),
        });
      }
      // 已订阅的事件重新订阅
      for (const id of this.subscribed) {
        this.send({ type: "subscribe", events: ["*"], id });
      }
      return;
    }
    if (msg.type === "auth_ok") {
      this.authed = true;
      if (typeof msg.protocolVersion === "number" || typeof msg.protocol === "number") {
        this.botProtocol = Number(msg.protocolVersion ?? msg.protocol);
        this.botGameVersion = typeof msg.gameVersion === "string" ? msg.gameVersion : gameVersionFor(this.botProtocol);
        this.log(`机器人协议：${this.botProtocol}（MCBE ${this.botGameVersion}）`);
      }
      this.log("事件桥鉴权通过");
      for (const id of this.subscribed) {
        this.send({ type: "subscribe", events: ["*"], id });
      }
      return;
    }
    if (msg.type === "auth_fail") {
      this.lastError = "事件桥 token 无效";
      this.log(this.lastError);
      try {
        this.sock?.destroy();
      } catch {}
      return;
    }
    if (msg.type === "event") {
      this.opts.onEvent?.(msg as BridgeEvent);
      return;
    }
    // 指令回执
    const id = msg.id;
    if (id && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(msg as BridgeResult);
    }
  }

  private send(obj: any) {
    try {
      this.sock?.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  /** 发一条指令并等待回执 */
  request(cmd: string, args: Record<string, any> = {}, timeoutMs = 15000): Promise<BridgeResult> {
    if (!this.sock || !this.authed) return Promise.resolve({ ok: false, error: "事件桥未连接" });
    const id = `c${++this.seq}`;
    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `指令超时：${cmd}` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ type: "command", cmd, args, id });
    });
  }

  /** 发指令不等待回执（异步通道） */
  requestNoWait(cmd: string, args: Record<string, any> = {}): void {
    this.send({ type: "command", cmd, args, id: `n${++this.seq}` });
  }

  /** 订阅事件（重连后自动恢复） */
  subscribeEvents(id = "sub-all"): void {
    this.subscribed.add(id);
    if (this.authed) this.send({ type: "subscribe", events: ["*"], id });
  }

  /** 执行一条原版指令（前面自动补 /），等回执 */
  async command(text: string, timeoutMs = 15000): Promise<BridgeResult> {
    return this.request("command", { text: text.startsWith("/") ? text : `/${text}` }, timeoutMs);
  }

  /** 执行原版指令，不等回执 */
  commandNoWait(text: string): void {
    this.requestNoWait("command_nowait", { text: text.startsWith("/") ? text : `/${text}` });
  }

  /** 机器人已确认的坐标 */
  async getPosition(): Promise<{ x: number; y: number; z: number } | null> {
    const r = await this.request("pos", {}, 6000);
    const d = r.ok ? r.data : null;
    if (!d || typeof d.x !== "number") return null;
    return { x: d.x, y: d.y, z: d.z };
  }

  async identity(): Promise<any | null> {
    const r = await this.request("identity", {}, 6000);
    return r.ok ? r.data : null;
  }

  async players(): Promise<any | null> {
    const r = await this.request("players", {}, 6000);
    return r.ok ? r.data : null;
  }

  /** 读某个位置的方块（本地缓存，仅对本客户端 set_block 过的方块有名字） */
  async getBlock(x: number, y: number, z: number): Promise<any | null> {
    const r = await this.request("get_block", { x, y, z }, 6000);
    return r.ok ? r.data : null;
  }

  /** 健康检查：socket 文件是否存在且可连 */
  static socketExists(p: string): boolean {
    if (parseTcpEndpoint(p)) return true;
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }
}

/** 读取配置里的桥接参数（环境变量优先） */
export function resolveBridgeOptions(): { socketPath: string; token: string } | null {
  const socketPath = process.env.FB_NETEASE_SOCKET || "";
  if (!socketPath) return null;
  const token = process.env.FB_NETEASE_TOKEN || "";
  return { socketPath, token };
}

/* ==========================================================================
 * 回读校验编排（纯函数，可脱离 socket 单独测试）
 *
 * P1-13 的根因是「校验时现取 pending.st，原点却用另一次导入留下的 lastOrigin」。
 * 这里的做法：build 的那一刻把 {st, origin, name} 一起冻成快照，之后校验只认
 * 快照里的 origin —— 结构体和原点在数据结构上就不可能来自两次 build。
 * 重新上传 / prepare / clear / cancel 都会让旧快照失效（服务侧清空 + pendingSeq
 * 编号双重保险），verify 只会拿到「当前这份结构 + 它自己的原点」。
 * ========================================================================== */

export type Vec3 = { x: number; y: number; z: number };

/** build 时冻下来的「待校验结构」：结构体、原点、名字来自同一次 build */
export type VerifySnapshot = {
  /** 快照序号（服务侧单调递增，日志/调试用） */
  id: number;
  name: string;
  /** 冻结副本：采样与坐标只用这一份，外部再改原结构也不影响已登记的校验 */
  st: ParsedStructure;
  /** 原始结构引用：只用于判断"这份快照还属不属于当前 pending"，不参与坐标计算 */
  source: ParsedStructure;
  origin: Vec3;
  /** 生成快照时 pending 的序号；重新上传会让它失效 */
  pendingSeq: number;
  builtAt: number;
  /** 指纹：name/尺寸/方块数/原点/pendingSeq 派生的可读串，能一眼看出"新结构配旧原点" */
  fingerprint: string;
};

export type VerifySnapshotInput = {
  st: ParsedStructure;
  origin: Vec3;
  /** 缺省用 st.name */
  name?: string;
  /** 当前 pending 序号（缺省 0） */
  pendingSeq?: number;
  /** 快照序号（缺省 0） */
  id?: number;
  /** 生成时间（缺省 Date.now()） */
  at?: number;
};

/** 当前上传的结构（服务侧 pending 的最小投影，用于快照归属校验） */
export type PendingStructureRef = {
  name: string;
  /** 每次 /prepare、/clear 自增 */
  seq: number;
  /** 结构对象本身：同名不同文件也能靠引用区分 */
  st: ParsedStructure;
};

export type SnapshotResolution =
  | { ok: true; snapshot: VerifySnapshot }
  | { ok: false; error: string };

function snapshotFingerprint(name: string, st: ParsedStructure, origin: Vec3, pendingSeq: number): string {
  return `${name}:${st.size.x}x${st.size.y}x${st.size.z}:${st.total}@${origin.x},${origin.y},${origin.z}#p${pendingSeq}`;
}

/**
 * 把 build 时的结构 + 原点冻成快照。
 * blocks 复制一份，之后即使有人原地改 st.blocks 也不会污染这次快照。
 */
export function createVerifySnapshot(input: VerifySnapshotInput): VerifySnapshot {
  const { st, origin } = input;
  const name = input.name || st.name;
  const pendingSeq = input.pendingSeq ?? 0;
  const frozen: ParsedStructure = {
    ...st,
    blocks: st.blocks.map((b) => ({ ...b })),
    materials: st.materials ? [...st.materials] : [],
  };
  const frozenOrigin: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
  return {
    id: input.id ?? 0,
    name,
    st: frozen,
    source: st,
    origin: frozenOrigin,
    pendingSeq,
    builtAt: input.at ?? Date.now(),
    fingerprint: snapshotFingerprint(name, frozen, frozenOrigin, pendingSeq),
  };
}

/**
 * 校验前只认快照，不认"当前 pending + 上次原点"。
 * 任何一项对不上都直接拒绝，让调用方重新 build，而不是拿旧原点去比新结构。
 */
export function resolveVerifySnapshot(
  snapshot: VerifySnapshot | null | undefined,
  pending: PendingStructureRef | null | undefined
): SnapshotResolution {
  if (!snapshot) {
    return { ok: false, error: "还没有可校验的导入记录（缺少校验快照），请先 build 再校验" };
  }
  if (!pending) {
    return { ok: false, error: "当前没有已上传的结构，校验快照已失效，请先重新导入并 build" };
  }
  if (snapshot.pendingSeq !== pending.seq) {
    return {
      ok: false,
      error:
        `结构「${pending.name}」是重新上传的（#${pending.seq}），` +
        `旧校验快照 #${snapshot.id}「${snapshot.name}」（#p${snapshot.pendingSeq}）已失效，请先 build 再校验`,
    };
  }
  if (snapshot.source !== pending.st) {
    return { ok: false, error: `校验快照不属于当前结构「${pending.name}」，请先 build 再校验` };
  }
  return { ok: true, snapshot };
}

export type SampleOptions = { deep?: boolean; cap?: number };

function defaultSampleCap(deep: boolean): number {
  return deep ? 600 : 120;
}

/** 采样表面位置（deep 时更密）；纯函数，只读结构 */
export function sampleSurfacePoints(
  st: ParsedStructure,
  deep = false,
  capOverride?: number
): { points: StructureBlock[]; surfaceTotal: number; stride: number } {
  const sx = st.size.x;
  const sy = st.size.y;
  const sz = st.size.z;
  const surface: StructureBlock[] = [];
  for (const b of st.blocks) {
    if (b.x === 0 || b.x === sx - 1 || b.y === 0 || b.y === sy - 1 || b.z === 0 || b.z === sz - 1) {
      surface.push({ x: b.x, y: b.y, z: b.z, block: b.block });
    }
  }
  const cap = capOverride && capOverride > 0 ? capOverride : defaultSampleCap(deep);
  const stride = Math.max(1, Math.ceil(surface.length / cap));
  const points: StructureBlock[] = [];
  for (let i = 0; i < surface.length; i += stride) points.push(surface[i]);
  return { points, surfaceTotal: surface.length, stride };
}

export type VerifyPoint = {
  /** 结构局部坐标 */
  lx: number;
  ly: number;
  lz: number;
  /** 世界坐标：snapshot.origin + 局部坐标（偏移的唯一来源） */
  x: number;
  y: number;
  z: number;
  block: string;
  /** 幂等 setblock：方块在 = 在位（noChange 回执），不在 = 直接补上 */
  command: string;
};

export type VerifyPlan = {
  snapshot: VerifySnapshot;
  points: VerifyPoint[];
  planned: number;
  deep: boolean;
  stride: number;
  /** 参与抽样的表面点总数（planned/surfaceTotal 就是抽样比例） */
  surfaceTotal: number;
};

/** 把快照 + 抽样参数编排成可执行的点位列表；世界坐标只在这里由快照原点算出 */
export function planVerify(input: SampleOptions & { snapshot: VerifySnapshot }): VerifyPlan {
  const { snapshot } = input;
  const deep = !!input.deep;
  const { points, surfaceTotal, stride } = sampleSurfacePoints(snapshot.st, deep, input.cap);
  const origin = snapshot.origin;
  const sampled: VerifyPoint[] = points.map((p) => {
    const x = origin.x + p.x;
    const y = origin.y + p.y;
    const z = origin.z + p.z;
    return {
      lx: p.x,
      ly: p.y,
      lz: p.z,
      x,
      y,
      z,
      block: p.block,
      command: `/setblock ${x} ${y} ${z} ${p.block}`,
    };
  });
  return { snapshot, points: sampled, planned: sampled.length, deep, stride, surfaceTotal };
}

/** 桥层致命错误：继续跑没有意义（断线/未连接/超时/鉴权失败） */
const FATAL_BRIDGE_ERROR =
  /事件桥未连接|事件桥已断开|事件桥 token|事件桥鉴权|指令超时|timed?\s*out|timeout|EPIPE|ECONNRESET|socket|not connected|closed/i;

export type ReceiptVerdict = {
  /** 方块确认在位（command_success / 全部 success / 幂等 noChange 回执） */
  confirmed: boolean;
  /** 方块不在位（指令层面失败，进补建轮） */
  missing: boolean;
  /** 桥本身坏了（未连接/断开/超时），必须中断整轮校验 */
  fatal: string | null;
  /** 指令层面错误信息（非致命） */
  error?: string;
};

/**
 * 解析一条 /setblock 回执。
 * 网易通道上不能用 testforblock（会 bad_packet 踢线），所以"读"就是幂等 setblock：
 *   · 回执成功 / 消息全 success → 方块在位；
 *   · 消息含 noChange（重复放置被拒）→ 方块本来就在，同样算在位；
 *   · 明确失败 → 缺，交给补建轮；
 *   · 桥层错误（未连接/超时）→ fatal，整轮中断，不能当成"这点缺"。
 */
export function classifyCommandReceipt(r: BridgeResult | null | undefined): ReceiptVerdict {
  if (!r) return { confirmed: false, missing: true, fatal: null, error: "空回执" };

  if (r.ok === false) {
    const err = String(r.error ?? "").trim();
    if (err && FATAL_BRIDGE_ERROR.test(err)) {
      return { confirmed: false, missing: false, fatal: err, error: err };
    }
  }

  const data: any = r.data ?? {};
  const echo: any[] = Array.isArray(data?.echo?.messages) ? data.echo.messages : [];
  const noChange = echo.some((m) => m && m.success === false && String(m?.message ?? "").includes("noChange"));
  if (noChange) return { confirmed: true, missing: false, fatal: null };
  if (data?.command_success === true) return { confirmed: true, missing: false, fatal: null };

  if (r.ok === false) {
    const err = String(r.error ?? "").trim();
    return { confirmed: false, missing: true, fatal: null, error: err || "桥返回 ok=false 但没有错误信息" };
  }

  const failedMsgs = echo.filter((m) => m && m.success === false);
  if (failedMsgs.length > 0) {
    const text = failedMsgs.map((m) => String(m?.message ?? "")).filter(Boolean).join("; ") || "指令失败";
    return { confirmed: false, missing: true, fatal: null, error: text };
  }
  if (echo.length > 0) return { confirmed: true, missing: false, fatal: null };
  return { confirmed: false, missing: true, fatal: null, error: "回执里没有 success 信息，按未确认处理" };
}

export type VerifyBridge = {
  /** 缺省视为已连接 */
  isConnected?: () => boolean;
  sendCommand: (text: string, timeoutMs?: number) => Promise<BridgeResult>;
};

export type VerifyPhase = "sample" | "repair" | "recheck" | "done";

export type VerifyProgress = {
  phase: VerifyPhase;
  /** 已经发过至少一条指令的点数 */
  checked: number;
  planned: number;
  /** 当前轮次下仍未确认的点数 */
  missing: number;
  /** 非首轮确认（真正补上）的点数 */
  fixed: number;
  /** 走完复检仍失败的点数 */
  failed: number;
};

export type VerifyPointOutcome = VerifyPoint & {
  attempts: number;
  /** 首轮就在位 */
  firstPass: boolean;
  /** 补建轮补上 */
  repaired: boolean;
  /** 复检轮确认在位 */
  recheckPass: boolean;
  /** 走完复检仍不在位（这一项才计入 failed） */
  recheckFailed: boolean;
  confirmed: boolean;
  lastError?: string;
};

export type VerifyRunOptions = {
  /** 单条指令回执超时 */
  timeoutMs?: number;
  /** 每点之间的限速间隔（毫秒，0 = 不等待） */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 外部中断信号（被踢/待机），返回非空字符串即中断 */
  isAborted?: () => string | null;
  onProgress?: (p: VerifyProgress) => void;
};

export type VerifyStatus = "passed" | "partial" | "failed" | "aborted";

export type VerifyRunResult = {
  status: VerifyStatus;
  planned: number;
  /** 实际发过指令的点数 */
  checked: number;
  /** 完全没轮到的点数 */
  unchecked: number;
  /** 首轮缺失（进过补建轮）的点数 */
  firstMissing: number;
  /** 非首轮确认 = 真正补上的数量 */
  fixed: number;
  /** 复检后仍失败的数量 */
  failed: number;
  /** 试过但没走完复检（中断）的点数，既不算成功也不算失败 */
  unverified: number;
  surfaceTotal: number;
  snapshotId: number;
  fingerprint: string;
  error?: string;
  message: string;
  outcomes: VerifyPointOutcome[];
};

export type VerifySummaryMeta = {
  planned: number;
  surfaceTotal?: number;
  snapshotName: string;
  snapshotId: number;
  fingerprint: string;
  abortReason?: string | null;
};

/**
 * 只做统计与文案，不发明成功：
 *   passed  = 全部点在位（允许 fixed>0，但要如实写"补齐 N 处"）
 *   partial = 有补上的、也有复检后仍缺的
 *   failed  = 一个都没补上且仍有缺（或根本没有可校验的点）
 *   aborted = 中途中断；只有"中断但所有点其实都确认了"才升格为 passed
 * 没轮到的点算 unchecked、试过但没复检的算 unverified，都不算 failed。
 */
export function summarizeVerify(outcomes: VerifyPointOutcome[], meta: VerifySummaryMeta): VerifyRunResult {
  const planned = Math.max(0, meta.planned);
  const checked = outcomes.filter((o) => o.attempts > 0).length;
  const confirmed = outcomes.filter((o) => o.confirmed).length;
  const firstMissing = outcomes.filter((o) => o.attempts > 0 && !o.firstPass).length;
  const fixed = outcomes.filter((o) => o.confirmed && !o.firstPass).length;
  const failed = outcomes.filter((o) => o.recheckFailed && !o.confirmed).length;
  const unchecked = Math.max(0, planned - checked);
  const unverified = Math.max(0, checked - confirmed - failed);
  const abortReason = meta.abortReason ?? null;

  let status: VerifyStatus;
  if (planned <= 0) status = "failed";
  else if (abortReason) status = confirmed === planned ? "passed" : "aborted";
  else if (failed > 0) status = fixed > 0 ? "partial" : "failed";
  else status = "passed";

  let error: string | undefined;
  if (status === "failed" && planned <= 0) {
    error = "没有可校验的抽样点（结构为空或没有表面方块）";
  } else if (status === "failed") {
    error = `${failed} 处复检后仍不在位`;
  } else if (status === "partial") {
    error = `部分完成：${failed} 处复检后仍不在位`;
  } else if (status === "aborted") {
    error = abortReason || "校验中断";
  }

  const head = `抽查 ${checked}/${planned} 点`;
  let message: string;
  if (status === "failed" && planned <= 0) {
    message = `✘ 未完成：${meta.snapshotName} · 没有可校验的抽样点`;
  } else if (status === "passed") {
    message =
      fixed > 0
        ? `✔ 校验通过（补建后确认）：${meta.snapshotName} · ${head} · 首轮缺 ${firstMissing} 处 · 补齐 ${fixed} 处 · 复检无残留`
        : `✔ 三步全部通过：${meta.snapshotName} · ${head} 全部在位`;
  } else if (status === "partial") {
    message =
      `⚠ 部分完成：${meta.snapshotName} · ${head} · 首轮缺 ${firstMissing} 处 · ` +
      `补齐 ${fixed} 处 · 复检仍有 ${failed} 处不在位`;
  } else if (status === "failed") {
    message =
      `✘ 未完成：${meta.snapshotName} · ${head} · 首轮缺 ${firstMissing} 处 · ` +
      `${failed} 处复检后仍不在位`;
  } else {
    message =
      `✘ 未完成（${abortReason}）：${meta.snapshotName} · 已抽查 ${checked}/${planned} 点` +
      (fixed > 0 ? ` · 补齐 ${fixed} 处` : "") +
      ` · 未复检 ${unchecked + unverified} 处`;
  }

  return {
    status,
    planned,
    checked,
    unchecked,
    firstMissing,
    fixed,
    failed,
    unverified,
    surfaceTotal: meta.surfaceTotal ?? planned,
    snapshotId: meta.snapshotId,
    fingerprint: meta.fingerprint,
    error,
    message,
    outcomes,
  };
}

/**
 * 三步校验的真实编排：
 *   第 1 轮 抽样回读（幂等 setblock 回执 → 在位/缺）
 *   第 2 轮 只对首轮缺失的点补建一次
 *   第 3 轮 复检剩余（这一轮还失败才计入 failed，补上的计入 fixed）
 * 桥断开 / 单条超时 / 外部中断 → 立刻停轮，结果走 aborted，绝不报"全部通过"。
 */
export async function runVerifyPlan(
  plan: VerifyPlan,
  bridge: VerifyBridge,
  opts: VerifyRunOptions = {}
): Promise<VerifyRunResult> {
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  const timeoutMs = opts.timeoutMs ?? 15000;

  const outcomes: VerifyPointOutcome[] = plan.points.map((p) => ({
    ...p,
    attempts: 0,
    firstPass: false,
    repaired: false,
    recheckPass: false,
    recheckFailed: false,
    confirmed: false,
  }));

  let abortReason: string | null = null;

  const aborted = (): boolean => {
    if (abortReason) return true;
    const external = opts.isAborted ? opts.isAborted() : null;
    if (external) {
      abortReason = external;
      return true;
    }
    if (bridge.isConnected && !bridge.isConnected()) {
      abortReason = "事件桥已断开（校验中断）";
      return true;
    }
    return false;
  };

  const attempt = async (o: VerifyPointOutcome): Promise<ReceiptVerdict> => {
    let verdict: ReceiptVerdict;
    try {
      const r = await bridge.sendCommand(o.command, timeoutMs);
      verdict = classifyCommandReceipt(r);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // 抛异常 = 通道本身坏了（断线/未连接），不是"这个点缺"
      verdict = { confirmed: false, missing: false, fatal: msg || "事件桥调用异常", error: msg };
    }
    o.attempts += 1;
    if (verdict.error) o.lastError = verdict.error;
    if (verdict.confirmed) o.confirmed = true;
    if (verdict.fatal) abortReason = verdict.fatal;
    return verdict;
  };

  const progress = (phase: VerifyPhase, override: Partial<VerifyProgress> = {}) => {
    if (!opts.onProgress) return;
    opts.onProgress({
      phase,
      planned: plan.planned,
      checked: outcomes.filter((o) => o.attempts > 0).length,
      missing: outcomes.filter((o) => o.attempts > 0 && !o.confirmed).length,
      fixed: outcomes.filter((o) => o.confirmed && !o.firstPass).length,
      failed: outcomes.filter((o) => o.recheckFailed && !o.confirmed).length,
      ...override,
    });
  };

  // 第 1 轮：抽样回读
  const firstMissing: VerifyPointOutcome[] = [];
  for (const o of outcomes) {
    if (aborted()) break;
    const v = await attempt(o);
    if (v.confirmed) o.firstPass = true;
    else if (!v.fatal) firstMissing.push(o);
    progress("sample");
    if (delayMs) await sleepFn(delayMs);
  }

  // 第 2 轮：补建（只重发首轮缺失的点）
  const stillMissing: VerifyPointOutcome[] = [];
  if (!abortReason) {
    for (const o of firstMissing) {
      if (aborted()) break;
      const v = await attempt(o);
      if (v.confirmed) o.repaired = true;
      else if (!v.fatal) stillMissing.push(o);
      progress("repair");
      if (delayMs) await sleepFn(delayMs);
    }
  }

  // 第 3 轮：复检剩余，只有这一轮仍失败才计入 failed
  if (!abortReason) {
    for (const o of stillMissing) {
      if (aborted()) break;
      const v = await attempt(o);
      if (v.confirmed) o.recheckPass = true;
      else if (!v.fatal) o.recheckFailed = true;
      progress("recheck");
      if (delayMs) await sleepFn(delayMs);
    }
  }

  progress("done");
  return summarizeVerify(outcomes, {
    planned: plan.planned,
    surfaceTotal: plan.surfaceTotal,
    snapshotName: plan.snapshot.name,
    snapshotId: plan.snapshot.id,
    fingerprint: plan.snapshot.fingerprint,
    abortReason,
  });
}
