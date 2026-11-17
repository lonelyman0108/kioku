import { describe, expect, it } from 'vitest'

import {
  addedSensitiveContent,
  isProtectedPersonalMemory,
  maskSensitiveContent,
  needsSensitiveInboxAlert,
  normalizeRuleKind,
  resolveSpacePrivacy,
  scanSensitiveContent,
  validateCustomRules,
} from '../sensitive'

const join = (...parts: string[]) => parts.join('')
const run = (n: number) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC'.repeat(8).slice(0, n)

describe('扩展凭据识别与反误报过滤', () => {
  it('识别常见第三方服务令牌与转发密钥', () => {
    const samples = [
      join('AI', 'za', run(35)),
      join('ar', 'k-', run(24)),
      join('hf', '_', run(32)),
      join('gs', 'k_', run(42)),
      join('xa', 'i-', run(42)),
      join('np', 'm_', run(36)),
      join('py', 'pi-', run(52)),
      join('do', 'p_v1_', 'a1b2c3d4'.repeat(8)),
      join('SG', '.', run(22), '.', run(43)),
      join('cf', 'ut_', run(42)),
      join('oc', '_sk_', run(24)),
    ]
    for (const token of samples) {
      const hits = scanSensitiveContent(`key=${token}`, { pii: false })
      expect(
        hits.map((h) => h.kind),
        token,
      ).toEqual(['provider_token'])
      expect(hits[0]!.category).toBe('credential')
    }
  })

  it('识别 URL 内嵌密码并排除用户名同名或路径同名测试库', () => {
    const real = scanSensitiveContent('DB=postgres://admin:S3cretP@ss99@db.example.com:5432/prod', {
      pii: false,
    })
    expect(real.map((h) => [h.kind, 'S3cretP@ss99'])).toBeTruthy()
    expect(real.some((h) => h.kind === 'url_password')).toBe(true)

    const sameUser = scanSensitiveContent('postgres://postgres:postgres@127.0.0.1:5432/app', {
      pii: false,
    })
    expect(sameUser).toEqual([])

    const repoInPath = scanSensitiveContent(
      'postgres://geodatafusion:geodatafusion@127.0.0.1:55432/geodatafusion',
      { pii: false },
    )
    expect(repoInPath).toEqual([])
  })

  it('识别 HTTP Authorization / Cookie / X-Auth-Key 头，放行普通说明文字', () => {
    const auth = scanSensitiveContent(`Authorization: Bearer ${run(24)}`, { pii: false })
    expect(auth.map((h) => h.kind)).toEqual(['header_secret'])

    const cookie = scanSensitiveContent('Cookie: sid=abc123def456; csrf=xyz987', { pii: false })
    expect(cookie.map((h) => h.kind)).toEqual(['header_secret'])

    const prose = scanSensitiveContent('Authorization: the user must sign in first', { pii: false })
    expect(prose).toEqual([])
  })

  it('识别加密钱包私钥与 BIP-0039 助记词，不误报普通哈希或英文句子', () => {
    const sui = join('suipriv', 'key1', 'q'.repeat(58))
    const nostr = join('ns', 'ec1', 'a'.repeat(58))
    const evm = `PRIVATE_KEY=${join('0x', 'ab'.repeat(32))}`
    const txHash = `tx_hash=${join('0x', 'ab'.repeat(32))}`
    expect(scanSensitiveContent(sui, { pii: false }).map((h) => h.kind)).toEqual(['wallet_key'])
    expect(scanSensitiveContent(nostr, { pii: false }).map((h) => h.kind)).toEqual(['wallet_key'])
    expect(scanSensitiveContent(evm, { pii: false }).some((h) => h.kind === 'wallet_key')).toBe(
      true,
    )
    expect(scanSensitiveContent(txHash, { pii: false })).toEqual([])

    const mnemonic =
      '助记词：abandon ability able about above absent absorb abstract absurd abuse access accident'
    expect(scanSensitiveContent(mnemonic, { pii: false }).map((h) => h.kind)).toEqual([
      'seed_phrase',
    ])

    const notMnemonic =
      'recovery: the quick brown fox jumps over the lazy dog inside the garden today'
    expect(scanSensitiveContent(notMnemonic, { pii: false })).toEqual([])
  })

  it('反误报：路径行号、版本号、时间戳、nextField、slug、非敏感键名不误报', () => {
    const cleanTexts = [
      'internal/auth/token.go:L643-669',
      'PRIVATE_KEY_PATH=~/.ssh/id_ed25519',
      '"credentials": "/Users/alice/adc.json"',
      '"jsonwebtoken": "^9.2.0-beta1"',
      'tokenizer: 2.4.0-beta02',
      '"access_token_expires_at": "2026-08-30T11:44:31.312645+08:00"',
      'UI_PASSWORD= UI_ADDR=127.0.0.1:39117',
      'https://news.example.com/sk-hynix-third-quarter-profit.html',
      'sort_key=created_at',
      'cache_key=user_profile_v2',
      'public_key=ed25519_main',
      '密钥为 2048 位',
    ]
    for (const text of cleanTexts) {
      expect(scanSensitiveContent(text, { pii: false }), text).toEqual([])
    }

    // 空字段后的下一个敏感字段仍可检出
    const nextToken = 'UI_PASSWORD= UI_TOKEN=AbCdEfGh123456' // gitleaks:allow
    const hits = scanSensitiveContent(nextToken, { pii: false })
    expect(hits.map((h) => nextToken.slice(h.start, h.end))).toEqual(['AbCdEfGh123456'])
  })
})

