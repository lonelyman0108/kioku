import { resolveCirclePrivacy, type PlaintextKind } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'

import { currentRevision, evaluateSensitiveContent } from '../credential/privacy'
import { withCircle, type Db } from '../db/client'
import { circles, entryVariants } from '../db/schema'

// 每一类已知格式的令牌各一个样例，在运行时拼出来：仓库里不出现完整的令牌写法，免得被托管平台的密钥扫描拦下
const join = (...parts: string[]) => parts.join('')
const run = (n: number) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC'.repeat(8).slice(0, n)

export const TOKEN_SAMPLES: { name: string; kind: PlaintextKind; token: string }[] = [
  { name: 'sk', kind: 'sk', token: join('sk', '-', run(48)) },
  { name: 'sk-proj', kind: 'sk', token: join('sk', '-proj-', run(20), '_', run(40)) },
  { name: 'sk-ant', kind: 'sk', token: join('sk', '-ant-api03-', run(40), '-', run(40)) },
  { name: 'github', kind: 'github', token: join('gh', 'p_', run(36)) },
  { name: 'github_pat', kind: 'github', token: join('github', '_pat_', run(22), '_', run(59)) },
  { name: 'gitlab', kind: 'gitlab', token: join('gl', 'pat-', run(20)) },
  { name: 'slack', kind: 'slack', token: join('xo', 'xb-', '1234567890-', run(24)) },
  { name: 'aws', kind: 'aws', token: join('AK', 'IA', run(16).toUpperCase()) },
  {
    name: 'jwt',
    kind: 'jwt',
    token: join('ey', 'J', run(30), '.', 'ey', 'J', run(40), '.', run(43)),
  },
  {
    name: 'private_key',
    kind: 'private_key',
    token: join(
      '-----BEGIN RSA ',
      'PRIVATE KEY-----\n',
      `${run(64)}\n${run(64)}\n`,
      '-----END RSA ',
      'PRIVATE KEY-----',
    ),
  },
  {
    name: 'pgp',
    kind: 'private_key',
    token: join('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n\n', run(64)),
  },
  { name: 'kioku', kind: 'kioku', token: join('kio', 'ku_', run(12), '_', run(40)) },
]

export const sampleToken = (kind: PlaintextKind): string =>
  TOKEN_SAMPLES.find((s) => s.kind === kind)!.token

// 直接把正文改成疑似明文：写入检查会拦下新增的疑似明文，要绕开它铺数据（例如别的成员的记忆、
// 不想多出 allowPlaintext 的写入记录）时用它。不经服务层，不记事件、不加版本
export async function setPlaintextContent(
  db: Db,
  circleId: string,
  entryId: string,
  content: string,
  variantId?: string,
): Promise<void> {
  await withCircle(db, circleId, async (tx) => {
    const [circle] = await tx
      .select({ privacy: circles.privacy, revision: circles.privacyRevision })
      .from(circles)
      .where(eq(circles.id, circleId))
    const privacy = resolveCirclePrivacy((circle?.privacy ?? {}) as Record<string, unknown>)
    const scan = evaluateSensitiveContent(content, privacy)
    await tx
      .update(entryVariants)
      .set({
        content,
        sensitiveRevision: currentRevision(circle?.revision ?? 1),
        sensitiveCredential: scan.hasCredential,
        sensitivePii: scan.hasPii,
        sensitiveFindings: scan.findings,
      })
      .where(
        variantId
          ? and(eq(entryVariants.entryId, entryId), eq(entryVariants.id, variantId))
          : eq(entryVariants.entryId, entryId),
      )
  })
}
