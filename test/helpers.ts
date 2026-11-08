/**
 * 测试夹具：用带类型的 NBT 写入器拼出合法的 .mcstructure。
 * 只依赖 src/，不引入测试框架。
 */
import * as zlib from "node:zlib";
import { serializeNbt, NbtValue, TAG_ID } from "../src/nbt-write";

export type FixtureOptions = {
  size: [number, number, number];
  /** 调色板方块名（索引即下标） */
  palette: string[];
  /** 第一层索引，长度必须是 sx*sy*sz；缺省全 -1 */
  indices?: number[];
  /** 第二层（液体层）索引，缺省全 -1 */
  indices2?: number[];
  /** 调色板里带 states（朝向/半砖等） */
  withStates?: boolean;
  /** 带一个实体与一条 block_position_data */
  withEntities?: boolean;
  /** 根节点上再挂一个自定义字段，用来验证"不认识的字段"会被保留 */
  withUnknownField?: boolean;
  /** 故意缺失的字段 */
  omit?: Array<"format_version" | "structure_world_origin" | "entities" | "block_position_data">;
};

const int = (v: number): NbtValue => ({ type: "int", value: v });
const str = (v: string): NbtValue => ({ type: "string", value: v });
const intList = (values: number[]): NbtValue => ({ type: "list", element: "int", items: values.map(int) });

export function makeStructure(opts: FixtureOptions): Buffer {
  const [sx, sy, sz] = opts.size;
  const volume = sx * sy * sz;
  const indices = opts.indices ?? new Array(volume).fill(-1);
  if (indices.length !== volume) throw new Error(`夹具索引长度 ${indices.length} ≠ ${volume}`);

  const paletteEntry = (name: string): NbtValue => {
    const fields: Record<string, NbtValue> = {
      name: str(name),
      version: int(18168865),
    };
    if (opts.withStates) {
      fields.states = {
        type: "compound",
        fields: {
          "minecraft:cardinal_direction": str("north"),
          "upside_down_bit": { type: "byte", value: 0 },
        },
      };
    }
    return { type: "compound", fields };
  };

  const structureFields: Record<string, NbtValue> = {
    block_indices: {
      type: "list",
      element: "list",
      items: [
        intList(indices),
        intList(opts.indices2 ?? new Array(volume).fill(-1)),
      ],
    },
    palette: {
      type: "compound",
      fields: {
        default: {
          type: "compound",
          fields: {
            block_palette: { type: "list", element: "compound", items: opts.palette.map(paletteEntry) },
            block_position_data: {
              type: "compound",
              fields: opts.withEntities
                ? {
                    "0": {
                      type: "compound",
                      fields: { sign_text: str("hello") },
                    },
                  }
                : {},
            },
          },
        },
      },
    },
  };

  if (!opts.omit?.includes("entities")) {
    structureFields.entities = {
      type: "list",
      element: "compound",
      items: opts.withEntities
        ? [
            {
              type: "compound",
              fields: {
                identifier: str("minecraft:sheep"),
                Pos: { type: "list", element: "float", items: [{ type: "float", value: 1.5 }] },
              },
            },
          ]
        : [],
    };
  }

  const rootFields: Record<string, NbtValue> = {
    size: intList([sx, sy, sz]),
    structure: { type: "compound", fields: structureFields },
  };
  if (!opts.omit?.includes("format_version")) rootFields.format_version = int(1);
  if (!opts.omit?.includes("structure_world_origin")) rootFields.structure_world_origin = intList([0, 0, 0]);
  if (opts.withUnknownField) {
    rootFields.custom_blocker = {
      type: "compound",
      fields: { note: str("keep me"), ratio: { type: "double", value: 0.5 } },
    };
  }

  return serializeNbt({ type: "compound", fields: rootFields });
}

/** 1×1×1 的最小结构（自定义调色板与索引） */
export function tinyStructure(palette: string[], indices: number[], extra: Partial<FixtureOptions> = {}): Buffer {
  return makeStructure({ size: [indices.length, 1, 1], palette, indices, ...extra });
}

/* ============================================================================
 * 格式层测试夹具（Java 版投影）：
 *   · makeStructureEx —— 调色板可定制（旧式字符串数组 / 自定义 states）
 *   · serializeJavaNbt + makeLitematic / makeSponge / makeSchematic —— 大端 NBT
 * 上面的 makeStructure / tinyStructure 行为完全不变。
 * 夹具全部现场构造，不依赖任何真实文件。
 * ========================================================================== */

/* ── 可定制调色板的 .mcstructure ── */

export type PaletteSpec = string | { name: string; states?: Record<string, NbtValue> };