describe('PII 识别与校验器', () => {
  it('默认开启手机号、身份证校验码、银行卡 Luhn、真实邮箱', () => {
    // 合法身份证号（带正确校验码 X）
    const idOk = '11010519491231002X'
    const idBad = '110105194912310021'
    expect(scanSensitiveContent(`身份证 ${idOk}`).map((h) => h.kind)).toEqual(['id_card'])
    expect(scanSensitiveContent(`身份证 ${idBad}`)).toEqual([])

    // 银行卡 Luhn 校验
    const cardOk = '6222020200111222333'
    const cardBad = '6222020200111222330'
    expect(scanSensitiveContent(`卡号 ${cardOk}`).map((h) => h.kind)).toEqual(['bank_card'])
    expect(scanSensitiveContent(`卡号 ${cardBad}`)).toEqual([])

    // 手机号
    expect(scanSensitiveContent('联系我 13800138000').map((h) => h.kind)).toEqual(['phone'])

    // 邮箱：过滤 git@、example.com、@2x.png、@AGENTS.md、@plt
    expect(scanSensitiveContent('邮箱 alice@acme.org').map((h) => h.kind)).toEqual(['email'])
    for (const ignored of [
      'git@github.com:org/repo.git',
      'alice@example.com',
      'noreply@acme.org',
      'hero@2x.png',
      'read@AGENTS.md',
      'puts@got.plt',
    ]) {
      expect(scanSensitiveContent(ignored), ignored).toEqual([])
    }
  })

  it('UUID 与 hex 摘要边界保护，不误切分内部手机号形态', () => {
    const uuid = '550e8400-e29b-41d4-a716-413800138000'
    expect(scanSensitiveContent(`id=${uuid}`)).toEqual([])
    const digest = '9f13800138000abc'
    expect(scanSensitiveContent(`digest=${digest}`)).toEqual([])
  })

  it('可选 PII 项（公网 IP、MAC、SSN、IBAN、护照）默认关闭，开启后生效', () => {
    const text = 'server 1.2.3.4 mac aa:bb:cc:dd:ee:ff'
    expect(scanSensitiveContent(text)).toEqual([])
    const enabled = scanSensitiveContent(text, {
      piiKinds: { public_ip: true, mac: true },
    })
    expect(enabled.map((h) => h.kind)).toEqual(['public_ip', 'mac'])

    // 版本号与内网 IP、DNS 解析器不误报
    expect(
      scanSensitiveContent('Chrome/120.0.6099.109 192.168.1.1 8.8.8.8 version 1.2.3.4', {
        piiKinds: { public_ip: true },
      }),
    ).toEqual([])
  })
})

