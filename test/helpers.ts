/**
 * 测试夹具：用带类型的 NBT 写入器拼出合法的 .mcstructure。
 * 只依赖 src/，不引入测试框架。
 */
import { serializeNbt, NbtValue } from "../src/nbt-write";

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
