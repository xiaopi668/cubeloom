/**
 * 网易版（基岩互通服）结构导入服务
 *
 * 与 WebSocket 版互不影响：本服务通过机器人客户端的事件桥，在网易租赁服里
 * 「以玩家身份」执行原版指令来完成结构导入、回读校验与补建。
 *
 * 启动：FB_NETEASE_SOCKET=/opt/netease-bot/bot.sock FB_NETEASE_TOKEN=xxx \
 *       node node_modules/tsx/dist/cli.mjs netease-service.ts
 * 接口：127.0.0.1:11454（仅本机，由 admin-server 反代）
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NeteaseBridge,
  BridgeEvent,
  createVerifySnapshot,
  resolveVerifySnapshot,
  planVerify,
  runVerifyPlan,
  VerifyPlan,
  VerifyRunResult,
  VerifySnapshot,
  VerifyStatus,
} from "./src/netease-bridge";
import { ManagedBot } from "./src/netease-bot";
import { structureCommands, ParsedStructure } from "./src/structure";
import { parseStructureFile } from "./src/formats";
import { describeBaseline, checkBotProtocol, effectiveProtocolVersion, gameVersionFor, NETEASE_PROTOCOL } from "./src/netease-protocol";

const APP_NAME = "Cubeloom-NetEase";
const PORT = Number(process.env.FB_NETEASE_PORT || 11454);
const HOST = process.env.FB_NETEASE_HOST || "127.0.0.1";
const SOCKET_PATH = process.env.FB_NETEASE_SOCKET || "";
/** 托管机器人：设了命令就由本服务启动/重启机器人（机器人本体仍需另行提供） */
const BOT_CMD = (process.env.FB_NETEASE_BOT_CMD || "").trim();
/** 账号模式：由 admin-server 算好的完整 argv（JSON 数组），不经 shell */
const BOT_ARGV: string[] | undefined = (() => {
  const raw = (process.env.FB_NETEASE_BOT_ARGV || "").trim();
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string" && x)) return arr;
    logError("FB_NETEASE_BOT_ARGV 不是非空字符串数组，忽略");
  } catch (e: any) {
    logError(`FB_NETEASE_BOT_ARGV 解析失败：${e?.message ?? e}`);
  }
  return undefined;
})();
const BOT_CWD = (process.env.FB_NETEASE_BOT_CWD || "").trim() || undefined;
const TOKEN = process.env.FB_NETEASE_TOKEN || "";
const LOG_DIR = process.env.FB_LOG_DIR || path.join(process.cwd(), "logs");
const STRUCTURE_LIMIT = 500000;
const BAR_WIDTH = 20;

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "netease.log");

function utc8(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}

