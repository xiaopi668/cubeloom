/**
 * 聊天栏 / 控制口执行的 JS 沙箱。
 *
 * ── 旧实现的问题（P0-1）───────────────────────────────────────────────────────
 * 第一版是 `new Function("inside", "with(inside){...}")`：宿主全局直接可达。
 * 第二版改用 `node:vm` 上下文，挡掉了 `process` / `require` / `Function(...)`
 * 这条最短路径，但**注入给脚本的 API 仍然是宿主对象**：
 *
 *     plot.constructor('return process')().getBuiltinModule('child_process')...
 *
 * `plot` / `setBlocks` / `session` / 以及 `sphere(3,0)` 返回的 `Vec3` 实例都是宿主
 * realm 的对象，它们的 `.constructor` 是宿主的 `Function`，于是 5 秒超时之外
 * 一切都白搭。→ 宿主 RCE。
 *
 * ── 现在的结构 ───────────────────────────────────────────────────────────────
 * 每条脚本新建一个上下文，里面只有两种东西：
 *
 *   1. **几何库**：`@pureeval/voxel-geometry` 由 esbuild 打成 IIFE（`src/sandbox-bundle.ts`），
 *      在上下文**内部**求值，再把命名空间平铺到全局。`sphere(2,0)` 返回的是上下文
 *      自己的 `Vec3`，`.constructor` 是上下文的 `Function`（被 codeGeneration 钉死）。
 *      脚本里能用到的几何 API 全部来自这里，宿主注入的同名函数会被覆盖。
 *      例外是 `Exp.equation` / `Exp.parametric`：它们在库内部用 `new Function` 编译
 *      表达式字符串（`simple_equation("x*x+y*y+z*z<=5", …)` 就是这么来的）。
 *      bundle 外面套了一层 `(function (Function) { … })(表达式 realm 的 Function)`，
 *      把这个构造器**只在 bundle 内部**遮蔽掉：表达式在另一个空 realm 里编译，
 *      那个 realm 里没有 process / require / 宿主回调，表达式只能算数学；
 *      沙箱 realm 的 `Function` 仍然被拦，脚本也拿不到那个构造器。
 *
 *   2. **宿主桥**：`plot` / `pos` / `setBlocks` / `tell_raw` / `session` / `setting`
 *      这些必须碰到宿主的 API，由上下文里的“包装工厂”包一层后再交给脚本：
 *        · 脚本只拿到*上下文函数*，闭包里握着宿主回调，脚本摸不到宿主 realm；
 *        · 参数进宿主前先 JSON 往返 → 宿主只看到普通数据（数字/字符串/数组/对象）；
 *        · 宿主返回值：函数再包一层上下文函数（`setBlocks(session)("stone")(space)`
 *          这种柯里化才还能用），对象 JSON 往返后 `JSON.parse` 进上下文，
 *          其余标量直通。宿主异常也会被改写成上下文 `Error`，绝不原样抛给脚本；
 *        · 注入的 `session` / `setting` 深拷贝成上下文对象，方法逐层包装；
 *        · 脚本改 `setting.block` / `setting.origin.x` 后回写宿主（每次调用宿主前
 *          和每条脚本结束后各同步一次，所以同一条脚本里改完就能影响 `plot`）。
 *
 * 仍然保留：`codeGeneration.strings:false` / `wasm:false`、`FB_SANDBOX_TIMEOUT`
 * 同步超时、每次执行新建上下文（顶层 `const` 不跨次冲突）。
 *
 * 已知残余风险 / 行为变化：
 *   · 这不是“无能力”沙箱。拿到进程内 JS 执行的脚本仍可**通过 API 本身**做它本来
 *     就能做的事（`setBlocks` 发几十万条命令、`session.sendCommand` 发任意原版命令、
 *     把整张地图刷掉）——这是功能，不是漏洞。真正的边界是 `--login` 认证；
 *     沙箱只保证“脚本拿不到宿主 realm 对象”。
 *   · 脚本传给宿主的**函数**参数会被丢掉（`toHost` 对函数返回 undefined）：
 *     `session.subscribe("X", fn)` / `sendCommand(cmd, cb)` 这类带回调的写法不再工作，
 *     会得到一个上下文 `Error`（旧实现里回调能传过去）。字符参数/数据参数不受影响。
 *   · 宿主实例（`session.server` 之类 socket/ws 对象）不进镜像，脚本里是 `undefined`。
 *   · 每条脚本都会重新求值一遍几何 bundle（≈5–7ms/条，60KB），换来的是
 *     “顶层 const 不跨次冲突 + 上下文里没有上一次的残留”。
 */
import vm from "node:vm";
import { createExpressionCompiler, geometryBundleFactoryScript } from "./sandbox-bundle";

