/**
 * .mcstructure 解析与命令生成
 *
 * 文件格式（Bedrock，未压缩 little-endian NBT）：
 *   { format_version:int, size:[x,y,z], structure:{ block_indices:[[...],[...]],
 *     palette:{ default:{ block_palette:[{name,states,version}], block_position_data } } } }
 *
 * block_indices 每个子列表按 ZYX 顺序（z 变化最快）：
 *   index = (x * sizeY + y) * sizeZ + z
 *   -1 表示空（保持原方块）；palette 里 minecraft:air 也视为空。
 *
 * 方块状态（P1-7）：
 *   调色板条目里的 states 是 NBT compound，会被拼进 Bedrock 的方块语法：
 *     minecraft:oak_stairs["facing"="north","upside_down_bit"=false]
 *   生成规则：字符串加双引号并转义内部的 " 与 \；布尔输出 true/false；
 *   整数/浮点直接输出（Bedrock 的 bool 状态在 NBT 里就是 TAG_Byte，所以 byte 当布尔）。
 *   这个字符串同时用于 setblock/fill 的方块字段和 testforblock 的比对串，
 *   所以除了“名字 + 状态”以外，命令的其余格式一个字都没动。
 *   states 缺失或为空、或者调色板是旧式字符串数组时，行为与以前完全一致（纯方块名）。
 */
import { parseNbtTyped, toPlain } from "./nbt";
import type { NbtValue } from "./nbt-write";

export type StructureBlock = { x: number; y: number; z: number; block: string };

export type ParsedStructure = {
  name: string;
  size: { x: number; y: number; z: number };
  /** 需要放置的方块（已去掉空气与空位），按 z 最快的顺序；block 可能带 ["state"=值] 后缀 */
  blocks: StructureBlock[];
  total: number;
  paletteSize: number;
  skippedAir: number;
  /** 调色板里出现过的方块名（去重，含状态后缀） */
  materials: string[];
  /** 解析提醒（未映射的方块名等）；没有提醒时不设该字段 */
  issues?: string[];
};

export type BuildCommand = { command: string; count: number };

/** 字符串字面量：加双引号，转义反斜杠与双引号 */
function quoteLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 数字字面量：整数原样，浮点收敛到 6 位小数（避免 float32 的 0.30000001192） */
function numberLiteral(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

/** 单个状态值 → 命令里的字面量；无法表示的类型返回 null（调用方丢弃该键） */
function stateLiteral(v: NbtValue): string | null {
  switch (v.type) {
    case "byte":
      // Bedrock 的 bool 状态在 NBT 里存成 TAG_Byte（0/1）
      return v.value !== 0 ? "true" : "false";
    case "short":
    case "int":
      return String(Math.trunc(v.value));
    case "long":
      return typeof v.value === "bigint" ? v.value.toString() : String(Math.trunc(v.value));
    case "float":
    case "double":
      return numberLiteral(v.value);
    case "string":
      return quoteLiteral(v.value);
    default:
      // compound / list / 数组不是合法的方块状态值
      return null;
  }
}

/**
 * states compound → `["key"=值,"key"=值]`。
 * 没有状态（未提供、不是 compound、或所有键都非法）时返回空串，调用方退化回纯方块名。
 */
export function formatBlockStates(states?: NbtValue | null): string {
  if (!states || states.type !== "compound") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(states.fields)) {
    const literal = stateLiteral(value);
    if (literal === null) continue;
    parts.push(`${quoteLiteral(key)}=${literal}`);
  }
  return parts.length ? `[${parts.join(",")}]` : "";
}

/** 方块名 + 状态后缀（Bedrock 命令语法） */
export function blockWithStates(name: string, states?: NbtValue | null): string {
  return `${String(name).trim().toLowerCase()}${formatBlockStates(states)}`;
}

/** 沿 compound 路径取字段（类型 AST） */
function typedField(node: NbtValue | undefined, key: string): NbtValue | undefined {
  return node && node.type === "compound" ? node.fields[key] : undefined;
}

/** 取 palette.default.block_palette 的类型化条目（保留 TAG_Byte/TAG_Int 区别） */
function typedPaletteEntries(root: NbtValue): NbtValue[] {
  const defaultSection = typedField(typedField(typedField(root, "structure"), "palette"), "default");
  const palette = typedField(defaultSection, "block_palette");
  return palette && palette.type === "list" ? palette.items : [];
}

