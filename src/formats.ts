/**
 * 投影文件解析（Java 版格式 → 统一的 ParsedStructure）
 *
 * 支持：
 *  - .litematic  Litematica 投影（gzip + 大端 NBT，BlockStates 64 位连续位流）
 *  - .schem      Sponge 原理图 v1/v2（根上的 Palette + BlockData）与
 *                v3（Blocks.Palette + Blocks.Data），方块数据都是变长整数
 *  - .schematic  MCEdit/WorldEdit 经典原理图（gzip，Blocks 字节数组 + 可选 AddBlocks
 *                高 4 位 + Data 材质位：羊毛/染色玻璃/陶瓦/混凝土的颜色就在这里）
 *  - .nbt        结构方块导出的结构（大端 NBT）
 *  - .mcstructure Bedrock 结构（沿用 src/structure.ts，含方块状态）
 *
 * Java 方块名会过一张「Java → 基岩版」常见方块表（见 JAVA_TO_BEDROCK）；
 * 表里没有的名字原样保留，并记一条 issue（未映射名字的汇总）。
 *
 * Java 的状态属性（Palette 键里的 `[facing=north]`、litematic 的 Properties）
 * 目前不转换：Java 与基岩版的状态名不同（facing vs weirdo_direction 等），
 * 猜测映射会比丢掉更糟，所以只保留方块名。
 */
import { parseNbt } from "./nbt";
import { parseJavaNbt } from "./java-nbt";
import { parseMcStructure, ParsedStructure, StructureBlock } from "./structure";

const AIR = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:structure_void",
]);

