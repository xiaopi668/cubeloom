/**
 * 把 `@pureeval/voxel-geometry` 打成一段 IIFE 源码，供沙箱上下文**内部**求值。
 *
 * 为什么必须搬进上下文：
 *   P0-1 的逃逸链是 `plot.constructor('return process')()`。旧实现把 VoxelGeometry 的
 *   函数直接注入沙箱，脚本里 `sphere(1)` 拿到的是**宿主 realm** 的 `Vec3` 实例，
 *   顺着 `vec.constructor.constructor` 就是宿主的 `Function`，再 `getBuiltinModule`
 *   就能起子进程。把几何库放进 vm 里跑，`sphere(1)` 得到的才是上下文自己的对象，
 *   `.constructor` 指向上下文自己的 `Function`（而它被 `codeGeneration.strings:false`
 *   钉死），逃逸链就断了。
 *
 * 为什么是 `buildSync` 而不是 `build`：
 *   `Sandbox.eval()` 是同步 API（聊天命令、控制口都按同步用），第一次求值时就要求
 *   bundle 已就绪，没法 `await`。esbuild 的 `buildSync` 走的是同一个打包器，只是用
 *   同步 IPC 等结果；整段 bundle 只构建一次并缓存在模块级。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { createRequire } from "node:module";

/** 打包进来的包名 */
const PACKAGE_NAME = "@pureeval/voxel-geometry";

/** 上下文里的全局名：`var VG = (() => {...})()` */
const BUNDLE_GLOBAL = "VG";

/** vm.Script 的 filename，报错时能看出来源 */
const BUNDLE_FILENAME = "cubeloom-voxel-geometry.iife.js";

/** bundle 文本只构建一次 */
let cachedSource: string | null = null;

/** 预编译只做一次：每次 eval 新建 context，但 Script 可以跨 context 复用 */
let cachedFactoryScript: vm.Script | null = null;

/** `@pureeval/voxel-geometry` → ["@pureeval", "voxel-geometry"] */
const PACKAGE_SEGMENTS = PACKAGE_NAME.split("/");

/** 从某个目录开始逐级向上找 `<dir>/node_modules/<pkg>/index.js` */
function findEntryFrom(startDir: string): string | null {
  if (!startDir) return null;
  let dir: string;
  try {
    dir = path.resolve(startDir);
  } catch {
    return null;
  }
  for (let depth = 0; depth < 12; depth++) {
    const candidate = path.join(dir, "node_modules", ...PACKAGE_SEGMENTS, "index.js");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续往上找 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 找到几何库的入口文件。
 *
 * 打包器要一个**绝对路径**，而 `src/sandbox.ts` 在 tsx 下既可能是 CJS 也可能是 ESM
 * 模式执行（`import.meta.url` / `__dirname` 未必存在），所以按可靠性依次尝试：
 *   1. `require.resolve`（tsx 的 CJS 分支，最准）
 *   2. 进程入口脚本所在目录（`tsx /repo/main.ts` 从任意 cwd 启动都能命中）
 *   3. `process.cwd()`（`start.sh` / `start.bat` 都会先 cd 到仓库根）
 */
function resolveEntry(): string {
  try {
    if (typeof require === "function" && typeof require.resolve === "function") {
      const resolved = require.resolve(PACKAGE_NAME);
      if (resolved && !resolved.includes("\0")) return resolved;
    }
  } catch {
    /* 没装或 ESM 环境下没有 require：往下走 */
  }

  const starts: string[] = [];
  const argvEntry = process.argv?.[1];
  if (argvEntry) starts.push(path.dirname(argvEntry));
  starts.push(process.cwd());

  for (const start of starts) {
    const found = findEntryFrom(start);
    if (found) return found;
  }

  throw new Error(
    `沙箱无法定位 ${PACKAGE_NAME}：请在仓库根目录执行 npm install（几何库与 esbuild 都必须存在）`
  );
}

/**
 * 找预构建的 bundle：`FB_GEOMETRY_BUNDLE` → 入口同目录 → `dist/server/`。
 * 打包产物里没有 esbuild 二进制（Android/Termux 尤其明显），必须能脱机加载。
 */
function readPrebuiltBundle(): string | null {
  const candidates: string[] = [];
  const envFile = (process.env.FB_GEOMETRY_BUNDLE || "").trim();
  if (envFile) candidates.push(path.resolve(envFile));
  const entry = process.argv[1];
  if (entry) candidates.push(path.join(path.dirname(path.resolve(entry)), "voxel-geometry.iife.js"));
  candidates.push(path.join(process.cwd(), "dist", "server", "voxel-geometry.iife.js"));
  candidates.push(path.join(process.cwd(), "voxel-geometry.iife.js"));
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.trim()) return text;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/**
 * 惰性加载 esbuild：
 *   · 开发态（仓库里）从 node_modules 取；
 *   · 打包态没有 esbuild 二进制，但因为优先读预构建 bundle，这条路径根本不会走到。
 * 用 createRequire 而不是静态 import，避免打包产物在启动时就 require 原生二进制。
 */
function esbuildBuildSync(options: Parameters<typeof import("esbuild").buildSync>[0]) {
  const requireFromCwd = createRequire(path.join(process.cwd(), "__cubeloom__.js"));
  let esbuild: typeof import("esbuild");
  try {
    esbuild = requireFromCwd("esbuild");
  } catch (e: any) {
    throw new Error(
      `找不到 esbuild（${e?.message ?? e}）。打包运行时请提供预构建的 voxel-geometry.iife.js（FB_GEOMETRY_BUNDLE）`
    );
  }
  return esbuild.buildSync(options);
}

/**
 * 构建（或复用缓存的）IIFE bundle 文本。
 *
 * 选项说明：
 *   · `format: "iife"` + `globalName: "VG"` —— 上下文里得到 `var VG = {...}`
 *   · `platform: "neutral"` —— 不注入 node 的 require/Buffer 分支，纯函数库
 *   · `target: "es2020"` —— 与 tsconfig 的 ES2022 兼容，V8 直接吃
 *   · `write: false` —— 只要内存里的文本，不落盘
 */
export function geometryBundleSource(): string {
  if (cachedSource !== null) return cachedSource;

  // 打包运行时（Electron / Android / 无 esbuild 的环境）优先用预构建产物
  const prebuilt = readPrebuiltBundle();
  if (prebuilt) {
    cachedSource = prebuilt;
    return cachedSource;
  }

  const entry = resolveEntry();
  const result = esbuildBuildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: BUNDLE_GLOBAL,
    platform: "neutral",
    target: "es2020",
    write: false,
    logLevel: "silent",
    legalComments: "none",
    sourcemap: false,
    charset: "utf8",
    absWorkingDir: path.dirname(entry),
  });

  const file = result.outputFiles?.[0];
  if (!file || typeof file.text !== "string" || file.text.length === 0) {
    throw new Error(`esbuild 没有产出 ${PACKAGE_NAME} 的 bundle`);
  }
  cachedSource = file.text;
  return cachedSource;
}

