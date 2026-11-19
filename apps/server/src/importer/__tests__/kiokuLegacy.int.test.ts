import { createCipheriv, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import { CreateCredentialRequest } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { sealBackup } from '../../backup/format'
import { credentialServiceForConsole } from '../../credential/context'
import { decryptSecret, encryptSecret } from '../../crypto/envelope'
import { decryptionKey, encryptionKey } from '../../crypto/keyring'
import { prepareMasterKey } from '../../crypto/rotation'
import { connect, withCircles, type Database } from '../../db/client'
import {
  circleMembers,
  circles,
  clientGroupRules,
  clients,
  credentials,
  entryVariants,
  facetTerms,
  personaTraits,
  settings,
  subjects,
  vaultConnections,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { entryServiceForConsole } from '../../memory/context'
import { loadModelRegistryView } from '../../models/store'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import {
  applyLegacyMigration,
  planLegacyMigration,
  readLegacyDatabase,
  readLegacyInstanceBackup,
  readLegacySpaceExport,
} from '../kiokuLegacy'

const scryptAsync = promisify(
  (
    pw: string,
    salt: Buffer,
    keylen: number,
    opts: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, k: Buffer) => void,
  ) => scrypt(pw, salt, keylen, opts, cb),
)

async function buildSpaceExportBuffer(passphrase: string, records: object[]): Promise<Buffer> {
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
    version: 6,
    createdAt: '2026-10-01T00:00:00.000Z',
    kioku: '0.5.0',
    exporter: { displayName: 'Alice', dreamPrivate: false },
    space: {
      name: '旧工作室',
      extractionMonthlyTokens: 800000,
      extractionDailyWrites: 30,
      advanced: { 'recall.limit': 10 },
      privacy: {},
    },
  }
  const plain = `${[headerLine, ...records].map((r) => JSON.stringify(r)).join('\n')}\n`
  const compressed = gzipSync(Buffer.from(plain, 'utf8'))
  const cipher = createCipheriv('aes-256-gcm', derived.subarray(0, 32), iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(compressed), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

async function buildLegacyBackupBuffer(masterKey: Buffer, lines: string[]): Promise<Buffer> {
  const header = JSON.stringify({
    format: 'kioku-backup',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    kioku: '0.5.0',
    migrations: { hash: 'oldhash', at: 1700000000000 },
  })
  async function* src() {
    yield `${header}\n`
    for (const l of lines) yield `${l}\n`
  }
  const chunks: Buffer[] = []
  for await (const c of sealBackup(masterKey, src())) chunks.push(c)
  return Buffer.concat(chunks)
}

function appendSchemaSearchPath(url: string, schema: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set('options', `-c search_path=${schema}`)
  return parsed.toString()
}

describe.skipIf(!testDatabaseUrl)('旧版 Kioku 双形态迁移集成测试', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  const targetMasterKey = randomBytes(32)
  const legacyMasterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: targetMasterKey,
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
  })

  it('KIOKUSX1 空间导出迁入已有实例：个人/共享分流、已有凭据冲突改名与占位符重写、persona trait 与机密安全转移', async () => {
    const ws: Workspace = await bootstrap(app)

    // 先在 alice 个人圈建一条同名下划线凭据 nas_cred，验证通过 RLS 查出冲突并保留下划线重命名
    const credSvc = await credentialServiceForConsole(
      {
        db: database.db,
        masterKey: targetMasterKey,
        cookieSecure: false,
        embedder: staticEmbedderSource(null),
        jobs: null,
      },
      ws.personalCircleId,
      ws.accountId,
    )
    await credSvc.create(
      CreateCredentialRequest.parse({
        identifier: 'nas_cred',
        name: '已有 NAS',
        source: { kind: 'new', values: { password: 'existing-secret-password' } },
      }),
    )

    const parentPersonaId = randomUUID()
    const childPersonaId = randomUUID()
    const appId = randomUUID()
    const groupSubjectId = randomUUID()
    const personSubjectId = randomUUID()
    const vaultConnId = randomUUID()

    const buf = await buildSpaceExportBuffer('export-pass-99', [
      {
        type: 'persona',
        id: parentPersonaId,
        slug: 'base-bot',
        name: '基础人格',
        extendsId: null,
        description: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'persona',
        id: childPersonaId,
        slug: 'work-bot',
        name: '工作人格',
        extendsId: parentPersonaId,
        description: '继承基础人格',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'app',
        id: appId,
        slug: 'mac-claude',
        name: 'Mac Claude',
        runtimeFamily: 'claudecode',
        defaultPersonaId: childPersonaId,
        config: { elevateOwnerDirect: 'internal' },
        advanced: { 'recall.limit': 12 },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'subject',
        id: groupSubjectId,
        kind: 'group',
        displayName: '研发群',
        nameLocked: false,
        linkedToExporter: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'subject',
        id: personSubjectId,
        kind: 'person',
        displayName: '导出人本人',
        nameLocked: true,
        linkedToExporter: true,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'groupPersona',
        appId,
        subjectId: groupSubjectId,
        personaId: parentPersonaId,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'vault_connection',
        id: vaultConnId,
        serverUrl: 'https://vault.example.com',
        email: 'alice@example.com',
        vaultUserId: 'vu-1',
        destination: {
          collectionId: 'col-1',
          organizationId: 'org-1',
          collectionName: '研发库',
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'credential',
        id: randomUUID(),
        identifier: 'nas_cred',
        name: '新导出 NAS',
        description: null,
        source: { kind: 'hosted', values: { password: 'imported-nas-password' } },
        appIds: [appId],
        expiresAt: null,
        rotationRequestedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'memory',
        id: randomUUID(),
        form: 'curated',
        layer: 'persona',
        sensitivity: 'internal',
        provenance: 'owner',
        originScope: 'global',
        personaId: parentPersonaId,
        appId: null,
        subjectId: null,
        uri: 'persona://base-bot/tone_style',
        title: '说话风格',
        content: '言简意赅',
        priority: 0,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'memory',
        id: randomUUID(),
        form: 'curated',
        layer: 'persona',
        sensitivity: 'secret',
        provenance: 'owner',
        originScope: 'global',
        personaId: childPersonaId,
        appId: null,
        subjectId: null,
        uri: 'persona://work-bot/secret_token',
        title: '私密指令口令',
        content: 'top-secret-persona-line',
        priority: 1,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'memory',
        id: randomUUID(),
        form: 'curated',
        layer: 'user',
        sensitivity: 'private',
        provenance: 'owner',
        originScope: 'global',
        personaId: null,
        appId: null,
        subjectId: null,
        uri: 'user://infra/home/nas',
        title: null,
        content: '# 家庭 NAS\n登录密码：{{cred:nas_cred#password}}',
        priority: 1,
        disclosure: null,
        glossary: ['NAS'],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
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
        uri: 'core://network/dns',
        title: null,
        content: '# 内网 DNS\n10.0.0.1',
        priority: 0,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'memory',
        id: randomUUID(),
        form: 'curated',
        layer: 'app',
        sensitivity: 'internal',
        provenance: 'owner',
        originScope: 'global',
        personaId: null,
        appId,
        subjectId: null,
        uri: 'app://mac-claude/workflow/deploy',
        title: null,
        content: '# 部署流程\npnpm build',
        priority: 1,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        type: 'memory',
        id: randomUUID(),
        form: 'extracted',
        layer: 'subject',
        sensitivity: 'public',
        provenance: 'agent',
        originScope: `group:${groupSubjectId}`,
        personaId: null,
        appId,
        subjectId: personSubjectId,
        uri: null,
        title: null,
        content: '喜欢用 TypeScript',
        priority: 2,
        disclosure: null,
        glossary: [],
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: null,
        expiresAt: null,
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ])

    const snap = await readLegacySpaceExport(buf, 'export-pass-99')
    const plan = await planLegacyMigration(database.db, snap, {
      targetMasterKey,
      accountUsername: 'alice',
    })
    expect(plan.warnings.some((w) => w.includes('nas_cred-2'))).toBe(true)
    expect(plan.warnings.some((w) => w.includes('persona://work-bot/secret_token'))).toBe(true)

    const result = await applyLegacyMigration(database.db, plan, { targetMasterKey })
    expect(result.summary.sharedCircles).toHaveLength(1)
    const newCircleId = result.summary.sharedCircles[0]!.id
    expect(result.summary.personaTraits).toBe(1)
    expect(result.summary.entries.entry).toBe(4) // 1 persona secret -> entry + user + core + app
    expect(result.summary.entries.fact).toBe(1)

    // 校验共享圈内 legacy_uris 检索、app runtime 切面、trait、接入实例与跨群重映射
    const sharedSvc = await entryServiceForConsole(
      { db: database.db, masterKey: targetMasterKey, jobs: null },
      newCircleId,
      ws.accountId,
    )
    const dnsEntry = await sharedSvc.get({ id: 'core://network/dns' })
    expect(dnsEntry.topics).toEqual(['network'])
    expect(dnsEntry.variants[0]?.content).toContain('10.0.0.1')

    const appEntry = await sharedSvc.get({ id: 'app://mac-claude/workflow/deploy' })
    expect(appEntry.topics).toEqual(['workflow'])
    expect(appEntry.variants[0]?.when).toEqual({ runtime: ['claudecode'] })

    const personalSvc = await entryServiceForConsole(
      { db: database.db, masterKey: targetMasterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    const userEntry = await personalSvc.get({ id: 'user://infra/home/nas' })
    expect(userEntry.topics).toEqual(['infra', 'home'])
    expect(userEntry.variants[0]?.content).toContain('{{cred:nas_cred-2#password}}')

    // persona secret 已转移至个人圈并信封加密（管理服务默认隐藏明文，直查切片密文解密核对）
    const personaSecret = await personalSvc.get({ id: 'persona://work-bot/secret_token' })
    expect(personaSecret.sensitivity).toBe('secret')
    expect(personaSecret.variants[0]?.content).toBeNull()

    await withCircles(
      database.db,
      { read: [newCircleId, ws.personalCircleId] },
      async (tx) => {
        const [secretVar] = await tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, personaSecret.id))
        expect(
          decryptSecret(
            decryptionKey(targetMasterKey, secretVar!.keyId),
            { ciphertext: secretVar!.ciphertext!, wrappedKey: secretVar!.wrappedKey! },
            `variant:${secretVar!.id}`,
          ),
        ).toBe('top-secret-persona-line')

        const traits = await tx.select().from(personaTraits)
        expect(traits[0]?.traitKey).toBe('tone_style')

        const terms = await tx.select().from(facetTerms)
        expect(terms.some((t) => t.dimensionKey === 'runtime' && t.slug === 'claudecode')).toBe(
          true,
        )

        const cls = await tx.select().from(clients)
        expect(cls[0]?.slug).toBe('mac-claude')
        expect(cls[0]?.runtimeFamily).toBe('claudecode')

        const rules = await tx.select().from(clientGroupRules)
        expect(rules).toHaveLength(1)

        const conns = await tx.select().from(vaultConnections)
        expect(conns[0]?.status).toBe('disconnected')

        const subjs = await tx.select().from(subjects).where(eq(subjects.kind, 'person'))
        expect(subjs[0]?.accountId).toBe(ws.accountId)

        const creds = await tx.select().from(credentials)
        expect(creds.map((c) => c.identifier).sort()).toEqual(['nas_cred', 'nas_cred-2'])
      },
      { accessMode: 'read only' },
    )

    await expect(prepareMasterKey(database.db, targetMasterKey)).resolves.toBeUndefined()
  })

  it('KIOKUBK1 全实例备份迁入空库并支持跨主密钥重封、跨空间个人凭据/连接去重与旧设置升级', async () => {
    await database.db.execute(sql`truncate circles, accounts, login_attempts, settings cascade`)

    const { key: oldKey, id: oldKeyId } = encryptionKey(legacyMasterKey)
    const aliceId = randomUUID()
    const space1Id = randomUUID()
    const space2Id = randomUUID()
    const app1Id = randomUUID()
    const conv1Id = randomUUID()
    const vault1Id = randomUUID()
    const vault2Id = randomUUID()
    const cred1Id = randomUUID()
    const cred2Id = randomUUID()
    const secretMemId = randomUUID()
    const episodeId = randomUUID()
    const userMem2Id = randomUUID()

    const sealedSecretMem = encryptSecret(oldKey, 'super-secret-alice-note', secretMemId)
    const sealedCred1 = encryptSecret(
      oldKey,
      JSON.stringify({ token: 'tok-from-space1' }),
      `credential:${cred1Id}`,
    )
    const sealedCred2 = encryptSecret(
      oldKey,
      JSON.stringify({ token: 'tok-from-space2' }),
      `credential:${cred2Id}`,
    )
    const sealedVault1 = encryptSecret(
      oldKey,
      JSON.stringify({
        refreshToken: 'rt-1',
        userKey: Buffer.from('user-key-1').toString('base64'),
      }),
      `vault-connection:${vault1Id}`,
    )
    const sealedVault2 = encryptSecret(
      oldKey,
      JSON.stringify({
        refreshToken: 'rt-2',
        userKey: Buffer.from('user-key-2').toString('base64'),
      }),
      `vault-connection:${vault2Id}`,
    )
    const sealedApiKey = encryptSecret(oldKey, 'sk-legacy-extraction-secret', 'settings:extraction')

    const backupBuf = await buildLegacyBackupBuffer(legacyMasterKey, [
      JSON.stringify(['accounts', null]),
      JSON.stringify({
        id: aliceId,
        username: 'alice',
        display_name: 'Alice',
        password_hash: 'scrypt:alice-hash',
        is_admin: true,
        disabled_at: null,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['spaces', null]),
      JSON.stringify({
        id: space1Id,
        name: '空间一',
        extraction_monthly_tokens: 100000,
        extraction_daily_writes: 20,
        advanced: {},
        privacy: {},
        privacy_revision: 1,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify({
        id: space2Id,
        name: '空间二',
        extraction_monthly_tokens: 100000,
        extraction_daily_writes: 20,
        advanced: {},
        privacy: {},
        privacy_revision: 1,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['space_members', null]),
      JSON.stringify({
        space_id: space1Id,
        account_id: aliceId,
        role: 'owner',
        dream_private: true,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify({
        space_id: space2Id,
        account_id: aliceId,
        role: 'owner',
        dream_private: false,
        created_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['settings', null]),
      JSON.stringify({
        key: 'extraction',
        value: {
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-test',
          apiKey: {
            ciphertext: sealedApiKey.ciphertext.toString('base64'),
            wrappedKey: sealedApiKey.wrappedKey.toString('base64'),
            keyId: oldKeyId,
          },
        },
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify({
        key: 'space-limit',
        value: { maxOwnedSpaces: 9 },
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify({
        key: 'backup',
        value: { endpoint: 'https://s3.example.com', bucket: 'old-bucket' },
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['apps', space1Id]),
      JSON.stringify({
        id: app1Id,
        space_id: space1Id,
        slug: 'cc-main',
        name: 'CC 主力',
        runtime_family: 'claudecode',
        owner_account_id: aliceId,
        default_persona_id: null,
        config: {},
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['conversations', space1Id]),
      JSON.stringify({
        id: conv1Id,
        space_id: space1Id,
        app_id: app1Id,
        kind: 'none',
        subject_id: null,
        owner_account_id: aliceId,
        created_at: '2026-10-01T00:00:00.000Z',
        last_active_at: '2026-10-02T00:00:00.000Z',
      }),
      JSON.stringify(['vault_connections', space1Id]),
      JSON.stringify({
        id: vault1Id,
        space_id: space1Id,
        owner_account_id: aliceId,
        server_url: 'https://vault.example.com',
        email: 'alice@example.com',
        vault_user_id: 'vu-dup',
        device_id: randomUUID(),
        ciphertext: `\\x${sealedVault1.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealedVault1.wrappedKey.toString('hex')}`,
        key_id: oldKeyId,
        status: 'ok',
        disabled_reason: null,
        last_error_kind: null,
        last_error_at: null,
        last_checked_at: null,
        default_collection_id: 'col-a',
        default_organization_id: 'org-a',
        default_collection_name: 'A 集合',
        disconnected_at: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
      }),
      JSON.stringify(['vault_connections', space2Id]),
      JSON.stringify({
        id: vault2Id,
        space_id: space2Id,
        owner_account_id: aliceId,
        server_url: 'https://vault.example.com',
        email: 'alice@example.com',
        vault_user_id: 'vu-dup',
        device_id: randomUUID(),
        ciphertext: `\\x${sealedVault2.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealedVault2.wrappedKey.toString('hex')}`,
        key_id: oldKeyId,
        status: 'ok',
        disabled_reason: null,
        last_error_kind: null,
        last_error_at: null,
        last_checked_at: null,
        default_collection_id: 'col-b',
        default_organization_id: 'org-b',
        default_collection_name: 'B 集合',
        disconnected_at: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
      JSON.stringify(['credentials', space1Id]),
      JSON.stringify({
        id: cred1Id,
        space_id: space1Id,
        owner_account_id: aliceId,
        identifier: 'api_tok',
        name: '令牌 1',
        description: null,
        source: 'hosted',
        vault_connection_id: null,
        vault_item_id: null,
        fields: [{ name: 'token', itemField: null }],
        ciphertext: `\\x${sealedCred1.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealedCred1.wrappedKey.toString('hex')}`,
        key_id: oldKeyId,
        app_ids: null,
        version: 1,
        expires_at: null,
        rotation_requested_at: null,
        value_version: 1,
        value_changed_at: '2026-10-01T00:00:00.000Z',
        vault_revision: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: null,
      }),
      JSON.stringify(['credentials', space2Id]),
      JSON.stringify({
        id: cred2Id,
        space_id: space2Id,
        owner_account_id: aliceId,
        identifier: 'api_tok',
        name: '令牌 2',
        description: null,
        source: 'hosted',
        vault_connection_id: null,
        vault_item_id: null,
        fields: [{ name: 'token', itemField: null }],
        ciphertext: `\\x${sealedCred2.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealedCred2.wrappedKey.toString('hex')}`,
        key_id: oldKeyId,
        app_ids: null,
        version: 1,
        expires_at: null,
        rotation_requested_at: null,
        value_version: 1,
        value_changed_at: '2026-10-01T00:00:00.000Z',
        vault_revision: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: null,
      }),
      JSON.stringify(['memories', space1Id]),
      JSON.stringify({
        id: secretMemId,
        space_id: space1Id,
        form: 'curated',
        layer: 'user',
        sensitivity: 'secret',
        provenance: 'owner',
        origin_scope: 'global',
        owner_account_id: aliceId,
        persona_id: null,
        app_id: null,
        subject_id: null,
        conversation_id: null,
        domain: 'user',
        path: 'secrets/bank',
        title: '银行卡',
        content: null,
        ciphertext: `\\x${sealedSecretMem.ciphertext.toString('hex')}`,
        wrapped_key: `\\x${sealedSecretMem.wrappedKey.toString('hex')}`,
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
      }),
      JSON.stringify({
        id: episodeId,
        space_id: space1Id,
        form: 'extracted',
        layer: 'episode',
        sensitivity: 'internal',
        provenance: 'agent',
        origin_scope: `app:${app1Id}`,
        owner_account_id: aliceId,
        persona_id: null,
        app_id: null,
        subject_id: null,
        conversation_id: conv1Id,
        domain: null,
        path: null,
        title: null,
        content: '用户今天配置了路由器',
        ciphertext: null,
        wrapped_key: null,
        key_id: null,
        plaintext_ignored_hash: null,
        sensitive_revision: 0,
        sensitive_credential: false,
        sensitive_pii: false,
        sensitive_findings: [],
        priority: 0,
        disclosure: null,
        valid_from: '2026-10-01T00:00:00.000Z',
        valid_to: null,
        expires_at: null,
        version: 1,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: null,
      }),
      JSON.stringify(['memories', space2Id]),
      JSON.stringify({
        id: userMem2Id,
        space_id: space2Id,
        form: 'curated',
        layer: 'user',
        sensitivity: 'private',
        provenance: 'owner',
        origin_scope: 'global',
        owner_account_id: aliceId,
        persona_id: null,
        app_id: null,
        subject_id: null,
        conversation_id: null,
        domain: 'user',
        path: 'tokens/space2',
        title: null,
        content: '# 空间二令牌\n使用 {{cred:api_tok#token}}',
        ciphertext: null,
        wrapped_key: null,
        key_id: null,
        plaintext_ignored_hash: null,
        sensitive_revision: 0,
        sensitive_credential: false,
        sensitive_pii: false,
        sensitive_findings: [],
        priority: 1,
        disclosure: null,
        valid_from: '2026-10-01T00:00:00.000Z',
        valid_to: null,
        expires_at: null,
        version: 1,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        deleted_at: null,
      }),
    ])

    const snap = readLegacyInstanceBackup(backupBuf, legacyMasterKey)
    const plan = await planLegacyMigration(database.db, snap, {
      legacyMasterKey,
      targetMasterKey,
    })
    expect(plan.warnings.some((w) => w.includes('backup'))).toBe(true)
    expect(plan.warnings.some((w) => w.includes('api_tok-2'))).toBe(true)
    expect(plan.summary.vaultConnections).toBe(1)

    const result = await applyLegacyMigration(database.db, plan, { targetMasterKey })
    expect(result.summary.accounts).toBe(1)
    expect(result.summary.sharedCircles).toHaveLength(2)

    await expect(prepareMasterKey(database.db, targetMasterKey)).resolves.toBeUndefined()

    // 验证旧设置被重封并迁移成 model-providers / model-bindings，space-limit 变为 circle-limit，backup 未写回
    const registry = await loadModelRegistryView(database.db)
    expect(registry.providers).toHaveLength(1)
    expect(registry.providers[0]?.hasApiKey).toBe(true)

    const [limitRow] = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'circle-limit'))
    expect(limitRow?.value).toEqual({ maxOwnedCircles: 9 })
    const [backupRow] = await database.db.select().from(settings).where(eq(settings.key, 'backup'))
    expect(backupRow).toBeUndefined()

    const [personal] = await database.db.select().from(circles).where(eq(circles.kind, 'personal'))
    const personalId = personal!.id
    const sharedCircleIds = result.summary.sharedCircles.map((c) => c.id)

    await withCircles(
      database.db,
      { read: [personalId, ...sharedCircleIds] },
      async (tx) => {
        const variants = await tx.select().from(entryVariants)
        const secretVar = variants.find((v) => v.sensitivity === 'secret')!
        const opened = decryptSecret(
          decryptionKey(targetMasterKey, secretVar.keyId),
          { ciphertext: secretVar.ciphertext!, wrappedKey: secretVar.wrappedKey! },
          `variant:${secretVar.id}`,
        )
        expect(opened).toBe('super-secret-alice-note')

        const user2 = variants.find((v) => v.content?.includes('api_tok-2'))
        expect(user2).toBeDefined()

        const epEntry = await tx.query.entries.findFirst({
          where: (e, { eq: eqCol }) => eqCol(e.kind, 'episode'),
        })
        expect(epEntry?.priority).toBe(1)
        expect(epEntry?.originScope.startsWith('client:')).toBe(true)
        expect(epEntry?.ownerAccountId).toBe(aliceId)
      },
      { accessMode: 'read only' },
    )

    // 再次在已初始化实例执行 instance 规划必须被拒绝
    await expect(
      planLegacyMigration(database.db, snap, { legacyMasterKey, targetMasterKey }),
    ).rejects.toThrow('已经初始化')
  })

  it('readLegacyDatabase 能从真实 PostgreSQL 旧版结构只读抽出并迁入空目标库', async () => {
    await database.db.execute(sql`truncate circles, accounts, login_attempts, settings cascade`)

    const schema = `legacy_src_${randomUUID().slice(0, 8).replace(/-/g, '')}`
    const accId = randomUUID()
    const spaceId = randomUUID()
    const memId = randomUUID()
    const rawSql = sql.raw
    const legacyDb = connect(appendSchemaSearchPath(testDatabaseUrl!, schema), { max: 2 })

    try {
      await database.db.execute(rawSql(`create schema "${schema}"`))
      await database.db.execute(
        rawSql(`
          create table "${schema}".accounts (
            id uuid primary key,
            username text not null unique,
            display_name text not null,
            password_hash text,
            is_admin boolean not null default false,
            disabled_at timestamptz,
            created_at timestamptz not null default now()
          );
          create table "${schema}".spaces (
            id uuid primary key,
            name text not null,
            extraction_monthly_tokens int not null default 1000000,
            extraction_daily_writes int not null default 50,
            advanced jsonb not null default '{}',
            privacy jsonb not null default '{}',
            privacy_revision int not null default 1,
            created_at timestamptz not null default now()
          );
          create table "${schema}".space_members (
            space_id uuid not null,
            account_id uuid not null,
            role text not null,
            dream_private boolean not null default true,
            created_at timestamptz not null default now()
          );
          create table "${schema}".settings (
            key text primary key,
            value jsonb not null,
            updated_at timestamptz not null default now()
          );
          create table "${schema}".api_keys (id uuid primary key);
          create table "${schema}".personas (id uuid primary key, space_id uuid, slug text, name text, extends_id uuid, description text, created_at timestamptz default now(), updated_at timestamptz default now());
          create table "${schema}".apps (id uuid primary key, space_id uuid, slug text, name text, runtime_family text, owner_account_id uuid, default_persona_id uuid, config jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now());
          create table "${schema}".app_group_personas (space_id uuid, app_id uuid, subject_id uuid, persona_id uuid, created_at timestamptz default now());
          create table "${schema}".subjects (id uuid primary key, space_id uuid, kind text, display_name text, name_locked boolean default false, account_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
          create table "${schema}".subject_identities (id uuid primary key, space_id uuid, subject_id uuid, kind text, platform text, external_id text, display_name text, created_at timestamptz default now());
          create table "${schema}".conversations (id uuid primary key, space_id uuid, app_id uuid, kind text, subject_id uuid, owner_account_id uuid, created_at timestamptz default now(), last_active_at timestamptz default now());
          create table "${schema}".vault_connections (id uuid primary key, space_id uuid, owner_account_id uuid, server_url text, email text, vault_user_id text, device_id uuid, ciphertext bytea, wrapped_key bytea, key_id text, status text, disabled_reason text, last_error_kind text, last_error_at timestamptz, last_checked_at timestamptz, default_collection_id text, default_organization_id text, default_collection_name text, disconnected_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
          create table "${schema}".credentials (id uuid primary key, space_id uuid, owner_account_id uuid, identifier text, name text, description text, source text, vault_connection_id uuid, vault_item_id text, fields jsonb default '[]', ciphertext bytea, wrapped_key bytea, key_id text, app_ids uuid[], version int default 1, expires_at timestamptz, rotation_requested_at timestamptz, value_version int default 1, value_changed_at timestamptz, vault_revision text, created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz);
          create table "${schema}".memory_glossary (space_id uuid, memory_id uuid, keyword text);
          create table "${schema}".memories (id uuid primary key, space_id uuid, form text, layer text, sensitivity text, provenance text, origin_scope text, owner_account_id uuid, persona_id uuid, app_id uuid, subject_id uuid, conversation_id uuid, domain text, path text, title text, content text, ciphertext bytea, wrapped_key bytea, key_id text, plaintext_ignored_hash text, sensitive_revision int default 0, sensitive_credential boolean default false, sensitive_pii boolean default false, sensitive_findings jsonb default '[]', priority int default 2, disclosure text, valid_from timestamptz default now(), valid_to timestamptz, expires_at timestamptz, version int default 1, created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz);
          alter table "${schema}".memories enable row level security;
          create policy p_mem on "${schema}".memories using (space_id = nullif(current_setting('app.space_id', true), '')::uuid);
          insert into "${schema}".accounts (id, username, display_name, is_admin) values ('${accId}', 'dbuser', 'DB User', true);
          insert into "${schema}".spaces (id, name) values ('${spaceId}', '原库空间');
          insert into "${schema}".space_members (space_id, account_id, role) values ('${spaceId}', '${accId}', 'owner');
          insert into "${schema}".api_keys (id) values ('${randomUUID()}');
          insert into "${schema}".memories (id, space_id, form, layer, sensitivity, provenance, origin_scope, domain, path, title, content)
            values ('${memId}', '${spaceId}', 'curated', 'core', 'internal', 'owner', 'global', 'core', 'guide/setup', '安装说明', '# 安装说明\n使用 Docker');
        `),
      )

      const snap = await readLegacyDatabase(appendSchemaSearchPath(testDatabaseUrl!, schema))
      expect(snap.accounts).toHaveLength(1)
      expect(snap.skippedApiKeys).toBe(1)
      expect(snap.memories).toHaveLength(1)

      const plan = await planLegacyMigration(database.db, snap, {
        legacyMasterKey: targetMasterKey,
        targetMasterKey,
      })
      const result = await applyLegacyMigration(database.db, plan, { targetMasterKey })
      expect(result.summary.entries.entry).toBe(1)

      const members = await database.db.select().from(circleMembers)
      expect(members.length).toBeGreaterThanOrEqual(2)
    } finally {
      await legacyDb.close()
      await database.db.execute(rawSql(`drop schema if exists "${schema}" cascade`))
    }
  })
})
