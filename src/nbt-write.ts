/**
 * NBT 序列化（Little-Endian），用于把修补后的结构写回标准 .mcstructure
 *
 * 支持全部标准标签类型，因为「修补」必须原样保留不认识的字段
 * （方块状态 states、实体 entities、block_position_data、第三方工具塞的私有键）。
 * 早期版本只支持 Int / String / List / Compound，导致修补器静默丢字段。
 */

export type NbtTagName =
  | "end"
  | "byte"
  | "short"
  | "int"
  | "long"
  | "float"
  | "double"
  | "byteArray"
  | "string"
  | "list"
  | "compound"
  | "intArray"
  | "longArray";

export type NbtValue =
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "int"; value: number }
  | { type: "long"; value: number | bigint }
  | { type: "float"; value: number }
  | { type: "double"; value: number }
  | { type: "byteArray"; value: number[] }
  | { type: "string"; value: string }
  | { type: "list"; element: NbtTagName; items: NbtValue[] }
  | { type: "compound"; fields: Record<string, NbtValue> }
  | { type: "intArray"; value: number[] }
  | { type: "longArray"; value: (number | bigint)[] };

export const TAG_ID: Record<NbtTagName, number> = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
};

const ID_TAG: Record<number, NbtTagName> = Object.fromEntries(
  Object.entries(TAG_ID).map(([k, v]) => [v, k as NbtTagName])
) as Record<number, NbtTagName>;

function i8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeInt8(Math.trunc(v) | 0, 0);
  return b;
}

function i16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(Math.trunc(v) | 0, 0);
  return b;
}

function i32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Math.trunc(v) | 0);
  return b;
}

function i64(v: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
  return b;
}

function f32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return b;
}

function f64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return b;
}

function nbtString(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function intArrayPayload(values: number[]): Buffer {
  return Buffer.concat([i32(values.length), ...values.map(i32)]);
}

function payload(v: NbtValue): Buffer {
  switch (v.type) {
    case "byte":
      return i8(v.value);
    case "short":
      return i16(v.value);
    case "int":
      return i32(v.value);
    case "long":
      return i64(v.value);
    case "float":
      return f32(v.value);
    case "double":
      return f64(v.value);
    case "byteArray":
      return Buffer.concat([i32(v.value.length), Buffer.from(v.value.map((n) => n & 0xff))]);
    case "string":
      return nbtString(v.value);
    case "compound": {
      const parts: Buffer[] = [];
      for (const [key, field] of Object.entries(v.fields)) {
        parts.push(Buffer.from([TAG_ID[field.type]]), nbtString(key), payload(field));
      }
      parts.push(Buffer.from([0])); // TAG_End
      return Buffer.concat(parts);
    }
    case "list": {
      const elementType = TAG_ID[v.element];
      return Buffer.concat([
        Buffer.from([elementType]),
        i32(v.items.length),
        ...v.items.map((item) => payload(item)),
      ]);
    }
    case "intArray":
      return intArrayPayload(v.value);
    case "longArray":
      return Buffer.concat([i32(v.value.length), ...v.value.map(i64)]);
    default:
      throw new Error(`无法序列化的 NBT 标签：${(v as any).type}`);
  }
}

/** 把字节标签类型映射回名字（供解析器使用） */
export function tagNameOf(id: number): NbtTagName {
  const name = ID_TAG[id];
  if (!name) throw new Error(`不支持的 NBT 标签类型：${id}`);
  return name;
}

/** 写出完整文件：根标签必须是 compound，名称用 "root" */
export function serializeNbt(root: NbtValue): Buffer {
  if (root.type !== "compound") throw new Error("根标签必须是 Compound");
  return Buffer.concat([Buffer.from([TAG_ID.compound]), nbtString("root"), payload(root)]);
}
