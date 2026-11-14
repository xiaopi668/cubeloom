/**
 * 网易账号登录助手（Go 子进程）。
 *
 * 为什么用子进程：网易 mpay 登录要做设备指纹注册、RSA/AES 加密、短信风控轮询，
 * 全部重写成 Node 只会引入一堆无法验证的加密细节。这里复用一个零依赖的 Go 实现
 * （vendor 在 tools/x19login/internal/neteasex19，MIT），Node 只负责驱动和脱敏。
 *
 * 口令只经过 stdin，不落盘、不进日志、不回传浏览器；拿到 token 后子进程立即退出。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 可能的仓库根：cwd（开发）与入口脚本所在目录（打包后的 server/） */
function candidateRoots(): string[] {
  const roots: string[] = [];
  const add = (p?: string) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.includes(abs)) roots.push(abs);
  };
  add(process.cwd());
  const entry = process.argv[1];
  if (entry) {
    const dir = path.dirname(path.resolve(entry));
    add(dir);
    add(path.dirname(dir));
  }
  return roots;
}

export type X19LoginMode = "email" | "phone" | "sms" | "sauth";

export type X19LoginRequest = {
  mode?: X19LoginMode;
  account?: string;
  password?: string;
  sauth?: string;
  project?: string;
  gv?: string;
  /** 设备指纹缓存路径；默认放在用户目录，跨启动复用，降低风控概率 */
  cache?: string;
};

export type X19LoginStatus =
  | "starting"
  | "need_password"
  | "need_sms"
  | "need_upstream"
  | "ok"
  | "error"
  | "cancelled";

export type X19LoginState = {
  status: X19LoginStatus;
  entityId: string;
  name: string;
  token: string;
  error: string;
  notices: string[];
  sms: { phone: string; upstream: boolean; number: string; content: string } | null;
  startedAt: number;
  finishedAt: number;
};

export type X19LoginHooks = {
  onLog?: (line: string) => void;
  timeoutMs?: number;
};

/** 找登录助手：环境变量 → 开发目录 → 打包目录 */
export function resolveX19LoginBinary(): string | null {
  const exe = process.platform === "win32" ? "x19login.exe" : "x19login";
  const candidates: string[] = [];
  const forced = (process.env.FB_X19LOGIN || "").trim();
  if (forced) candidates.push(forced);

  for (const root of candidateRoots()) {
    // 便携版/打包版：server/x19login 与入口脚本同目录
    candidates.push(path.join(root, exe));
    // 开发/源码运行（npm run admin 的 cwd 是仓库根）
    candidates.push(path.join(root, "tools", "x19login", "bin", exe));
    // 便携版从根目录启动时：<root>/server/x19login
    candidates.push(path.join(root, "server", exe));
  }
  // Electron：<resources>/x19login(.exe)
  const resources = (process as any).resourcesPath as string | undefined;
  if (resources) candidates.push(path.join(resources, exe));
  // 兜底：exe 同目录
  if (process.execPath) candidates.push(path.join(path.dirname(process.execPath), exe));

  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) return file;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

export function defaultDeviceCachePath(): string {
  const forced = (process.env.FB_X19_CACHE || "").trim();
  if (forced) return forced;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(home || ".", ".cubeloom", "x19-device.json");
}

/**
 * 一次登录会话。状态由 stdout 的 NDJSON 事件推进：
 *   starting → (need_password | need_sms | need_upstream)* → ok | error
 */
export class X19LoginSession {
  readonly state: X19LoginState;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private timer: NodeJS.Timeout | null = null;
  private timeoutMs: number;
  private hooks: X19LoginHooks;
  private stderrTail = "";
  private settled = false;
  private waiters: Array<(s: X19LoginState) => void> = [];

  constructor(request: X19LoginRequest, hooks: X19LoginHooks = {}) {
    this.hooks = hooks;
    this.timeoutMs = hooks.timeoutMs ?? 5 * 60_000;
    this.state = {
      status: "starting",
      entityId: "",
      name: "",
      token: "",
      error: "",
      notices: [],
      sms: null,
      startedAt: Date.now(),
      finishedAt: 0,
    };
    this.start(request);
  }

  private log(line: string) {
    this.hooks.onLog?.(line);
  }