/** 经典 .schematic 数字 ID → 方块名（常见方块子集） */
const LEGACY_IDS: Record<number, string> = {
  1: "minecraft:stone",
  2: "minecraft:grass_block",
  3: "minecraft:dirt",
  4: "minecraft:cobblestone",
  5: "minecraft:oak_planks",
  6: "minecraft:oak_sapling",
  7: "minecraft:bedrock",
  8: "minecraft:water",
  9: "minecraft:water",
  10: "minecraft:lava",
  11: "minecraft:lava",
  12: "minecraft:sand",
  13: "minecraft:gravel",
  14: "minecraft:gold_ore",
  15: "minecraft:iron_ore",
  16: "minecraft:coal_ore",
  17: "minecraft:oak_log",
  18: "minecraft:oak_leaves",
  19: "minecraft:sponge",
  20: "minecraft:glass",
  21: "minecraft:lapis_ore",
  22: "minecraft:lapis_block",
  23: "minecraft:dispenser",
  24: "minecraft:sandstone",
  25: "minecraft:note_block",
  26: "minecraft:red_bed",
  27: "minecraft:powered_rail",
  28: "minecraft:detector_rail",
  29: "minecraft:sticky_piston",
  30: "minecraft:cobweb",
  31: "minecraft:grass",
  32: "minecraft:dead_bush",
  33: "minecraft:piston",
  34: "minecraft:piston_head",
  35: "minecraft:white_wool",
  37: "minecraft:dandelion",
  38: "minecraft:poppy",
  39: "minecraft:brown_mushroom",
  40: "minecraft:red_mushroom",
  41: "minecraft:gold_block",
  42: "minecraft:iron_block",
  43: "minecraft:smooth_stone_slab",
  44: "minecraft:stone_slab",
  45: "minecraft:bricks",
  46: "minecraft:tnt",
  47: "minecraft:bookshelf",
  48: "minecraft:mossy_cobblestone",
  49: "minecraft:obsidian",
  50: "minecraft:torch",
  51: "minecraft:fire",
  52: "minecraft:spawner",
  53: "minecraft:oak_stairs",
  54: "minecraft:chest",
  55: "minecraft:redstone_wire",
  56: "minecraft:diamond_ore",
  57: "minecraft:diamond_block",
  58: "minecraft:crafting_table",
  59: "minecraft:wheat",
  60: "minecraft:farmland",
  61: "minecraft:furnace",
  62: "minecraft:oak_sign",
  63: "minecraft:oak_door",
  64: "minecraft:ladder",
  65: "minecraft:rail",
  66: "minecraft:cobblestone_stairs",
  67: "minecraft:cobblestone_stairs",
  68: "minecraft:oak_wall_sign",
  69: "minecraft:lever",
  70: "minecraft:stone_pressure_plate",
  71: "minecraft:iron_door",
  72: "minecraft:oak_pressure_plate",
  73: "minecraft:redstone_ore",
  74: "minecraft:redstone_torch",
  75: "minecraft:redstone_wall_torch",
  76: "minecraft:redstone_torch",
  77: "minecraft:stone_button",
  78: "minecraft:snow",
  79: "minecraft:ice",
  80: "minecraft:snow_block",
  81: "minecraft:cactus",
  82: "minecraft:clay",
  83: "minecraft:sugar_cane",
  84: "minecraft:jukebox",
  85: "minecraft:oak_fence",
  86: "minecraft:carved_pumpkin",
  87: "minecraft:netherrack",
  88: "minecraft:soul_sand",
  89: "minecraft:glowstone",
  90: "minecraft:nether_portal",
  91: "minecraft:jack_o_lantern",
  92: "minecraft:cake",
  93: "minecraft:repeater",
  94: "minecraft:repeater",
  95: "minecraft:white_stained_glass",
  96: "minecraft:oak_trapdoor",
  97: "minecraft:infested_stone",
  98: "minecraft:stone_bricks",
  99: "minecraft:brown_mushroom_block",
  100: "minecraft:red_mushroom_block",
  101: "minecraft:iron_bars",
  102: "minecraft:glass_pane",
  103: "minecraft:melon",
  104: "minecraft:pumpkin_stem",
  105: "minecraft:melon_stem",
  106: "minecraft:vine",
  107: "minecraft:oak_fence_gate",
  108: "minecraft:brick_stairs",
  109: "minecraft:stone_brick_stairs",
  110: "minecraft:mycelium",
  111: "minecraft:lily_pad",
  112: "minecraft:nether_bricks",
  113: "minecraft:nether_brick_fence",
  114: "minecraft:nether_brick_stairs",
  115: "minecraft:nether_wart",
  116: "minecraft:enchanting_table",
  117: "minecraft:brewing_stand",
  118: "minecraft:cauldron",
  119: "minecraft:end_portal",
  120: "minecraft:end_portal_frame",
  121: "minecraft:end_stone",
  122: "minecraft:dragon_egg",
  123: "minecraft:redstone_lamp",
  124: "minecraft:redstone_lamp",
  125: "minecraft:oak_slab",
  126: "minecraft:oak_slab",
  128: "minecraft:sandstone_stairs",
  129: "minecraft:emerald_ore",
  130: "minecraft:ender_chest",
  131: "minecraft:tripwire_hook",
  132: "minecraft:tripwire",
  133: "minecraft:emerald_block",
  134: "minecraft:spruce_stairs",
  135: "minecraft:birch_stairs",
  136: "minecraft:jungle_stairs",
  137: "minecraft:command_block",
  138: "minecraft:beacon",
  139: "minecraft:cobblestone_wall",
  140: "minecraft:flower_pot",
  141: "minecraft:carrots",
  142: "minecraft:potatoes",
  143: "minecraft:oak_button",
  144: "minecraft:skeleton_skull",
  145: "minecraft:anvil",
  146: "minecraft:trapped_chest",
  147: "minecraft:light_weighted_pressure_plate",
  148: "minecraft:heavy_weighted_pressure_plate",
  149: "minecraft:comparator",
  150: "minecraft:comparator",
  151: "minecraft:daylight_detector",
  152: "minecraft:redstone_block",
  153: "minecraft:nether_quartz_ore",
  154: "minecraft:hopper",
  155: "minecraft:quartz_block",
  156: "minecraft:quartz_stairs",
  157: "minecraft:activator_rail",
  158: "minecraft:dropper",
  159: "minecraft:white_terracotta",
  160: "minecraft:white_stained_glass_pane",
  161: "minecraft:acacia_leaves",
  162: "minecraft:acacia_log",
  163: "minecraft:acacia_stairs",
  164: "minecraft:dark_oak_stairs",
  168: "minecraft:prismarine",
  169: "minecraft:sea_lantern",
  170: "minecraft:hay_block",
  171: "minecraft:white_carpet",
  172: "minecraft:terracotta",
  173: "minecraft:coal_block",
  174: "minecraft:packed_ice",
  175: "minecraft:sunflower",
  179: "minecraft:red_sandstone",
  180: "minecraft:red_sandstone_stairs",
  181: "minecraft:red_sandstone_slab",
  182: "minecraft:spruce_fence_gate",
  183: "minecraft:birch_fence_gate",
  184: "minecraft:jungle_fence_gate",
  185: "minecraft:dark_oak_fence_gate",
  186: "minecraft:acacia_fence_gate",
  187: "minecraft:spruce_fence",
  188: "minecraft:birch_fence",
  189: "minecraft:jungle_fence",
  190: "minecraft:dark_oak_fence",
  191: "minecraft:acacia_fence",
  192: "minecraft:spruce_door",
  193: "minecraft:birch_door",
  194: "minecraft:jungle_door",
  195: "minecraft:acacia_door",
  196: "minecraft:dark_oak_door",
  197: "minecraft:end_rod",
  198: "minecraft:chorus_plant",
  199: "minecraft:chorus_flower",
  200: "minecraft:purpur_block",
  201: "minecraft:purpur_pillar",
  202: "minecraft:purpur_stairs",
  203: "minecraft:purpur_slab",
  204: "minecraft:purpur_slab",
  205: "minecraft:purpur_slab",
  206: "minecraft:end_stone_bricks",
  208: "minecraft:dirt_path",
  210: "minecraft:repeating_command_block",
  211: "minecraft:chain_command_block",
  213: "minecraft:magma_block",
  214: "minecraft:nether_wart_block",
  215: "minecraft:red_nether_bricks",
  216: "minecraft:bone_block",
  218: "minecraft:observer",
  219: "minecraft:white_shulker_box",
  220: "minecraft:orange_shulker_box",
  221: "minecraft:magenta_shulker_box",
  222: "minecraft:light_blue_shulker_box",
  223: "minecraft:yellow_shulker_box",
  224: "minecraft:lime_shulker_box",
  225: "minecraft:pink_shulker_box",
  226: "minecraft:gray_shulker_box",
  227: "minecraft:light_gray_shulker_box",
  228: "minecraft:cyan_shulker_box",
  229: "minecraft:purple_shulker_box",
  230: "minecraft:blue_shulker_box",
  231: "minecraft:brown_shulker_box",
  232: "minecraft:green_shulker_box",
  233: "minecraft:red_shulker_box",
  234: "minecraft:black_shulker_box",
  235: "minecraft:white_glazed_terracotta",
  236: "minecraft:orange_glazed_terracotta",
  237: "minecraft:magenta_glazed_terracotta",
  238: "minecraft:light_blue_glazed_terracotta",
  239: "minecraft:yellow_glazed_terracotta",
  240: "minecraft:lime_glazed_terracotta",
  241: "minecraft:pink_glazed_terracotta",
  242: "minecraft:gray_glazed_terracotta",
  243: "minecraft:light_gray_glazed_terracotta",
  244: "minecraft:cyan_glazed_terracotta",
  245: "minecraft:purple_glazed_terracotta",
  246: "minecraft:blue_glazed_terracotta",
  247: "minecraft:brown_glazed_terracotta",
  248: "minecraft:green_glazed_terracotta",
  249: "minecraft:red_glazed_terracotta",
  250: "minecraft:black_glazed_terracotta",
  251: "minecraft:white_concrete",
  252: "minecraft:white_concrete_powder",
};

