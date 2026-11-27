export type SessionDeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface ParsedUserAgent {
  label: string
  deviceKind: SessionDeviceKind
}

function detectBrowser(ua: string): string | null {
  const edge = /Edg(?:A|iOS)?\/(\d+)/.exec(ua)
  if (edge) return `Edge ${edge[1]}`
  const opera = /(?:OPR|Opera)\/(\d+)/.exec(ua)
  if (opera) return `Opera ${opera[1]}`
  const firefox = /(?:Firefox|FxiOS)\/(\d+)/.exec(ua)
  if (firefox) return `Firefox ${firefox[1]}`
  const chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(ua)
  if (chrome) return `Chrome ${chrome[1]}`
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) {
    const ver = /Version\/(\d+)/.exec(ua)
    return ver ? `Safari ${ver[1]}` : 'Safari'
  }
  const curl = /curl\/([\d.]+)/i.exec(ua)
  if (curl) return `curl ${curl[1]}`
  return null
}

function detectPlatform(ua: string): { os: string | null; deviceKind: SessionDeviceKind } {
  if (/iPad/i.test(ua)) return { os: 'iPadOS', deviceKind: 'tablet' }
  if (/iPhone|iPod/i.test(ua)) return { os: 'iOS', deviceKind: 'mobile' }
  if (/Android/i.test(ua)) {
    return /Mobile/i.test(ua)
      ? { os: 'Android', deviceKind: 'mobile' }
      : { os: 'Android', deviceKind: 'tablet' }
  }
  if (/Windows NT/i.test(ua)) return { os: 'Windows', deviceKind: 'desktop' }
  if (/Macintosh|Mac OS X/i.test(ua)) return { os: 'macOS', deviceKind: 'desktop' }
  if (/CrOS/i.test(ua)) return { os: 'ChromeOS', deviceKind: 'desktop' }
  if (/Linux/i.test(ua)) return { os: 'Linux', deviceKind: 'desktop' }
  return { os: null, deviceKind: 'unknown' }
}

// 将冗长的浏览器 User-Agent 规整为「浏览器 · 系统」摘要，原始串留作悬停提示
export function parseUserAgent(raw: string | null | undefined): ParsedUserAgent {
  const ua = raw?.trim() ?? ''
  if (!ua) return { label: '未知浏览器', deviceKind: 'unknown' }
  const browser = detectBrowser(ua)
  const { os, deviceKind } = detectPlatform(ua)
  if (browser && os) return { label: `${browser} · ${os}`, deviceKind }
  if (browser) return { label: browser, deviceKind }
  if (os) return { label: os, deviceKind }
  return {
    label: ua.length > 48 ? `${ua.slice(0, 48)}…` : ua,
    deviceKind,
  }
}
