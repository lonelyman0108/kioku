import { URI_PATTERN, type Layer, type Sensitivity } from '@kioku/contracts'

export interface ParsedUri {
  domain: string
  path: string
  // persona:// 与 app:// 下第一段是人格或应用的标识
  namespaceSlug: string | null
}

export const PERSONA_DOMAIN = 'persona'
export const APP_DOMAIN = 'app'

export function parseUri(uri: string): ParsedUri | null {
  const match = URI_PATTERN.exec(uri)
  if (!match) return null
  const domain = match[1]!
  const path = match[2]!
  const namespaced = domain === PERSONA_DOMAIN || domain === APP_DOMAIN
  return { domain, path, namespaceSlug: namespaced ? path.split('/')[0]! : null }
}

export function formatUri(domain: string, path: string): string {
  return `${domain}://${path}`
}

// 保留 domain 决定层；其余 domain 的层由调用方指定，不指定时按私人层处理，宁可收得紧
export function layerForDomain(domain: string): Layer | null {
  if (domain === PERSONA_DOMAIN) return 'persona'
  if (domain === APP_DOMAIN) return 'app'
  return null
}

export const DEFAULT_SENSITIVITY: Record<Layer, Sensitivity> = {
  base: 'public',
  persona: 'public',
  app: 'internal',
  owner: 'internal',
  private: 'private',
  subject: 'public',
  episode: 'public',
}
