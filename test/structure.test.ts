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
import { needsIndividualPlacement, parseMcStructure, structureCommands } from "../src/structure";
import { makeStructure } from "./helpers";

/** 把 fill / setblock 命令还原成方块坐标集合，用于校验覆盖范围 */
function expandCommands(cmds: Array<{ command: string }>): Set<string> {
  const out = new Set<string>();
  for (const c of cmds) {
    const f = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(c.command);
    if (f) {
      const [x1, y1, z1, x2, y2, z2] = f.slice(1, 7).map(Number);
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) out.add(`${x},${y},${z}`);
        }
      }
      continue;
    }
    const b = /^setblock (-?\d+) (-?\d+) (-?\d+)/.exec(c.command);
    if (b) out.add(`${Number(b[1])},${Number(b[2])},${Number(b[3])}`);
  }
  return out;
}

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
  // 相邻两块现在会合成一条 fill
  assert.equal(cmds.length, 1, cmds.map((c) => c.command).join(" | "));
  assert.equal(cmds[0].command, "fill 100 71 -20 101 71 -20 minecraft:stone");
  // main.ts verifyStructure 里的 world()：origin.x + p.x, origin.y + p.y + offsetY, origin.z + p.z
  const world = blocks.map((p) => ({ x: origin.x + p.x, y: origin.y + p.y + offsetY, z: origin.z + p.z }));
  const cells = expandCommands(cmds);
  assert.deepEqual([...cells].sort(), world.map((p) => `${p.x},${p.y},${p.z}`).sort());
});

test("3D 合块：实心立方体一条 fill 覆盖", () => {
  const blocks: Array<{ x: number; y: number; z: number; block: string }> = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 4; z++) blocks.push({ x, y, z, block: "minecraft:stone" });
    }
  }
  const cmds = structureCommands(st(blocks), { x: 0, y: 0, z: 0 }, 0);
  assert.equal(cmds.length, 1, cmds.map((c) => c.command).join(" | "));
  assert.equal(cmds[0].command, "fill 0 0 0 3 3 3 minecraft:stone");
  assert.equal(cmds[0].count, 64);
});

test("超过单条 fill 上限时自动切片，总量不丢", () => {
  const blocks: Array<{ x: number; y: number; z: number; block: string }> = [];
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      for (let z = 0; z < 8; z++) blocks.push({ x, y, z, block: "minecraft:stone" });
    }
  }
  const cmds = structureCommands(st(blocks), { x: 0, y: 0, z: 0 }, 0, { maxFillVolume: 64 });
  assert.ok(cmds.length > 1, "应该被切成多条");
  assert.equal(cmds.reduce((n, c) => n + c.count, 0), 512);
  for (const c of cmds) assert.ok(c.count <= 64, `${c.command} -> ${c.count}`);
  assert.equal(expandCommands(cmds).size, 512, "切片后覆盖范围不变");
});

test("混合方块 + 空腔：fill 覆盖范围与原始方块集合完全一致", () => {
  const blocks: Array<{ x: number; y: number; z: number; block: string }> = [];
  for (let x = 0; x < 6; x++) {
    for (let y = 0; y < 6; y++) {
      for (let z = 0; z < 6; z++) {
        if ((x + y + z) % 3 === 0) continue; // 挖空一部分
        blocks.push({ x, y, z, block: (x + y) % 2 === 0 ? "minecraft:stone" : "minecraft:oak_planks" });
      }
    }
  }
  const cmds = structureCommands(st(blocks), { x: 0, y: 0, z: 0 }, 0);
  const cells = expandCommands(cmds);
  assert.equal(cells.size, blocks.length, "不能多放也不能少放");
  assert.equal(cmds.reduce((n, c) => n + c.count, 0), blocks.length);
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

test("重力/附着方块不进 fill：实心块先放，特殊块最后逐块 setblock", () => {
  const blocks = [
    { x: 0, y: 0, z: 0, block: "minecraft:stone" },
    { x: 0, y: 1, z: 0, block: "minecraft:stone" },
    { x: 0, y: 2, z: 0, block: "minecraft:sand" },
    { x: 1, y: 0, z: 0, block: "minecraft:torch" },
  ];
  const cmds = structureCommands(st(blocks), { x: 0, y: 0, z: 0 }, 0);
  // 石头先合成一条 fill
  assert.equal(cmds[0].command, "fill 0 0 0 0 1 0 minecraft:stone");
  const fills = cmds.filter((c) => c.command.startsWith("fill"));
  assert.ok(!fills.some((c) => c.command.includes("sand") || c.command.includes("torch")), "沙子/火把不能进 fill");
  const specials = cmds.slice(1);
  assert.equal(specials.length, 2);
  assert.ok(specials.every((c) => c.command.startsWith("setblock")));
  // 自下而上：y=0 的火把在 y=2 的沙子前面
  assert.ok(specials[0].command.includes("minecraft:torch"));
  assert.ok(specials[1].command.includes("minecraft:sand"));
});

test("特殊方块判定：重力/附着类要逐块，普通建筑方块不误伤", () => {
  for (const name of [
    "minecraft:sand",
    "minecraft:red_sand",
    "minecraft:gravel",
    "minecraft:torch",
    "minecraft:oak_door",
    "minecraft:oak_sign",
    "minecraft:rail",
    "minecraft:white_carpet",
    "minecraft:red_concrete_powder",
    "minecraft:oak_sapling",
    "minecraft:sand[\"sand_type\"=\"normal\"]",
  ]) {
    assert.equal(needsIndividualPlacement(name), true, name);
  }
  for (const name of [
    "minecraft:stone",
    "minecraft:oak_planks",
    "minecraft:oak_stairs",
    "minecraft:glass",
    "minecraft:white_wool",
    "minecraft:torchflower_block",
  ]) {
    assert.equal(needsIndividualPlacement(name), false, name);
  }
});
