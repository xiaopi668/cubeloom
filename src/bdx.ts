/**
 * BDX 解析（PhoenixBuilder / FastBuilder 的建筑文件）。
 *
 * 容器格式（由 PhoenixBuilder 定义，BDXConverter 的 UnMarshal 是事实标准）：
 *   "BD@" + brotli( "BDX\x00" + 作者名 + "\x00" + 操作流 + 签名 )
 * 操作流每条是 1 字节操作码 + 定长负载；坐标用一个「笔」的相对移动指令
 * （AddXValue / AddInt8X / AddInt16X / AddInt32X ...）推进，然后 PlaceBlock 落块。
 * 88（'X'）是终止符，后面是签名，我们不关心。
 *
 * 方块来源有三类：
 *   1) CreateConstantString 建字符串表，PlaceBlockWithBlockStates 用「名字下标 + 状态下标」；
 *   2) PlaceBlock 用「名字下标 + 旧版 data 值」；
 *   3) PlaceBlockWithBlockStatesDeprecated 直接在指令里带状态字符串。
 *
 * 旧版 data 值（颜色/木种/石种/半砖上下）会过一张常见映射表；映射不到的方块
 * 保留名字、忽略 data，并在 issues 里汇总，不静默当成同一种方块。
 *
 * 运行时 ID 池（操作 31/32/33…）需要按游戏版本查表，体积太大且各版本不同，
 * 这里直接报错让用户换「字符串方块」方式导出，不猜方块。
 */
import * as zlib from "node:zlib";
import type { ParsedStructure, StructureBlock } from "./structure";
import { finishParsedStructure, isAir } from "./parsed-structure";