/** 单条命令的同步执行上限（毫秒），防止 `-while(true){}` 之类把实例卡死 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 下限：太小的超时会让正常的大体素计算直接失败 */
const MIN_TIMEOUT_MS = 100;

/**
 * 每次 eval 重新读 `FB_SANDBOX_TIMEOUT`。
 *
 * 旧实现是模块加载时读一次；改成按次读取，测试里可以临时注入 200ms 验证超时，
 * 运维改环境变量后也不用重启进程。默认/下限语义保持不变。
 */
function execTimeoutMs(): number {
  const raw = Number(process.env.FB_SANDBOX_TIMEOUT ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, raw);
}

/**
 * 上下文里的桥接引导（可信源码，由宿主编译成 vm.Script 后求值）。
 *
 * 它的产物是一个对象 `{ names, env, install }`，只被宿主持有，脚本永远拿不到
 * 它的引用；脚本能看到的一切都已经被转成上下文 realm 的普通对象/函数。
 */
const BOOTSTRAP_SOURCE = `(function (beforeHostCall) {
  "use strict";

  /** 上下文镜像 -> 宿主原对象：脚本把注入对象传回宿主时按表还原 */
  var hostRefs = new WeakMap();
  /** 宿主函数 -> 上下文包装函数（同一函数复用同一个包装，引用保持稳定） */
  var callCache = new WeakMap();
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var MAX_DEPTH = 5;

  /** 宿主 realm 的普通对象（proto 是宿主的 Object.prototype，其 proto 为 null） */
  function isPlainHostObject(value) {
    var proto = Object.getPrototypeOf(value);
    if (proto === null) return true;
    if (Object.getPrototypeOf(proto) !== null) return false;
    return Object.prototype.hasOwnProperty.call(proto, "hasOwnProperty");
  }

  /** 只镜像"纯数据"：数组、普通对象、{x,y,z} 形状。宿主实例（socket/ws server）不进来 */
  function isDataLike(value) {
    if (Array.isArray(value)) return true;
    try {
      if (isPlainHostObject(value)) return true;
      return typeof value.x === "number" && typeof value.y === "number" && typeof value.z === "number";
    } catch (e) {
      return false;
    }
  }

  /**
   * 脚本值 -> 宿主可消费的数据。
   *
   * 宿主自己注入的对象/方法（handles 表里有记录）原样还回去，这样
   * setBlocks(session)("minecraft:stone")(...) 里的 session 还是宿主那个会话对象；
   * 其余对象一律 JSON 往返，剥掉原型链和 getter，宿主只看到普通数据。
   */
  function toHost(value) {
    if (value === null) return null;
    var type = typeof value;
    if (type === "string" || type === "number" || type === "boolean" || type === "undefined") return value;
    if (type === "bigint") return Number(value);
    if (type === "function") return undefined;
    if (type !== "object") return undefined;
    var original = hostRefs.get(value);
    if (original !== undefined) return original;
    try {
      var text = stringify(value);
      return text === undefined ? undefined : parse(text);
    } catch (e) {
      return undefined;
    }
  }

  /** 宿主返回值 -> 上下文值：函数包一层，对象 JSON 进上下文，标量直通 */
  function fromHost(value, label) {
    if (typeof value === "function") return wrap(value, label);
    if (value === null) return null;
    var type = typeof value;
    if (type === "undefined" || type === "string" || type === "number" || type === "boolean") return value;
    if (type === "bigint" || type === "symbol") {
      try {
        return String(value);
      } catch (e) {
        return "[宿主返回值无法序列化]";
      }
    }
    try {
      var text = stringify(value);
      if (text === undefined) return String(value);
      return parse(text);
    } catch (e) {
      return "[宿主返回值无法序列化]";
    }
  }

  /** 把宿主函数包成上下文函数：脚本只能看到这一层 */
  function wrap(hostFn, label) {
    var cached = callCache.get(hostFn);
    if (cached !== undefined) return cached;

    var wrapper = function () {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(toHost(arguments[i]));
      // 调宿主前先把 setting 之类的改动回写，保证同一条脚本里改完就生效
      if (typeof beforeHostCall === "function") {
        try {
          beforeHostCall();
        } catch (e) {
          /* 回写失败不影响主调用 */
        }
      }
      var result;
      try {
        result = hostFn.apply(undefined, args);
      } catch (err) {
        // 宿主异常是宿主对象：只把 message 文本带进上下文
        var message = "宿主函数执行失败";
        try {
          message = String(err && err.message !== undefined ? err.message : err);
        } catch (e2) {
          /* 保持默认文案 */
        }
        throw new Error(label ? label + ": " + message : message);
      }
      return fromHost(result, label);
    };

    callCache.set(hostFn, wrapper);
    return wrapper;
  }

  /** 原型链上的方法（含继承来的）：只在最外层对象上补一遍 */
  function collectMethods(source) {
    var out = [];
    var taken = Object.create(null);
    var proto = Object.getPrototypeOf(source);
    while (proto !== null) {
      var names = Object.getOwnPropertyNames(proto);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (name === "constructor" || taken[name]) continue;
        var desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== "function") continue;
        taken[name] = true;
        out.push([name, desc.value]);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return out;
  }

  function copyObject(source, target, depth, seen) {
    if (Array.isArray(source)) {
      var length = source.length;
      for (var i = 0; i < length; i++) target[i] = mirror(source[i], depth + 1, seen);
      return;
    }

    var keys = Object.keys(source);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key.charAt(0) === "_") continue; // 内部字段（_events 之类）不暴露
      var value;
      try {
        value = source[key];
      } catch (e) {
        continue;
      }
      if (value !== null && typeof value === "object" && !isDataLike(value)) continue;
      target[key] = typeof value === "function" ? wrap(value.bind(source), key) : mirror(value, depth + 1, seen);
    }

    if (depth === 0) {
      var methods = collectMethods(source);
      for (var m = 0; m < methods.length; m++) {
        var name = methods[m][0];
        if (name in target) continue; // 已有同名（含上下文 Object.prototype）就不覆盖
        target[name] = wrap(methods[m][1].bind(source), name);
      }
    }
  }

  /** 宿主值 -> 上下文镜像（原型链不会跟着过来，方法逐个包装） */
  function mirror(value, depth, seen) {
    if (value === null) return null;
    var type = typeof value;
    if (type === "string" || type === "number" || type === "boolean" || type === "undefined") return value;
    if (type === "function") return wrap(value, "");
    if (type === "bigint") return Number(value);
    if (type !== "object") return undefined;
    if (depth > MAX_DEPTH) return undefined;

    var cached = seen.get(value);
    if (cached !== undefined) return cached;

    var target = Array.isArray(value) ? [] : {};
    seen.set(value, target);
    hostRefs.set(target, value);
    copyObject(value, target, depth, seen);
    return target;
  }

  /** 把几何库的命名空间平铺到全局：sphere / circle / move / vec3 / Turtle2D ... */
  function flattenBundle() {
    var names = [];
    var geometry = globalThis.VG;
    if (!geometry || typeof geometry !== "object") return names;
    var keys = Object.keys(geometry);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = geometry[key];
      if (value === null || value === undefined) continue;
      if (typeof value === "function") {
        globalThis[key] = value;
        names.push(key);
        continue;
      }
      if (typeof value !== "object") continue;
      var inner = Object.keys(value);
      for (var j = 0; j < inner.length; j++) {
        var name = inner[j];
        if (typeof value[name] !== "function") continue;
        globalThis[name] = value[name];
        names.push(name);
      }
    }
    return names;
  }

  var names = flattenBundle();
  var env = Object.create(null);

  return {
    /** 几何库提供的全局名：宿主注入的同名项以 bundle 为准 */
    names: names,
    /** 注入项的上下文镜像（宿主按这个对象回写 setting） */
    env: env,
    install: function (values) {
      var keys = Object.keys(values);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var converted = mirror(values[key], 0, new WeakMap());
        env[key] = converted;
        globalThis[key] = converted;
      }
    },
  };
})`;

