/**
 * 网易版校验（P1-13）回归测试
 *
 * 锁死三件事：
 *   1) 校验只认 build 时冻下来的快照 {st, origin, name}，重新上传/prepare 之后
 *      旧快照必须失效——不允许出现「A 的结构 + B 的原点」；
 *   2) 三步语义是真的：抽样回读 → 补建一轮 → 复检剩余，fixed 只能是真正补上的
 *      数量，failed 只是复检后仍失败的，未完成就说未完成；
 *   3) 桥断开/超时 = 中断，必须带 error，不能报"全部通过"。
 *
 * 用假的 bridge（只暴露 sendCommand）驱动，不启动服务、不连 socket。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createVerifySnapshot,
  planVerify,
  resolveVerifySnapshot,
  runVerifyPlan,
  summarizeVerify,
  classifyCommandReceipt,
  type BridgeResult,
  type PendingStructureRef,
  type VerifyBridge,
  type VerifyPointOutcome,
} from "../src/netease-bridge";
import { parseMcStructure, type ParsedStructure } from "../src/structure";
import { checkBotProtocol } from "../src/netease-protocol";
import { makeStructure } from "./helpers";

/** 1×1×N 的石头柱：每个方块都在表面（x==0==sx-1，y==0==sy-1），抽样必然覆盖全部点 */
function column(name: string, n: number): ParsedStructure {
  const buf = makeStructure({
    size: [1, 1, n],
    palette: ["minecraft:stone"],
    indices: new Array(n).fill(0),
  });
  return parseMcStructure(buf, name);
}

const okReply = (): BridgeResult => ({ ok: true, data: { command_success: true } });
/** 幂等 setblock 的"方块本来就在"回执 */
const noChangeReply = (): BridgeResult => ({
  ok: true,
  data: { echo: { messages: [{ success: false, message: "Block already here (noChange)" }] } },
});
/** 指令层面失败（缺方块） */
const failReply = (): BridgeResult => ({
  ok: true,
  data: { echo: { messages: [{ success: false, message: "The block couldn't be placed" }] } },
});

type ScriptedBridge = VerifyBridge & { sent: string[] };

/** 按「命令 + 第几次」决定回执的假 bridge */
function scriptedBridge(reply: (text: string, attempt: number) => BridgeResult | Promise<BridgeResult>): ScriptedBridge {
  const attempts = new Map<string, number>();
  const sent: string[] = [];
  return {
    sent,
    isConnected: () => true,
    async sendCommand(text: string) {
      sent.push(text);
      const n = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, n);
      return reply(text, n);
    },
  };
}

/** 从 /setblock x y z block 里取世界坐标 */
function coordsOf(text: string): { x: number; y: number; z: number } {
  const m = /\/setblock (-?\d+) (-?\d+) (-?\d+)/.exec(text);
  assert.ok(m, `拿不到坐标：${text}`);
  return { x: Number(m![1]), y: Number(m![2]), z: Number(m![3]) };
}

test("重新上传后旧快照失效：不会出现 A 的结构配 B 的原点", () => {
  const stA = column("A", 4);
  const stB = column("B", 4);
  const pendingA: PendingStructureRef = { name: stA.name, seq: 1, st: stA };
  const pendingB: PendingStructureRef = { name: stB.name, seq: 2, st: stB };

  const snapA = createVerifySnapshot({ st: stA, origin: { x: 0, y: 0, z: 0 }, name: "A", pendingSeq: 1, id: 1 });
  assert.equal(resolveVerifySnapshot(snapA, pendingA).ok, true);

  // 即使旧快照"漏网"没被清掉，pending 序号/引用对不上也必须拒绝
  const stale = resolveVerifySnapshot(snapA, pendingB);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /失效|请先 build/);

  // 服务侧 /prepare 的真实做法：清空快照 → verify 直接报"请先导入/build"
  const cleared = resolveVerifySnapshot(null, pendingB);
  assert.equal(cleared.ok, false);
  if (!cleared.ok) assert.match(cleared.error, /请先 build|还没有可校验/);

  // 重新 build 之后：新快照绑定 B 的结构 + B 的原点
  const snapB = createVerifySnapshot({ st: stB, origin: { x: 500, y: 80, z: -200 }, name: "B", pendingSeq: 2, id: 2 });
  const resolved = resolveVerifySnapshot(snapB, pendingB);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const plan = planVerify({ snapshot: resolved.snapshot, cap: 10 });
  assert.equal(plan.planned, 4);
  assert.deepEqual([...new Set(plan.points.map((p) => p.x))], [500]);
  assert.deepEqual([...new Set(plan.points.map((p) => p.y))], [80]);
  assert.deepEqual([...new Set(plan.points.map((p) => p.z))].sort((a, b) => a - b), [-200, -199, -198, -197]);
  // A 的坐标一个都不能出现
  assert.ok(plan.points.every((p) => !(p.x === 0 && p.y === 0 && p.z === 0)));
  assert.notEqual(snapA.fingerprint, snapB.fingerprint);

  // 快照是复制品：外部改 st.blocks 不会污染已冻结的快照
  stB.blocks[0].x = 999;
  assert.equal(resolved.snapshot.st.blocks[0].x, 0);
});