function fileLog(line: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${utc8()}] ${line}\n`);
  } catch {}
}

function log(line: string) {
  console.log(`[${utc8()}] ${line}`);
  fileLog(line);
}
function logError(line: string) {
  console.error(`[${utc8()}] ${line}`);
  fileLog(`[错误] ${line}`);
}

/** ===== 机器人事件桥 ===== */
let bridgeError = "";
let lastText: { source?: string; message?: string; at: number } | null = null;
let lastKick: string | null = null;
let lastKickAt = 0;
/** 指令限速（条/秒）。网易反作弊对方块/指令突发很敏感，默认 5 条/秒。 */
const CMD_RATE = Math.max(1, Number(process.env.FB_NETEASE_RATE || 5));
/** 回读校验的抽样上限（越低越安全，越高越快） */
const VERIFY_SAMPLE = Math.max(10, Number(process.env.FB_NETEASE_VERIFY_SAMPLE || 120));
/** 单条校验指令的回执超时 */
const VERIFY_CMD_TIMEOUT = 15000;

const bridge = new NeteaseBridge({
  socketPath: SOCKET_PATH,
  token: TOKEN,
  onLog: (line) => log(line),
  onEvent: (ev: BridgeEvent) => {
    try {
      if (ev.event === "on_text" && ev.fields) {
        lastText = { source: ev.fields.source, message: String(ev.fields.message ?? ""), at: Date.now() };
      } else if (ev.event === "on_kicked" || ev.event === "on_disconnect") {
        const f: any = ev.fields || {};
        lastKick = f.reason_name ? `${f.reason_name}（reason=${f.reason_code}）` : "已断开";
        lastKickAt = Date.now();
        logError(`机器人断开：${lastKick}`);
        // 被踢时立即中止正在进行的导入/校验，避免继续往断开的会话里发指令
        if (build && !build.done) {
          build.error = `机器人被踢出：${lastKick}`;
          build.done = true;
          build.stepLabel = "已中断";
          if (buildTimer) clearTimeout(buildTimer);
          buildTimer = null;
          logError(`导入「${build.name}」因机器人断开被中止`);
        }
        if (verify && verify.running) {
          verify.running = false;
          verify.status = "aborted";
          verify.doneAt = Date.now();
          verify.error = `机器人被踢出：${lastKick}`;
          verify.message = `✘ 未完成（机器人被踢出）：已抽查 ${verify.checked}/${verify.planned} 点`;
          logError(`校验「${verify.snapshot?.name ?? ""}」因机器人断开被中止`);
        }
      } else if (ev.event === "on_start_game") {
        lastKick = null;
        lastKickAt = 0;
        log("机器人已进服（on_start_game）");
      }
    } catch {}
  },
});

/** 机器人进程托管（FB_NETEASE_BOT_CMD 未设置时为 null） */
const managedBot = BOT_ARGV || BOT_CMD
  ? new ManagedBot({
      command: BOT_ARGV ? undefined : BOT_CMD,
      argv: BOT_ARGV,
      socketPath: SOCKET_PATH,
      cwd: BOT_CWD,
      onLog: (line) => log(line),
    })
  : null;

/** ===== 状态 ===== */
type BuildState = {
  name: string;
  total: number;
  sent: number;
  commands: number;
  origin: { x: number; y: number; z: number };
  startedAt: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  step: number;
  stepLabel: string;
};

type VerifyState = {
  running: boolean;
  /** running / passed / partial / failed / aborted —— 只有 passed 才能说"三步全部通过" */
  status: VerifyStatus | "running";
  planned: number;
  checked: number;
  /** 首轮缺失数（面板叫"缺失"） */
  missing: number;
  /** 真正补上的数量 */
  fixed: number;
  /** 复检后仍失败的数量 */
  failed: number;
  /** 复检后仍缺（= failed，保留旧字段名给面板用） */
  remaining: number;
  unchecked: number;
  deep: boolean;
  doneAt: number;
  error?: string;
  message?: string;
  surfaceTotal: number;
  /** 这次校验认的是哪份快照（结构名 + 原点 + 指纹） */
  snapshot: { id: number; name: string; fingerprint: string; origin: { x: number; y: number; z: number }; builtAt: number } | null;
};

let pending: { st: ParsedStructure; uploadedAt: number } | null = null;
let build: BuildState | null = null;
let verify: VerifyState | null = null;
let buildTimer: NodeJS.Timeout | null = null;
let importStartedAt = 0;
/**
 * 待校验结构快照：build 时连同原点一起冻住（P1-13）。
 * 校验只认这一份，绝不出现"新结构 st + 旧 lastOrigin"。
 */
let verifySnapshot: VerifySnapshot | null = null;
let verifySnapshotSeq = 0;
/** 每次 /prepare、/clear 自增；快照必须和当前 pending 同号才能用 */
let pendingSeq = 0;

function bar(placed: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, placed / total) : 0;
  const filled = ratio >= 1 ? BAR_WIDTH : Math.min(BAR_WIDTH - 1, Math.floor(ratio * BAR_WIDTH));
  const pct = Math.floor(ratio * 100);
  return `§f[§a${"#".repeat(filled)}§7${"-".repeat(BAR_WIDTH - filled)}§f] §e${pct}% §7${placed}/${total}`;
}

function actionbar(text: string) {
  bridge.commandNoWait(`/titleraw @a actionbar ${JSON.stringify({ rawtext: [{ text }] })}`);
}

function chat(text: string) {
  bridge.commandNoWait(`/tellraw @a ${JSON.stringify({ rawtext: [{ text }] })}`);
}

function setStep(step: number, label: string) {
  if (build) {
    build.step = step;
    build.stepLabel = label;
  }
}

/** 当前 pending 的最小投影，用于「快照是否还属于这份结构」的判断 */
function pendingRef() {
  return pending ? { name: pending.st.name, seq: pendingSeq, st: pending.st } : null;
}

/** 让校验快照作废（重新上传、清空、取消导入时调用） */
function invalidateSnapshot(reason: string) {
  if (!verifySnapshot) return;
  log(`校验快照 #${verifySnapshot.id}「${verifySnapshot.name}」（${verifySnapshot.fingerprint}）作废：${reason}`);
  verifySnapshot = null;
}