/** 调色板条目可以是字符串（旧式）或 {name, states}；states 走带类型的 NBT 值 */
export function makeStructureEx(opts: {
  size: [number, number, number];
  palette: PaletteSpec[];
  indices?: number[];
}): Buffer {
  const [sx, sy, sz] = opts.size;
  const volume = sx * sy * sz;
  const indices = opts.indices ?? new Array(volume).fill(-1);
  if (indices.length !== volume) throw new Error(`夹具索引长度 ${indices.length} ≠ ${volume}`);
  if (!opts.palette.length) throw new Error("夹具调色板不能为空");

  const element = typeof opts.palette[0] === "string" ? "string" : "compound";
  const items = opts.palette.map((p): NbtValue => {
    if (typeof p === "string") return { type: "string", value: p };
    const fields: Record<string, NbtValue> = {
      name: str(p.name),
      version: int(18168865),
    };
    if (p.states) fields.states = { type: "compound", fields: p.states };
    return { type: "compound", fields };
  });

  return serializeNbt({
    type: "compound",
    fields: {
      size: intList([sx, sy, sz]),
      structure: {
        type: "compound",
        fields: {
          block_indices: {
            type: "list",
            element: "list",
            items: [intList(indices), intList(new Array(volume).fill(-1))],
          },
          palette: {
            type: "compound",
            fields: {
              default: {
                type: "compound",
                fields: {
                  block_palette: { type: "list", element, items },
                  block_position_data: { type: "compound", fields: {} },
                },
              },
            },
          },
        },
      },
    },
  });
}

/* ── 大端 NBT 写入器（Java 版投影格式用；src/nbt-write.ts 只写小端） ── */

function bU8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v & 0xff, 0);
  return b;
}

function bI16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(Math.trunc(v) | 0, 0);
  return b;
}

function bI32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.trunc(v) | 0, 0);
  return b;
}

function bI64(v: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt.asIntN(64, typeof v === "bigint" ? v : BigInt(Math.trunc(v))), 0);
  return b;
}

function bF32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  return b;
}

function bF64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v, 0);
  return b;
}

function bStr(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function bePayload(v: NbtValue): Buffer {
  switch (v.type) {
    case "byte":
      return bU8(v.value);
    case "short":
      return bI16(v.value);
    case "int":
      return bI32(v.value);
    case "long":
      return bI64(v.value);
    case "float":
      return bF32(v.value);
    case "double":
      return bF64(v.value);
    case "byteArray":
      return Buffer.concat([bI32(v.value.length), Buffer.from(v.value.map((n) => n & 0xff))]);
    case "string":
      return bStr(v.value);
    case "compound": {
      const parts: Buffer[] = [];
      for (const [key, field] of Object.entries(v.fields)) {
        parts.push(Buffer.from([TAG_ID[field.type]]), bStr(key), bePayload(field));
      }
      parts.push(Buffer.from([0]));
      return Buffer.concat(parts);
    }
    case "list":
      return Buffer.concat([
        Buffer.from([TAG_ID[v.element]]),
        bI32(v.items.length),
        ...v.items.map(bePayload),
      ]);
    case "intArray":
      return Buffer.concat([bI32(v.value.length), ...v.value.map(bI32)]);
    case "longArray":
      return Buffer.concat([bI32(v.value.length), ...v.value.map(bI64)]);
    default:
      throw new Error(`无法序列化的 NBT 标签：${(v as any).type}`);
  }
}

/** 写出大端 NBT（根标签必须是 compound，根名留空） */
export function serializeJavaNbt(root: NbtValue): Buffer {
  if (root.type !== "compound") throw new Error("根标签必须是 Compound");
  return Buffer.concat([Buffer.from([TAG_ID.compound]), bStr(""), bePayload(root)]);
}

/** Java 版投影基本都是 gzip */
export function gzipFixture(buf: Buffer): Buffer {
  return zlib.gzipSync(buf);
}

/* ── .litematic ── */

/** Litematica 的 BlockStates：64 位连续位流（一个值可以跨 long 边界） */
export function packLitematicLongs(ids: number[], bits: number, longCount?: number): bigint[] {
  const need = Math.ceil((ids.length * bits) / 64);
  const words = new Array<bigint>(longCount ?? Math.max(need, 1)).fill(0n);
  for (let i = 0; i < ids.length; i++) {
    const value = BigInt(ids[i]);
    const bitPos = i * bits;
    const word = Math.floor(bitPos / 64);
    const shift = bitPos % 64;
    if (word < words.length) {
      words[word] = BigInt.asUintN(64, words[word] | BigInt.asUintN(64, value << BigInt(shift)));
    }
    if (shift + bits > 64 && word + 1 < words.length) {
      words[word + 1] = BigInt.asUintN(64, words[word + 1] | (value >> BigInt(64 - shift)));
    }
  }
  return words;
}

export type LitematicOptions = {
  size: [number, number, number];
  palette: string[];
  /** 每格的调色板下标（长度 = sx*sy*sz），按 Litematica 的连续位流打包 */
  ids: number[];
  /** 打包位宽；缺省 max(2, ceil(log2(palette 长度))) */
  bits?: number;
  /** 覆盖 BlockStates 的 long 个数（造「位宽对不上」的坏文件） */
  longCount?: number;
};

export function makeLitematic(opts: LitematicOptions): Buffer {
  const [sx, sy, sz] = opts.size;
  const volume = sx * sy * sz;
  if (opts.ids.length !== volume) throw new Error(`夹具索引长度 ${opts.ids.length} ≠ ${volume}`);
  const bits = opts.bits ?? Math.max(2, Math.ceil(Math.log2(Math.max(2, opts.palette.length))));
  const longs = packLitematicLongs(opts.ids, bits, opts.longCount);
  return serializeJavaNbt({
    type: "compound",
    fields: {
      Version: int(6),
      MinecraftDataVersion: int(3465),
      Regions: {
        type: "compound",
        fields: {
          Main: {
            type: "compound",
            fields: {
              Position: {
                type: "compound",
                fields: { x: int(0), y: int(0), z: int(0) },
              },
              Size: {
                type: "compound",
                fields: { x: int(sx), y: int(sy), z: int(sz) },
              },
              BlockStatePalette: {
                type: "list",
                element: "compound",
                items: opts.palette.map((name) => ({
                  type: "compound" as const,
                  fields: { Name: str(name) },
                })),
              },
              BlockStates: { type: "longArray", value: longs },
            },
          },
        },
      },
    },
  });
}

/* ── .schem（Sponge v2 / v3） ── */

/** VarInt 编码（Sponge 的 BlockData / Blocks.Data） */
export function encodeVarints(values: number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    let v = value >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v) byte |= 0x80;
      out.push(byte);
    } while (v);
  }
  return out;
}

