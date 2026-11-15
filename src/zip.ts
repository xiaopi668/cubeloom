/**
 * 极简 ZIP 读取（只读、同步）。
 *
 * 用途：`.mcworld` 是 ZIP（里面是 level.dat + db/ 区块），部分工具也会把投影
 * 文件打进 .zip 上传。这里只解析中央目录，按需解一条 entry：
 *  - stored(0) 直接切片；
 *  - deflate(8) 用 zlib.inflateRawSync。
 *
 * 不支持 ZIP64 与加密包：遇到就抛明确错误，不去猜。
 */
import * as zlib from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export type ZipEntry = {
  /** ZIP 内路径（已统一成 / 分隔） */
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 中央目录里记录的文件名偏移（用于本地头定位） */
  localOffset: number;
  entryOffset: number;
};

export function isZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // 普通包 PK\x03\x04；空包 PK\x05\x06；跨卷 PK\x07\x08
  return (
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) ||
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06) ||
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x07 && buf[3] === 0x08)
  );
}

/** 从尾部找 EOCD（注释最长 65535 字节） */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是合法的 ZIP：找不到中央目录（EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    throw new Error("ZIP64 压缩包暂不支持（请解压后单独上传结构文件）");
  }
  if (cdOffset + cdSize > buf.length) throw new Error("ZIP 中央目录越界，文件可能被截断");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error("ZIP 中央目录条目越界");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, entryOffset: p });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读取一条 entry 的内容（目录条目不在这里处理） */
export function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lh = entry.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) {
    throw new Error(`ZIP 条目「${entry.name}」的本地头损坏`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`ZIP 条目「${entry.name}」被截断`);
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: 512 << 20 });
    } catch (e: any) {
      throw new Error(`ZIP 条目「${entry.name}」解压失败：${e?.message ?? e}`);
    }
  }
  throw new Error(`ZIP 条目「${entry.name}」使用了不支持的压缩方式（method=${entry.method}）`);
}