/** 预编译的引导脚本（跨 context 复用） */
let bootstrapScript: vm.Script | null = null;

function bootstrap(): vm.Script {
  if (bootstrapScript === null) {
    bootstrapScript = new vm.Script(BOOTSTRAP_SOURCE, { filename: "cubeloom-sandbox-bootstrap.js" });
  }
  return bootstrapScript;
}

/** 桥对象：上下文里创建，宿主持有 */
type Bridge = {
  /** 几何库平铺出来的全局名 */
  names: string[];
  /** 注入项的上下文镜像 */
  env: Record<string, unknown>;
  /** 把宿主 env 转成上下文镜像并挂到全局 */
  install(values: Record<string, unknown>): void;
};

/** 宿主侧的"可回写容器"判定：普通对象 / 数组 / {x,y,z} 形状（Vec3） */
function isDataContainer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  const point = value as { x?: unknown; y?: unknown; z?: unknown };
  return (
    typeof point.x === "number" && typeof point.y === "number" && typeof point.z === "number"
  );
}

/**
 * 把上下文镜像里的**原始值**回写到宿主对象（只写标量，不换对象身份）。
 *
 * `setting` 是宿主那个对象本身，`setting.origin` 是宿主 `Vec3`：
 * 脚本里 `setting.block = "minecraft:gold_block"` / `setting.origin.x = 12`
 * 都会在这里落到宿主对象上。函数、访问器、宿主自己的对象图一律不覆盖。
 */
