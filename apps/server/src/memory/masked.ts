// 打码时给调用方看的占位文字。模型读到之后可能照抄进下一次写入，而 secret 的历史不存正文、
// 凭据的事件不留旧值，写进去就找不回来，所以打码时写入也认这些文字（见 MemoryContext.maskSecret、CredentialContext.mask）。
// 这个文件不依赖别的模块：命令行用到的工具结果格式化也引用它，不能带上服务端的代码

// 读不到 secret 的正文时给的文字
export const MASKED_SECRET_CONTENT = '（secret 正文需要显式读取权限）'
// 回滚模式下换掉的外部绑定
export const MASKED_BINDING = '（测试台的回滚模式不显示，要看去凭据页）'
// 托管的值的说明开头，后面接字段名
export const MASKED_HOSTED_PREFIX = '值由 Kioku 托管，测试台不解密。'

const MASKED_TEXTS = [MASKED_SECRET_CONTENT, MASKED_BINDING, MASKED_HOSTED_PREFIX]

export const hasMaskedText = (text: string) => MASKED_TEXTS.some((masked) => text.includes(masked))