  private start(request: X19LoginRequest) {
    const bin = resolveX19LoginBinary();
    if (!bin) {
      this.fail("缺少网易登录助手（tools/x19login/bin/x19login），请先运行 npm run build:x19login");
      return;
    }
    const payload: X19LoginRequest = {
      ...request,
      cache: request.cache || defaultDeviceCachePath(),
    };
    this.log(`启动登录助手：${bin}`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX 下单独成组：取消时能连助手派生的子进程一起收掉
        detached: process.platform !== "win32",
      });
    } catch (e: any) {
      this.fail(`登录助手启动失败：${e?.message ?? e}`);
      return;
    }
    this.child = child;
    child.on("error", (e) => this.fail(`登录助手进程错误：${e.message}`));
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.log(`[x19login] ${line.trim()}`);
    });
    child.stdout.on("data", (d: Buffer) => this.consume(d.toString("utf8")));
    // 用 close 而不是 exit：exit 可能早于 stdout 的 data 事件，
    // 会把「助手先报错再退出」误判成「意外退出」。
    child.on("close", (code, signal) => {
      this.child = null;
      if (this.settled) return;
      const tail = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
      this.fail(`登录进程意外退出（code=${code} signal=${signal}）${tail ? "：" + tail : ""}`);
    });
    this.timer = setTimeout(() => {
      this.fail(`登录超时（${Math.round(this.timeoutMs / 1000)} 秒）`);
      this.kill();
    }, this.timeoutMs);
    this.timer.unref?.();

    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (e: any) {
      this.fail(`向登录助手写入参数失败：${e?.message ?? e}`);
    }
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`[x19login] ${line}`);
        continue;
      }
      this.handle(msg);
    }
  }

  private handle(msg: any) {
    switch (msg?.event) {
      case "notice":
        this.pushNotice(String(msg.message ?? ""));
        break;
      case "password_required":
        this.state.status = "need_password";
        this.pushNotice("需要密码");
        break;
      case "sms_required":
        this.state.status = "need_sms";
        this.state.sms = { phone: String(msg.phone ?? ""), upstream: false, number: "", content: "" };
        this.pushNotice(`已发送短信验证码到 ${msg.phone ?? "手机号"}`);
        break;
      case "sms_upstream":
        this.state.status = "need_upstream";
        this.state.sms = {
          phone: String(msg.phone ?? ""),
          upstream: true,
          number: String(msg.number ?? ""),
          content: String(msg.content ?? ""),
        };
        this.pushNotice(`网易要求上行短信：发送「${msg.content}」到 ${msg.number}`);
        break;
      case "result": {
        const token = String(msg.token ?? "");
        if (!token) {
          this.fail("登录助手没有返回 token");
          break;
        }
        this.state.status = "ok";
        this.state.token = token;
        this.state.entityId = String(msg.entity_id ?? "");
        this.state.name = String(msg.name ?? "");
        this.state.sms = null;
        this.settle();
        this.kill();
        break;
      }
      case "error":
        this.fail(String(msg.message ?? "登录失败"));
        break;
      default:
        this.log(`[x19login] 未知事件：${JSON.stringify(msg).slice(0, 200)}`);
    }
  }

  private pushNotice(text: string) {
    if (!text) return;
    this.state.notices.push(text);
    if (this.state.notices.length > 50) this.state.notices.shift();
    this.log(`[x19login] ${text}`);
  }

  private settle() {
    this.settled = true;
    this.state.finishedAt = Date.now();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w(this.state);
  }

  private fail(message: string) {
    if (this.settled) return;
    this.state.status = "error";
    this.state.error = message;
    this.log(`登录失败：${message}`);
    this.settle();
  }

  private kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill();
    } catch {
      try { child.kill(); } catch {}
    }
  }

  /** 提交短信验证码 */
  submitCode(code: string): boolean {
    if (this.state.status !== "need_sms" || !this.child) return false;
    this.state.status = "starting";
    this.write({ code: String(code ?? "").trim() });
    return true;
  }

  /** 上行短信已发送 */
  ackUpstream(): boolean {
    if (this.state.status !== "need_upstream" || !this.child) return false;
    this.state.status = "starting";
    this.write({ ack: "ok" });
    return true;
  }

  /** 补交密码（正常情况下不会走到） */
  submitPassword(password: string): boolean {
    if (this.state.status !== "need_password" || !this.child) return false;
    this.state.status = "starting";
    this.write({ password: String(password ?? "") });
    return true;
  }

  private write(obj: unknown) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + "\n");
    } catch (e: any) {
      this.fail(`写入登录助手失败：${e?.message ?? e}`);
    }
  }

  cancel() {
    if (this.settled) return;
    this.state.status = "cancelled";
    this.state.error = "已取消";
    this.settle();
    this.kill();
  }

  /** 等一个终态（ok / error / cancelled） */
  wait(timeoutMs = this.timeoutMs): Promise<X19LoginState> {
    if (this.settled) return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onState);
        resolve(this.state);
      }, timeoutMs);
      timer.unref?.();
      const onState = (s: X19LoginState) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.waiters.push(onState);
    });
  }

  /** 给接口返回用的快照（永远不含 token 之外的敏感信息；token 单独取） */
  snapshot() {
    return {
      status: this.state.status,
      entityId: this.state.entityId,
      name: this.state.name,
      error: this.state.error,
      sms: this.state.sms,
      notices: this.state.notices.slice(-20),
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
    };
  }
}
