/**
 * 修补器回归测试（node --test）
 *
 * 这组用例锁死四条契约：
 *  1. 规范文件必须原样返回，不允许"修补"降级；
 *  2. 修复其他问题时，entities / states / 未知字段必须保留；
 *  3. 数据中间被截断的文件必须失败，不允许补零补出"成功"；
 *  4. 任何改变方块集合的修复都必须挂 lossy。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { repairMcStructure } from "../src/structure-repair";
import { parseNbtTyped } from "../src/nbt";
import { makeStructure } from "./helpers";
import type { NbtValue } from "../src/nbt-write";

function canonical() {
  return makeStructure({
    size: [2, 1, 2],
    palette: ["minecraft:stone", "minecraft:oak_stairs"],
    indices: [0, 0, -1, 1],
    withStates: true,
    withEntities: true,
    withUnknownField: true,
  });
}

function typedRoot(buf: Buffer): any {
  const r = parseNbtTyped(buf);
  assert.equal(r.value.type, "compound");
  return (r.value as Extract<NbtValue, { type: "compound" }>).fields;
}

test("规范文件原样返回：不重写字节、不动 fixed/lossy", () => {
  const input = canonical();
  const r = repairMcStructure(input, "canonical");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, false);
  assert.equal(r.lossy, false);
  assert.equal(r.issues.length, 0);
  assert.ok(r.data);
  assert.equal(Buffer.compare(r.data!, input), 0, "规范文件的输出必须与输入逐字节一致");
  assert.equal(r.parsed?.total, 3);
});

test("修复缺失字段时保留 entities / states / 未知字段", () => {
  const input = makeStructure({
    size: [2, 1, 2],
    palette: ["minecraft:stone", "minecraft:oak_stairs"],
    indices: [0, 0, -1, 1],
    withStates: true,
    withEntities: true,
    withUnknownField: true,
    omit: ["structure_world_origin"],
  });
  const r = repairMcStructure(input, "missing-origin");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  assert.equal(r.lossy, false, "补默认字段不属于有损修复");
  assert.match(r.issues.join("；"), /structure_world_origin/);

  const root = typedRoot(r.data!);
  const structure = root.structure as Extract<NbtValue, { type: "compound" }>;
  const entities = structure.fields.entities as Extract<NbtValue, { type: "list" }>;
  assert.equal(entities.items.length, 1, "实体不能被丢掉");
  const sheep = entities.items[0] as Extract<NbtValue, { type: "compound" }>;
  const ident = sheep.fields.identifier as Extract<NbtValue, { type: "string" }>;
  assert.equal(ident.value, "minecraft:sheep");

  const palette = (structure.fields.palette as any).fields.default.fields.block_palette;
  const stairs = palette.items[1];
  assert.ok(stairs.fields.states, "方块状态必须保留");
  assert.equal(stairs.fields.states.fields["minecraft:cardinal_direction"].value, "north");

  const custom = root.custom_blocker as Extract<NbtValue, { type: "compound" }>;
  assert.equal((custom.fields.note as any).value, "keep me", "不认识的字段必须原样保留");
  assert.equal((custom.fields.ratio as any).value, 0.5);
});

test("只缺末尾 TAG_End：补零修复成功，且方块数据不变", () => {
  const input = canonical();
  const truncated = input.subarray(0, input.length - 1);
  const r = repairMcStructure(truncated, "missing-end");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  assert.match(r.issues.join("；"), /结束标记/);
  assert.equal(r.parsed?.total, 3);
  assert.equal(Buffer.compare(r.data!, input), 0, "补回结束标记后应与规范文件一致");
});

test("数据中间被截断：必须失败，不允许补零成成功", () => {
  const input = canonical();
  const cut = input.subarray(0, Math.floor(input.length * 0.6));
  const r = repairMcStructure(cut, "mid-truncated");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /截断/);
  assert.equal(r.data, undefined);
});

test("调色板里出现 NUL 方块名：判定为截断并失败", () => {
  const input = makeStructure({
    size: [1, 1, 1],
    palette: ["minecraft:oa\u0000\u0000"],
    indices: [0],
  });
  const r = repairMcStructure(input, "bad-name");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /非法方块名/);
});

test("索引越界：置空并标记 lossy", () => {
  const input = makeStructure({
    size: [2, 1, 1],
    palette: ["minecraft:stone"],
    indices: [0, 9],
  });
  const r = repairMcStructure(input, "out-of-range");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  assert.equal(r.lossy, true);
  assert.match(r.issues.join("；"), /越界/);
  assert.equal(r.parsed?.total, 1, "越界索引应变成空位");
});

test("gzip 输入：解压为标准 NBT，不算有损", () => {
  const input = canonical();
  const gz = zlib.gzipSync(input);
  const r = repairMcStructure(gz, "gzipped");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  assert.equal(r.lossy, false);
  assert.match(r.issues.join("；"), /gzip/);
  assert.equal(Buffer.compare(r.data!, input), 0);
});

test("entities 缺失时补空列表，并记录问题", () => {
  const input = makeStructure({
    size: [1, 1, 1],
    palette: ["minecraft:stone"],
    indices: [0],
    omit: ["entities"],
  });
  const r = repairMcStructure(input, "no-entities");
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  assert.match(r.issues.join("；"), /entities/);
  const root = typedRoot(r.data!);
  assert.equal(root.structure.fields.entities.items.length, 0);
});