describe('自定义规则、白名单与打码', () => {
  it('校验并运行自定义规则与白名单', () => {
    expect(normalizeRuleKind('my gateway-key')).toBe('MY_GATEWAY_KEY')
    const valid = validateCustomRules([
      { kind: 'corp_key', prefix: 'corp_' },
      { kind: 'empty', regex: 'a*' },
    ])
    expect(valid.ok).toBe(false)

    const checked = validateCustomRules([{ kind: 'corp_key', prefix: 'corp_' }])
    expect(checked.ok).toBe(true)
    if (!checked.ok) return

    const opts = resolveSpacePrivacy({
      customRules: checked.rules,
      allowlist: ['13800138000'],
    })
    const text = 'key=corp_1234567890 phone=13800138000 other=13900139000' // gitleaks:allow
    const hits = scanSensitiveContent(text, opts)
    expect(hits.map((h) => [h.kind, text.slice(h.start, h.end)])).toEqual([
      ['custom', 'corp_1234567890'],
      ['phone', '13900139000'],
    ])

    const tagged = maskSensitiveContent(text, opts, 'tag')
    expect(tagged).toBe('key=[REDACTED:CORP_KEY] phone=13800138000 other=[REDACTED:PHONE]')
    const starred = maskSensitiveContent('电话 13900139000 和 {{cred:wifi}}', opts, 'stars')
    expect(starred).toBe('电话 *** 和 {{cred:wifi}}')

    // 模型额外识别片段同样遵循占位符保护与白名单放行
    const modelInput = '联系人 张三，白名单 13800138000，凭据 {{cred:alice#token}}'
    const spanOf = (sub: string, kind: string) => {
      const start = modelInput.indexOf(sub)
      return { start, end: start + sub.length, kind }
    }
    const extraSpans = [
      spanOf('张三', 'person'),
      spanOf('13800138000', 'account'),
      spanOf('alice#token', 'account'),
    ]
    expect(maskSensitiveContent(modelInput, opts, 'tag', extraSpans)).toBe(
      '联系人 [REDACTED:PERSON]，白名单 13800138000，凭据 {{cred:alice#token}}',
    )
  })

  it('addedSensitiveContent 对比新增项', () => {
    const before = '电话 13800138000'
    const after = '电话 13800138000\n新卡 6222020200111222333'
    const added = addedSensitiveContent(before, after)
    expect(added.map((h) => h.kind)).toEqual(['bank_card'])
  })

  it('needsSensitiveInboxAlert 仅对本人私密边界外的 PII 或明文凭据触发待处理告警', () => {
    expect(isProtectedPersonalMemory('user', 'private', 'owner')).toBe(true)
    expect(isProtectedPersonalMemory('user', 'private', 'untrusted')).toBe(false)
    expect(isProtectedPersonalMemory('user', 'internal', 'owner')).toBe(false)
    expect(isProtectedPersonalMemory('core', 'private', 'owner')).toBe(false)

    // 本人私密受信任的 PII 不进待处理告警
    expect(
      needsSensitiveInboxAlert({
        layer: 'user',
        sensitivity: 'private',
        provenance: 'owner',
        sensitiveCredential: false,
        sensitivePii: true,
        plaintextIgnored: false,
      }),
    ).toBe(false)

    // 共享、非私密或未确认来源的 PII 需要告警
    expect(
      needsSensitiveInboxAlert({
        layer: 'core',
        sensitivity: 'internal',
        provenance: 'owner',
        sensitivePii: true,
      }),
    ).toBe(true)
    expect(
      needsSensitiveInboxAlert({
        layer: 'user',
        sensitivity: 'internal',
        provenance: 'owner',
        sensitivePii: true,
      }),
    ).toBe(true)
    expect(
      needsSensitiveInboxAlert({
        layer: 'user',
        sensitivity: 'private',
        provenance: 'untrusted',
        sensitivePii: true,
      }),
    ).toBe(true)

    // 明文凭据即使在本人私密中也必须进待处理（非机密且未忽略）
    expect(
      needsSensitiveInboxAlert({
        layer: 'user',
        sensitivity: 'private',
        provenance: 'owner',
        sensitiveCredential: true,
        sensitivePii: false,
      }),
    ).toBe(true)

    // 已设为机密或已忽略均不提示
    expect(
      needsSensitiveInboxAlert({
        layer: 'user',
        sensitivity: 'secret',
        provenance: 'owner',
        sensitiveCredential: true,
        sensitivePii: true,
      }),
    ).toBe(false)
  })
})