/** 快照里跟 /status 有关的那部分 */
function snapshotBrief(snap: VerifySnapshot | null) {
  if (!snap) return null;
  return {
    id: snap.id,
    name: snap.name,
    fingerprint: snap.fingerprint,
    origin: { ...snap.origin },
    builtAt: snap.builtAt,
  };
}

type VerifyPrecheck = { ok: true; plan: VerifyPlan } | { ok: false; error: string };

/**
 * 校验前置检查（同步，可在 HTTP 层直接用来拒绝请求）：
 * 只认 build 时冻下来的快照，快照和当前 pending 对不上就要求重新 build。
 */
function precheckVerify(deep: boolean, cap?: number): VerifyPrecheck {
  if (!bridge.isConnected) return { ok: false, error: "机器人未连接（先确认机器人已进服）" };
  if (lastKick && Date.now() - lastKickAt < 20000) {
    return { ok: false, error: `机器人刚被踢出（${lastKick}），等它重新进服` };
  }
  if (verify && verify.running) return { ok: false, error: "校验正在进行" };
  if (build && !build.done && build.step < 2) {
    return { ok: false, error: "导入还在放置方块阶段（第 1 步未完成），等放置完再校验" };
  }
  const resolved = resolveVerifySnapshot(verifySnapshot, pendingRef());
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const plan = planVerify({ snapshot: resolved.snapshot, deep, cap: cap && cap > 0 ? cap : deep ? 600 : VERIFY_SAMPLE });
  if (plan.planned === 0) {
    return { ok: false, error: `结构「${resolved.snapshot.name}」没有可校验的表面方块` };
  }
  return { ok: true, plan };
}

type VerifyOutcome = {
  ok: boolean;
  status: VerifyStatus | "rejected";
  error?: string;
  result?: VerifyRunResult;
};

/**
 * 回读校验 + 补建（网易版）三步：
 *   1) 抽样回读：每个点发幂等 setblock，成功/noChange = 在位；
 *   2) 补建：只对首轮失败的点再发一次；
 *   3) 复检：剩余点再确认一轮，这一轮仍失败才计入 failed。
 * 不依赖 testforblock（那会触发网易 bad_packet 踢线），整轮按 CMD_RATE 限速。
 * 状态与计数全部由 runVerifyPlan/summarizeVerify 给出，这里只负责接线与播报。
 */
async function executeVerify(plan: VerifyPlan): Promise<VerifyOutcome> {
  const snap = plan.snapshot;
  if (build && !build.done) setStep(2, "完整性校验");
  verify = {
    running: true,
    status: "running",
    planned: plan.planned,
    checked: 0,
    missing: 0,
    fixed: 0,
    failed: 0,
    remaining: 0,
    unchecked: plan.planned,
    deep: plan.deep,
    doneAt: 0,
    surfaceTotal: plan.surfaceTotal,
    snapshot: snapshotBrief(snap),
  };
  log(
    `开始校验「${snap.name}」：抽查 ${plan.planned}/${plan.surfaceTotal} 个表面方块，` +
      `快照 #${snap.id} ${snap.fingerprint}，原点 ${snap.origin.x},${snap.origin.y},${snap.origin.z}，限速 ${CMD_RATE}/秒`
  );
  chat(`§e第 2/3 步：完整性校验「${snap.name}」（抽查 ${plan.planned} 个方块）…`);

  const delayMs = Math.max(30, Math.round(1000 / CMD_RATE));
  let lastBarAt = 0;
  const phaseLabel: Record<string, string> = { sample: "抽样回读", repair: "补建缺失", recheck: "复检剩余", done: "完成" };

  const result = await runVerifyPlan(
    plan,
    {
      isConnected: () => bridge.isConnected,
      sendCommand: (text, timeoutMs) => bridge.command(text, timeoutMs ?? VERIFY_CMD_TIMEOUT),
    },
    {
      timeoutMs: VERIFY_CMD_TIMEOUT,
      delayMs,
      isAborted: (): string | null => {
        if (!bridge.isConnected) return "机器人连接已断开";
        if (lastKick) return `机器人被踢出：${lastKick}`;
        return null;
      },
      onProgress: (p) => {
        if (!verify) return;
        verify.checked = p.checked;
        verify.missing = p.missing;
        verify.fixed = p.fixed;
        verify.failed = p.failed;
        verify.unchecked = Math.max(0, plan.planned - p.checked);
        const now = Date.now();
        if (p.phase === "recheck" || p.phase === "done" || p.checked % 10 === 0 || now - lastBarAt > 1200) {
          lastBarAt = now;
          actionbar(
            `§e第 2/3 步 ${phaseLabel[p.phase] ?? ""}「${snap.name}」 ${bar(p.checked, plan.planned)}` +
              ` §c缺 ${p.missing} §a补 ${p.fixed}`
          );
        }
      },
    }
  );

  verify = {
    running: false,
    status: result.status,
    planned: result.planned,
    checked: result.checked,
    missing: result.firstMissing,
    fixed: result.fixed,
    failed: result.failed,
    remaining: result.failed,
    unchecked: result.unchecked,
    deep: plan.deep,
    doneAt: Date.now(),
    error: result.error,
    message: result.message,
    surfaceTotal: plan.surfaceTotal,
    snapshot: snapshotBrief(snap),
  };

  const passed = result.status === "passed";
  if (passed) {
    log(`${result.message}（快照 #${snap.id} ${snap.fingerprint}）`);
    chat(`§a✔ ${result.message}`);
  } else {
    logError(`${result.message}（快照 #${snap.id} ${snap.fingerprint}）`);
    chat(`§c⚠ ${result.message}`);
  }
  return { ok: passed, status: result.status, error: passed ? undefined : result.error ?? result.message, result };
}

