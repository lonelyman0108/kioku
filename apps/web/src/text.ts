// 按 UTF-16 码元截断，和契约的 max 同一个数法。不切开代理对：落单的代理项写进去会被换成 U+FFFD，
// 之后和原文比永远不等
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const last = text.charCodeAt(limit - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}
