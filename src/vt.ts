/**
 * `.vt` 建筑文件（VQ / Vector 的加密容器）。
 *
 * 容器：44 字节头（VTVB + 版本 + flags + IV + HMAC + 密文长度）+ AES-256-CBC
 * 密文；明文是 .NET Deflate 原始流。负载：字符串表 + varint 方块表 + 命令块/
 * 告示牌元数据。
 *
 * 这里只还原“方块 + 状态”；命令块内容、告示牌文字需要引擎侧 command_update /
 * BlockActorData，暂不在这里处理，解析时会记一条 issue。
 */
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import type { CommandBlockUpdate, ParsedStructure, StructureBlock } from "./structure";
import { finishParsedStructure, isAir } from "./parsed-structure";

const MAGIC = Buffer.from("VTVB", "latin1");
const HEADER_SIZE = 44;
const FLAG_ENCRYPTED = 1;
const FLAG_COMPRESSED = 2;
const SECRET = "VQ-Vector-Building-Format|v1|9f2a31c7d84b06e5|ntvector|lurete-cn";
const SALT = Buffer.from("VQVT$1$2026$building$container", "utf8");

class VtError extends Error {}

function deriveKeys(): { enc: Buffer; mac: Buffer } {
  const enc = crypto.pbkdf2Sync(SECRET, SALT, 4096, 32, "sha256");
  const mac = crypto.createHash("sha256").update(Buffer.concat([enc, Buffer.from("mac")])).digest();
  return { enc, mac };
}

export function isVt(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC);
}

function containerPayload(data: Buffer): Buffer {
  if (data.length < HEADER_SIZE) throw new VtError(`文件太小（${data.length} 字节），不是 .vt`);
  if (!isVt(data)) throw new VtError("文件头不是 VTVB，不是 .vt");
  const version = data.readUInt16LE(4);
  const flags = data.readUInt16LE(6);
  if (version !== 1) throw new VtError(`不支持的 .vt 版本 ${version}`);
  const iv = data.subarray(8, 24);
  const tag = data.subarray(24, 40);
  const clen = data.readInt32LE(40);
  if (clen < 0 || HEADER_SIZE + clen > data.length) {
    throw new VtError(`.vt 密文长度不对：${clen}`);
  }
  const body = data.subarray(HEADER_SIZE, HEADER_SIZE + clen);

  const { enc, mac } = deriveKeys();
  let plain: Buffer;
  if (flags & FLAG_ENCRYPTED) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32LE(clen, 0);
    const h = crypto.createHmac("sha256", mac).update(Buffer.concat([iv, lenBuf, body])).digest();
    if (!crypto.timingSafeEqual(h.subarray(0, 16), tag)) {
      throw new VtError(".vt HMAC 校验失败：文件被改过，或版本密钥不匹配");
    }
    const decipher = crypto.createDecipheriv("aes-256-cbc", enc, iv);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } else {
    plain = Buffer.from(body);
  }

  if (flags & FLAG_COMPRESSED) {
    try {
      plain = zlib.inflateRawSync(plain, { maxOutputLength: 256 << 20 });
    } catch (e: any) {
      throw new VtError(`.vt 解压失败：${e?.message ?? e}`);
    }
  }
  if (plain.length < 16) throw new VtError(`.vt 负载太短（${plain.length} 字节）`);
  return plain;
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new VtError(`.vt 负载读到末尾（偏移 ${this.pos} 想读 ${n} 字节，总长 ${this.buf.length}）`);
    }
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  byte(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  raw(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new VtError(".vt varint 过长，数据损坏");
    }
  }
  zigzag(): number {
    const v = this.varint();
    return (v >>> 1) ^ -(v & 1);
  }
  u16String(): string {
    return this.raw(this.u16()).toString("utf8").replace(/\x00+$/, "");
  }
  i32String(): string {
    const n = this.i32();
    if (n < 0 || n > this.buf.length - this.pos) throw new VtError(`.vt 字符串长度不合理：${n}`);
    return this.raw(n).toString("utf8").replace(/\x00+$/, "");
  }
  vString(): string {
    return this.raw(this.varint()).toString("utf8").replace(/\x00+$/, "");
  }
  vLines(): string[] | null {
    const n = this.byte();
    if (n === 0) return null;
    return Array.from({ length: n }, () => this.vString());
  }
}

type VtBlock = {
  x: number;
  y: number;
  z: number;
  name: string;
  states: string;
  slot: number;
  command?: string;
  commandMode?: string;
  commandConditional?: boolean;
  commandAuto?: boolean;
  commandPowered?: boolean;
  commandTickDelay?: number;
  signLines?: string[] | null;
  signLinesBack?: string[] | null;
};

