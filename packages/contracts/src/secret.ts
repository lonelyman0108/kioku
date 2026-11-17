import { z } from 'zod'

export const BaseUrl = z.url({
  protocol: /^https?$/,
  error: '接口地址须以 http:// 或 https:// 开头',
})

// 粘贴来的密钥：去掉首尾的空白（多带一个换行很常见），别的只收可打印的 ASCII（空格到 ~）。换行、零宽字符、全角符号放过去的话，
// 它进请求头时 fetch 直接报错，进签名时算出来的签名对不上，都看不出是密钥的问题。name 是这个密钥叫什么
export const pastedSecret = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} 不能只有空白`)
    .regex(
      /^[\x20-\x7e]+$/,
      `${name} 只能包含英文字母、数字和半角符号，请检查粘贴的内容是否含换行、零宽字符或全角符号`,
    )

export const ApiKey = pastedSecret('Key')
