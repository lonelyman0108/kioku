// 交给模型的文字压缩与安全处理：召回块、启动加载与对象直连共用

// 压成单行：去掉控制字符，连续空白折叠为单个空格
export function oneLine(text: string): string {
  const printable = [...text].filter((ch) => {
    const code = ch.codePointAt(0)!
    return code >= 0x20 ? code !== 0x7f : /\s/.test(ch)
  })
  return printable.join('').replace(/\s+/g, ' ').trim()
}

// 召回与启动块进入宿主上下文，必须剔除尖括号防止伪造闭合标签注入
export function inlineText(text: string): string {
  return oneLine(text.replace(/[<>]/g, ''))
}

// 短 ID 后的可读标题附注（「标题」），标题与短 ID 相同时省去
export function titleSuffix(shortId: string, title: string): string {
  const label = inlineText(title).replace(/[「」]/g, '')
  return label && label !== shortId ? `「${label}」` : ''
}

// 按 Unicode 码点截断，避免拆开代理对，发生截断时拼上 suffix
export function clipChars(text: string, max: number, suffix = ''): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}${suffix}` : text
}