/** 校验入口：前置检查 + 执行 */
async function verifyStructure(deep = false, cap?: number): Promise<VerifyOutcome> {
  const pre = precheckVerify(deep, cap);
  if (!pre.ok) {
    logError(`拒绝校验：${pre.error}`);
    return { ok: false, status: "rejected", error: pre.error };
  }
  return executeVerify(pre.plan);
}

/** 导入结构（异步执行，进度看 /import/status） */
async function startImport(st: ParsedStructure, offsetY: number): Promise<{ ok: boolean; error?: string; info?: any }> {
  if (!bridge.isConnected) return { ok: false, error: "机器人未连接（先确认机器人已进服）" };
  if (build && !build.done) return { ok: false, error: "已有导入进行中" };
  if (st.total > STRUCTURE_LIMIT) return { ok: false, error: `结构太大：${st.total} 方块（上限 ${STRUCTURE_LIMIT}）` };

  const pos = await bridge.getPosition();
  if (!pos) return { ok: false, error: "拿不到机器人坐标" };
  const origin = { x: Math.floor(pos.x), y: Math.floor(pos.y) + Math.trunc(offsetY), z: Math.floor(pos.z) };
  const cmds = structureCommands(st, origin, 0);
  // 快照：结构 + 原点 + 名称来自同一次 build，校验只认它（P1-13）
  const snap = createVerifySnapshot({
    st,
    origin,
    name: st.name,
    pendingSeq,
    at: Date.now(),
    id: ++verifySnapshotSeq,
  });
  verifySnapshot = snap;
  build = {
    name: st.name,
    total: st.total,
    sent: 0,
    commands: cmds.length,
    origin,
    startedAt: Date.now(),
    done: false,
    cancelled: false,
    step: 1,
    stepLabel: "放置方块",
  };
  importStartedAt = Date.now();
  log(`开始导入「${st.name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块 / ${cmds.length} 条命令，原点 ${origin.x},${origin.y},${origin.z}`);
  log(`已登记校验快照 #${snap.id} ${snap.fingerprint}（结构名/原点/尺寸一起冻结，重新上传即失效）`);
  chat(`§e第 1/3 步：放置方块「${st.name}」 ${st.size.x}×${st.size.y}×${st.size.z}，共 ${st.total} 方块`);
  actionbar(`§e第 1/3 步 放置「${st.name}」 ${bar(0, cmds.length)}`);

  let idx = 0;
  let lastBar = 0;
  const tick = () => {
    buildTimer = null;
    if (!build || build.cancelled) return;
    if (!bridge.isConnected) {
      build.error = "机器人连接已断开";
      build.done = true;
      build.stepLabel = "已中断";
      invalidateSnapshot("导入第 1 步中断，原点状态不明");
      logError(`导入中断：机器人连接已断开`);
      return;
    }
    // 限速：每个节拍只发 1 条命令（默认 5 条/秒），避免触发网易反作弊
    if (idx < cmds.length) {
      const c = cmds[idx++];
      bridge.commandNoWait(`/${c.command}`);
      build.sent++;
    }
    if (Date.now() - lastBar > 1200 || idx >= cmds.length) {
      lastBar = Date.now();
      actionbar(`§e第 1/3 步 放置「${build.name}」 ${bar(idx, cmds.length)} §7(${CMD_RATE}/秒)`);
    }
    if (idx >= cmds.length) {
      setStep(2, "完整性校验");
      log(`「${st.name}」第 1 步完成（${cmds.length} 条命令，限速 ${CMD_RATE}/秒），2 秒后进入第 2 步校验`);
      build.stepLabel = "完整性校验";
      setTimeout(() => {
        verifyStructure(false)
          .then((r) => {
            if (!build) return;
            const b = build;
            b.done = true;
            b.step = 3;
            const partial = r.status === "partial";
            b.stepLabel = r.ok ? "已完成" : partial ? "部分完成" : "未完成";
            if (!r.ok) b.error = r.error ?? "校验未通过";
            if (r.ok) {
              const v = verify;
              actionbar(`§a✔ 导入完成「${b.name}」 三步全部通过`);
              chat(
                `§a✔ 导入完成（三步全部通过）：${b.name} · ${b.total} 方块 · 回读 ${v?.planned ?? 0} 点 · 补齐 ${v?.fixed ?? 0} 处`
              );
              log(`「${b.name}」三步全部通过：${b.total} 方块 / 回读 ${v?.planned ?? 0} 点 / 补齐 ${v?.fixed ?? 0} 处`);
            } else {
              // 没做完就如实说：部分完成 / 未完成，绝不写成"三步全部通过"
              const why = r.error ?? "未知原因";
              actionbar(`§c⚠ 导入完成但校验${partial ? "部分完成" : "未完成"}「${b.name}」`);
              chat(`§c⚠ 导入完成但校验${partial ? "部分完成" : "未完成"}：${b.name}（${why}）`);
              logError(`「${b.name}」校验${partial ? "部分完成" : "未完成"}：${why}`);
            }
            setTimeout(() => {
              if (build?.done) build = null;
            }, 15000);
          })
          .catch((e) => {
            logError(`校验异常：${e?.message ?? e}`);
            if (build) {
              build.done = true;
              build.stepLabel = "未完成";
              build.error = `校验异常：${e?.message ?? e}`;
            }
          });
      }, 2000);
      return;
    }
    buildTimer = setTimeout(tick, Math.max(30, Math.round(1000 / CMD_RATE)));
  };
  tick();
  return { ok: true, info: { name: st.name, size: st.size, total: st.total, commands: cmds.length, origin } };
}