/** `.vt` 的 states 串有两种写法：`"key"="v"` 与 `"key": v`；数字/布尔要裸写 */
export function formatVtStates(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  // 旧版数字 data（.txt 里的 setblock ... 6）暂时只会保留方块名
  if (/^-?\d+$/.test(text)) return "";
  const pairs: string[] = [];
  const re = /"([^"]+)"\s*[:=]\s*("(?:[^"\\]|\\.)*"|[^,\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    const literal =
      /^-?\d+$/.test(value) || value === "true" || value === "false"
        ? value
        : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    pairs.push(`"${key}"=${literal}`);
  }
  return pairs.length ? `[${pairs.join(",")}]` : "";
}

function normalizeName(raw: string): string {
  let n = String(raw || "").trim().toLowerCase();
  if (!n) return "minecraft:air";
  if (!n.includes(":")) n = `minecraft:${n}`;
  // VQ 存的是 dark_oak，基岩版指令里是 darkoak
  if (n.startsWith("minecraft:dark_oak")) n = `minecraft:darkoak${n.slice("minecraft:dark_oak".length)}`;
  return n;
}

export function parseVtFile(buf: Buffer, name: string): ParsedStructure {
  const payload = containerPayload(buf);
  const r = new Reader(payload);
  const ver = r.i32();
  if (ver < 1 || ver > 3) throw new VtError(`不认识的 .vt 负载版本 ${ver}`);

  const buildingName = r.i32String();
  r.i32String(); // source_format
  r.i32(); // size_x
  r.i32(); // size_y
  r.i32(); // size_z
  const count = r.i32();
  if (count < 0 || count > 8_000_000) throw new VtError(`.vt 方块数量异常：${count}`);

  const nameCount = r.i32();
  if (nameCount < 0 || nameCount > 1_000_000) throw new VtError(`.vt 方块名表异常：${nameCount}`);
  const names = Array.from({ length: nameCount }, () => r.u16String());
  const stateCount = r.i32();
  if (stateCount < 0 || stateCount > 1_000_000) throw new VtError(`.vt 状态表异常：${stateCount}`);
  const states = Array.from({ length: stateCount }, () => r.u16String());

  const blocks: VtBlock[] = [];
  for (let i = 0; i < count; i++) {
    const ni = r.varint();
    const x = r.zigzag();
    const y = r.zigzag();
    const z = r.zigzag();
    const si = r.varint();
    blocks.push({
      x,
      y,
      z,
      name: names[ni] ?? "minecraft:air",
      states: states[si] ?? "",
      slot: i,
    });
  }

  const commandMeta: Array<CommandBlockUpdate & { slot: number }> = [];
  if (ver >= 2) {
    const metaCount = r.i32();
    for (let i = 0; i < metaCount; i++) {
      const slot = r.varint();
      const flags = r.byte();
      const blk = blocks[slot];
      if (!blk) throw new VtError(`.vt 元数据指向不存在的方块 ${slot}`);
      if (flags & 1) {
        blk.command = r.vString();
        blk.commandMode = r.vString() || "impulse";
        blk.commandConditional = !!r.byte();
        blk.commandAuto = !!r.byte();
        blk.commandPowered = !!r.byte();
        r.byte(); // track output
        r.vString(); // custom name
        if (ver >= 3) blk.commandTickDelay = r.varint();
        commandMeta.push({
          slot,
          x: blk.x,
          y: blk.y,
          z: blk.z,
          mode: /chain/i.test(blk.commandMode || "")
            ? 2
            : /repeat|循环/i.test(blk.commandMode || "")
              ? 1
              : 0,
          needsRedstone: !blk.commandAuto,
          conditional: !!blk.commandConditional,
          tickDelay: Math.max(0, Math.trunc(blk.commandTickDelay || 0)),
          // .vt 里没有 execute_on_first_tick 字段，按 Bedrock 默认 true
          executeOnFirstTick: true,
          command: String(blk.command || ""),
          customName: "",
        });
      }
      if (flags & 2) {
        blk.signLines = r.vLines();
        blk.signLinesBack = r.vLines();
        r.vString(); // color
        r.byte(); // glowing
        r.byte(); // waxed
      }
    }
  }

  const out: StructureBlock[] = [];
  let commandBlocks = 0;
  let signs = 0;
  let legacyStates = 0;
  for (const b of blocks) {
    const blockName = normalizeName(b.name);
    if (isAir(blockName)) continue;
    if (blockName.includes("command_block")) commandBlocks++;
    if (/sign|banner/.test(blockName)) signs++;
    let suffix = formatVtStates(b.states);
    if (!suffix && /^-?\d+$/.test(b.states.trim())) legacyStates++;
    out.push({ x: b.x, y: b.y, z: b.z, block: `${blockName}${suffix}` });
  }

  const issues: string[] = [];
  let commandUpdates: CommandBlockUpdate[] | undefined;
  if (commandMeta.length) {
    // 坐标要和 finishParsedStructure 一样平移到最小角
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const b of out) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.z < minZ) minZ = b.z;
    }
    commandUpdates = commandMeta.map(({ slot: _slot, ...m }) => ({
      ...m,
      x: m.x - minX,
      y: m.y - minY,
      z: m.z - minZ,
    }));
  }
  if (commandBlocks > 0) {
    issues.push(
      commandUpdates?.length
        ? `${commandBlocks} 个命令方块的内容会随后补写`
        : `${commandBlocks} 个命令方块没有内容元数据（只摆方块和状态）`
    );
  }
  if (signs > 0) issues.push(`${signs} 个告示牌的文字暂未还原`);
  if (legacyStates > 0) issues.push(`${legacyStates} 个方块的旧版数字 data 未映射，只保留了方块名`);

  const parsed = finishParsedStructure(
    name || buildingName || "structure",
    out,
    new Set(out.map((b) => b.block)).size,
    0,
    issues
  );
  if (commandUpdates?.length) parsed.commandBlocks = commandUpdates;
  return parsed;
}