function isAir(name: string): boolean {
  return AIR.has(name);
}

/** 16 种染色变体的顺序（羊毛 / 染色玻璃 / 陶瓦 / 混凝土…的 Data 值） */
const DYE_COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];

/** 木板/台阶的木质顺序（Data 0..5） */
const PLANK_TYPES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"];
/** 原木的木质顺序（id 17 的 Data & 3） */
const LOG_TYPES = ["oak", "spruce", "birch", "jungle"];

/** id 1（石头）的 Data 变种 */
const STONE_VARIANTS: Array<string | undefined> = [
  "minecraft:stone",
  "minecraft:granite",
  "minecraft:polished_granite",
  "minecraft:diorite",
  "minecraft:polished_diorite",
  "minecraft:andesite",
  "minecraft:polished_andesite",
];

/**
 * Java 方块名 → 基岩版方块名（常见方块表）。
 *
 * 同名方块也显式列出来：这样“表里没有”才真正代表“这个名字我们没把握”，
 * 遇到未收录的名字会保留原名并记一条 issue（见 createNameMapper）。
 * 注意 Java 与基岩版都叫 `oak_log` —— 不要映射成 `oak_wood`。
 */
const JAVA_TO_BEDROCK: Record<string, string> = {
  // —— 同名方块（只需要补 minecraft: 命名空间）——
  "minecraft:air": "minecraft:air",
  "minecraft:cave_air": "minecraft:cave_air",
  "minecraft:void_air": "minecraft:void_air",
  "minecraft:structure_void": "minecraft:structure_void",
  "minecraft:stone": "minecraft:stone",
  "minecraft:granite": "minecraft:granite",
  "minecraft:diorite": "minecraft:diorite",
  "minecraft:andesite": "minecraft:andesite",
  "minecraft:cobblestone": "minecraft:cobblestone",
  "minecraft:mossy_cobblestone": "minecraft:mossy_cobblestone",
  "minecraft:stone_bricks": "minecraft:stone_bricks",
  "minecraft:dirt": "minecraft:dirt",
  "minecraft:grass_block": "minecraft:grass_block",
  "minecraft:sand": "minecraft:sand",
  "minecraft:red_sand": "minecraft:red_sand",
  "minecraft:sandstone": "minecraft:sandstone",
  "minecraft:red_sandstone": "minecraft:red_sandstone",
  "minecraft:gravel": "minecraft:gravel",
  "minecraft:clay": "minecraft:clay",
  "minecraft:bedrock": "minecraft:bedrock",
  "minecraft:obsidian": "minecraft:obsidian",
  "minecraft:netherrack": "minecraft:netherrack",
  "minecraft:soul_sand": "minecraft:soul_sand",
  "minecraft:end_stone": "minecraft:end_stone",
  "minecraft:ice": "minecraft:ice",
  "minecraft:packed_ice": "minecraft:packed_ice",
  "minecraft:glass": "minecraft:glass",
  "minecraft:glass_pane": "minecraft:glass_pane",
  "minecraft:water": "minecraft:water",
  "minecraft:lava": "minecraft:lava",
  "minecraft:oak_planks": "minecraft:oak_planks",
  "minecraft:spruce_planks": "minecraft:spruce_planks",
  "minecraft:birch_planks": "minecraft:birch_planks",
  "minecraft:jungle_planks": "minecraft:jungle_planks",
  "minecraft:acacia_planks": "minecraft:acacia_planks",
  "minecraft:dark_oak_planks": "minecraft:dark_oak_planks",
  "minecraft:oak_log": "minecraft:oak_log",
  "minecraft:spruce_log": "minecraft:spruce_log",
  "minecraft:birch_log": "minecraft:birch_log",
  "minecraft:jungle_log": "minecraft:jungle_log",
  "minecraft:acacia_log": "minecraft:acacia_log",
  "minecraft:dark_oak_log": "minecraft:dark_oak_log",
  "minecraft:oak_leaves": "minecraft:oak_leaves",
  "minecraft:oak_slab": "minecraft:oak_slab",
  "minecraft:oak_stairs": "minecraft:oak_stairs",
  "minecraft:cobblestone_stairs": "minecraft:cobblestone_stairs",
  "minecraft:stone_brick_stairs": "minecraft:stone_brick_stairs",
  "minecraft:oak_fence": "minecraft:oak_fence",
  "minecraft:oak_fence_gate": "minecraft:oak_fence_gate",
  "minecraft:oak_door": "minecraft:oak_door",
  "minecraft:oak_trapdoor": "minecraft:oak_trapdoor",
  "minecraft:oak_sign": "minecraft:oak_sign",
  "minecraft:torch": "minecraft:torch",
  "minecraft:chest": "minecraft:chest",
  "minecraft:trapped_chest": "minecraft:trapped_chest",
  "minecraft:crafting_table": "minecraft:crafting_table",
  "minecraft:furnace": "minecraft:furnace",
  "minecraft:bookshelf": "minecraft:bookshelf",
  "minecraft:ladder": "minecraft:ladder",
  "minecraft:tnt": "minecraft:tnt",
  "minecraft:coal_ore": "minecraft:coal_ore",
  "minecraft:iron_ore": "minecraft:iron_ore",
  "minecraft:gold_ore": "minecraft:gold_ore",
  "minecraft:diamond_ore": "minecraft:diamond_ore",
  "minecraft:redstone_ore": "minecraft:redstone_ore",
  "minecraft:lapis_ore": "minecraft:lapis_ore",
  "minecraft:emerald_ore": "minecraft:emerald_ore",
  "minecraft:coal_block": "minecraft:coal_block",
  "minecraft:iron_block": "minecraft:iron_block",
  "minecraft:gold_block": "minecraft:gold_block",
  "minecraft:diamond_block": "minecraft:diamond_block",
  "minecraft:emerald_block": "minecraft:emerald_block",
  "minecraft:lapis_block": "minecraft:lapis_block",
  "minecraft:quartz_block": "minecraft:quartz_block",
  "minecraft:smooth_stone": "minecraft:smooth_stone",
  "minecraft:stone_slab": "minecraft:stone_slab",
  "minecraft:white_wool": "minecraft:white_wool",
  // —— 改过名的方块 ——
  "minecraft:bricks": "minecraft:brick_block",
  "minecraft:nether_bricks": "minecraft:nether_brick",
  "minecraft:red_nether_bricks": "minecraft:red_nether_brick",
  "minecraft:end_stone_bricks": "minecraft:end_bricks",
  "minecraft:cobweb": "minecraft:web",
  "minecraft:dead_bush": "minecraft:deadbush",
  "minecraft:lily_pad": "minecraft:waterlily",
  "minecraft:melon": "minecraft:melon_block",
  "minecraft:melon_slice": "minecraft:melon",
  "minecraft:magma_block": "minecraft:magma",
  "minecraft:terracotta": "minecraft:hardened_clay",
  "minecraft:snow_block": "minecraft:snow",
  "minecraft:snow": "minecraft:snow_layer",
  "minecraft:spawner": "minecraft:mob_spawner",
  "minecraft:wall_torch": "minecraft:torch",
  "minecraft:redstone_wall_torch": "minecraft:redstone_torch",
  "minecraft:soul_wall_torch": "minecraft:soul_torch",
};

