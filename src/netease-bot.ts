/**
 * 托管机器人进程（网易版）。
 *
 * 背景：网易租赁服没有 `/connect`，指令必须以"玩家"身份进服执行，所以必须有一个
 * 进服机器人。本模块负责**把机器人当作 Cubeloom 的托管子进程**：启动、等事件桥
 * socket 就绪、异常退出自动重启、退出时收尾。
 *
 * 机器人本体不在本仓库分发（见 packaging/netease-bot/README.md），任何能提供
 * NDJSON 事件桥（协议见 src/netease-bridge.ts）的实现都可以接：
 *
 *   FB_NETEASE_BOT_CMD="C:\\cubeloom\\netease-bot\\start-bot.cmd"
 *   FB_NETEASE_SOCKET="C:\\cubeloom\\netease-bot\\bot.sock"
 *
 * Windows 上如果用的是命名管道，socket 路径检测会退化成"等固定时间"——桥客户端
 * 自己会重连，所以不影响最终连上。
 */
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";

export type ManagedBotOptions = {
  /** 完整命令行（用 shell 执行，支持 .cmd/.bat/带参数） */
  command: string;
  /** 事件桥 socket 路径（用于就绪探测） */
  socketPath: string;
  cwd?: string;
  /** 等 socket 出现的最长时间，默认 30s */
  readyTimeoutMs?: number;
  /** 崩溃后重启延迟，默认 5s */
  restartDelayMs?: number;
  onLog?: (line: string) => void;
};

export type ManagedBotStatus = {
  managed: true;
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError?: string;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ManagedBot {
  private opts: Required<Pick<ManagedBotOptions, "readyTimeoutMs" | "restartDelayMs">> & ManagedBotOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private lastError = "";
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(opts: ManagedBotOptions) {
    this.opts = {
      readyTimeoutMs: 30_000,
      restartDelayMs: 5_000,
      ...opts,
    } as any;
  }

  private log(line: string) {
    this.opts.onLog?.(line);
  }

  /** 启动机器人；已在运行则忽略 */
  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.log(`托管机器人启动：${this.opts.command}`);
    let child: ChildProcess;
    try {
      child = spawn(this.opts.command, {
        shell: true,
        cwd: this.opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      this.log(`机器人启动失败：${this.lastError}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    const prefix = (d: Buffer) => d.toString("utf8").replace(/\s+$/, "");
    child.stdout?.on("data", (d: Buffer) => this.log(`[bot] ${prefix(d)}`));
    child.stderr?.on("data", (d: Buffer) => this.log(`[bot:err] ${prefix(d)}`));
    child.on("error", (e: Error) => {
      this.lastError = e.message;
      this.log(`机器人进程错误：${e.message}`);
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.log(`机器人已退出（code=${code} signal=${signal}）`);
      if (!this.stopping) this.scheduleRestart();
    });
  }

  /** 等事件桥 socket 就绪（文件存在或可连接） */
  async waitReady(timeoutMs = this.opts.readyTimeoutMs): Promise<boolean> {
    if (!this.opts.socketPath) return true;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.stopping) return false;
      try {
        if (fs.existsSync(this.opts.socketPath)) return true;
      } catch {
        /* 路径不存在继续等 */
      }
      // 进程已经挂了就不必等满超时
      if (!this.child && this.restarts === 0) return false;
      await sleep(300);
    }
    return false;
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      if (process.platform === "win32") child.kill();
      else if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    this.log("托管机器人已停止");
  }

  get status(): ManagedBotStatus {
    return {
      managed: true,
      running: !!this.child,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastError: this.lastError || undefined,
    };
  }

  private scheduleRestart() {
    if (this.stopping) return;
    this.restarts++;
    this.log(`机器人将在 ${this.opts.restartDelayMs}ms 后重启（第 ${this.restarts} 次）`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.start();
    }, this.opts.restartDelayMs);
    this.restartTimer.unref?.();
  }
}