/** 调色板条目的方块名（兼容旧式「字符串数组」调色板） */
function paletteEntryName(entry: NbtValue | undefined, plain: any): string {
  if (entry?.type === "string") return entry.value.trim().toLowerCase() || "minecraft:air";
  const nameField = entry?.type === "compound" ? entry.fields.name : undefined;
  if (nameField?.type === "string") return nameField.value.trim().toLowerCase() || "minecraft:air";
  if (typeof plain === "string") return plain.trim().toLowerCase() || "minecraft:air";
  const fallback = String(plain?.name ?? "").trim().toLowerCase();
  return fallback || "minecraft:air";
}

export function parseMcStructure(buf: Buffer, name: string): ParsedStructure {
  const typedRoot = parseNbtTyped(buf).value;
  const root: any = toPlain(typedRoot);

  const sizeArr = root?.size;
  if (!Array.isArray(sizeArr) || sizeArr.length !== 3) {
    throw new Error("结构文件缺少 size 字段");
  }
  const sx = Math.max(0, Math.trunc(Number(sizeArr[0])));
  const sy = Math.max(0, Math.trunc(Number(sizeArr[1])));
  const sz = Math.max(0, Math.trunc(Number(sizeArr[2])));
  if (!sx || !sy || !sz) throw new Error(`结构尺寸无效：${sx}×${sy}×${sz}`);

  const palette = root?.structure?.palette?.default?.block_palette;
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new Error("结构文件缺少 palette.default.block_palette 字段");
  }

  // 带类型地读调色板：states 里的 TAG_Byte 要还原成布尔（true/false）
  const entries = typedPaletteEntries(typedRoot);
  const baseNames: string[] = [];
  const blockNames: string[] = [];
  for (let i = 0; i < palette.length; i++) {
    const entry = entries[i];
    const base = paletteEntryName(entry, palette[i]);
    baseNames.push(base);
    blockNames.push(blockWithStates(base, entry?.type === "compound" ? entry.fields.states : undefined));
  }

  const layers = root?.structure?.block_indices;
  if (!Array.isArray(layers) || !Array.isArray(layers[0])) {
    throw new Error("结构文件缺少 structure.block_indices 字段");
  }
  const layer0: number[] = layers[0].map((v: any) => Number(v));
  const totalPositions = sx * sy * sz;
  if (layer0.length !== totalPositions) {
    throw new Error(
      `block_indices 数量（${layer0.length}）与尺寸 ${sx}×${sy}×${sz}（${totalPositions}）不一致`
    );
  }

  const blocks: StructureBlock[] = [];
  let skippedAir = 0;
  for (let i = 0; i < layer0.length; i++) {
    const idx = layer0[i];
    if (idx < 0) continue; // 空位，保持原方块
    const base = baseNames[idx];
    if (!base || base === "minecraft:air" || base === "minecraft:structure_void") {
      skippedAir++;
      continue;
    }
    const z = i % sz;
    const y = Math.floor(i / sz) % sy;
    const x = Math.floor(i / (sz * sy));
    blocks.push({ x, y, z, block: blockNames[idx] ?? base });
  }

  const materials = [...new Set(blocks.map((b) => b.block))];
  return {
    name,
    size: { x: sx, y: sy, z: sz },
    blocks,
    total: blocks.length,
    paletteSize: palette.length,
    skippedAir,
    materials: materials.slice(0, 40),
  };
}

/**
 * 生成放置命令：沿 z 轴把连续同方块合并成 fill，显著减少命令数
 * @param origin 放置原点（世界坐标，对应结构局部坐标 0,0,0）
 * @param offsetY Y 方向额外偏移
 *
 * 注意：b.block 可能已经带 `["state"=值]` 后缀（P1-7），这里原样拼接，
 * 合并条件是「完整方块字符串相同」，所以同名字同状态才合并。
 */
export function structureCommands(
  st: ParsedStructure,
  origin: { x: number; y: number; z: number },
  offsetY = 0
): BuildCommand[] {
  const cmds: BuildCommand[] = [];
  const MAX_RUN = 64;
  const blocks = st.blocks;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    let j = i + 1;
    while (
      j < blocks.length &&
      j - i < MAX_RUN &&
      blocks[j].x === b.x &&
      blocks[j].y === b.y &&
      blocks[j].z === b.z + (j - i) &&
      blocks[j].block === b.block
    ) {
      j++;
    }
    const len = j - i;
    const wx = origin.x + b.x;
    const wy = origin.y + b.y + offsetY;
    const wz = origin.z + b.z;
    if (len === 1) {
      cmds.push({ command: `setblock ${wx} ${wy} ${wz} ${b.block}`, count: 1 });
    } else {
      cmds.push({
        command: `fill ${wx} ${wy} ${wz} ${wx} ${wy} ${wz + len - 1} ${b.block}`,
        count: len,
      });
    }
    i = j;
  }
  return cmds;
}