/** palette: 方块名 → 调色板下标；ids 按 Sponge 的顺序（x 最快，然后 z，最后 y） */
export function makeSponge(opts: {
  size: [number, number, number];
  palette: Record<string, number>;
  ids: number[];
  version?: 2 | 3;
}): Buffer {
  const [sx, sy, sz] = opts.size;
  if (opts.ids.length !== sx * sy * sz) {
    throw new Error(`夹具索引长度 ${opts.ids.length} ≠ ${sx * sy * sz}`);
  }
  const version = opts.version ?? 2;
  const paletteTag: NbtValue = {
    type: "compound",
    fields: Object.fromEntries(Object.entries(opts.palette).map(([k, v]) => [k, int(v)])),
  };
  const dataTag: NbtValue = { type: "byteArray", value: encodeVarints(opts.ids) };
  const fields: Record<string, NbtValue> = {
    Version: int(version),
    DataVersion: int(3465),
    Width: { type: "short", value: sx },
    Height: { type: "short", value: sy },
    Length: { type: "short", value: sz },
  };
  if (version === 3) {
    fields.Blocks = {
      type: "compound",
      fields: {
        Palette: paletteTag,
        Data: dataTag,
        BlockEntities: { type: "list", element: "compound", items: [] },
      },
    };
  } else {
    fields.Palette = paletteTag;
    fields.BlockData = dataTag;
  }
  return serializeJavaNbt({ type: "compound", fields: { Schematic: { type: "compound", fields } } });
}

/* ── 经典 .schematic ── */

/** blocks 是低 8 位 ID；add 是 AddBlocks（每字节装两格的高 4 位）；data 是 Data 材质位 */
export function makeSchematic(opts: {
  size: [number, number, number];
  blocks: number[];
  add?: number[];
  data?: number[];
  palette?: Record<string, number>;
}): Buffer {
  const [sx, sy, sz] = opts.size;
  if (opts.blocks.length !== sx * sy * sz) {
    throw new Error(`夹具 Blocks 长度 ${opts.blocks.length} ≠ ${sx * sy * sz}`);
  }
  const fields: Record<string, NbtValue> = {
    Width: { type: "short", value: sx },
    Height: { type: "short", value: sy },
    Length: { type: "short", value: sz },
    Blocks: { type: "byteArray", value: opts.blocks.map((v) => v & 0xff) },
  };
  if (opts.add) fields.AddBlocks = { type: "byteArray", value: opts.add.map((v) => v & 0xff) };
  if (opts.data) fields.Data = { type: "byteArray", value: opts.data.map((v) => v & 0xff) };
  if (opts.palette) {
    fields.Palette = {
      type: "compound",
      fields: Object.fromEntries(Object.entries(opts.palette).map(([k, v]) => [k, int(v)])),
    };
  }
  return serializeJavaNbt({ type: "compound", fields });
}
