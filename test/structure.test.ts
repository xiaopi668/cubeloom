/**
 * 坐标与命令生成回归测试
 *
 * 锁死「offsetY 只加一次」的契约：
 *   · structureCommands 产出的命令已经包含 origin + offsetY；
 *   · 回读/补建用的是原始结构坐标 + world()，也只在 world() 里加一次。
 * 如果有人在这两条路径的任意一侧再加一次偏移，这里会立刻红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMcStructure, structureCommands } from "../src/structure";
import { makeStructure } from "./helpers";

const st = (blocks: Array<{ x: number; y: number; z: number; block: string }>) => ({
  name: "t",
  size: { x: Math.max(...blocks.map((b) => b.x)) + 1, y: Math.max(...blocks.map((b) => b.y)) + 1, z: Math.max(...blocks.map((b) => b.z)) + 1 },
  blocks,
  total: blocks.length,
  paletteSize: new Set(blocks.map((b) => b.block)).size,
  skippedAir: 0,
  materials: [...new Set(blocks.map((b) => b.block))],
});

test("setblock 命令只叠加一次 origin + offsetY", () => {
  const s = st([{ x: 1, y: 2, z: 3, block: "minecraft:stone" }]);
  const cmds = structureCommands(s, { x: 10, y: 20, z: 30 }, 5);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].command, "setblock 11 27 33 minecraft:stone");
  assert.equal(cmds[0].count, 1);
});

test("同轴连续同方块合并为 fill，count 等于方块数", () => {
  const s = st([
    { x: 0, y: 0, z: 0, block: "minecraft:stone" },
    { x: 0, y: 0, z: 1, block: "minecraft:stone" },
    { x: 0, y: 0, z: 2, block: "minecraft:stone" },
  ]);
  const cmds = structureCommands(s, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].command, "fill 0 0 0 0 0 2 minecraft:stone");
  assert.equal(cmds[0].count, 3);
});

test("回读坐标与命令坐标一致：world(p) 只加一次偏移", () => {
  const origin = { x: 100, y: 64, z: -20 };
  const offsetY = 7;
  const blocks = [
    { x: 0, y: 0, z: 0, block: "minecraft:stone" },
    { x: 1, y: 0, z: 0, block: "minecraft:stone" },
  ];
  const s = st(blocks);
  const cmds = structureCommands(s, origin, offsetY);
  const fromCommands = cmds.map((c) => {
    const m = /^(?:setblock|fill) (-?\d+) (-?\d+) (-?\d+)/.exec(c.command);
    assert.ok(m, c.command);
    return { x: Number(m![1]), y: Number(m![2]), z: Number(m![3]) };
  });
  // main.ts verifyStructure 里的 world()：origin.x + p.x, origin.y + p.y + offsetY, origin.z + p.z
  const world = blocks.map((p) => ({ x: origin.x + p.x, y: origin.y + p.y + offsetY, z: origin.z + p.z }));
  assert.deepEqual(fromCommands, world);
});

test("索引 → 坐标映射：z 变化最快", () => {
  const size: [number, number, number] = [2, 2, 2];
  const indices = new Array(8).fill(-1);
  indices[0] = 0; // (x0,y0,z0)
  indices[1] = 0; // (x0,y0,z1)
  indices[2] = 0; // (x0,y1,z0)
  indices[4] = 0; // (x1,y0,z0)
  const buf = makeStructure({ size, palette: ["minecraft:stone"], indices });
  const parsed = parseMcStructure(buf, "map");
  assert.deepEqual(
    parsed.blocks.map((b) => `${b.x},${b.y},${b.z}`).sort(),
    ["0,0,0", "0,0,1", "0,1,0", "1,0,0"].sort()
  );
});

test("空气与 structure_void 不计入方块", () => {
  const buf = makeStructure({
    size: [2, 1, 1],
    palette: ["minecraft:air", "minecraft:structure_void", "minecraft:stone"],
    indices: [0, 1],
  });
  const parsed = parseMcStructure(buf, "air");
  assert.equal(parsed.total, 0);
  assert.equal(parsed.skippedAir, 2);
});
