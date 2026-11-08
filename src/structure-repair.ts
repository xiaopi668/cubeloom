/**
 * .mcstructure 修补
 *
 * 设计原则（2026-11 重写）：
 *  1. **规范文件原样返回**：解析通过且没有任何问题时不重写字节，避免"修补"降级文件。
 *  2. **保留不认识的字段**：走 parseNbtTyped() 的带类型 AST，entities / block_position_data /
 *     方块状态 states / 第三方私有键都原样写回（旧实现重建 root，把它们全丢了）。
 *  3. **不把截断当成功**：只在末尾缺 TAG_End（补零能正常收尾且数据长度自洽）时补零；
 *     数据中间被截断导致索引数量对不上时直接失败，不再用 -1 填出"看起来成功"的文件。
 *  4. **有损必须明说**：任何会改变方块集合/名称的修复都置 lossy=true，UI 必须提示。
 *
 * 常见损坏与处理：
 *  - gzip 压缩 → 解压
 *  - 末尾缺 TAG_End（1~16 字节）→ 补零
 *  - block_indices 层数不是 2 → 补/删第二层
 *  - 层内数量与 size 乘积不一致 → 在"未补零"前提下用 -1 补/截断（lossy）
 *  - 索引越界或非法 → 置为 -1（lossy）
 *  - 缺 format_version / structure_world_origin / entities / block_position_data → 补默认值
 *  - 调色板条目缺 name → 按 air 处理（lossy）；name 含控制字符 → 判定为截断并失败
 */
import * as zlib from "node:zlib";
import { parseNbtTyped, NbtTruncatedError } from "./nbt";
import { serializeNbt, NbtValue } from "./nbt-write";
import { parseMcStructure, ParsedStructure } from "./structure";

export type RepairResult = {
  ok: boolean;
  /** 是否真的改动了内容（false 表示文件本来就规范，data 与输入一致） */
  fixed: boolean;
  /** 修复是否改变了方块集合/名称/状态（true 时 UI 必须提示"有损"） */
  lossy: boolean;
  issues: string[];
  error?: string;
  data?: Buffer;
  parsed?: ParsedStructure;
};

type Compound = Extract<NbtValue, { type: "compound" }>;
type ListValue = Extract<NbtValue, { type: "list" }>;

const isCompound = (v: NbtValue | undefined): v is Compound => !!v && v.type === "compound";
const isList = (v: NbtValue | undefined): v is ListValue => !!v && v.type === "list";
const isNum = (v: NbtValue | undefined): v is Extract<NbtValue, { type: "int" | "byte" | "short" | "long" }> =>
  !!v && (v.type === "int" || v.type === "byte" || v.type === "short" || v.type === "long");

function numOf(v: NbtValue | undefined): number | null {
  if (!isNum(v)) return null;
  const n = Number(v.value);
  return Number.isFinite(n) ? n : null;
}

const intTag = (n: number): NbtValue => ({ type: "int", value: Math.trunc(n) });
const intList = (values: number[]): ListValue => ({ type: "list", element: "int", items: values.map(intTag) });
const emptyCompoundList = (): ListValue => ({ type: "list", element: "compound", items: [] });

/** 方块名合法性：基岩版命名空间只允许这些字符；出现 NUL/替换字符说明文件被截断过 */
function isValidBlockName(name: string): boolean {
  if (!name || name.length > 128) return false;
  return /^[a-z0-9_.:+-]+$/i.test(name);
}

