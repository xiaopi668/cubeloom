/**
 * 格式层回归测试（P1-7 方块状态 / P1-8 litematic 位宽 / P1-16 格式缺口）
 *
 * 所有夹具都在 test/helpers.ts 里现场构造，不依赖任何真实投影文件。
 *
 * 锁死的契约：
 *   · 调色板 states 会拼进 Bedrock 方块语法，且只影响“方块字段”，命令其余格式不变；
 *   · 没有 states / 旧式字符串调色板时行为与以前完全一致（纯方块名）；
 *   · .litematic 的位宽按 long 数组长度反推，palette=2 的 2 位打包必须解出全部方块；
 *   · long 数组长度与任何位宽都对不上时抛明确错误，不静默错解；
 *   · 经典 .schematic 的 Data 参与材质（羊毛颜色不再全白）；
 *   · Sponge .schem v3（Blocks.Palette + Blocks.Data）与 v2 都能解析；
 *   · Java → 基岩版方块名映射，未收录的名字保留原名并记 issue。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inferLitematicBits, parseStructureFile } from "../src/formats";
import { parseMcStructure, structureCommands } from "../src/structure";
import {
  gzipFixture,
  makeLitematic,
  makeSchematic,
  makeSponge,
  makeStructure,
  makeStructureEx,
} from "./helpers";

const OAK_STAIRS_STATES = 'minecraft:oak_stairs["minecraft:cardinal_direction"="north","upside_down_bit"=false]';

/* ───────────────────────── P1-7：方块状态 ───────────────────────── */

test("P1-7：调色板 states 拼进 setblock 命令（楼梯朝向/含水等不再丢）", () => {
  const buf = makeStructure({
    size: [1, 1, 1],
    palette: ["minecraft:oak_stairs"],
    indices: [0],
    withStates: true,
  });
  const parsed = parseStructureFile(buf, "stairs");
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].block, OAK_STAIRS_STATES);

  const cmds = structureCommands(parsed, { x: 10, y: 64, z: 5 }, 0);
  assert.equal(cmds.length, 1);
  // 命令其余格式（坐标、动词）必须原样保留
  assert.equal(cmds[0].command, `setblock 10 64 5 ${OAK_STAIRS_STATES}`);
  assert.equal(cmds[0].count, 1);
});

test("P1-7：没有 states / 旧式字符串调色板时保持纯方块名（向后兼容）", () => {
  const compoundPalette = parseMcStructure(
    makeStructure({ size: [2, 1, 1], palette: ["minecraft:stone", "minecraft:oak_planks"], indices: [0, 1] }),
    "no-states"
  );
  assert.deepEqual(
    compoundPalette.blocks.map((b) => b.block),
    ["minecraft:stone", "minecraft:oak_planks"]
  );

  // 旧式调色板：block_palette 直接是字符串数组
  const stringPalette = parseMcStructure(
    makeStructureEx({ size: [2, 1, 1], palette: ["minecraft:stone", "minecraft:oak_planks"], indices: [0, 1] }),
    "string-palette"
  );
  assert.deepEqual(
    stringPalette.blocks.map((b) => b.block),
    ["minecraft:stone", "minecraft:oak_planks"]
  );
  assert.ok(stringPalette.blocks.every((b) => !b.block.includes("[")));
});

test("P1-7：同名字同状态才合并成 fill，状态不同各自 setblock", () => {
  const buf = makeStructureEx({
    size: [1, 1, 4],
    palette: [
      { name: "minecraft:oak_stairs", states: { "minecraft:cardinal_direction": { type: "string", value: "north" } } },
      { name: "minecraft:oak_stairs", states: { "minecraft:cardinal_direction": { type: "string", value: "south" } } },
    ],
    indices: [0, 1, 0, 1],
  });
  const parsed = parseMcStructure(buf, "mixed");
  const cmds = structureCommands(parsed, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(cmds.length, 4, "方向不同不能合并");
  assert.ok(cmds[0].command.includes('["minecraft:cardinal_direction"="north"]'), cmds[0].command);
  assert.ok(cmds[1].command.includes('["minecraft:cardinal_direction"="south"]'), cmds[1].command);

  // 连续同状态 → 一条 fill，count 是方块数，状态后缀跟在方块字段后面
  const same = makeStructureEx({
    size: [1, 1, 3],
    palette: [
      { name: "minecraft:oak_stairs", states: { "minecraft:cardinal_direction": { type: "string", value: "north" } } },
    ],
    indices: [0, 0, 0],
  });
  const merged = structureCommands(parseMcStructure(same, "same"), { x: 0, y: 0, z: 0 }, 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].command, 'fill 0 0 0 0 0 2 minecraft:oak_stairs["minecraft:cardinal_direction"="north"]');
  assert.equal(merged[0].count, 3);
});