function copyPrimitives(target: unknown, source: unknown, depth: number): void {
  if (depth > 3) return;
  if (!isDataContainer(target)) return;
  if (!source || typeof source !== "object") return;

  let keys: string[];
  try {
    keys = Object.keys(source as object);
  } catch {
    return;
  }

  for (const key of keys) {
    if (key.startsWith("_")) continue;
    let next: unknown;
    try {
      next = (source as Record<string, unknown>)[key];
    } catch {
      continue;
    }

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(target as object, key);
    } catch {
      descriptor = undefined;
    }
    if (descriptor && !("value" in descriptor)) continue; // 访问器不写

    let current: unknown;
    try {
      current = (target as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof current === "function") continue;

    if (next !== null && typeof next === "object") {
      if (current !== null && typeof current === "object") copyPrimitives(current, next, depth + 1);
      continue;
    }
    if (next === undefined || typeof next === "function") continue;

    try {
      (target as Record<string, unknown>)[key] = next;
    } catch {
      /* 只读属性跳过 */
    }
  }
}

/**
 * eval 的返回值可能是上下文对象：调用方（main.ts 的 preview）会 `JSON.stringify` 它。
 * 循环引用 / BigInt 之类序列化会抛的话，退化成一句描述，别把调用方炸掉。
 */
function previewable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    try {
      return `[沙箱对象：${Object.prototype.toString.call(value)}]`;
    } catch {
      return "[沙箱对象]";
    }
  }
}

class Sandbox {
  /** 累积注入的环境（跨次执行保留，避免每次 run 都重新注入全量 API） */
  private env: Record<string, unknown> = {};

  constructor(sandbox: object) {
    this.updateEnv(sandbox);
  }

  updateEnv(...env: object[]) {
    for (const e of env) {
      if (!e || typeof e !== "object") continue;
      Object.assign(this.env, e);
    }
  }

  /**
   * 每次执行新建上下文：
   * 顶层 `const` / `let` 不会因为上一次执行而重复声明报错（与原实现行为一致），
   * 也不会把 `globalThis.xxx = 1` 之类的副作用带到下一次执行。
   *
   * 组装顺序：几何库（上下文内部）→ 桥接引导 → 宿主 env 的镜像。
   */
  private createContext(): { context: vm.Context; bridge: Bridge } {
    const timeout = execTimeoutMs();
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      name: "cubeloom-sandbox",
    });

    // 1) 几何库：在上下文里求值，`var VG = {...}` 成为上下文全局。
    //    外面套了一层 `(function (Function) {...})`：VoxelGeometry 的表达式 API
    //    （simple_equation / simple_parametric / equation / parametric）内部要用
    //    `new Function` 编译表达式字符串，而上下文按 P0-1 关着 codeGeneration.strings。
    //    这里把这个构造器替换成“表达式 realm”的 Function：那个 realm 里没有任何宿主
    //    引用，编译出的表达式只能算数学，沙箱 realm 的 Function 依旧被拦。
    const geometryFactory = geometryBundleFactoryScript().runInContext(context, {
      timeout,
    }) as (compiler: unknown) => void;
    geometryFactory(createExpressionCompiler());

    // 2) 桥接引导：拿到工厂函数，再把"调用宿主前回写"的钩子塞进去
    const bridgeFactory = bootstrap().runInContext(context, { timeout }) as (
      hook: () => void
    ) => Bridge;
    let bridge: Bridge | undefined;
    const beforeHostCall = () => {
      if (bridge) this.syncBack(bridge);
    };
    bridge = bridgeFactory(beforeHostCall);
    const concrete = bridge;

    // 3) 宿主 env：几何库已经提供的名字直接跳过（bundle 优先）
    const provided = new Set<string>(Array.from(concrete.names ?? []));
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(this.env)) {
      if (provided.has(key)) continue;
      values[key] = this.env[key];
    }
    concrete.install(values);

    return { context, bridge: concrete };
  }

  /** 上下文镜像 → 宿主原对象（只回写标量） */
  private syncBack(bridge: Bridge | undefined): void {
    if (!bridge) return;
    const mirrorEnv = bridge.env;
    if (!mirrorEnv || typeof mirrorEnv !== "object") return;

    for (const key of Object.keys(this.env)) {
      const original = this.env[key];
      if (!isDataContainer(original)) continue;
      let mirrored: unknown;
      try {
        mirrored = (mirrorEnv as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (!mirrored || typeof mirrored !== "object") continue;
      copyPrimitives(original, mirrored, 0);
    }
  }

  eval(code: string): unknown {
    if (typeof code !== "string") throw new TypeError("sandbox.eval 只接受字符串");
    const { context, bridge } = this.createContext();
    try {
      const value = vm.runInContext(code, context, {
        timeout: execTimeoutMs(),
        displayErrors: true,
        breakOnSigint: false,
      });
      return previewable(value);
    } finally {
      // 脚本中途抛错也要把 setting 的改动带回去
      this.syncBack(bridge);
    }
  }
}

export { Sandbox };