test("抽样 10 点、3 点首轮失败 → fixed=2 / failed=1，状态是「部分完成」", async () => {
  const st = column("partial", 10);
  const snapshot = createVerifySnapshot({ st, origin: { x: 100, y: 64, z: 0 }, name: st.name, pendingSeq: 1, id: 1 });
  const plan = planVerify({ snapshot, cap: 10 });
  assert.equal(plan.planned, 10);

  const flaky = new Set([5, 6, 7]); // 首轮失败的 3 点（原点 z=0，世界 z 就是局部 z）
  const repaired = new Set([5, 6]); // 补建轮被真正补上的 2 点
  const bridge = scriptedBridge((text, attempt) => {
    const { z } = coordsOf(text);
    if (!flaky.has(z)) return okReply();
    if (attempt === 1) return failReply();
    return repaired.has(z) ? noChangeReply() : failReply();
  });

  const result = await runVerifyPlan(plan, bridge, { delayMs: 0, sleep: async () => {} });

  assert.equal(result.planned, 10);
  assert.equal(result.checked, 10);
  assert.equal(result.unchecked, 0);
  assert.equal(result.firstMissing, 3);
  assert.equal(result.fixed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.unverified, 0);
  assert.equal(result.status, "partial");
  assert.match(result.message, /部分完成/);
  assert.ok(!result.message.includes("全部通过"));
  // 首轮 10 条 + 补建 3 条 + 复检 1 条
  assert.equal(bridge.sent.length, 14);

  // fixed 只统计真正补上的（首轮就在位的不算）
  const fixedPoints = result.outcomes.filter((o) => o.confirmed && !o.firstPass);
  assert.equal(fixedPoints.length, 2);
  assert.deepEqual(fixedPoints.map((o) => o.z).sort((a, b) => a - b), [5, 6]);
});

test("桥断开 / 指令抛异常 → verify 返回 error 且状态是中断，不报成功", async () => {
  const st = column("abort", 10);
  const snapshot = createVerifySnapshot({ st, origin: { x: 10, y: 20, z: 30 }, name: st.name, pendingSeq: 7, id: 3 });
  const plan = planVerify({ snapshot, cap: 10 });

  // 场景 1：isConnected() 变 false（事件桥断开）
  let sent = 0;
  const disconnecting: VerifyBridge = {
    isConnected: () => sent < 2,
    async sendCommand() {
      sent++;
      return okReply();
    },
  };
  const r1 = await runVerifyPlan(plan, disconnecting, { delayMs: 0 });
  assert.equal(r1.status, "aborted");
  assert.ok(r1.error && r1.error.length > 0, "中断必须带 error");
  assert.equal(r1.checked, 2);
  assert.equal(r1.unchecked, 8);
  assert.equal(r1.fixed, 0);
  assert.equal(r1.failed, 0, "没轮到的点不能算失败");
  assert.match(r1.message, /未完成/);
  assert.ok(!r1.message.includes("全部通过"));

  // 场景 2：sendCommand 直接抛异常（通道坏了）
  let n = 0;
  const throwing: VerifyBridge = {
    isConnected: () => true,
    async sendCommand() {
      n++;
      if (n >= 3) throw new Error("事件桥已断开");
      return okReply();
    },
  };
  const r2 = await runVerifyPlan(plan, throwing, { delayMs: 0 });
  assert.equal(r2.status, "aborted");
  assert.match(String(r2.error), /事件桥已断开/);
  assert.equal(r2.checked, 3);
  assert.equal(r2.unchecked, 7);
  assert.equal(r2.failed, 0);
});

