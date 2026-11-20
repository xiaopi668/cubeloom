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

/** 命令方块元数据（坐标相对结构最小角，与 ParsedStructure.blocks 一致） */
export type CommandBlockUpdate = {
  x: number;
  y: number;
  z: number;
  /** 0=脉冲 1=循环 2=连锁 */
  mode: number;
  needsRedstone: boolean;
  conditional: boolean;
  tickDelay: number;
  executeOnFirstTick: boolean;
  command: string;
  customName: string;
};

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
  /** 命令方块内容（.vt 等格式）；没有时不设该字段 */
  commandBlocks?: CommandBlockUpdate[];
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
 * 单个 fill 的方块数上限。
 *
 * Bedrock 的 /fill 理论上限是 32768，但实际按「包含两端」计数，32768 会越界被拒，
 * 所以留 2 的余量（星月导入器同样用 32766）。
 */
const FILL_LIMIT = 32766;

export type StructureCommandOptions = {
  /**
   * 单个 fill 命令最多放多少方块（默认 32768，Bedrock 的 /fill 上限）。
   * 设成 1 就等于退回「每块一条 setblock」。
   */
  maxFillVolume?: number;
};

/**
 * 这些方块不能进 fill / 不能被批量覆盖：
 *   · 重力方块（沙、砂砾、混凝土粉末…）批量放置时会在半空中下落，落点全错；
 *   · 附着类（火把、铁轨、藤蔓、作物、告示牌、门…）需要依附面，fill 后状态会掉；
 *   · 液体/气泡柱等也一样。
 * 它们的统一处理是：先放完实心块，再逐块 setblock（自下而上）。
 *
 * 名单参考《星月导入器 1.0.5》chunk_fill.IsSpecialPlacementBlockName 的分类思路，
 * 这里按「名字后缀 + 明确枚举」实现，避免把普通建筑方块也逐块发出去。
 */
const SPECIAL_BLOCKS = new Set([
  "sand", "red_sand", "gravel", "suspicious_sand", "suspicious_gravel",
  "anvil", "chipped_anvil", "damaged_anvil", "dragon_egg", "pointed_dripstone", "scaffolding",
  "rail", "golden_rail", "detector_rail", "activator_rail",
  "grass", "tallgrass", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "vine",
  "weeping_vines", "twisting_vines", "cave_vines", "glow_lichen", "hanging_roots", "spore_blossom",
  "seagrass", "tall_seagrass", "kelp", "kelp_plant", "bamboo", "sugar_cane",
  "cactus", "lily_pad", "pink_petals", "torchflower", "pitcher_plant",
  "azalea", "flowering_azalea", "nether_sprouts", "mangrove_propagule",
  "leaf_litter", "wildflowers", "open_eyeblossom", "closed_eyeblossom",
  "pale_hanging_moss", "pale_moss_carpet",
  "wheat", "beetroot", "carrots", "potatoes", "nether_wart", "cocoa",
  "melon_stem", "pumpkin_stem", "attached_melon_stem", "attached_pumpkin_stem",
  "torchflower_crop", "pitcher_crop", "chorus_plant", "small_dripleaf", "big_dripleaf",
  "big_dripleaf_stem",
  "torch", "redstone_torch", "unlit_redstone_torch", "soul_torch", "underwater_torch",
  "fire", "soul_fire", "ladder", "lever", "tripwire", "tripwire_hook",
  "bed", "flower_pot", "candle", "sea_pickle", "turtle_egg", "snow_layer",
  "end_rod", "chain", "lantern", "soul_lantern", "fence_gate", "amethyst_cluster",
  "small_amethyst_bud", "medium_amethyst_bud", "large_amethyst_bud",
]);