test("P1-7：状态值格式化 —— 字符串转义、byte 转布尔、整数原样", () => {
  const buf = makeStructureEx({
    size: [1, 1, 1],
    palette: [
      {
        name: "minecraft:stone",
        states: {
          "minecraft:test_quote": { type: "string", value: 'a"b\\c' },
          "minecraft:test_bool": { type: "byte", value: 1 },
          "minecraft:test_int": { type: "int", value: -3 },
        },
      },
    ],
    indices: [0],
  });
  const parsed = parseMcStructure(buf, "values");
  const expected = 'minecraft:stone["minecraft:test_quote"="a\\"b\\\\c","minecraft:test_bool"=true,"minecraft:test_int"=-3]';
  assert.equal(parsed.blocks[0].block, expected);
});

/* ───────────────────────── P1-8：litematic 位宽 ───────────────────────── */

test("P1-8：palette=2 且按 2 位打包的 .litematic 解出 50 块（不是 50→25）", () => {
  const buf = makeLitematic({
    size: [10, 1, 5],
    palette: ["minecraft:air", "minecraft:stone"],
    ids: new Array(50).fill(1), // 全石头：旧实现按 1 位解，只会得到一半
  });
  const parsed = parseStructureFile(gzipFixture(buf), "two-bit");
  assert.equal(parsed.total, 50);
  assert.deepEqual(parsed.size, { x: 10, y: 1, z: 5 });
  assert.ok(
    parsed.blocks.every((b) => b.block === "minecraft:stone"),
    [...new Set(parsed.blocks.map((b) => b.block))].join(",")
  );
  const coords = new Set(parsed.blocks.map((b) => `${b.x},${b.y},${b.z}`));
  assert.ok(coords.has("0,0,0"));
  assert.ok(coords.has("9,0,4"));
  assert.equal(coords.size, 50);
});

test("P1-8：位宽反推公式与 long 数组长度自洽", () => {
  // 体积 50：2 位 → ceil(100/64) = 2 个 long
  assert.equal(inferLitematicBits(2, 50, 2), 2);
  // 4 个 long 只对得上 4 位（ceil(50*4/64) = 4）
  assert.equal(inferLitematicBits(4, 50, 2), 4);
  // 调色板 5 项 → 最少 3 位；3 位下 ceil(50*3/64) = 3
  assert.equal(inferLitematicBits(3, 50, 5), 3);
});

