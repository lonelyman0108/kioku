import { createCipheriv, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { sealBackup } from '../../backup/format'
import { encryptSecret } from '../../crypto/envelope'
import { encryptionKey } from '../../crypto/keyring'
import { readLegacyInstanceBackup, readLegacySpaceExport } from '../kiokuLegacy'

const scryptAsync = promisify(
  (
    pw: string,
    salt: Buffer,
    keylen: number,
    opts: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, k: Buffer) => void,
  ) => scrypt(pw, salt, keylen, opts, cb),
)

async function packLegacySpaceExport(
  passphrase: string,
  records: object[],
  version = 6,
): Promise<Buffer> {
  const kdf = { logN: 14, r: 1, p: 1 }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const derived = await scryptAsync(passphrase.normalize('NFKC'), salt, 64, {
    N: 2 ** kdf.logN,
    r: kdf.r,
    p: kdf.p,
    maxmem: 32 * 1024 * 1024,
  })
  const check = createHmac('sha256', derived.subarray(32))
    .update('kioku-space-export-check')
    .digest()
    .subarray(0, 16)
  const header = Buffer.concat([
    Buffer.from('KIOKUSX1'),
    Buffer.from([kdf.logN, kdf.r, kdf.p]),
    salt,
    iv,
    check,
  ])

  const headerLine = {
    format: 'kioku-space-export',
    version,
    createdAt: '2026-10-01T00:00:00.000Z',
    kioku: '0.5.0',
    exporter: { displayName: 'Alice', dreamPrivate: false },
    space: {
      name: '工作空间',
      extractionMonthlyTokens: 500000,
      extractionDailyWrites: 40,
      ...(version >= 6 ? { advanced: { 'recall.limit': 8 }, privacy: {} } : {}),
    },
  }
  const plain = `${[headerLine, ...records].map((r) => JSON.stringify(r)).join('\n')}\n`
  const compressed = gzipSync(Buffer.from(plain, 'utf8'))
  const cipher = createCipheriv('aes-256-gcm', derived.subarray(0, 32), iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(compressed), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

async function packLegacyBackup(masterKey: Buffer, lines: string[], version = 1): Promise<Buffer> {
  const header = JSON.stringify({
    format: 'kioku-backup',
    version,
    createdAt: '2026-10-01T00:00:00.000Z',
    kioku: '0.5.0',
    migrations: { hash: 'oldhash', at: 1700000000000 },
  })
  const chunks: Buffer[] = []
  async function* src() {
    yield `${header}\n`
    for (const line of lines) yield `${line}\n`
  }
  for await (const c of sealBackup(masterKey, src())) chunks.push(c)
  return Buffer.concat(chunks)
}

describe('旧版 Kioku 解析器单元测试', () => {
  it('能用 NFKC 规范化口令解开格式版本 4 与 6 的 KIOKUSX1 空间导出文件', async () => {
    const appId = randomUUID()
    const memId = randomUUID()
    const packed = await packLegacySpaceExport(
      'ＡＢＣ-passphrase-123',
      [
        {
          type: 'app',
          id: appId,
          slug: 'claudecode',
          name: 'Claude Code',
          runtimeFamily: 'claudecode',
          defaultPersonaId: null,
          config: { elevateOwnerDirect: 'internal' },
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
        {
          type: 'memory',
          id: memId,
          form: 'curated',
          layer: 'app',
          sensitivity: 'internal',
          provenance: 'owner',
          originScope: 'global',
          personaId: null,
          appId,
          subjectId: null,
          uri: 'app://claudecode/rules/lint',
          title: null,
          content: '# 代码规范\n保留注释',
          priority: 1,
          disclosure: null,
          glossary: ['lint'],
          validFrom: '2026-10-01T00:00:00.000Z',
          validTo: null,
          expiresAt: null,
          version: 2,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      4,
    )

    const snap = await readLegacySpaceExport(packed, 'ABC-passphrase-123')
    expect(snap.mode).toBe('space-export')
    expect(snap.spaces[0]?.name).toBe('工作空间')
    expect(snap.apps).toHaveLength(1)
    expect(snap.memories).toHaveLength(1)
    expect(snap.memories[0]?.uri).toBe('app://claudecode/rules/lint')
    expect(snap.memories[0]?.glossary).toEqual(['lint'])
  })

  it('口令错误、伪造头部或误传全实例备份/新版记忆圈导出包时明确报错', async () => {
    const valid = await packLegacySpaceExport('correct-pass', [])
    await expect(readLegacySpaceExport(valid, 'wrong-pass')).rejects.toThrow('口令错误')
    await expect(readLegacySpaceExport(Buffer.from('KIOKUBK1rest'), 'x')).rejects.toThrow(
      '--backup',
    )
    await expect(readLegacySpaceExport(Buffer.from('KIOKUCX2rest'), 'x')).rejects.toThrow(
      '新版记忆圈',
    )
    await expect(readLegacySpaceExport(Buffer.from('NOTKIOKU'), 'x')).rejects.toThrow('不是旧版')
  })

  it('readLegacyInstanceBackup 能解码 bytea 十六进制并识别软删除与 api_keys，拒绝新版备份误入', async () => {
    const key = randomBytes(32)
    const { key: encKey, id: keyId } = encryptionKey(key)
    const accId = randomUUID()
    const spaceId = randomUUID()
    const memId = randomUUID()
    const delMemId = randomUUID()
    const sealed = encryptSecret(encKey, 'old secret payload', memId)

    const buf = await packLegacyBackup(key, [
      JSON.stringify(['accounts', null]),
      JSON.stringify({
        id: accId,
        username: 'alice',
        display_name: 'Alice',
        password_hash: 'scrypt:abc',
        is_admin: true,
        disabled_at: null,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['spaces', null]),
      JSON.stringify({
        id: spaceId,
        name: '家',
        extraction_monthly_tokens: 100000,
        extraction_daily_writes: 20,
        advanced: {},
        privacy: {},
        privacy_revision: 1,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['api_keys', null]),
      JSON.stringify({ id: randomUUID() }),
      JSON.stringify(['memories', spaceId]),
      JSON.stringify({
        id: memId,
        space_id: spaceId,
        form: 'curated',
        layer: 'user',
        sensitivity: 'secret',
        provenance: 'owner',
        origin_scope: 'global',
        owner_account_id: accId,
        persona_id: null,
        app_id: null,
        subject_id: null,
        conversation_id: null,
        domain: 'user',
        path: 'keys/router',
        title: '路由器密钥',
        content: null,
        ciphertext: `\\x${sealed.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealed.wrappedKey.toString('hex')}`,
        key_id: keyId,
        plaintext_ignored_hash: null,
        sensitive_revision: 0,
        sensitive_credential: false,
        sensitive_pii: false,
        sensitive_findings: [],
        priority: 2,
        disclosure: null,
        valid_from: '2026-10-01T00:00:00.000Z',
        valid_to: null,
        expires_at: null,
        version: 1,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: null,
      }),
      JSON.stringify({
        id: delMemId,
        space_id: spaceId,
        form: 'curated',
        layer: 'core',
        sensitivity: 'internal',
        provenance: 'owner',
        origin_scope: 'global',
        owner_account_id: null,
        persona_id: null,
        app_id: null,
        subject_id: null,
        conversation_id: null,
        domain: 'core',
        path: 'deleted',
        title: '已删',
        content: 'gone',
        ciphertext: null,
        wrapped_key: null,
        key_id: null,
        plaintext_ignored_hash: null,
        sensitive_revision: 0,
        sensitive_credential: false,
        sensitive_pii: false,
        sensitive_findings: [],
        priority: 2,
        disclosure: null,
        valid_from: '2026-10-01T00:00:00.000Z',
        valid_to: null,
        expires_at: null,
        version: 1,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: '2026-10-02T00:00:00.000Z',
      }),
    ])

    const snap = readLegacyInstanceBackup(buf, key)
    expect(snap.mode).toBe('instance')
    expect(snap.accounts).toHaveLength(1)
    expect(snap.skippedApiKeys).toBe(1)
    expect(snap.skippedDeletedMemories).toBe(1)
    expect(snap.memories).toHaveLength(1)
    expect(snap.memories[0]?.ciphertext).toEqual(sealed.ciphertext)

    const currentVersionBackup = await packLegacyBackup(key, [], 2)
    expect(() => readLegacyInstanceBackup(currentVersionBackup, key)).toThrow('restore')
  })
})