const SPECIAL_SUFFIXES = [
  "_concrete_powder", "_carpet", "_pressure_plate", "_button", "_rail", "_sapling",
  "_flower", "_bush", "_roots", "_vine", "_fungus", "_mushroom", "_coral",
  "_coral_fan", "_sign", "_frame", "_door", "_trapdoor", "_torch", "_lantern",
  "_candle", "_bed", "_banner", "_skull", "_head", "_pot", "_campfire",
];

/** 方块名是否必须逐块放置（去掉 namespacing 与状态后缀再判断） */
export function needsIndividualPlacement(block: string): boolean {
  const bare = String(block || "").split("[")[0].trim().toLowerCase().replace(/^minecraft:/, "");
  if (!bare) return false;
  if (SPECIAL_BLOCKS.has(bare)) return true;
  return SPECIAL_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

/**
 * 生成放置命令：按方块做 **3D 贪心合块**，大块区域用一条 fill 命令覆盖。
 *
 * 以前只沿 z 轴合并成 1×1×N 的细条，大平面上命令数还是等于行数；
 * 现在先沿 z 长大，再沿 x 扩成平面，最后沿 y 堆成方块体，一个 16×16×16 的实心区
 * 只需要 1 条 fill（体积超过 /fill 上限时自动切片）。
 *
 * @param origin 放置原点（世界坐标，对应结构局部坐标 0,0,0）
 * @param offsetY Y 方向额外偏移
 * @param opts   maxFillVolume：单条 fill 的方块上限
 *
 * 注意：b.block 可能已经带 `["state"=值]` 后缀（P1-7），这里原样拼接，
 * 合并条件是「完整方块字符串相同」，所以同名字同状态才会合到同一个块里。
 */
export function structureCommands(
  st: ParsedStructure,
  origin: { x: number; y: number; z: number },
  offsetY = 0,
  opts: StructureCommandOptions = {}
): BuildCommand[] {
  const cmds: BuildCommand[] = [];
  const maxFill = Math.max(1, Math.min(FILL_LIMIT, Math.trunc(opts.maxFillVolume ?? FILL_LIMIT) || FILL_LIMIT));
  const sx = Math.max(1, st.size.x);
  const sy = Math.max(1, st.size.y);
  const sz = Math.max(1, st.size.z);
  /** 结构内局部坐标 → 唯一数字 key（坐标都在 [0, size) 内） */
  const keyOf = (x: number, y: number, z: number) => (x * sy + y) * sz + z;

  // 逐块放置的特殊方块（重力/附着类）：先收集，等实心块放完再自下而上补
  const special: StructureBlock[] = [];
  // 按方块字符串分组（同名字同状态才会合并）
  const groups = new Map<string, StructureBlock[]>();
  for (const b of st.blocks) {
    if (needsIndividualPlacement(b.block)) {
      special.push(b);
      continue;
    }
    let list = groups.get(b.block);
    if (!list) groups.set(b.block, (list = []));
    list.push(b);
  }

  /** 6 种生长顺序：不同形状下「先长哪根轴」差异很大，逐个试、取体积最大的 */
  const AXIS_ORDERS: Array<[number, number, number]> = [
    [2, 0, 1],
    [2, 1, 0],
    [0, 2, 1],
    [1, 2, 0],
    [0, 1, 2],
    [1, 0, 2],
  ];

  for (const [block, list] of groups) {
    list.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    const cells = new Set<number>();
    for (const b of list) cells.add(keyOf(b.x, b.y, b.z));
    const used = new Set<number>();

    for (const b of list) {
      if (used.has(keyOf(b.x, b.y, b.z))) continue;

      let best = { x2: b.x, y2: b.y, z2: b.z, volume: 1, dims: 0 };
      for (const order of AXIS_ORDERS) {
        let x2 = b.x;
        let y2 = b.y;
        let z2 = b.z;
        for (const axis of order) {
          for (;;) {
            if (axis === 0) {
              const x = x2 + 1;
              if (x >= sx) break;
              let ok = true;
              for (let y = b.y; y <= y2 && ok; y++) {
                for (let z = b.z; z <= z2; z++) {
                  const k = keyOf(x, y, z);
                  if (!cells.has(k) || used.has(k)) {
                    ok = false;
                    break;
                  }
                }
              }
              if (!ok) break;
              x2 = x;
            } else if (axis === 1) {
              const y = y2 + 1;
              if (y >= sy) break;
              let ok = true;
              for (let x = b.x; x <= x2 && ok; x++) {
                for (let z = b.z; z <= z2; z++) {
                  const k = keyOf(x, y, z);
                  if (!cells.has(k) || used.has(k)) {
                    ok = false;
                    break;
                  }
                }
              }
              if (!ok) break;
              y2 = y;
            } else {
              const z = z2 + 1;
              if (z >= sz) break;
              let ok = true;
              for (let x = b.x; x <= x2 && ok; x++) {
                for (let y = b.y; y <= y2; y++) {
                  const k = keyOf(x, y, z);
                  if (!cells.has(k) || used.has(k)) {
                    ok = false;
                    break;
                  }
                }
              }
              if (!ok) break;
              z2 = z;
            }
          }
        }
        const volume = (x2 - b.x + 1) * (y2 - b.y + 1) * (z2 - b.z + 1);
        const dims = (x2 > b.x ? 1 : 0) + (y2 > b.y ? 1 : 0) + (z2 > b.z ? 1 : 0);
        if (volume > best.volume || (volume === best.volume && dims > best.dims)) {
          best = { x2, y2, z2, volume, dims };
        }
      }

      const { x2, y2, z2 } = best;
      for (let x = b.x; x <= x2; x++) {
        for (let y = b.y; y <= y2; y++) {
          for (let z = b.z; z <= z2; z++) used.add(keyOf(x, y, z));
        }
      }

      const wx = origin.x + b.x;
      const wy = origin.y + b.y + offsetY;
      const wz = origin.z + b.z;
      const width = x2 - b.x + 1;
      const height = y2 - b.y + 1;
      const depth = z2 - b.z + 1;
      const volume = width * height * depth;

      if (volume === 1) {
        cmds.push({ command: `setblock ${wx} ${wy} ${wz} ${block}`, count: 1 });
        continue;
      }

      // 超过单条 fill 上限就切片：先按「一层」切 y，层本身还太大就再切 x
      const layer = width * depth;
      if (layer <= maxFill) {
        const perY = Math.max(1, Math.floor(maxFill / layer));
        for (let y = 0; y < height; y += perY) {
          const yEnd = Math.min(height - 1, y + perY - 1);
          cmds.push({
            command: `fill ${wx} ${wy + y} ${wz} ${wx + width - 1} ${wy + yEnd} ${wz + depth - 1} ${block}`,
            count: (yEnd - y + 1) * layer,
          });
        }
      } else {
        const perX = Math.max(1, Math.floor(maxFill / depth));
        for (let x = 0; x < width; x += perX) {
          const xEnd = Math.min(width - 1, x + perX - 1);
          const chunk = (xEnd - x + 1) * depth;
          const perY = Math.max(1, Math.floor(maxFill / chunk));
          for (let y = 0; y < height; y += perY) {
            const yEnd = Math.min(height - 1, y + perY - 1);
            cmds.push({
              command:
                `fill ${wx + x} ${wy + y} ${wz} ` +
                `${wx + xEnd} ${wy + yEnd} ${wz + depth - 1} ${block}`,
              count: (yEnd - y + 1) * chunk,
            });
          }
        }
      }
    }
  }

  // 特殊方块最后逐块放：此时支撑块已经在位，自下而上减少掉落/脱附
  special.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  for (const b of special) {
    cmds.push({
      command: `setblock ${origin.x + b.x} ${origin.y + b.y + offsetY} ${origin.z + b.z} ${b.block}`,
      count: 1,
    });
  }
  return cmds;
}