test("P1-8：跨 long 边界的位流不错位（三轴 + 多个调色板下标）", () => {
  const sx = 11, sy = 3, sz = 7;
  const volume = sx * sy * sz;
  const palette = ["minecraft:stone", "minecraft:dirt", "minecraft:oak_planks", "minecraft:sand", "minecraft:glass"];
  const ids = Array.from({ length: volume }, (_, i) => (i * 7) % palette.length);
  const buf = makeLitematic({ size: [sx, sy, sz], palette, ids });
  const parsed = parseStructureFile(gzipFixture(buf), "cross-long");
  assert.equal(parsed.total, volume);

  // 独立算一遍期望值：litematic 的索引顺序是 x 最快、然后 z、最后 y
  const expected = ids
    .map((id, i) => ({
      x: i % sx,
      y: Math.floor(i / (sx * sz)),
      z: Math.floor(i / sx) % sz,
      block: palette[id],
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  assert.deepEqual(
    parsed.blocks.map((b) => `${b.x},${b.y},${b.z}=${b.block}`),
    expected.map((b) => `${b.x},${b.y},${b.z}=${b.block}`)
  );
});

test("P1-8：long 数组长度与任何位宽都不匹配时抛明确错误（不静默错解）", () => {
  const buf = makeLitematic({
    size: [10, 1, 5],
    palette: ["minecraft:air", "minecraft:stone"],
    ids: new Array(50).fill(1),
    longCount: 1, // 正确应该是 2 个 long
  });
  assert.throws(
    () => parseStructureFile(gzipFixture(buf), "broken-bits"),
    (err: any) => {
      assert.match(String(err?.message), /BlockStates 长度/);
      assert.match(String(err?.message), /不匹配/);
      return true;
    }
  );
});

/* ───────────────────────── P1-16：经典 .schematic ───────────────────────── */

test("P1-16：.schematic 的 Data 还原羊毛颜色（不再全白）", () => {
  const buf = makeSchematic({
    size: [4, 1, 1],
    blocks: [35, 35, 35, 35], // 羊毛
    data: [0, 1, 14, 15], // 白 / 橙 / 红 / 黑
  });
  const parsed = parseStructureFile(gzipFixture(buf), "wool");
  assert.deepEqual(
    parsed.blocks.map((b) => b.block),
    ["minecraft:white_wool", "minecraft:orange_wool", "minecraft:red_wool", "minecraft:black_wool"]
  );
});

test("P1-16：.schematic 的 AddBlocks 高 4 位参与 ID，并优先按 Palette 映射", () => {
  const buf = makeSchematic({
    size: [2, 1, 1],
    blocks: [0, 0],
    add: [0x11], // 两格的高 4 位都是 1 → ID = 0x100
    palette: { "minecraft:stone": 256 },
  });
  const parsed = parseStructureFile(gzipFixture(buf), "addblocks");
  assert.deepEqual(
    parsed.blocks.map((b) => b.block),
    ["minecraft:stone", "minecraft:stone"]
  );
});

test("P1-16：经典数字 ID 也会过 Java→基岩版改名表", () => {
  const buf = makeSchematic({
    size: [3, 1, 1],
    blocks: [45, 80, 30], // Java: bricks / snow_block / cobweb
  });
  const parsed = parseStructureFile(gzipFixture(buf), "legacy-rename");
  assert.deepEqual(
    parsed.blocks.map((b) => b.block),
    ["minecraft:brick_block", "minecraft:snow", "minecraft:web"]
  );
});

/* ───────────────────────── P1-16：Sponge .schem ───────────────────────── */

test("P1-16：.schem v3（Blocks.Palette + Blocks.Data）能解析", () => {
  const buf = makeSponge({
    size: [2, 1, 2],
    palette: { "minecraft:stone": 0, "minecraft:oak_planks": 1, "minecraft:air": 2 },
    ids: [0, 1, 2, 0], // 索引顺序：x 最快 → (x0,z0) (x1,z0) (x0,z1) (x1,z1)
    version: 3,
  });
  const parsed = parseStructureFile(gzipFixture(buf), "v3");
  assert.deepEqual(parsed.size, { x: 2, y: 1, z: 2 });
  assert.deepEqual(
    parsed.blocks.map((b) => `${b.x},${b.y},${b.z}=${b.block}`),
    ["0,0,0=minecraft:stone", "1,0,0=minecraft:oak_planks", "1,0,1=minecraft:stone"]
  );
  assert.equal(parsed.skippedAir, 1); // 调色板里的 air 不计入方块
});

test("P1-16：.schem v2（Palette + BlockData）不回归，Java 状态属性被剥掉", () => {
  const buf = makeSponge({
    size: [1, 1, 1],
    palette: { "minecraft:oak_stairs[facing=north]": 0 },
    ids: [0],
    version: 2,
  });
  const parsed = parseStructureFile(gzipFixture(buf), "v2");
  assert.equal(parsed.blocks[0].block, "minecraft:oak_stairs");
});

test("P1-16：Java → 基岩版方块名映射，未收录的名字保留原名并记 issue", () => {
  const buf = makeLitematic({
    size: [4, 1, 1],
    palette: [
      "minecraft:bricks", // → brick_block
      "minecraft:oak_log", // 基岩版也叫 oak_log
      "minecraft:lily_pad", // → waterlily
      "minecraft:not_a_real_block", // 表里没有 → 原名 + issue
    ],
    ids: [0, 1, 2, 3],
  });
  const parsed = parseStructureFile(gzipFixture(buf), "mapping");
  assert.deepEqual(
    parsed.blocks.map((b) => b.block),
    ["minecraft:brick_block", "minecraft:oak_log", "minecraft:waterlily", "minecraft:not_a_real_block"]
  );
  assert.ok(parsed.issues && parsed.issues.length === 1, JSON.stringify(parsed.issues));
  assert.match(parsed.issues![0], /未在映射表内/);
  assert.match(parsed.issues![0], /not_a_real_block/);
});
