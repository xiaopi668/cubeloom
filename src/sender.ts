/**
 * 结构导入的「在途命令」追踪与等待。
 *
 * 修复 P1-5：原来的 `inFlight` 是 startStructureBuild 里的一个闭包变量，跨补建轮
 * 共享，且只在游戏回执回调里自减。mcpews 在连接关闭或回执丢失时不会调用回调，
 * 于是 inFlight 只增不减；waitIdle 8 秒超时后带着 inFlight > 0 进入下一轮，发送
 * 窗口被永久占满 → pump 每 12ms 空转、finish() 永不执行，`/structure/build|verify`
 * 被 `build.done === false` 永久挡住，只能人工 cancel。
 *
 * 现在：
 *   · 每一轮（首次 / 每轮补建）各用一个 InFlightTracker，轮与轮之间互不影响；
 *   · 超时或停滞时 tracker.abandon() 把未回执命令交回失败队列——setblock 是幂等的，
 *     重发安全；
 *   · 迟到回执 ack() 返回 false 被忽略，不会误减下一轮的计数；
 *   · 发送停滞（窗口占满且长时间没有任何回执）也会触发 abandon，不再空转。
 */

export type PendingCommand = { command: string; count: number };

export class InFlightTracker {
  private pending = new Set<PendingCommand>();
  private abandoned = false;

  get inFlight(): number {
    return this.pending.size;
  }

  get abandonedRound(): boolean {
    return this.abandoned;
  }

  track(cmd: PendingCommand): void {
    if (this.abandoned) return;
    this.pending.add(cmd);
  }

  /** 返回 true 表示这次回执属于本轮且未被重复处理 */
  ack(cmd: PendingCommand): boolean {
    if (this.abandoned) return false;
    return this.pending.delete(cmd);
  }

  /** 结束本轮：返回仍未回执的命令，并让后续回执全部失效 */
  abandon(): PendingCommand[] {
    this.abandoned = true;
    const left = [...this.pending];
    this.pending.clear();
    return left;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 等本轮回执全部回来；超时则放弃本轮并返回未回执命令。
 * 返回值只会是非空数组（超时/停滞）或空数组（全部回执）。
 */
export async function waitForIdle(opts: {
  tracker: InFlightTracker;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PendingCommand[]> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const intervalMs = opts.intervalMs ?? 80;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const started = now();
  while (opts.tracker.inFlight > 0 && now() - started <= timeoutMs) {
    await wait(intervalMs);
  }
  if (opts.tracker.inFlight > 0) return opts.tracker.abandon();
  return [];
}