test("checkBotProtocol 区分「比目标旧」「比目标新」和「低于最低支持」", () => {
  const noEnv: NodeJS.ProcessEnv = {}; // 不覆盖基线：期望 898

  const same = checkBotProtocol(898, null, noEnv);
  assert.equal(same.level, "ok");

  const older = checkBotProtocol(860, "1.21.120", noEnv);
  assert.equal(older.level, "warn");
  assert.match(older.message, /低于目标 898/);

  const newer = checkBotProtocol(900, null, noEnv);
  assert.equal(newer.level, "newer");
  assert.match(newer.message, /高于本项目基线/);
  assert.ok(!/低于目标/.test(newer.message), "比目标新不能写成「低于目标」");

  const tooOld = checkBotProtocol(700, null, noEnv);
  assert.equal(tooOld.level, "error");
  assert.match(tooOld.message, /低于最低支持/);

  const unknown = checkBotProtocol(null, null, noEnv);
  assert.equal(unknown.level, "warn");
  assert.match(unknown.message, /未上报/);

  // 环境变量覆盖基线后，判断要跟着走
  const overridden = checkBotProtocol(898, null, { FB_NETEASE_PROTOCOL: "900" } as NodeJS.ProcessEnv);
  assert.equal(overridden.level, "warn");
  assert.match(overridden.message, /低于目标 900/);
});

test("summarizeVerify：只有全部在位才算 passed，没轮到的点不算失败", () => {
  const outcome = (patch: Partial<VerifyPointOutcome>): VerifyPointOutcome => ({
    lx: 0,
    ly: 0,
    lz: 0,
    x: 0,
    y: 0,
    z: 0,
    block: "minecraft:stone",
    command: "/setblock 0 0 0 minecraft:stone",
    attempts: 0,
    firstPass: false,
    repaired: false,
    recheckPass: false,
    recheckFailed: false,
    confirmed: false,
    ...patch,
  });
  const meta = { planned: 4, surfaceTotal: 4, snapshotName: "s", snapshotId: 1, fingerprint: "s:1x1x4:4@0,0,0#p1" };

  const passed = summarizeVerify(
    [
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
    ],
    meta
  );
  assert.equal(passed.status, "passed");
  assert.equal(passed.fixed, 0);
  assert.equal(passed.failed, 0);
  assert.match(passed.message, /三步全部通过/);

  const partial = summarizeVerify(
    [
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
      outcome({ attempts: 1, firstPass: true, confirmed: true }),
      outcome({ attempts: 2, repaired: true, confirmed: true }),
      outcome({ attempts: 3, recheckFailed: true }),
    ],
    meta
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.fixed, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.unverified, 0);
  assert.match(partial.message, /补齐 1 处/);
  assert.ok(!partial.message.includes("全部通过"));

  // 中断：只试过 1 点，另外 3 点没轮到 → unchecked，不是 failed
  const cut = summarizeVerify(
    [outcome({ attempts: 1, firstPass: true, confirmed: true }), outcome({}), outcome({}), outcome({})],
    { ...meta, abortReason: "事件桥已断开" }
  );
  assert.equal(cut.status, "aborted");
  assert.equal(cut.checked, 1);
  assert.equal(cut.unchecked, 3);
  assert.equal(cut.failed, 0);
  assert.equal(cut.unverified, 0);
  assert.equal(cut.error, "事件桥已断开");
  assert.match(cut.message, /未完成/);
});

test("幂等 setblock 回执分类：noChange 视为在位，桥层错误才是致命", () => {
  assert.deepEqual(classifyCommandReceipt(okReply()), {
    confirmed: true,
    missing: false,
    fatal: null,
  });

  const noChange = classifyCommandReceipt(noChangeReply());
  assert.equal(noChange.confirmed, true);
  assert.equal(noChange.missing, false);
  assert.equal(noChange.fatal, null);

  const allOk = classifyCommandReceipt({ ok: true, data: { echo: { messages: [{ success: true }, { success: true }] } } });
  assert.equal(allOk.confirmed, true);

  const failed = classifyCommandReceipt(failReply());
  assert.equal(failed.confirmed, false);
  assert.equal(failed.missing, true);
  assert.equal(failed.fatal, null, "单点指令失败不是桥故障，要进补建轮");
  assert.match(String(failed.error), /couldn't be placed/);

  const timeout = classifyCommandReceipt({ ok: false, error: "指令超时：command" });
  assert.equal(timeout.confirmed, false);
  assert.match(String(timeout.fatal), /指令超时/);

  const dropped = classifyCommandReceipt({ ok: false, error: "事件桥已断开" });
  assert.match(String(dropped.fatal), /事件桥已断开/);

  const empty = classifyCommandReceipt(undefined);
  assert.equal(empty.confirmed, false);
  assert.equal(empty.fatal, null);
});