/**
 * 经典 .schematic：Blocks 的 id + Data 材质位 → 方块名。
 * 只覆盖「Data 决定材质」的几类（羊毛、染色玻璃、陶瓦、混凝土、木板、原木、石头变种），
 * Data 只表示朝向/半砖的那几百个方块不在这里猜。
 */
const LEGACY_DATA_NAMES: Record<number, (data: number) => string | undefined> = {
  1: (d) => STONE_VARIANTS[d],
  5: (d) => (d < PLANK_TYPES.length ? `minecraft:${PLANK_TYPES[d]}_planks` : undefined),
  17: (d) => `minecraft:${LOG_TYPES[d & 3]}_log`,
  18: (d) => `minecraft:${LOG_TYPES[d & 3]}_leaves`,
  24: (d) =>
    ["minecraft:sandstone", "minecraft:chiseled_sandstone", "minecraft:cut_sandstone"][d] as string | undefined,
  35: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_wool` : undefined),
  95: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_stained_glass` : undefined),
  98: (d) =>
    [
      "minecraft:stone_bricks",
      "minecraft:mossy_stone_bricks",
      "minecraft:cracked_stone_bricks",
      "minecraft:chiseled_stone_bricks",
    ][d] as string | undefined,
  125: (d) => (d < PLANK_TYPES.length ? `minecraft:${PLANK_TYPES[d]}_slab` : undefined),
  126: (d) => (d < PLANK_TYPES.length ? `minecraft:${PLANK_TYPES[d]}_slab` : undefined),
  159: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_terracotta` : undefined),
  160: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_stained_glass_pane` : undefined),
  162: (d) => (d === 0 ? "minecraft:acacia_log" : "minecraft:dark_oak_log"),
  171: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_carpet` : undefined),
  179: (d) =>
    ["minecraft:red_sandstone", "minecraft:chiseled_red_sandstone", "minecraft:cut_red_sandstone"][d] as
      | string
      | undefined,
  251: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_concrete` : undefined),
  252: (d) => (d < 16 ? `minecraft:${DYE_COLORS[d]}_concrete_powder` : undefined),
};

