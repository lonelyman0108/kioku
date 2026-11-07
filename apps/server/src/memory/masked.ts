// 打码时给调用方看的占位文字。模型读到之后可能照抄进下一次写入，而 secret 的历史不存正文、
// 凭据的事件不留旧值，写进去就找不回来，所以打码时写入也认这些文字（见 MemoryContext.maskSecret、CredentialContext.mask）。
// 这个文件不依赖别的模块：命令行用到的工具结果格式化也引用它，不能带上服务端的代码

// 读不到 secret 的正文时给的文字
export const MASKED_SECRET_CONTENT = '（secret 正文需要显式读取权限）'
// 测试台里取用凭据时代替值的文字：两种来源、两种模式都不给值
export const MASKED_CREDENTIAL_VALUES = '（测试台不给凭据的值，要看去凭据页）'

const MASKED_TEXTS = [MASKED_SECRET_CONTENT, MASKED_CREDENTIAL_VALUES]

export const hasMaskedText = (text: string) => MASKED_TEXTS.some((masked) => text.includes(masked))