/**
 * 包一层函数作用域，把 `Function` **在 bundle 内部遮蔽**掉。
 *
 * 为什么需要：`Exp.equation` / `Exp.parametric` 的实现是
 * `new Function('x','y','z', 'return ' + expr)` —— 它本身就是个表达式编译器。
 * 沙箱上下文按 P0-1 的要求开着 `codeGeneration.strings:false`，`new Function`
 * 会被 V8 直接拒绝，`simple_equation("x*x+y*y+z*z<=5", -5, 5, 1)` 就废了
 * （check-sandbox 里锁着这条）。
 *
 * 解法不是把 strings 打开，而是把这个**构造器**换成另一个 realm 的：
 *
 *     (function (Function) { var VG = … ; globalThis.VG = VG; })(表达式编译器的 Function)
 *
 * 于是 bundle 里 `new Function(...)` 编译出来的函数属于“表达式 realm”——那个
 * realm 里除了内置对象什么都没有（没有 process/require/宿主回调），编译出的表达式
 * 只能算数学。沙箱 realm 的 `Function` 依旧被 codeGeneration 钉死，脚本里
 * `Function("return 1")()` 照旧抛错；wrapper 的参数在函数返回后就没了，
 * 脚本既拿不到那个构造器，也拿不到表达式 realm。
 */
export function geometryBundleFactorySource(): string {
  return `(function (Function) {\n${geometryBundleSource()}\n;globalThis.VG = VG;\n})`;
}

/** 预编译的“带参数遮蔽”的工厂脚本（同一个 Script 可以在多个 context 里反复执行） */
export function geometryBundleFactoryScript(): vm.Script {
  if (cachedFactoryScript === null) {
    cachedFactoryScript = new vm.Script(geometryBundleFactorySource(), {
      filename: BUNDLE_FILENAME,
    });
  }
  return cachedFactoryScript;
}

/**
 * 造一个**只用来编译数学表达式**的 realm，返回它的 `Function` 构造器。
 *
 * 这个 realm 是干净的新 context：只有内置对象，宿主一个引用都不放进去。
 * 所以 `new Function('return process')()` 在这里只会 `ReferenceError`，
 * 拿不到任何宿主能力；它唯一的价值是让 VoxelGeometry 的表达式 API 还能用。
 */
export function createExpressionCompiler(): Function {
  const realm = vm.createContext(Object.create(null), {
    codeGeneration: { strings: true, wasm: false },
    name: "cubeloom-expression",
  });
  // 从 realm 内部取它的 Function：宿主不参与构造链，编译出的函数闭包会一直
  // 引用这个 realm，所以它不会被提前回收
  return vm.runInContext("(function () { return Function; })()", realm) as Function;
}

/** 自测/诊断用：bundle 字节数（未构建时先构建） */
export function geometryBundleSize(): number {
  return geometryBundleSource().length;
}