type NameMapper = {
  /** Java 方块名 → 基岩版；表里没有的原样返回，并记入 unmapped */
  map: (raw: any) => string;
  /** 确定已经是基岩版名的直接采用，不记 unmapped */
  keep: (raw: any) => string;
  /** 未收录的 Java 方块名（去重） */
  unmapped: Set<string>;
  /** 汇总成 ParsedStructure.issues */
  issues: () => string[];
};

/**
 * 归一化方块名：小写、补齐 minecraft: 命名空间、去掉 Java 状态属性
 * （`minecraft:oak_stairs[facing=north]` → `minecraft:oak_stairs`），再过改名表。
 */
function createNameMapper(): NameMapper {
  const unmapped = new Set<string>();

  const resolve = (raw: any): { name: string; mapped: boolean } => {
    let n = String(raw ?? "minecraft:air").trim().toLowerCase();
    if (!n) n = "minecraft:air";
    const bracket = n.indexOf("[");
    if (bracket > 0) n = n.slice(0, bracket);
    if (!n.includes(":")) n = `minecraft:${n}`;
    const mapped = JAVA_TO_BEDROCK[n];
    return { name: mapped ?? n, mapped: mapped !== undefined };
  };

  return {
    map(raw: any): string {
      const r = resolve(raw);
      if (!r.mapped) unmapped.add(r.name);
      return r.name;
    },
    keep(raw: any): string {
      return resolve(raw).name;
    },
    unmapped,
    issues(): string[] {
      if (!unmapped.size) return [];
      const names = [...unmapped];
      const sample = names.slice(0, 5).join(", ");
      const more = names.length > 5 ? ` 等 ${names.length} 个` : "";
      return [`Java 方块名未在映射表内，按原名保留：${sample}${more}`];
    },
  };
}

/** 统一收尾：把坐标平移到最小角、排序（x→y→z）、生成 ParsedStructure */
function finish(
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

/** ===== Litematica ===== */
/** 连续位流解包（Litematica 的 BlockStates 是 64 位打包，位宽可以跨 long 边界） */
function unpackContinuous(states: bigint[], bits: number, count: number): number[] {
  const mask = (1n << BigInt(bits)) - 1n;
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const bitPos = i * bits;
    const word = Math.floor(bitPos / 64);
    const shift = bitPos % 64;
    let v = BigInt.asUintN(64, states[word] ?? 0n) >> BigInt(shift);
    if (shift + bits > 64) {
      const hi = BigInt.asUintN(64, states[word + 1] ?? 0n) << BigInt(64 - shift);
      v |= hi;
    }
    ids[i] = Number(v & mask);
  }
  return ids;
}

