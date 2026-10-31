// 接口设置里保存着的密钥（嵌入渠道与抽取模型的 Key、备份的 Secret Access Key）：服务端只在同一个主机上沿用，
// 换了接口主机又没说新的密钥怎么处理时拒绝保存，免得把它发给新主机。界面在提交之前按同一条规则判断

// 一份接口设置的草稿里与密钥有关的几项
export interface KeyDraft {
  // 现在填的接口地址
  baseUrl: string
  // 已保存的接口地址；新加的、还没保存过的为 null
  savedBaseUrl: string | null
  // 已保存的设置里有密钥
  hasApiKey: boolean
  // 新填的密钥，留空表示沿用
  apiKey: string
  // 勾了清除；不能清除的（备份的 Secret）一直是 false
  clearKey: boolean
}

// 接口地址的主机（协议、主机名与端口）；不是 http 或 https 的地址、还没填完整的为 null
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

// 换了接口的主机、密钥留空、也没勾清除：这样提交会被服务端拒绝。提交之前就在密钥旁边说明，按钮不可点。
// 地址还没填成 http 或 https 的不算，那时提交先报地址不对
export function needsNewKey(draft: KeyDraft): boolean {
  if (!draft.hasApiKey || draft.savedBaseUrl === null || draft.clearKey || draft.apiKey !== '') {
    return false
  }
  const host = hostOf(draft.baseUrl)
  return host !== null && host !== hostOf(draft.savedBaseUrl)
}

// 密钥旁边的说明：name 是这个密钥叫什么，能清除的再说怎么清（对着界面上「清除已保存的 …」那个勾选框）
export function newKeyHint(name: string, clearable: boolean): string {
  const clear = clearable ? `；新接口不需要 ${name} 时，请勾选下方的「清除已保存的 ${name}」` : ''
  return `接口主机已更改，已保存的 ${name} 不会发送到新主机。请重新填写${clear}。`
}
