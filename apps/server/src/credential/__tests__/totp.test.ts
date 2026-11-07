import { describe, expect, it } from 'vitest'

import { TotpFormatError, totpCode } from '../totp'

// RFC 6238 附录 B 的测试向量：密钥是 ASCII 的 12345678901234567890（SHA-1）
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // gitleaks:allow

describe('TOTP 验证码', () => {
  it('和 RFC 6238 的测试向量一致', () => {
    const uri = `otpauth://totp/Kioku:agent?secret=${SECRET}&digits=8&period=30`
    expect(totpCode(uri, 59_000)).toBe('94287082')
    expect(totpCode(uri, 1_111_111_109_000)).toBe('07081804')
    expect(totpCode(uri, 20_000_000_000_000)).toBe('65353130')
  })

  it('只有密钥时按 6 位、30 秒、SHA-1；空白与小写都认', () => {
    expect(totpCode(SECRET.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000)).toBe('287082')
  })

  it('认不出的写法明确报错，不猜', () => {
    for (const secret of ['steam://ABC', 'otpauth://hotp/x?secret=ABC', 'not base32!', '']) {
      expect(() => totpCode(secret), secret).toThrow(TotpFormatError)
    }
    expect(() => totpCode(`otpauth://totp/x?secret=${SECRET}&algorithm=MD5`)).toThrow(
      TotpFormatError,
    )
  })
})