/** 按「每个 long 内补齐」解包（少数工具用这种打包） */
function unpackPadded(states: bigint[], bits: number, count: number): number[] {
  const mask = (1n << BigInt(bits)) - 1n;
  const perLong = Math.max(1, Math.floor(64 / bits));
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const word = Math.floor(i / perLong);
    const shift = (i % perLong) * bits;
    ids[i] = Number((BigInt.asUintN(64, states[word] ?? 0n) >> BigInt(shift)) & mask);
  }
  return ids;
}

/**
 * 反推 Litematica 的位宽（P1-8）。
 *
 * 旧实现按 `max(1, ceil(log2(palette)))` 猜：调色板只有 2 项时算出 1 位，
 * 而 Litematica 实际按 2 位打包，于是整个位流错位（夹具里 50 块解成 25 块）。
 * 现在按「体积 × bits 向上取整 / 64 == long 数组长度」反推，候选从
 * `max(2, ceil(log2(palette 长度)))` 开始，取最小的自洽位宽。
 *
 * long 数组长度和任何位宽都对不上时**抛错**，不再静默按猜的位宽解码。
 */
export function inferLitematicBits(longCount: number, volume: number, paletteLen: number): number {
  const minBits = Math.max(2, Math.ceil(Math.log2(Math.max(2, paletteLen))));
  for (let bits = minBits; bits <= 32; bits++) {
    if (Math.ceil((volume * bits) / 64) === longCount) return bits;
  }
  for (let bits = minBits; bits <= 32; bits++) {
    const perLong = Math.floor(64 / bits);
    if (perLong > 0 && Math.ceil(volume / perLong) === longCount) return bits;
  }
  throw new Error(
    `Litematica BlockStates 长度（${longCount} 个 long）与体积（${volume}）不匹配：` +
      `按 64 位打包反推不到任何合法位宽（调色板 ${paletteLen} 项，最少 ${minBits} 位），文件可能损坏`
  );
}

function unpackLitematic(
  states: bigint[],
  bits: number,
  count: number,
  paletteLen: number
): number[] {
  const within = (ids: number[]) => ids.every((v) => v < paletteLen);
  const continuous = unpackContinuous(states, bits, count);
  if (within(continuous)) return continuous;
  const padded = unpackPadded(states, bits, count);
  if (within(padded)) return padded;
  const bad = continuous.find((v) => v >= paletteLen) ?? paletteLen;
  throw new Error(
    `Litematica 方块索引越界（${bad} ≥ 调色板 ${paletteLen} 项）：位宽 ${bits} 可能不正确，文件可能损坏`
  );
}

function parseLitematic(root: any, name: string): ParsedStructure {
  const regions = root.Regions;
  if (!regions || typeof regions !== "object") throw new Error("不是 Litematica 投影（缺少 Regions）");
  const mapper = createNameMapper();
  const raw: StructureBlock[] = [];
  let paletteSize = 0;
  let skipped = 0;
  for (const region of Object.values<any>(regions)) {
    const pos = region?.Position || { x: 0, y: 0, z: 0 };
    const size = region?.Size || { x: 0, y: 0, z: 0 };
    const sx = Math.abs(Math.trunc(Number(size.x)));
    const sy = Math.abs(Math.trunc(Number(size.y)));
    const sz = Math.abs(Math.trunc(Number(size.z)));
    if (!sx || !sy || !sz) continue;
    const palette: any[] = Array.isArray(region?.BlockStatePalette) ? region.BlockStatePalette : [];
    paletteSize = Math.max(paletteSize, palette.length);
    const names = palette.map((p) => mapper.map(p?.Name ?? p?.name));
    const volume = sx * sy * sz;
    const packed: bigint[] | undefined = Array.isArray(region?.BlockStates) ? region.BlockStates : undefined;
    let ids: number[];
    if (!packed || !packed.length) {
      ids = new Array(volume).fill(0);
    } else {
      const words = packed.map((v) => (typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)))));
      const bits = inferLitematicBits(words.length, volume, Math.max(1, palette.length));
      ids = unpackLitematic(words, bits, volume, Math.max(1, palette.length));
    }
    const px = Math.trunc(Number(pos.x));
    const py = Math.trunc(Number(pos.y));
    const pz = Math.trunc(Number(pos.z));
    const negX = Number(size.x) < 0;
    const negY = Number(size.y) < 0;
    const negZ = Number(size.z) < 0;
    for (let i = 0; i < volume; i++) {
      const nm = names[ids[i]] ?? "minecraft:air";
      if (isAir(nm)) {
        skipped++;
        continue;
      }
      const lx = i % sx;
      const lz = Math.floor(i / sx) % sz;
      const ly = Math.floor(i / (sx * sz));
      raw.push({
        x: px + (negX ? -lx - 1 : lx),
        y: py + (negY ? -ly - 1 : ly),
        z: pz + (negZ ? -lz - 1 : lz),
        block: nm,
      });
    }
  }
  return finish(name, raw, paletteSize, skipped, mapper.issues());
}