export function repairMcStructure(input: Buffer, name: string): RepairResult {
  const issues: string[] = [];
  let lossy = false;
  let data = input;
  let wasGzip = false;

  if (!data.length) return { ok: false, fixed: false, lossy: false, issues, error: "文件为空" };

  // 1) gzip
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = zlib.gunzipSync(data);
      wasGzip = true;
      issues.push("检测到 gzip 压缩，已解压为标准未压缩 NBT");
    } catch (e: any) {
      return { ok: false, fixed: false, lossy: false, issues, error: `gzip 解压失败：${e?.message ?? e}` };
    }
  }

  // 2) 解析：先按原样解析；失败再尝试尾部补零（只补 1~16 字节的 TAG_End）
  let root: Compound | null = null;
  let paddedBytes = 0;
  let parseError: unknown = null;
  try {
    const r = parseNbtTyped(data);
    if (r.value.type === "compound") root = r.value;
  } catch (e) {
    parseError = e;
    root = null;
  }
  if (!root) {
    // 只有"停在文件末尾、只缺结束标记"才允许补零；截断在数据中间一律失败，
    // 否则补出来的零字节会被当成方块索引，产出一个"看起来成功"的错误结构。
    const atEnd = parseError instanceof NbtTruncatedError && parseError.atEnd;
    if (!atEnd) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        fixed: false,
        lossy: false,
        issues,
        error: `无法解析为 NBT 结构文件（${detail}）。文件很可能被截断在数据中间，请重新导出`,
      };
    }
    for (let extra = 1; extra <= 16; extra++) {
      try {
        const r = parseNbtTyped(Buffer.concat([data, Buffer.alloc(extra)]));
        if (r.value.type === "compound") {
          root = r.value;
          paddedBytes = extra;
          issues.push(`文件末尾缺少结束标记，已补齐 ${extra} 字节`);
          break;
        }
      } catch {
        // 继续尝试
      }
    }
  }
  if (!root) {
    return {
      ok: false,
      fixed: false,
      lossy: false,
      issues,
      error: "无法解析为 NBT 结构文件（文件可能被截断在数据中间，或不是 .mcstructure）",
    };
  }

  // 3) size
  const sizeList = root.fields.size;
  const sizeValues = isList(sizeList) ? sizeList.items.map((v) => numOf(v)) : [];
  const size =
    sizeValues.length === 3 && sizeValues.every((n): n is number => n !== null && n > 0)
      ? (sizeValues as number[])
      : null;
  if (!size) {
    return { ok: false, fixed: false, lossy: false, issues, error: "缺少合法的 size 字段（无法确定结构尺寸）" };
  }
  const [sx, sy, sz] = size;
  const expected = sx * sy * sz;

  // 4) structure
  let structure = root.fields.structure;
  if (!isCompound(structure)) {
    issues.push("缺少 structure 节点，已补空结构");
    structure = { type: "compound", fields: {} };
    root.fields.structure = structure;
    lossy = true;
  }
  const st = structure;

  // 5) 调色板（保留 states，把旧式字符串数组规范化）
  let paletteHolder = st.fields.palette;
  if (!isCompound(paletteHolder)) {
    paletteHolder = { type: "compound", fields: {} };
    st.fields.palette = paletteHolder;
  }
  const paletteRoot = paletteHolder as Compound;
  let def = paletteRoot.fields.default;
  if (!isCompound(def)) {
    def = { type: "compound", fields: {} };
    paletteRoot.fields.default = def;
  }
  const defC = def as Compound;
  let palette = defC.fields.block_palette;
  if (!isList(palette)) {
    // 少数工具把调色板放在根上
    const legacy = root.fields.block_palette;
    if (isList(legacy)) {
      palette = legacy;
      defC.fields.block_palette = legacy;
      delete root.fields.block_palette;
      issues.push("调色板位于根节点（非标准），已移动到 structure.palette.default.block_palette");
    }
  }
  if (!isList(palette) || palette.items.length === 0) {
    return { ok: false, fixed: false, lossy: false, issues, error: "缺少 block_palette 调色板（无法恢复方块类型）" };
  }
  const paletteList = palette as ListValue;

  let badName = "";
  paletteList.items = paletteList.items.map((entry, i) => {
    if (entry.type === "string") {
      issues.push("调色板里有旧式字符串条目，已转成标准结构");
      const nm = entry.value.toLowerCase();
      if (!isValidBlockName(nm)) badName = nm;
      return { type: "compound", fields: { name: { type: "string", value: nm } } };
    }
    if (!isCompound(entry)) {
      issues.push(`调色板第 ${i} 项不是 compound，已按 air 处理`);
      lossy = true;
      return { type: "compound", fields: { name: { type: "string", value: "minecraft:air" } } };
    }
    const nameField = entry.fields.name;
    let nm = nameField?.type === "string" ? nameField.value.toLowerCase() : "";
    if (!nm) {
      issues.push("调色板里有条目缺少 name，已按 air 处理");
      lossy = true;
      nm = "minecraft:air";
      entry.fields.name = { type: "string", value: nm };
    } else if (!isValidBlockName(nm)) {
      badName = nm;
    } else if (nameField && nameField.type === "string" && nameField.value !== nm) {
      entry.fields.name = { type: "string", value: nm };
    }
    return entry;
  });
  if (badName) {
    return {
      ok: false,
      fixed: false,
      lossy: false,
      issues,
      error: `调色板含非法方块名（文件很可能在数据中间被截断）：${JSON.stringify(badName.slice(0, 48))}`,
    };
  }
  const paletteSize = paletteList.items.length;

  // 6) block_indices 两层
  let layersRaw = st.fields.block_indices;
  if (isList(layersRaw) && layersRaw.items.length && layersRaw.items[0].type !== "list") {
    // 只有一层（不是数组套数组）
    layersRaw = { type: "list", element: "list", items: [layersRaw] };
    st.fields.block_indices = layersRaw;
  }
  if (!isList(layersRaw) || !layersRaw.items.length || layersRaw.items[0].type !== "list") {
    return { ok: false, fixed: false, lossy: false, issues, error: "缺少 block_indices 方块索引数据" };
  }
  const layersList = layersRaw as ListValue;
  const layers = layersList.items as ListValue[];

  if (layers.length < 2) {
    issues.push("block_indices 只有 1 层，已补第二层（全 -1）");
    while (layers.length < 2) layers.push(intList(new Array(expected).fill(-1)));
  } else if (layers.length > 2) {
    issues.push(`block_indices 有 ${layers.length} 层，已只保留前两层`);
    layersList.items = layers.slice(0, 2);
    lossy = true;
  }

  // 7) 长度与索引校验
  let filled = 0;
  let outOfRange = 0;
  for (let li = 0; li < 2; li++) {
    const layer = layersList.items[li] as ListValue;
    const values: number[] = layer.items.map((v) => {
      const n = numOf(v);
      return n === null ? NaN : Math.trunc(n);
    });

    if (values.length !== expected) {
      if (paddedBytes > 0) {
        // 补零之后长度仍然对不上：说明零字节被当成了数据，真实文件被截断在中间
        return {
          ok: false,
          fixed: false,
          lossy: false,
          issues,
          error: `文件在数据中间被截断：第 ${li + 1} 层索引数量 ${values.length} ≠ 尺寸乘积 ${expected}（补零无法修复，请重新导出结构）`,
        };
      }
      if (values.length < expected) {
        issues.push(`第 ${li + 1} 层数量 ${values.length} < 尺寸 ${expected}，已用 -1 补齐`);
        filled += expected - values.length;
      } else {
        issues.push(`第 ${li + 1} 层数量 ${values.length} > 尺寸 ${expected}，已截断`);
        filled += values.length - expected;
      }
      lossy = true;
    }

    const fixedLen = values.length < expected
      ? values.concat(new Array(expected - values.length).fill(-1))
      : values.slice(0, expected);
    const items: NbtValue[] = fixedLen.map((v) => {
      if (!Number.isInteger(v) || v < -1 || v >= paletteSize) {
        outOfRange++;
        return intTag(-1);
      }
      return intTag(v);
    });
    layer.element = "int";
    layer.items = items;
  }
  if (outOfRange) {
    issues.push(`有 ${outOfRange} 个方块索引越界/非法，已置为 -1（保持原方块）`);
    lossy = true;
  }
  if (filled) lossy = true;

  // 8) 其他可选字段
  if (!isNum(root.fields.format_version)) {
    issues.push("缺少 format_version，已补 1");
    root.fields.format_version = intTag(1);
  }
  const originList = root.fields.structure_world_origin;
  const originValues = isList(originList) ? originList.items.map((v) => numOf(v)) : [];
  if (!(originValues.length === 3 && originValues.every((n) => n !== null))) {
    issues.push("缺少 structure_world_origin，已补 [0,0,0]");
    root.fields.structure_world_origin = intList([0, 0, 0]);
  }

  // 9) entities / block_position_data 缺失时补默认值；存在则原样保留
  if (!isList(st.fields.entities)) {
    issues.push("缺少 entities，已补空列表");
    st.fields.entities = emptyCompoundList();
  }
  if (!isCompound(defC.fields.block_position_data)) {
    issues.push("缺少 block_position_data，已补空 compound");
    defC.fields.block_position_data = { type: "compound", fields: {} };
  }

  // 10) 文件本来就规范：原样返回字节，不重写
  if (issues.length === 0 && !wasGzip) {
    let parsed: ParsedStructure;
    try {
      parsed = parseMcStructure(data, name);
    } catch (e: any) {
      return { ok: false, fixed: false, lossy: false, issues, error: `解析失败：${e?.message ?? e}` };
    }
    return { ok: true, fixed: false, lossy: false, issues, data, parsed };
  }

  // 11) 写回并自检
  let out: Buffer;
  try {
    out = serializeNbt(root);
  } catch (e: any) {
    return { ok: false, fixed: issues.length > 0, lossy, issues, error: `重新序列化失败：${e?.message ?? e}` };
  }
  let parsed: ParsedStructure;
  try {
    parsed = parseMcStructure(out, name);
  } catch (e: any) {
    return { ok: false, fixed: issues.length > 0, lossy, issues, error: `修补后仍无法解析：${e?.message ?? e}` };
  }

  return { ok: true, fixed: issues.length > 0, lossy, issues, data: out, parsed };
}
