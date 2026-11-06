// 交给模型的文字怎么压：召回块、启动加载与 MCP 工具结果共用。不依赖别的模块：
// mcp/format.ts 引用它，又打进不带数据库的 dist/bench.mjs

// 压成单行：去掉控制字符（数据库的文本里存不了 \u0000），连续的空白换成一个空格
export function oneLine(text: string): string {
  const printable = [...text].filter((ch) => {
    const code = ch.codePointAt(0)!
    return code >= 0x20 ? code !== 0x7f : /\s/.test(ch)
  })
  return printable.join('').replace(/\s+/g, ' ').trim()
}

// 召回块会原样进入宿主的上下文。disclosure 与关键词可能来自不可信的写入者，
// 压成单行并去掉尖括号，避免伪造 </recall> 闭合标签后注入任意文本
export function inlineText(text: string): string {
  return oneLine(text.replace(/[<>]/g, ''))
}

// 给模型看的坐标后面带上标题（「」里），标题就是标识（没写标题、正文里也没有 # 标题）时省掉。
// 标题里的「」去掉，免得和外面的括号混在一起（bench/executor.ts 按它认出坐标）
export function titleSuffix(uri: string, title: string): string {
  const label = inlineText(title).replace(/[「」]/g, '')
  return label && label !== uri.slice(uri.lastIndexOf('/') + 1) ? `「${label}」` : ''
}

// 按字符（不是 UTF-16 码元）截断，免得切开表情符号；截掉了才接上 suffix
export function clipChars(text: string, max: number, suffix = ''): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}${suffix}` : text
}