/** ===== Sponge 原理图（.schem） ===== */
function decodeVarints(data: number[], count: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length && out.length < count) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (i >= data.length) throw new Error("BlockData 变长整数被截断");
      const b = data[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error("BlockData 变长整数损坏");
    }
    out.push(value >>> 0);
  }
  return out;
}

/**
 * Sponge 原理图：v1/v2 的方块数据在根上的 Palette + BlockData，
 * v3 挪到了 Blocks.Palette + Blocks.Data（生物群系另有 Biomes.Palette/Data，不关心）。
 */
function parseSponge(root: any, name: string): ParsedStructure {
  const sch = root.Schematic && typeof root.Schematic === "object" ? root.Schematic : root;
  const sx = Math.trunc(Number(sch.Width));
  const sy = Math.trunc(Number(sch.Height));
  const sz = Math.trunc(Number(sch.Length));
  if (!sx || !sy || !sz) throw new Error("Sponge 原理图缺少 Width/Height/Length");

  let palette: any = sch.Palette;
  let data: any = sch.BlockData;
  const blocksNode =
    sch.Blocks && typeof sch.Blocks === "object" && !Array.isArray(sch.Blocks) ? sch.Blocks : null;
  if (blocksNode) {
    if (blocksNode.Palette && typeof blocksNode.Palette === "object") palette = blocksNode.Palette;
    if (Array.isArray(blocksNode.Data)) data = blocksNode.Data;
  }
  if (!palette || typeof palette !== "object" || !Array.isArray(data)) {
    throw new Error(
      `Sponge 原理图缺少调色板或方块数据（Version=${sch.Version ?? "未知"}）：` +
        `支持 v1/v2 的 Palette+BlockData 与 v3 的 Blocks.Palette+Blocks.Data`
    );
  }

  const mapper = createNameMapper();
  const rev = new Map<number, string>();
  for (const [n, idx] of Object.entries(palette)) rev.set(Number(idx), mapper.map(n));

  const volume = sx * sy * sz;
  const ids = decodeVarints(data, volume);
  if (ids.length !== volume) {
    throw new Error(
      `Sponge 原理图方块数据只有 ${ids.length} 项，与 ${sx}×${sy}×${sz}（${volume}）不一致`
    );
  }

  const raw: StructureBlock[] = [];
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    const nm = rev.get(ids[i]);
    if (!nm || isAir(nm)) {
      skipped++;
      continue;
    }
    const x = i % sx;
    const z = Math.floor(i / sx) % sz;
    const y = Math.floor(i / (sx * sz));
    raw.push({ x, y, z, block: nm });
  }
  return finish(name, raw, rev.size, skipped, mapper.issues());
}

/** ===== MCEdit / WorldEdit 经典 .schematic ===== */
function parseSchematic(root: any, name: string): ParsedStructure {
  const sx = Math.trunc(Number(root.Width));
  const sy = Math.trunc(Number(root.Height));
  const sz = Math.trunc(Number(root.Length));
  if (!sx || !sy || !sz) throw new Error("原理图缺少 Width/Height/Length");

  // 少数工具把 Sponge 的原理图（v2 的 Palette/BlockData、v3 的 Blocks 复合体）塞进 .schematic
  if (root.Palette && Array.isArray(root.BlockData)) return parseSponge(root, name);
  if (root.Blocks && typeof root.Blocks === "object" && !Array.isArray(root.Blocks)) {
    return parseSponge(root, name);
  }

  const blocksArr = root.Blocks;
  if (!Array.isArray(blocksArr)) throw new Error("原理图缺少 Blocks 数据");
  const add = Array.isArray(root.AddBlocks) ? root.AddBlocks : null;
  // Data：每格一个字节的材质/damage 位（羊毛颜色、木板种类、楼梯朝向都在这里）
  const dataArr = Array.isArray(root.Data) ? root.Data : null;
  const palette: Record<string, any> | null =
    root.Palette && typeof root.Palette === "object" && !Array.isArray(root.Palette) ? root.Palette : null;
  const mapper = createNameMapper();
  const rev = new Map<number, string>();
  if (palette) for (const [n, idx] of Object.entries(palette)) rev.set(Number(idx), mapper.map(n));

  const raw: StructureBlock[] = [];
  let skipped = 0;
  let unknown = 0;
  const volume = sx * sy * sz;
  for (let i = 0; i < volume; i++) {
    const low = (blocksArr[i] ?? 0) & 0xff;
    let high = 0;
    if (add) high = ((add[i >> 1] ?? 0) >> ((i & 1) * 4)) & 0x0f;
    const id = low | (high << 8);
    const data = dataArr ? (dataArr[i] ?? 0) & 0x0f : 0;
    let nm: string | undefined;
    if (palette) {
      // 有 Palette 时索引是调色板下标，不能再拿经典 ID 表去猜
      nm = rev.get(id);
    } else {
      const legacy = LEGACY_DATA_NAMES[id]?.(data) ?? LEGACY_IDS[id];
      nm = legacy === undefined ? undefined : mapper.keep(legacy);
    }
    if (nm === undefined) {
      unknown++;
      skipped++;
      continue;
    }
    if (isAir(nm)) {
      skipped++;
      continue;
    }
    const x = i % sx;
    const z = Math.floor(i / sx) % sz;
    const y = Math.floor(i / (sx * sz));
    raw.push({ x, y, z, block: nm });
  }
  if (unknown > 0 && raw.length === 0) {
    throw new Error(
      palette
        ? `调色板里没有这些方块索引（${unknown} 个位置），无法映射到方块名`
        : `无法识别的旧版方块 ID ${unknown} 个（该文件可能没有 Palette，暂不支持）`
    );
  }
  return finish(name, raw, rev.size || 256, skipped, mapper.issues());
}

