/**
 * ParsedStructure 的共享收尾逻辑。
 *
 * formats.ts（投影文件）与 bdx.ts（BDX 指令流）都要把一堆带绝对坐标的方块
 * 归一化成「最小角为原点 + 按 x→y→z 排序」的结构，所以把这段抽出来，
 * 避免两份实现慢慢漂移。
 */
import type { ParsedStructure, StructureBlock } from "./structure";

export const AIR = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:structure_void",
]);

export function isAir(name: string): boolean {
  return AIR.has(name);
}

/** 统一收尾：把坐标平移到最小角、排序（x→y→z）、生成 ParsedStructure */
export function finishParsedStructure(
  name: string,
  raw: StructureBlock[],
  paletteSize: number,
  skippedAir: number,
  issues: string[] = []
): ParsedStructure {
  if (!raw.length) throw new Error("文件里没有可放置的方块（可能全是空气）");
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of raw) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.z > maxZ) maxZ = b.z;
  }
  const size = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 };
  const blocks = raw.map((b) => ({ x: b.x - minX, y: b.y - minY, z: b.z - minZ, block: b.block }));
  blocks.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  if (issues.length) console.warn(`[formats] ${name}: ${issues.join("；")}`);
  const parsed: ParsedStructure = {
    name,
    size,
    blocks,
    total: blocks.length,
    paletteSize: Math.max(1, paletteSize),
    skippedAir,
    materials: [...new Set(blocks.map((b) => b.block))].slice(0, 40),
  };
  if (issues.length) parsed.issues = issues;
  return parsed;
}