const COLORS = [
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

const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"];
const STONE_VARIANTS = [
  "stone",
  "granite",
  "polished_granite",
  "diorite",
  "polished_diorite",
  "andesite",
  "polished_andesite",
];
const SANDSTONE_VARIANTS = ["sandstone", "chiseled_sandstone", "cut_sandstone", "smooth_sandstone"];
const QUARTZ_VARIANTS = ["quartz_block", "chiseled_quartz_block", "quartz_pillar", "smooth_quartz"];
const PRISMARINE_VARIANTS = ["prismarine", "prismarine_bricks", "dark_prismarine", "prismarine"];
const STONE_SLABS = [
  "smooth_stone_slab",
  "sandstone_slab",
  "oak_slab",
  "cobblestone_slab",
  "brick_slab",
  "stone_brick_slab",
  "quartz_slab",
  "nether_brick_slab",
];
const STONE_SLAB_FULL = [
  "smooth_stone",
  "sandstone",
  "oak_planks",
  "cobblestone",
  "bricks",
  "stone_bricks",
  "quartz_block",
  "nether_bricks",
];
const INFESTED = [
  "infested_stone",
  "infested_cobblestone",
  "infested_stone_bricks",
  "infested_mossy_stone_bricks",
  "infested_cracked_stone_bricks",
  "infested_chiseled_stone_bricks",
];
const FLOWERS = [
  "poppy",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "red_tulip",
  "orange_tulip",
  "white_tulip",
  "pink_tulip",
  "oxeye_daisy",
];
const DOUBLE_PLANTS = ["sunflower", "lilac", "tall_grass", "large_fern", "rose_bush", "peony"];

/** 旧版名字直接改名（data 不参与） */
const RENAMES: Record<string, string> = {
  brick_block: "bricks",
  nether_brick: "nether_bricks",
  red_nether_brick: "red_nether_bricks",
  end_bricks: "end_stone_bricks",
  stonebrick: "stone_bricks",
  noteblock: "note_block",
  web: "cobweb",
  waterlily: "lily_pad",
  deadbush: "dead_bush",
  mob_spawner: "spawner",
  melon_block: "melon",
  melon: "melon_slice",
  magma: "magma_block",
  quartz_ore: "nether_quartz_ore",
  grass: "grass_block",
  grass_path: "dirt_path",
  flowing_water: "water",
  flowing_lava: "lava",
  lit_furnace: "furnace",
  powered_repeater: "repeater",
  unpowered_repeater: "repeater",
  powered_comparator: "comparator",
  unpowered_comparator: "comparator",
  wooden_button: "oak_button",
  wooden_pressure_plate: "oak_pressure_plate",
  wooden_door: "oak_door",
  wooden_trapdoor: "oak_trapdoor",
  trapdoor: "oak_trapdoor",
  fence: "oak_fence",
  fence_gate: "oak_fence_gate",
  wooden_stairs: "oak_stairs",
  wooden_slab: "oak_slab",
  double_wooden_slab: "oak_planks",
  snow: "snow",
  snow_layer: "snow_layer",
  stone_stairs: "cobblestone_stairs",
  stone_slab: "smooth_stone_slab",
  double_stone_slab: "smooth_stone",
  shulker_box: "shulker_box",
  undyed_shulker_box: "shulker_box",
};

/** 去掉命名空间（保留 `minecraft:` 由调用方补） */
function bareName(raw: string): string {
  let n = String(raw ?? "").trim().toLowerCase();
  if (n.startsWith("minecraft:")) n = n.slice("minecraft:".length);
  return n;
}

function ns(name: string): string {
  return name.includes(":") ? name : `minecraft:${name}`;
}

/** 状态值 → 命令字面量 */
function literal(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 状态表 → `["key"=值]` */
function statesSuffix(states?: Record<string, string | number | boolean>): string {
  if (!states) return "";
  const parts = Object.entries(states).map(([k, v]) => `"${k}"=${literal(v)}`);
  return parts.length ? `[${parts.join(",")}]` : "";
}

/**
 * 解析 BDX 里的方块状态字符串。
 * 现行格式 `["color"="red"]`，老格式 `["color":"red"]`；两种都吃。
 */
export function parseBdxStates(input: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const text = String(input ?? "").trim();
  if (text.length < 2 || !text.startsWith("[") || !text.endsWith("]")) return out;
  const body = text.slice(1, -1).trim();
  if (!body) return out;

  const parseValue = (rawValue: string): string | number | boolean | undefined => {
    const v = rawValue.trim();
    if (!v) return undefined;
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    const lower = v.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    return v;
  };

  for (const part of body.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    let key: string | undefined;
    let rawValue: string | undefined;

    // 带引号的键："minecraft:cardinal_direction":"north" / "color"="red"
    const quoted = piece.match(/^"([^"]+)"\s*[:=]\s*(.+)$/);
    if (quoted) {
      key = quoted[1];
      rawValue = quoted[2];
    } else {
      const eq = piece.indexOf("=");
      const colon = piece.lastIndexOf(":");
      const at = eq >= 0 ? eq : colon;
      if (at > 0) {
        key = piece.slice(0, at).trim().replace(/^"|"$/g, "");
        rawValue = piece.slice(at + 1);
      }
    }
    if (!key || rawValue === undefined) continue;
    const value = parseValue(rawValue);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 旧版（名字 + data）→ 基岩版方块串。
 * 返回 undefined 表示「名字本身都认不出来」，调用方会按原名保留并记 issue。
 */
type LegacyResult = { block: string; dataMapped: boolean };

function legacyBlock(rawName: string, data: number): LegacyResult | undefined {
  const name = bareName(rawName);
  if (!name) return { block: "minecraft:air", dataMapped: true };
  if (name.includes("[")) return { block: ns(name), dataMapped: true }; // 已经是带状态的写法

  const d = Math.max(0, Math.trunc(data)) & 0xffff;
  const color = COLORS[d & 0xf];
  const mapped = (block: string): LegacyResult => ({ block, dataMapped: true });

  switch (name) {
    case "wool":
      return mapped(`minecraft:${color}_wool`);
    case "carpet":
      return mapped(`minecraft:${color}_carpet`);
    case "concrete":
      return mapped(`minecraft:${color}_concrete`);
    case "concrete_powder":
    case "concretepowder":
      return mapped(`minecraft:${color}_concrete_powder`);
    case "stained_glass":
      return mapped(`minecraft:stained_glass${statesSuffix({ color })}`);
    case "stained_glass_pane":
      return mapped(`minecraft:stained_glass_pane${statesSuffix({ color })}`);
    case "stained_hardened_clay":
    case "stained_terracotta":
      return mapped(`minecraft:stained_hardened_clay${statesSuffix({ color })}`);
    case "hardened_clay":
    case "terracotta":
      return mapped("minecraft:terracotta");
    case "glazed_terracotta":
      return mapped(`minecraft:${color}_glazed_terracotta`);
    case "shulker_box":
    case "undyed_shulker_box":
      return mapped(d === 0 ? "minecraft:shulker_box" : `minecraft:${color}_shulker_box`);
    case "planks":
      return mapped(d < WOODS.length ? `minecraft:${WOODS[d]}_planks` : "minecraft:oak_planks");
    case "log":
      return mapped(woodLog(name, d, 0, 3));
    case "log2":
      return mapped(woodLog(name, d, 4, 5));
    case "leaves":
      return mapped(woodLeaves(name, d, 0));
    case "leaves2":
      return mapped(woodLeaves(name, d, 4));
    case "sapling":
      return mapped(d < WOODS.length ? `minecraft:${WOODS[d]}_sapling` : "minecraft:oak_sapling");
    case "stone":
      return mapped(`minecraft:${STONE_VARIANTS[d & 7] ?? "stone"}`);
    case "sandstone":
      return mapped(`minecraft:${SANDSTONE_VARIANTS[d & 3] ?? "sandstone"}`);
    case "red_sandstone":
      return mapped(
        `minecraft:${SANDSTONE_VARIANTS[d & 3]?.replace("sandstone", "red_sandstone") ?? "red_sandstone"}`
      );
    case "quartz_block":
      return mapped(
        `minecraft:${QUARTZ_VARIANTS[d & 3] ?? "quartz_block"}${
          (d & 3) === 2 ? statesSuffix({ pillar_axis: "y" }) : ""
        }`
      );
    case "prismarine":
      return mapped(`minecraft:${PRISMARINE_VARIANTS[d & 3] ?? "prismarine"}`);
    case "stone_slab":
    case "double_stone_slab": {
      const full = name === "double_stone_slab";
      const base = full ? STONE_SLAB_FULL[d & 7] : STONE_SLABS[d & 7];
      if (!base) return undefined;
      return mapped(`minecraft:${base}${full ? "" : statesSuffix({ top_slot_bit: (d & 8) === 8 })}`);
    }
    case "wooden_slab":
    case "double_wooden_slab": {
      const full = name === "double_wooden_slab";
      const wood = WOODS[d & 7] ?? "oak";
      return mapped(
        full ? `minecraft:${wood}_planks` : `minecraft:${wood}_slab${statesSuffix({ top_slot_bit: (d & 8) === 8 })}`
      );
    }
    case "monster_egg":
    case "infested_stone":
      return mapped(`minecraft:${INFESTED[d & 7] ?? "infested_stone"}`);
    case "red_flower":
      return mapped(`minecraft:${FLOWERS[d & 7] ?? "poppy"}`);
    case "yellow_flower":
      return mapped("minecraft:dandelion");
    case "double_plant":
      return mapped(`minecraft:${DOUBLE_PLANTS[d & 7] ?? "sunflower"}`);
    case "tallgrass":
      return mapped(d === 2 ? "minecraft:fern" : d === 0 ? "minecraft:dead_bush" : "minecraft:short_grass");
    case "light_block":
      return mapped(`minecraft:light_block${statesSuffix({ block_light_level: d & 15 })}`);
    case "cobblestone_wall":
      return mapped(d === 1 ? "minecraft:mossy_cobblestone_wall" : "minecraft:cobblestone_wall");
  }

  const renamed = RENAMES[name];
  if (renamed) return { block: ns(renamed), dataMapped: d === 0 };

  // 认不出 data 含义：保留名字，data 丢弃（调用方统计）
  return { block: ns(name), dataMapped: false };
}

function woodLog(_name: string, data: number, baseIndex: number, maxWood: number): string {
  const woodIndex = baseIndex + (data & (maxWood === 5 ? 1 : 3));
  const wood = WOODS[woodIndex] ?? "oak";
  const axis = ["y", "x", "z", ""][(data >> 2) & 3];
  if (!axis) return `minecraft:${wood}_wood`;
  return `minecraft:${wood}_log${statesSuffix({ pillar_axis: axis })}`;
}

function woodLeaves(_name: string, data: number, baseIndex: number): string {
  const wood = WOODS[baseIndex + (data & (baseIndex === 4 ? 1 : 3))] ?? "oak";
  return `minecraft:${wood}_leaves${statesSuffix({
    persistent_bit: (data & 4) === 4,
    update_bit: (data & 8) === 8,
  })}`;
}

/**
 * 1.20 起基岩版把「羊毛 / 地毯 / 混凝土 / 混凝土粉末 / 潜影盒」按颜色拆成了独立
 * identifier（orange_wool、red_concrete…），旧的 `wool ["color"="orange"]` 写法
 * 不再可靠。BDX 里的状态字符串可能是老写法，这里统一折叠成新 identifier。
 */
const SPLIT_COLOR_BLOCKS = new Set(["wool", "carpet", "concrete", "concrete_powder", "shulker_box"]);

function normalizeColoredBlock(
  rawName: string,
  states: Record<string, string | number | boolean>
): { name: string; states: Record<string, string | number | boolean> } {
  const bare = bareName(rawName).replace(/\[.*$/, "");
  if (!SPLIT_COLOR_BLOCKS.has(bare)) return { name: ns(bare), states };

  const rest = { ...states };
  const color = typeof rest.color === "string" ? String(rest.color) : undefined;
  delete rest.color;

  if (bare === "shulker_box" && !color) return { name: "minecraft:shulker_box", states: rest };
  if (!color) {
    // 没有颜色状态：混凝土/羊毛默认白色，和游戏里 data=0 的行为一致
    return { name: `minecraft:white_${bare}`, states: rest };
  }
  return { name: `minecraft:${color}_${bare}`, states: rest };
}

/** 简单游标 */
class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("BDX 数据被截断（操作流不完整）");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i8(): number {
    this.need(1);
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** 以 \x00 结尾的 UTF-8 字符串 */
  cstring(what = "字符串"): string {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
    if (this.pos >= this.buf.length) throw new Error(`BDX ${what}没有结束符（文件可能损坏）`);
    const text = this.buf.toString("utf8", start, this.pos);
    this.pos++;
    return text;
  }
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
}

/**
 * 跳过一段大端 NBT（用于 PlaceBlockWithNBTData 的方块 NBT）。
 * 注意 NBT 的字符串是「u16 长度 + 字节」，不是 \x00 结尾——这里只跳不解析。
 */
function skipNbt(reader: Reader, depth = 0): void {
  if (depth > 64) throw new Error("BDX 方块 NBT 嵌套过深");
  const type = reader.u8();
  if (type === 0) return;
  reader.bytes(reader.u16()); // 根名字
  skipNbtPayload(reader, type, depth);
}

function skipNbtPayload(reader: Reader, type: number, depth: number): void {
  switch (type) {
    case 1: // byte
      reader.bytes(1);
      return;
    case 2: // short
      reader.bytes(2);
      return;
    case 3: // int
    case 5: // float
      reader.bytes(4);
      return;
    case 4: // long
    case 6: // double
      reader.bytes(8);
      return;
    case 7: // byte array
      reader.bytes(reader.i32());
      return;
    case 8: // string
      reader.bytes(reader.u16());
      return;
    case 9: {
      const element = reader.u8();
      const n = reader.i32();
      for (let i = 0; i < n; i++) skipNbtPayload(reader, element, depth + 1);
      return;
    }
    case 10: {
      for (;;) {
        const child = reader.u8();
        if (child === 0) return;
        reader.bytes(reader.u16()); // 子标签名字
        skipNbtPayload(reader, child, depth + 1);
      }
    }
    case 11: // int array
      reader.bytes(reader.i32() * 4);
      return;
    case 12: // long array
      reader.bytes(reader.i32() * 8);
      return;
    default:
      throw new Error(`BDX 方块 NBT 里有未知标签类型 ${type}`);
  }
}

function skipChestSlots(reader: Reader, count: number): void {
  for (let i = 0; i < count; i++) {
    reader.cstring("容器物品名"); // itemName
    reader.bytes(1); // count
    reader.bytes(2); // data
    reader.bytes(1); // slotID
  }
}

function skipCommandBlockData(reader: Reader): void {
  reader.bytes(4); // mode
  reader.cstring("命令方块指令");
  reader.cstring("命令方块名称");
  reader.cstring("命令方块输出");
  reader.bytes(4); // tickDelay
  reader.bytes(4); // executeOnFirstTick / trackOutput / conditional / needsRedstone
}

export function isBdx(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x42 && buf[1] === 0x44 && buf[2] === 0x40;
}

/**
 * 解析 BDX → ParsedStructure。
 * 名字里的坐标会被归一化到最小角，所以 BDX 的「笔」起点不影响结果形状。
 */
export function parseBdxFile(buf: Buffer, name: string): ParsedStructure {
  if (!isBdx(buf)) throw new Error("不是 BDX 文件（缺少 BD@ 文件头）");

  let payload: Buffer;
  try {
    payload = zlib.brotliDecompressSync(buf.subarray(3), { maxOutputLength: 512 << 20 });
  } catch (e: any) {
    throw new Error(`BDX 解压失败（BD@ 后面应当是 brotli 数据）：${e?.message ?? e}`);
  }

  if (payload.length < 4 || payload[0] !== 0x42 || payload[1] !== 0x44 || payload[2] !== 0x58) {
    throw new Error("BDX 内部头不是 BDX\\0（文件可能损坏或不是建筑文件）");
  }
  const reader = new Reader(payload);
  reader.bytes(3); // BDX
  if (reader.u8() !== 0) throw new Error("BDX 内部头格式不正确（BDX 后应为 \\0）");
  reader.cstring("作者名");

  const strings: string[] = [];
  const blocks = new Map<string, StructureBlock>();
  let x = 0;
  let y = 0;
  let z = 0;
  let skippedAir = 0;
  let dataIgnored = 0;
  let runtimePool: number | undefined;
  let terminated = false;

  const setBlock = (block: string): void => {
    if (isAir(block)) {
      skippedAir++;
      return;
    }
    if (blocks.size >= 4_000_000) throw new Error("BDX 方块数量超过 400 万，拒绝继续解析");
    // 同一坐标后放的覆盖先放的（BDX 是笔刷式指令流，允许重复落块）
    blocks.set(`${x},${y},${z}`, { x, y, z, block });
  };

  const placeLegacy = (nameIndex: number, data: number): void => {
    const raw = strings[nameIndex];
    if (raw === undefined) throw new Error(`BDX 方块名下标越界：${nameIndex}`);
    const resolved = legacyBlock(raw, data);
    if (!resolved) {
      dataIgnored++;
      setBlock(ns(bareName(raw)));
      return;
    }
    if (!resolved.dataMapped && data !== 0) dataIgnored++;
    setBlock(resolved.block);
  };

  while (!reader.eof()) {
    const op = reader.u8();
    if (op === 88) {
      terminated = true;
      break;
    }
    switch (op) {
      case 1:
        strings.push(reader.cstring("字符串表"));
        break;
      case 5: {
        const nameIndex = reader.u16();
        const statesIndex = reader.u16();
        const raw = strings[nameIndex];
        if (raw === undefined) throw new Error(`BDX 方块名下标越界：${nameIndex}`);
        const statesText = strings[statesIndex];
        if (statesText === undefined) throw new Error(`BDX 方块状态下标越界：${statesIndex}`);
        const folded = normalizeColoredBlock(raw, parseBdxStates(statesText));
        setBlock(`${folded.name}${statesSuffix(folded.states)}`);
        break;
      }
      case 6:
        z += reader.u16();
        break;
      case 7: {
        const nameIndex = reader.u16();
        const data = reader.u16();
        placeLegacy(nameIndex, data);
        break;
      }
      case 8:
        z += 1;
        break;
      case 9:
        break; // NOP
      case 12:
        z += reader.u32();
        break;
      case 13: {
        const nameIndex = reader.u16();
        const statesText = reader.cstring("方块状态");
        const raw = strings[nameIndex];
        if (raw === undefined) throw new Error(`BDX 方块名下标越界：${nameIndex}`);
        const folded = normalizeColoredBlock(raw, parseBdxStates(statesText));
        setBlock(`${folded.name}${statesSuffix(folded.states)}`);
        break;
      }
      case 14:
        x += 1;
        break;
      case 15:
        x -= 1;
        break;
      case 16:
        y += 1;
        break;
      case 17:
        y -= 1;
        break;
      case 18:
        z += 1;
        break;
      case 19:
        z -= 1;
        break;
      case 20:
        x += reader.i16();
        break;
      case 21:
        x += reader.i32();
        break;
      case 22:
        y += reader.i16();
        break;
      case 23:
        y += reader.i32();
        break;
      case 24:
        z += reader.i16();
        break;
      case 25:
        z += reader.i32();
        break;
      case 26:
        skipCommandBlockData(reader);
        break;
      case 27: {
        const nameIndex = reader.u16();
        const data = reader.u16();
        placeLegacy(nameIndex, data);
        skipCommandBlockData(reader);
        break;
      }
      case 28:
        x += reader.i8();
        break;
      case 29:
        y += reader.i8();
        break;
      case 30:
        z += reader.i8();
        break;
      case 31:
        runtimePool = reader.u8();
        break;
      case 32:
      case 33:
      case 34:
      case 35: {
        // 32: u16 runtimeId；33: u32；34: u16 + 命令方块数据；35: u32 + 命令方块数据
        if (op === 32 || op === 34) reader.u16();
        else reader.u32();
        if (op === 34 || op === 35) skipCommandBlockData(reader);
        throw new Error(
          `该 BDX 使用运行时方块 ID 池（pool=${runtimePool ?? "未声明"}），需要按游戏版本查表，` +
            "无法离线还原方块名；请用 FastBuilder/BDXConverter 导出「字符串方块」格式后再导入"
        );
      }
      case 36: {
        reader.u16();
        skipCommandBlockData(reader);
        throw new Error("该 BDX 使用运行时方块 ID 池（PlaceCommandBlockWithCommandBlockData），暂不支持");
      }
      case 37:
      case 38:
      case 40: {
        if (op === 37) reader.u16();
        else if (op === 38) reader.u32();
        else {
          reader.u16();
          reader.u16();
        }
        const slots = reader.u8();
        skipChestSlots(reader, slots);
        throw new Error("该 BDX 使用运行时方块 ID 池（容器方块），暂不支持");
      }
      case 39:
        reader.bytes(reader.u32());
        break;
      case 41: {
        const nameIndex = reader.u16();
        const statesIndex = reader.u16();
        reader.bytes(2);
        const raw = strings[nameIndex];
        if (raw === undefined) throw new Error(`BDX 方块名下标越界：${nameIndex}`);
        const statesText = strings[statesIndex];
        if (statesText === undefined) throw new Error(`BDX 方块状态下标越界：${statesIndex}`);
        const folded = normalizeColoredBlock(raw, parseBdxStates(statesText));
        setBlock(`${folded.name}${statesSuffix(folded.states)}`);
        skipNbt(reader);
        break;
      }
      default:
        throw new Error(`不支持的 BDX 操作码 ${op}（偏移 ${reader.pos - 1}）`);
    }
  }

  if (!terminated) throw new Error("BDX 缺少终止符，文件可能被截断");
  if (!blocks.size) throw new Error("BDX 里没有可放置的方块（可能全是空气）");

  const issues: string[] = [];
  if (dataIgnored > 0) {
    issues.push(`${dataIgnored} 个方块的旧版 data 值没有对应状态，已按方块名放置（颜色/朝向可能不同）`);
  }
  const placed = [...blocks.values()];
  return finishParsedStructure(name, placed, new Set(placed.map((b) => b.block)).size, skippedAir, issues);
}