/** ===== 结构方块 .nbt（Java） ===== */
function parseJavaStructure(root: any, name: string): ParsedStructure {
  const size = Array.isArray(root.size) ? root.size : null;
  if (!size || size.length !== 3) throw new Error("结构文件缺少 size");
  const sx = Math.trunc(Number(size[0]));
  const sy = Math.trunc(Number(size[1]));
  const sz = Math.trunc(Number(size[2]));
  if (!sx || !sy || !sz) throw new Error("结构尺寸无效");
  const mapper = createNameMapper();
  const palette: any[] = Array.isArray(root.palette) ? root.palette : [];
  const names = palette.map((p) => mapper.map(p?.Name ?? p?.name));
  const blocks: any[] = Array.isArray(root.blocks) ? root.blocks : [];
  const raw: StructureBlock[] = [];
  let skipped = 0;
  for (const b of blocks) {
    const pos = Array.isArray(b?.pos) ? b.pos : null;
    const st = Math.trunc(Number(b?.state ?? 0));
    if (!pos || pos.length !== 3) continue;
    const nm = names[st];
    if (!nm || isAir(nm)) {
      skipped++;
      continue;
    }
    raw.push({ x: Math.trunc(Number(pos[0])), y: Math.trunc(Number(pos[1])), z: Math.trunc(Number(pos[2])), block: nm });
  }
  return finish(name, raw, palette.length, skipped, mapper.issues());
}

/** 根据 NBT 根节点判断投影格式并解析 */
function fromJavaRoot(root: any, name: string): ParsedStructure {
  if (root && typeof root === "object") {
    // Litematica 一定有 Regions（Sponge v3 也有 Metadata，不能只看 Metadata）
    if (root.Regions) return parseLitematic(root, name);
    if (root.Schematic && typeof root.Schematic === "object") return parseSponge(root, name);
    if (root.Palette && Array.isArray(root.BlockData)) return parseSponge(root, name);
    // Sponge v3 也可能没有 Schematic 外壳，直接是根上的 Blocks 复合体
    if (root.Blocks && typeof root.Blocks === "object" && !Array.isArray(root.Blocks)) {
      return parseSponge(root, name);
    }
    if (root.Width !== undefined && root.Height !== undefined && root.Length !== undefined) {
      return root.Palette && !Array.isArray(root.Blocks)
        ? parseSponge(root, name)
        : parseSchematic(root, name);
    }
    if (root.size && root.palette && root.blocks) return parseJavaStructure(root, name);
  }
  throw new Error("无法识别的投影文件格式（支持 .litematic / .schem / .schematic / .nbt / .mcstructure）");
}

/** 是否 gzip 压缩（Java 版投影文件基本都是） */
export function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * 统一解析入口：自动识别 .mcstructure（Bedrock LE）与各类 Java 投影文件。
 */
export function parseStructureFile(buf: Buffer, name: string): ParsedStructure {
  if (!buf.length) throw new Error("文件为空");

  // Java 版投影文件基本都是 gzip
  if (isGzip(buf)) {
    return fromJavaRoot(parseJavaNbt(buf), name);
  }

  // 先试 Bedrock .mcstructure（LE，未压缩）
  try {
    const root = parseNbt(buf);
    if (root && root.structure && Array.isArray(root.size)) {
      return parseMcStructure(buf, name);
    }
  } catch {}

  // 再试 Java 大端 NBT（未压缩的 .nbt / .litematic）
  try {
    return fromJavaRoot(parseJavaNbt(buf), name);
  } catch (e: any) {
    throw new Error(`无法识别文件格式：${e?.message ?? e}`);
  }
}
