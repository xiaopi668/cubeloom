import * as VG from "@pureeval/voxel-geometry";
import type { ServerSession } from "mcpews";

/**
 * 体素落块层。
 *
 * 这里的导出名与调用形状（柯里化）是沙箱里的公共 API，脚本会直接写到：
 *
 *     setBlocks(session)("minecraft:stone")(sphere(3, 0))
 *     setBlock(session)("minecraft:stone")(vec3(0, 64, 0))
 *
 * 实现按「先拼前缀、再单次遍历」组织，不做三层闭包嵌套，
 * 这样空数组、单点、整片体素走的是同一条路径，也方便单独测命令格式。
 */

/** 体素坐标集合（等价于 VoxelGeometry 的 Space） */
type Vec3Like = { x: number; y: number; z: number };
type Space = VG.Vec3[];

/** 坐标工厂：VG.Vec3 是 class，沙箱里需要当普通函数调用 */
function Vec3(x: number, y: number, z: number): VG.Vec3 {
  return new VG.Vec3(x, y, z);
}

/** 从任意 {x,y,z} 提升为 VG.Vec3（是 VG.Vec3 时原样返回） */
function lift(p: Vec3Like): VG.Vec3 {
  if (p instanceof VG.Vec3) return p;
  return new VG.Vec3(p.x, p.y, p.z);
}

/** 一条 setblock 命令的纯函数形式 */
function setBlockCommand(block: string, pos: Vec3Like): string {
  return `setblock ${pos.x} ${pos.y} ${pos.z} ${block}`;
}

/** 单块落块：setBlock(session)(block)(pos) */
function setBlock(session: ServerSession) {
  return (block: string) => (pos: Vec3Like) => {
    session.sendCommand(setBlockCommand(block, pos));
  };
}

/** 遍历体素：overSpace(space)(fn) */
function overSpace(space: Space) {
  return (fn: (pos: VG.Vec3) => void) => {
    for (let i = 0; i < space.length; i++) fn(space[i]);
  };
}

/**
 * 整片落块：setBlocks(session)(block)(space)
 *
 * 每个体素发一条 setblock。命令的固定前后缀只拼一次，
 * 循环里只做数值插值——大结构（十万级）能省下可观的字符串拼接。
 */
function setBlocks(session: ServerSession) {
  return (block: string) => (space: Space) => {
    const head = "setblock ";
    const tail = " " + block;
    for (let i = 0; i < space.length; i++) {
      const p = space[i];
      session.sendCommand(`${head}${p.x} ${p.y} ${p.z}${tail}`);
    }
  };
}

export { Vec3, lift, setBlock, setBlocks, overSpace, setBlockCommand };
export type { Space, Vec3Like };
