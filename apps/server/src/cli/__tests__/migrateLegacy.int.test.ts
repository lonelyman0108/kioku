import { spawn } from 'node:child_process'
import { createCipheriv, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { sealBackup } from '../../backup/format'
import { encryptSecret } from '../../crypto/envelope'
import { encryptionKey } from '../../crypto/keyring'
import type { Database } from '../../db/client'
import { circles, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { entryServiceForConsole } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))
const RUN_TIMEOUT = 20_000

const scryptAsync = promisify(
  (
    pw: string,
    salt: Buffer,
    keylen: number,
    opts: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, k: Buffer) => void,
  ) => scrypt(pw, salt, keylen, opts, cb),
)

async function runCommand(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/ctl.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c))
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c))
  const [code] = (await once(child, 'close')) as [number | null]
  return {
    code,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  }
}

async function createSampleSpaceExport(passphrase: string): Promise<Buffer> {
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
  const plain =
    [
      JSON.stringify({
        format: 'kioku-space-export',
        version: 6,
        createdAt: '2026-10-01T00:00:00.000Z',
        kioku: '0.5.0',
        exporter: { displayName: 'Alice', dreamPrivate: true },
        space: {
          name: 'CLI 导出空间',
          extractionMonthlyTokens: 500000,
          extractionDailyWrites: 30,
          advanced: {},
        },
      }),
      JSON.stringify({
        type: 'memory',
        id: randomUUID(),
        form: 'curated',
        layer: 'core',
        sensitivity: 'internal',
        provenance: 'owner',
        originScope: 'global',
        personaId: null,
        appId: null,
        subjectId: null,
        uri: 'core://cli/note',
        title: null,
        content: '# CLI 规则\n正文测试',
        priority: 0,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ].join('\n') + '\n'
  const cipher = createCipheriv('aes-256-gcm', derived.subarray(0, 32), iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(plain, 'utf8'))), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

describe.skipIf(!testDatabaseUrl)('旧版迁移命令行 migrate-legacy', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let tempDir: string
  const masterKey = randomBytes(32)
  const legacyKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    tempDir = await mkdtemp(join(tmpdir(), 'kioku-migrate-cli-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it(
    '支持帮助与参数校验（多来源冲突或缺少口令退出码 2），干跑 --json 不写库，--space-export --apply 正确入库',
    async () => {
      const ws: Workspace = await bootstrap(app)
      const exportSecretPass = 'top-secret-export-passphrase-value'
      const exportPath = join(tempDir, 'space.kioku')
      await writeFile(exportPath, await createSampleSpaceExport(exportSecretPass))

      const envBase = {
        DATABASE_URL: testDatabaseUrl,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      }

      const help = await runCommand(['migrate-legacy', '--help'], envBase)
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('--from-db')
      expect(help.stdout).toContain('--space-export')

      const conflict = await runCommand(
        ['migrate-legacy', '--backup', exportPath, '--space-export', exportPath],
        envBase,
      )
      expect(conflict.code).toBe(2)

      const noPass = await runCommand(
        ['migrate-legacy', '--space-export', exportPath, '--account', 'alice'],
        envBase,
      )
      expect(noPass.code).toBe(2)

      const dry = await runCommand(
        ['migrate-legacy', '--space-export', exportPath, '--account', 'alice', '--json'],
        { ...envBase, KIOKU_EXPORT_PASSPHRASE: exportSecretPass },
      )
      expect(dry.code).toBe(0)
      expect(dry.stdout).not.toContain(exportSecretPass)
      const dryJson = JSON.parse(dry.stdout) as {
        applied: boolean
        summary: { entries: { entry: number } }
      }
      expect(dryJson.applied).toBe(false)
      expect(dryJson.summary.entries.entry).toBe(1)

      // 干跑后库里还没有新共享圈 CLI 导出空间
      const beforeCircles = await database.db.select().from(circles)
      expect(beforeCircles.some((c) => c.name === 'CLI 导出空间')).toBe(false)

      const applied = await runCommand(
        [
          'migrate-legacy',
          '--space-export',
          exportPath,
          '--account',
          'alice',
          '--circle-name',
          '迁移后工作室',
          '--apply',
          '--json',
        ],
        { ...envBase, KIOKU_EXPORT_PASSPHRASE: exportSecretPass },
      )
      expect(applied.code).toBe(0)
      expect(applied.stdout).not.toContain(exportSecretPass)
      expect(applied.stderr).not.toContain(exportSecretPass)

      const afterCircles = await database.db.select().from(circles)
      const targetCircle = afterCircles.find((c) => c.name === '迁移后工作室')
      expect(targetCircle).toBeDefined()

      const svc = await entryServiceForConsole(
        { db: database.db, masterKey, jobs: null },
        targetCircle!.id,
        ws.accountId,
      )
      const note = await svc.get({ id: 'core://cli/note' })
      expect(note.title).toBe('CLI 规则')
    },
    RUN_TIMEOUT,
  )

  it(
    '支持 --backup 跨主密钥迁入空实例并在完成后通过 status 核对且不泄露明文密钥',
    async () => {
      await database.db.execute(sql`truncate circles, accounts, login_attempts, settings cascade`)

      const secretBody = 'never-leak-this-plaintext-secret-xyz'
      const { key: oldKey, id: oldKeyId } = encryptionKey(legacyKey)
      const accId = randomUUID()
      const spaceId = randomUUID()
      const memId = randomUUID()
      const sealed = encryptSecret(oldKey, secretBody, memId)

      async function* src() {
        yield `${JSON.stringify({
          format: 'kioku-backup',
          version: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          kioku: '0.5.0',
          migrations: { hash: 'old', at: 1700000000000 },
        })}\n`
        yield `${JSON.stringify(['accounts', null])}\n`
        yield `${JSON.stringify({
          id: accId,
          username: 'bob',
          display_name: 'Bob',
          password_hash: 'scrypt:bob',
          is_admin: true,
          disabled_at: null,
          created_at: '2026-10-01T00:00:00.000Z',
        })}\n`
        yield `${JSON.stringify(['spaces', null])}\n`
        yield `${JSON.stringify({
          id: spaceId,
          name: '家',
          extraction_monthly_tokens: 100000,
          extraction_daily_writes: 20,
          advanced: {},
          privacy: {},
          privacy_revision: 1,
          created_at: '2026-10-01T00:00:00.000Z',
        })}\n`
        yield `${JSON.stringify(['space_members', null])}\n`
        yield `${JSON.stringify({
          space_id: spaceId,
          account_id: accId,
          role: 'owner',
          dream_private: true,
          created_at: '2026-10-01T00:00:00.000Z',
        })}\n`
        yield `${JSON.stringify(['memories', spaceId])}\n`
        yield `${JSON.stringify({
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
          path: 'bank/pin',
          title: '密码',
          content: null,
          ciphertext: `\\x${sealed.ciphertext.toString('hex')}`,
          wrapped_key: `\\x${sealed.wrappedKey.toString('hex')}`,
          key_id: oldKeyId,
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
        })}\n`
      }

      const chunks: Buffer[] = []
      for await (const c of sealBackup(legacyKey, src())) chunks.push(c)
      const backupFile = join(tempDir, 'legacy.backup')
      await writeFile(backupFile, Buffer.concat(chunks))

      const env = {
        DATABASE_URL: testDatabaseUrl,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
        LEGACY_KIOKU_MASTER_KEY: legacyKey.toString('base64'),
      }

      const applied = await runCommand(['migrate-legacy', '--backup', backupFile, '--apply'], env)
      expect(applied.code).toBe(0)
      expect(applied.stdout).not.toContain(secretBody)
      expect(applied.stderr).not.toContain(secretBody)

      const status = await runCommand(['status'], {
        DATABASE_URL: testDatabaseUrl,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      })
      expect(status.code).toBe(0)
    },
    RUN_TIMEOUT,
  )
})