/** ===== HTTP ===== */
function json(res: ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage, limit = 96 << 20): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;
    if (p === "/health") return json(res, 200, { ok: true, app: APP_NAME, connected: bridge.isConnected });

    if (p === "/status" && req.method === "GET") {
      const pos = await bridge.getPosition().catch(() => null);
      const identity = await bridge.identity().catch(() => null);
      const players = await bridge.players().catch(() => null);
      const bp = bridge.protocol;
      const protocolCheck = checkBotProtocol(bp.version, bp.gameVersion);
      return json(res, 200, {
        ok: true,
        app: APP_NAME,
        protocol: {
          ...protocolCheck,
          source: NETEASE_PROTOCOL.source,
          target: effectiveProtocolVersion(),
          targetGameVersion: gameVersionFor(effectiveProtocolVersion()),
          minSupported: NETEASE_PROTOCOL.minSupportedProtocol,
        },
        bridge: { connected: bridge.isConnected, socket: SOCKET_PATH, error: bridge.error || bridgeError },
        bot: { identity, position: pos, players },
        managedBot: managedBot ? managedBot.status : null,
        pending: pending
          ? { name: pending.st.name, size: pending.st.size, total: pending.st.total, uploadedAt: pending.uploadedAt, seq: pendingSeq }
          : null,
        verifySnapshot: snapshotBrief(verifySnapshot),
        build,
        verify,
        lastText,
        lastKick,
        serverNow: utc8(),
      });
    }

    if (p === "/prepare" && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "structure").replace(/\.mcstructure$/i, "").trim().slice(0, 80) || "structure";
      const data = String(body.data ?? "");
      if (!data) return json(res, 400, { ok: false, error: "缺少文件数据" });
      let buf: Buffer;
      try {
        buf = Buffer.from(data, "base64");
      } catch {
        return json(res, 400, { ok: false, error: "文件数据不是合法的 Base64" });
      }
      let st: ParsedStructure;
      try {
        st = parseStructureFile(buf, name);
      } catch (e: any) {
        return json(res, 200, { ok: false, error: `解析失败：${e?.message ?? e}` });
      }
      // 重新上传 = 世界里的旧结构和当前 pending 不再对应：旧快照必须失效
      pending = { st, uploadedAt: Date.now() };
      pendingSeq += 1;
      invalidateSnapshot(`结构重新上传为「${st.name}」（#${pendingSeq}）`);
      log(`已解析结构「${name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块（pending #${pendingSeq}）`);
      return json(res, 200, {
        ok: true,
        structure: { name: st.name, size: st.size, total: st.total, paletteSize: st.paletteSize, materials: st.materials },
        pendingSeq,
        /** 旧快照已清空：面板/CLI 看到 needsBuild 就知道要重新 build 才能校验 */
        needsBuild: true,
      });
    }

    if (p === "/build" && req.method === "POST") {
      const body = await readJson(req);
      if (!pending) return json(res, 200, { ok: false, error: "还没有上传结构文件" });
      const r = await startImport(pending.st, Number(body.offsetY ?? 0));
      return json(res, 200, r);
    }

    if (p === "/cancel" && req.method === "POST") {
      if (build && !build.done) {
        build.cancelled = true;
        build.done = true;
        build.stepLabel = "已取消";
        if (buildTimer) clearTimeout(buildTimer);
        invalidateSnapshot("导入被取消，世界只建了一半");
        chat("§c已取消导入");
        log("已取消导入");
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: false, error: "没有正在进行的导入" });
    }

    if (p === "/clear" && req.method === "POST") {
      pending = null;
      pendingSeq += 1;
      invalidateSnapshot("结构已清空");
      return json(res, 200, { ok: true });
    }

    if (p === "/verify" && req.method === "POST") {
      const body = await readJson(req);
      const deep = !!body.deep;
      const cap = Number(body.cap || 0) || undefined;
      // 前置检查同步做完：快照缺失/失效、导入未完成、桥断开都直接告知，不再"假 started"
      const pre = precheckVerify(deep, cap);
      if (!pre.ok) {
        logError(`拒绝校验：${pre.error}`);
        return json(res, 200, { ok: false, started: false, error: pre.error });
      }
      executeVerify(pre.plan).catch((e) => logError(`校验异常：${e?.message ?? e}`));
      return json(res, 200, {
        ok: true,
        started: true,
        deep,
        planned: pre.plan.planned,
        surfaceTotal: pre.plan.surfaceTotal,
        snapshot: snapshotBrief(pre.plan.snapshot),
      });
    }

    if (p === "/pos" && req.method === "POST") {
      const pos = await bridge.getPosition();
      return json(res, 200, pos ? { ok: true, ...pos } : { ok: false, error: "拿不到坐标" });
    }

    if (p === "/command" && req.method === "POST") {
      const body = await readJson(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { ok: false, error: "text 不能为空" });
      const r = await bridge.command(text, 20000);
      return json(res, 200, r);
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    logError(`请求处理异常：${e?.message ?? e}`);
    return json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

async function boot() {
  if (managedBot) {
    managedBot.start();
    const ready = await managedBot.waitReady();
    log(ready ? "托管机器人事件桥已就绪" : "托管机器人 30 秒内未创建 socket，继续尝试连接（桥会自动重连）");
  }
  if (!SOCKET_PATH) {
    logError("未设置 FB_NETEASE_SOCKET，无法连接机器人事件桥");
  } else {
    log(`${APP_NAME} 启动：事件桥 ${SOCKET_PATH}`);
    log(describeBaseline());
    bridge.subscribeEvents("cubeloom");
    bridge.connect();
  }
  server.listen(PORT, HOST, () => {
    log(`网易版服务已启动：http://${HOST}:${PORT}`);
  });
}

/** 退出时先把机器人收掉，避免孤儿进程占着游戏账号 */
function shutdown() {
  try { managedBot?.stop(); } catch {}
  try { bridge.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  try { managedBot?.stop(); } catch {}
});

boot();
