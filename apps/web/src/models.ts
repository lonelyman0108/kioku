import type {
  ModelFormat,
  ModelProfileKind,
  ModelProfileView,
  ModelProviderView,
  ThinkingLevel,
  ThinkingStyle,
} from '@kioku/contracts'

export const FORMAT_LABELS: Record<ModelFormat, string> = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
  ollama: 'Ollama 原生',
}

export const FORMAT_OPTIONS: { label: string; value: ModelFormat }[] = [
  { label: 'OpenAI Chat Completions (/chat/completions)', value: 'openai-chat' },
  { label: 'OpenAI Responses (/responses)', value: 'openai-responses' },
  { label: 'Anthropic Messages (/v1/messages)', value: 'anthropic' },
  { label: 'Google Gemini (generateContent)', value: 'gemini' },
  { label: 'Ollama 原生 (/api/chat)', value: 'ollama' },
]

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  default: '默认（不传参数）',
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
}

export const THINKING_OPTIONS: { label: string; value: ThinkingLevel }[] = [
  { label: '默认（不传参数）', value: 'default' },
  { label: '关闭', value: 'off' },
  { label: '极低', value: 'minimal' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
]

export const THINKING_STYLE_OPTIONS: { label: string; value: ThinkingStyle }[] = [
  { label: '自动（reasoning_effort）', value: 'auto' },
  { label: 'reasoning_effort', value: 'reasoning_effort' },
  { label: 'enable_thinking（布尔开关）', value: 'enable_thinking' },
  { label: '不传思考字段', value: 'none' },
]

export interface ProfileOption {
  profileId: string
  providerId: string
  providerName: string
  format: ModelFormat
  baseUrl: string
  model: string
  label: string | null
  kind: ModelProfileKind
  thinking?: ThinkingLevel
  display: string
}

export function flattenProfiles(
  providers: readonly ModelProviderView[],
  kind: ModelProfileKind,
): ProfileOption[] {
  const out: ProfileOption[] = []
  for (const provider of providers) {
    for (const profile of provider.profiles) {
      if (profile.kind !== kind) continue
      const name = profile.label ? `${profile.label} (${profile.model})` : profile.model
      const thinkingTag =
        profile.kind === 'chat' && profile.thinking !== 'default'
          ? ` · 思考：${THINKING_LABELS[profile.thinking]}`
          : ''
      out.push({
        profileId: profile.id,
        providerId: provider.id,
        providerName: provider.name,
        format: provider.format,
        baseUrl: provider.baseUrl,
        model: profile.model,
        label: profile.label,
        kind: profile.kind,
        ...(profile.kind === 'chat' ? { thinking: profile.thinking } : {}),
        display: `${provider.name} / ${name}${thinkingTag}`,
      })
    }
  }
  return out
}

export function profileSummary(profile: ModelProfileView): string {
  const base = profile.label ? `${profile.label} (${profile.model})` : profile.model
  if (profile.kind === 'chat' && profile.thinking !== 'default') {
    return `${base} · 思考：${THINKING_LABELS[profile.thinking]}`
  }
  return base
}
