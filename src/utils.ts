/**
 * 游戏内文本回显。
 *
 * 命令形状：`tellraw <target> {"rawtext":[{"text":"<时间戳> <正文>"}]}`
 *
 * 用对象 + JSON.stringify 组装，而不是模板字符串直接内插：
 * 这样正文里出现 `"`、`\`、换行时不会拼出非法 JSON，也不需要手工处理转义。
 */

/** 游戏内时间统一按 UTC+8（服务器本身可能跑在 UTC） */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

/** `[HH:mm:ss]`，默认取当前时刻 */
function stamp(at: number = Date.now()): string {
  return `[${new Date(at + TZ_OFFSET_MS).toISOString().slice(11, 19)}]`;
}

/** 组装一条 tellraw 命令（纯函数，便于单测） */
function tellrawCommand(target: string, lines: readonly string[], at: number = Date.now()): string {
  const payload = { rawtext: [{ text: `${stamp(at)} ${lines.join("\n")}` }] };
  return `tellraw ${target} ${JSON.stringify(payload)}`;
}

/** 旧签名：tell_raw(target, ...message) → 命令字符串 */
function tell_raw(Player: string, ...Message: string[]): string {
  return tellrawCommand(Player, Message);
}

export { tell_raw, tellrawCommand, stamp };
