/**
 * 沙箱隔离回归测试（P0-1）。
 *
 * 旧实现把 `plot` / `setBlocks` / `session` 以及 `sphere(3,0)` 返回的 `Vec3` 实例
 * 原样塞进 vm 上下文，这些全是**宿主 realm** 对象，`.constructor` 直通宿主 `Function`：
 *
 *     plot.constructor('return process')().getBuiltinModule('child_process')…
 *
 * 这些断言锁住新结构：几何库在上下文内部求值，宿主 API 只以“上下文包装函数”出现，
 * 参数/返回值过桥时只走普通数据。跑法：
 *
 *     npm test                          # 全套
 *     node --import tsx --test test/sandbox.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "@pureeval/voxel-geometry";
import { Sandbox } from "../src/sandbox";
import { setBlocks } from "../src/effect";

/** `process` 里只有宿主 Node 才有的字段，用来判定"真的摸到了宿主" */
const HOST_MARKERS = ["versions", "getBuiltinModule", "binding"];

type Attempt =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

function attempt(sandbox: Sandbox, code: string): Attempt {
  try {
    return { ok: true, value: sandbox.eval(code) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 断言"这条逃逸链没有拿到宿主 process"。
 *
 * 允许两种结果：抛错（`codeGeneration.strings:false` 把 `Function(...)` 拦了），
 * 或者返回 undefined / 字符串这种非对象。绝不允许返回对象（那就是宿主 process）。
 */
function assertNoHostProcess(result: Attempt, label: string) {
  if (!result.ok) return; // 抛错 = 拦住
  const value = result.value;
  const type = typeof value;
  assert.notEqual(type, "object", `${label}：返回了对象，疑似拿到宿主 process`);
  assert.notEqual(type, "function", `${label}：返回了函数，疑似拿到宿主对象`);
  const text = value === undefined ? "" : String(value);
  for (const marker of HOST_MARKERS) {
    assert.ok(!text.includes(marker), `${label}：返回值里出现了宿主进程字段 ${marker}`);
  }
}

/** 造一个与 session.ts 类似的宿主环境（几何函数用宿主版，验证 bundle 覆盖） */
function hostGeometryEnv(): Record<string, unknown> {
  return {
    ...V.Generator,
    ...V.Exp,
    ...V.Transform,
    ...V.LSystem,
    ...V.IFS,
    ...V.DLA,
    Turtle2D: V.Turtle2D,
    Turtle3D: V.Turtle3D,
    // 故意注入一个"宿主版" vec3：bundle 里同名，必须被上下文版本覆盖
    vec3: (x: number, y: number, z: number) => new V.Vec3(x, y, z),
  };
}

test("几何对象（sphere 的返回值）拿不到宿主 process", () => {
  const sandbox = new Sandbox(hostGeometryEnv());
  assertNoHostProcess(
    attempt(sandbox, "sphere(1, 0).constructor.constructor('return process')()"),
    "sphere().constructor"
  );
  assertNoHostProcess(
    attempt(sandbox, "vec3(1, 2, 3).constructor.constructor('return process')()"),
    "vec3().constructor"
  );
});

test("注入的宿主函数 plot 拿不到宿主 process", () => {
  const sandbox = new Sandbox({ plot: () => undefined });
  assertNoHostProcess(
    attempt(sandbox, "plot.constructor.constructor('return process')()"),
    "plot.constructor"
  );
  assertNoHostProcess(
    attempt(sandbox, "plot.constructor('return process')()"),
    "plot.constructor(直接调用)"
  );
});

test("嵌套注入对象的包装函数拿不到宿主 process", () => {
  const sandbox = new Sandbox({
    session: { sendCommand: () => "req-1" },
    setting: { block: "minecraft:stone", origin: { x: 0, y: 0, z: 0 } },
  });
  assertNoHostProcess(
    attempt(sandbox, "session.sendCommand.constructor.constructor('return process')()"),
    "session.sendCommand.constructor"
  );
  assertNoHostProcess(
    attempt(sandbox, "setting.origin.constructor.constructor('return process')()"),
    "setting.origin.constructor"
  );
});

test("普通对象与字符串构造在上下文里被拦", () => {
  const sandbox = new Sandbox({});
  assert.throws(
    () => sandbox.eval("({}).constructor.constructor('return process')()"),
    /code generation|is not defined|not a function/i
  );
  assert.throws(() => sandbox.eval('Function("return 1")()'), /code generation/i);
  assert.throws(() => sandbox.eval('eval("1+1")'), /code generation/i);
  assert.equal(sandbox.eval("typeof process"), "undefined");
  assert.equal(sandbox.eval("typeof require"), "undefined");
  assert.equal(sandbox.eval("typeof Buffer"), "undefined");
  assert.equal(sandbox.eval("typeof globalThis.process"), "undefined");
});

test("对照组：同样的写法在宿主 realm 里确实能拿到 process（证明断言有效）", () => {
  const hostVec = V.Generator.sphere(1, 0)[0];
  const hostProcess = (hostVec.constructor as any).constructor("return process")() as any;
  assert.equal(typeof hostProcess, "object");
  assert.equal(hostProcess.versions.node, process.versions.node);
});

test("几何 API 与宿主一致：sphere 数量、move + vec3 坐标", () => {
  const sandbox = new Sandbox(hostGeometryEnv());

  const sphereCount = sandbox.eval("sphere(2, 0).length") as number;
  assert.equal(sphereCount, V.Generator.sphere(2, 0).length);

  const circleCount = sandbox.eval("circle(5, 4).length") as number;
  assert.equal(circleCount, V.Generator.circle(5, 4).length);

  const moved = sandbox.eval("move(sphere(1, 0), vec3(1, 1, 1))") as Array<{
    x: number;
    y: number;
    z: number;
  }>;
  const expected = V.Transform.move(V.Generator.sphere(1, 0), new V.Vec3(1, 1, 1));
  assert.equal(moved.length, expected.length);
  // 注意：moved 是**上下文 realm** 的数组，比较前先搬回宿主数组
  assert.deepEqual(
    Array.from(moved, (p) => [p.x, p.y, p.z]),
    expected.map((p) => [p.x, p.y, p.z])
  );

  // bundle 里的 class 也能用
  assert.equal(
    sandbox.eval("(() => { const t = new Turtle2D(); t.forward(10); return t.getTrack().length })()"),
    11
  );
});

test("注入的宿主函数被调用：plot 收到的是普通数据而不是上下文对象", () => {
  const received: unknown[] = [];
  const sandbox = new Sandbox({
    plot: (space: unknown) => {
      received.push(space);
    },
  });

  sandbox.eval("plot(sphere(1, 0))");

  assert.equal(received.length, 1);
  const space = received[0] as Array<{ x: number; y: number; z: number }>;
  assert.ok(Array.isArray(space), "参数应当是数组");
  assert.equal(space.length, V.Generator.sphere(1, 0).length);
  for (const point of space) {
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");
    assert.equal(typeof point.z, "number");
    // 过桥后只剩普通数据：宿主 Vec3 的方法/原型链都不在了
    assert.ok(!(point instanceof V.Vec3), "参数不能被当成宿主 Vec3");
    assert.equal(typeof (point as { add?: unknown }).add, "undefined");
    assert.equal(Object.getPrototypeOf(point), Object.getPrototypeOf(space[0]));
  }
});

test("嵌套对象的方法可调用：session.sendCommand 打到宿主", () => {
  const sent: string[] = [];
  const hostSession = {
    sent,
    sendCommand(command: string) {
      this.sent.push(command);
      return "req-1";
    },
  };
  const sandbox = new Sandbox({ session: hostSession });

  assert.equal(sandbox.eval('session.sendCommand("say hi")'), "req-1");
  assert.deepEqual(sent, ["say hi"]);
});

test("柯里化的 setBlocks 穿过桥仍然按体素发命令", () => {
  const sent: string[] = [];
  const hostSession = {
    sendCommand(command: string) {
      sent.push(command);
      return "req-1";
    },
  };
  const sandbox = new Sandbox({ session: hostSession, setBlocks });

  sandbox.eval('setBlocks(session)("minecraft:stone")(sphere(1, 0))');

  const first = V.Generator.sphere(1, 0)[0];
  assert.equal(sent.length, V.Generator.sphere(1, 0).length);
  assert.equal(sent[0], `setblock ${first.x} ${first.y} ${first.z} minecraft:stone`);
});

test("setting.block 改动在 eval 后同步回宿主", () => {
  const setting = {
    block: "minecraft:iron_block",
    origin: new V.Vec3(0, 64, 0),
    particle: "minecraft:explosion",
  };
  const sandbox = new Sandbox({ setting });

  sandbox.eval('setting.block = "minecraft:gold_block"');

  assert.equal(setting.block, "minecraft:gold_block");
  assert.equal(setting.particle, "minecraft:explosion", "没改的字段不应被动过");
});

test("setting.origin 的嵌套改动同步回宿主，且不换掉宿主 Vec3 身份", () => {
  const origin = new V.Vec3(0, 64, 0);
  const setting = { block: "minecraft:iron_block", origin, particle: "p" };
  const sandbox = new Sandbox({ setting });

  sandbox.eval("setting.origin.x = 12; setting.origin.z = -5");

  assert.equal(origin.x, 12);
  assert.equal(origin.z, -5);
  assert.equal(origin.y, 64);
  assert.equal(setting.origin, origin, "宿主对象身份必须保持");
  assert.ok(origin instanceof V.Vec3);
});

test("同一条脚本里改 setting.block 后 plot 立刻用新方块", () => {
  const setting = { block: "minecraft:iron_block", origin: { x: 0, y: 0, z: 0 }, particle: "p" };
  const seen: string[] = [];
  const sandbox = new Sandbox({
    setting,
    plot: () => {
      seen.push(setting.block);
    },
  });

  sandbox.eval('setting.block = "minecraft:quartz_block"; plot()');

  assert.deepEqual(seen, ["minecraft:quartz_block"]);
  assert.equal(setting.block, "minecraft:quartz_block");
});

test("宿主函数抛错时只把文本带进脚本，异常对象仍是上下文 realm", () => {
  const sandbox = new Sandbox({
    boom: () => {
      throw new Error("host exploded");
    },
  });

  const message = sandbox.eval('try { boom() } catch (e) { String(e.message) }');
  assert.match(String(message), /host exploded/);

  assertNoHostProcess(
    attempt(sandbox, 'try { boom() } catch (e) { e.constructor.constructor("return process")() }'),
    "catch(e).constructor"
  );
});

test("表达式 API（simple_equation）在沙箱里可用，元素仍是上下文 Vec3", () => {
  const sandbox = new Sandbox(hostGeometryEnv());

  const count = sandbox.eval('simple_equation("x*x+y*y+z*z<=5", -5, 5, 1).length') as number;
  assert.equal(count, V.Exp.simple_equation("x*x+y*y+z*z<=5", -5, 5, 1).length);
  assert.ok(count > 0);

  // 元素必须是上下文自己的 Vec3（有 add/scale 这些方法，而不是裸 {x,y,z}）
  const elementCheck = sandbox.eval(
    '(() => { const p = simple_equation("x*x+y*y+z*z<=5", -1, 1, 1)[0]; ' +
      'return [typeof p.add, typeof p.scale, p.x, p.y, p.z] })()'
  ) as string[];
  assert.deepEqual(Array.from(elementCheck as unknown as string[]), [
    "function",
    "function",
    -1,
    -1,
    -1,
  ]);

  // simple_parametric 同样依赖表达式编译，必须一起活着
  const parametric = sandbox.eval(
    'simple_parametric("Math.cos(t)", "0", "Math.sin(t)", ["t", 0, 1, 0.5]).length'
  ) as number;
  assert.ok(parametric > 0, `simple_parametric 返回 ${parametric} 个体素`);

  // 表达式是"另一个 realm"里编译的，那个 realm 里同样没有 process
  const guarded = sandbox.eval(
    'simple_equation("typeof process === \\"undefined\\" ? 1 : 0", -1, 1, 1).length'
  ) as number;
  assert.equal(guarded, 27, "表达式 realm 里也必须看不到 process");
});

test("表达式路径也拿不到宿主 process", () => {
  const sandbox = new Sandbox(hostGeometryEnv());
  // 直接对表达式 API 的返回值做逃逸尝试
  assertNoHostProcess(
    attempt(
      sandbox,
      'simple_equation("x*x+y*y+z*z<=5", -1, 1, 1).constructor.constructor("return process")()'
    ),
    "simple_equation().constructor"
  );
  // 在表达式里试图回到宿主的 Function 链：表达式 realm 里编译可以成功，
  // 但 `process` 在那个 realm 不存在，调用时直接 ReferenceError
  const inExpression = attempt(
    sandbox,
    'simple_equation("Function(\\"return process\\")().versions.node", -1, 1, 1)'
  );
  if (inExpression.ok === false) {
    const message = String((inExpression.error as Error)?.message ?? inExpression.error);
    assert.match(message, /process is not defined/i);
  } else {
    assertNoHostProcess(inExpression, "表达式里 Function('return process')");
  }
});

test("eval 返回最后表达式的值；不可序列化的返回退化成字符串而不是抛错", () => {
  const sandbox = new Sandbox({});
  assert.equal(sandbox.eval("1+1"), 2);
  assert.equal(sandbox.eval("let x = 3; x * 7"), 21);
  assert.equal(sandbox.eval("const a = 1; a"), 1);
  assert.equal(sandbox.eval("const a = 2; a"), 2, "每次执行应当是新上下文");

  const circular = sandbox.eval("const o = {}; o.self = o; o");
  assert.equal(typeof circular, "string");
  assert.ok(String(circular).includes("沙箱对象"));
});

test("死循环被 FB_SANDBOX_TIMEOUT 打断（200ms）", () => {
  const saved = process.env.FB_SANDBOX_TIMEOUT;
  process.env.FB_SANDBOX_TIMEOUT = "200";
  try {
    const sandbox = new Sandbox({});
    const startedAt = Date.now();
    assert.throws(() => sandbox.eval("while(true){}"), /timed out|script execution/i);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `超时用了 ${elapsed}ms，明显超过设定的 200ms`);
  } finally {
    if (saved === undefined) delete process.env.FB_SANDBOX_TIMEOUT;
    else process.env.FB_SANDBOX_TIMEOUT = saved;
  }
});
