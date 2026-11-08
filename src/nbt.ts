/**
 * 极简 NBT 解析器（Little-Endian，用于 .mcstructure）
 * 标签类型：1 Byte / 2 Short / 3 Int / 4 Long / 5 Float / 6 Double /
 *           7 ByteArray / 8 String / 9 List / 10 Compound / 11 IntArray / 12 LongArray
 *
 * 两个入口：
 *   · parseNbtTyped() —— 保留标签类型的 AST，供修补器原样写回（不丢 states / entities / 未知字段）
 *   · parseNbt()      —— 转成普通 JS 值，供只读方使用（保持旧行为）
 *
 * 解析器对所有长度字段做边界检查：损坏文件里一个 2^31 的列表长度不会再变成
 * 一次几十 GB 的分配，而是直接抛错。
 */
import { NbtValue, tagNameOf } from "./nbt-write";

export type TypedNbt = { value: NbtValue; consumed: number };

/** 数据不足时抛出，带上出错位置：offset 等于文件长度时说明只缺尾部结束标记 */
export class NbtTruncatedError extends Error {
  constructor(
    public readonly offset: number,
    public readonly length: number,
    public readonly needBytes = 0
  ) {
    super(
      offset >= length
        ? `NBT 数据在末尾结束（缺 ${needBytes || 1} 字节）`
        : `NBT 数据被截断：位置 ${offset}/${length} 需要 ${needBytes} 字节`
    );
    this.name = "NbtTruncatedError";
  }

  /** 只缺末尾的结束标记，补零是无损的 */
  get atEnd(): boolean {
    return this.offset >= this.length;
  }
}

export function parseNbtTyped(buf: Buffer): TypedNbt {
  let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const need = (n: number) => {
    if (n < 0 || off + n > buf.length) throw new NbtTruncatedError(off, buf.length, n);
  };
  const i8 = () => {
    need(1);
    return dv.getInt8(off++);
  };
  const i16 = () => {
    need(2);
    const v = dv.getInt16(off, true);
    off += 2;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = dv.getInt32(off, true);
    off += 4;
    return v;
  };
  const i64 = () => {
    need(8);
    const v = dv.getBigInt64(off, true);
    off += 8;
    return v;
  };
  const f32 = () => {
    need(4);
    const v = dv.getFloat32(off, true);
    off += 4;
    return v;
  };
  const f64 = () => {
    need(8);
    const v = dv.getFloat64(off, true);
    off += 8;
    return v;
  };
  const str = () => {
    need(2);
    const len = dv.getUint16(off, true);
    off += 2;
    need(len);
    const s = buf.toString("utf8", off, off + len);
    off += len;
    return s;
  };

  function readTag(type: number): NbtValue {
    switch (type) {
      case 1:
        return { type: "byte", value: i8() };
      case 2:
        return { type: "short", value: i16() };
      case 3:
        return { type: "int", value: i32() };
      case 4:
        return { type: "long", value: i64() };
      case 5:
        return { type: "float", value: f32() };
      case 6:
        return { type: "double", value: f64() };
      case 7: {
        const n = i32();
        need(n);
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(i8());
        return { type: "byteArray", value: a };
      }
      case 8:
        return { type: "string", value: str() };
      case 9: {
        const element = tagNameOf(i8());
        const n = i32();
        // 每个元素至少 1 字节（compound 的 TAG_End）；负长度或超过剩余字节数一律视为损坏
        if (n < 0 || n > buf.length - off) throw new NbtTruncatedError(off, buf.length, n);
        const items: NbtValue[] = [];
        for (let i = 0; i < n; i++) items.push(readTag(TAG_OF[element]));
        return { type: "list", element, items };
      }
      case 10: {
        const fields: Record<string, NbtValue> = {};
        for (;;) {
          const t = i8();
          if (t === 0) break;
          const name = str();
          fields[name] = readTag(t);
        }
        return { type: "compound", fields };
      }
      case 11: {
        const n = i32();
        if (n < 0 || n > (buf.length - off) / 4) throw new NbtTruncatedError(off, buf.length, n * 4);
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(i32());
        return { type: "intArray", value: a };
      }
      case 12: {
        const n = i32();
        if (n < 0 || n > (buf.length - off) / 8) throw new NbtTruncatedError(off, buf.length, n * 8);
        const a: bigint[] = [];
        for (let i = 0; i < n; i++) a.push(i64());
        return { type: "longArray", value: a };
      }
      default:
        throw new Error(`不支持的 NBT 标签类型：${type}`);
    }
  }

  if (off >= buf.length) throw new Error("文件为空");
  const rootType = i8();
  if (rootType !== 10) throw new Error("不是合法的结构文件（根标签不是 Compound）");
  str(); // 根名称
  const value = readTag(10);
  return { value, consumed: off };
}

/** 标签名 → 标签 id（列表元素类型反查用） */
const TAG_OF: Record<string, number> = {
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

/** 保留旧接口：转成普通 JS 值（Long 转 Number，数组转 number[]） */
export function parseNbt(buf: Buffer): any {
  return toPlain(parseNbtTyped(buf).value);
}

export function toPlain(v: NbtValue): any {
  switch (v.type) {
    case "byte":
    case "short":
    case "int":
    case "float":
    case "double":
      return v.value;
    case "long":
      return Number(v.value);
    case "byteArray":
    case "intArray":
      return v.value.map((n) => Number(n));
    case "longArray":
      return v.value.map((n) => Number(n));
    case "string":
      return v.value;
    case "list":
      return v.items.map(toPlain);
    case "compound": {
      const out: Record<string, any> = {};
      for (const [k, field] of Object.entries(v.fields)) out[k] = toPlain(field);
      return out;
    }
  }
}
