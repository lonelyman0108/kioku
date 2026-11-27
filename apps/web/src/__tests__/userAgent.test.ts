import { describe, expect, it } from 'vitest'

import { parseUserAgent } from '../userAgent'

describe('parseUserAgent', () => {
  it('解析常见桌面浏览器与系统为简洁摘要', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
      ),
    ).toEqual({ label: 'Chrome 158 · Windows', deviceKind: 'desktop' })

    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
      ),
    ).toEqual({ label: 'Chrome 158 · macOS', deviceKind: 'desktop' })

    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      ),
    ).toEqual({ label: 'Safari 18 · macOS', deviceKind: 'desktop' })

    expect(
      parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'),
    ).toEqual({ label: 'Firefox 132 · Linux', deviceKind: 'desktop' })
  })

  it('区分移动与平板设备并兜底空值或未知 UA', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ label: 'Safari 18 · iOS', deviceKind: 'mobile' })

    expect(
      parseUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ label: 'Safari 18 · iPadOS', deviceKind: 'tablet' })

    expect(parseUserAgent(null)).toEqual({ label: '未知浏览器', deviceKind: 'unknown' })
    expect(parseUserAgent('   ')).toEqual({ label: '未知浏览器', deviceKind: 'unknown' })
    expect(parseUserAgent('curl/8.7.1')).toEqual({ label: 'curl 8.7.1', deviceKind: 'unknown' })
  })
})
