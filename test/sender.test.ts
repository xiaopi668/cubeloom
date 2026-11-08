/**
 * 发送窗口 / 回执追踪回归（P1-5）
 *
 * 锁死三件事：
 *  1. 回执丢了要能超时收场，未回执命令交回失败队列（setblock 幂等，可重发）；
 *  2. 上一轮放弃后，迟到回执不能让下一轮计数变负或误判；
 *  3. 新的一轮从 inFlight=0 开始，不会被上一轮的残留占满窗口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { InFlightTracker, waitForIdle } from "../src/sender";

const cmd = (command: string, count = 1) => ({ command, count });

test("全部回执：waitForIdle 返回空数组", async () => {
  const tracker = new InFlightTracker();
  const a = cmd("setblock 0 0 0 stone");
  const b = cmd("setblock 0 0 1 stone");
  tracker.track(a);
  tracker.track(b);
  assert.equal(tracker.inFlight, 2);
  setTimeout(() => {
    tracker.ack(a);
    tracker.ack(b);
  }, 5);
  const lost = await waitForIdle({ tracker, timeoutMs: 100, intervalMs: 5 });
  assert.deepEqual(lost, []);
  assert.equal(tracker.inFlight, 0);
});

test("回执丢失：超时放弃，返回未回执命令，迟到回执被忽略", async () => {
  const tracker = new InFlightTracker();
  const a = cmd("setblock 0 0 0 stone");
  const b = cmd("setblock 0 0 1 stone");
  tracker.track(a);
  tracker.track(b);
  tracker.ack(a);
  const lost = await waitForIdle({ tracker, timeoutMs: 30, intervalMs: 5 });
  assert.equal(lost.length, 1);
  assert.equal(lost[0], b);
  assert.equal(tracker.abandonedRound, true);
  // 迟到回执：不能再算作确认
  assert.equal(tracker.ack(b), false);
  assert.equal(tracker.inFlight, 0);
});

test("新一轮从 0 开始：上一轮残留不会占满窗口（P1-5 回归）", async () => {
  const round1 = new InFlightTracker();
  for (let i = 0; i < 24; i++) round1.track(cmd(`setblock 0 0 ${i} stone`));
  const lost = await waitForIdle({ tracker: round1, timeoutMs: 20, intervalMs: 5 });
  assert.equal(lost.length, 24);

  const round2 = new InFlightTracker();
  assert.equal(round2.inFlight, 0, "新的一轮必须是空的");
  assert.equal(round2.abandonedRound, false);
  const c = cmd("setblock 1 0 0 gold_block");
  round2.track(c);
  round2.ack(c);
  assert.equal(round2.inFlight, 0);
  // 上一轮的迟到回执不能影响这一轮
  round1.ack(c);
  assert.equal(round2.inFlight, 0);
});

test("重复回执只计一次", () => {
  const tracker = new InFlightTracker();
  const c = cmd("setblock 0 0 0 stone");
  tracker.track(c);
  assert.equal(tracker.ack(c), true);
  assert.equal(tracker.ack(c), false);
  assert.equal(tracker.inFlight, 0);
});

test("放弃后不再接收新命令", () => {
  const tracker = new InFlightTracker();
  tracker.abandon();
  tracker.track(cmd("setblock 0 0 0 stone"));
  assert.equal(tracker.inFlight, 0);
});

test("放弃后立即唤醒等待者（不用等满超时）", async () => {
  const tracker = new InFlightTracker();
  tracker.track(cmd("setblock 0 0 0 stone"));
  const started = Date.now();
  setTimeout(() => tracker.abandon(), 10);
  const lost = await waitForIdle({ tracker, timeoutMs: 200, intervalMs: 5 });
  assert.deepEqual(lost, []);
  assert.ok(Date.now() - started < 150, "abandon 后应尽快返回");
});
