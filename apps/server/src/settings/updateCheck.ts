import type { UpdateCheckView, UpdateNotice } from '@kioku/contracts'
import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

import { errorText, logInternalError, type Db, type Tx } from '../db/client'
import { settings } from '../db/schema'
import { VERSION } from '../version'
import { fetchFailure, upstreamJson } from './endpoint'

// 检查新版本：实例设置里的开关，默认关闭（自托管服务默认不向第三方发请求）。打开后每天最多向 GitHub 请求一次最新的正式版，
// 结果存在实例设置里，系统信息与概览的系统提醒读它

const REPO = 'lonelyman0108/kioku'
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = (tag: string) =>
  `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`
const ENABLED_KEY = 'update-check'
const STATE_KEY = 'update-check-state'
// 请求 GitHub 最多等这么久
const FETCH_TIMEOUT_MS = 10_000

const Enabled = z.object({ enabled: z.boolean() })
// 只认这几项；latest 为 null 是还没有正式版
const State = z.object({
  attemptedAt: z.string(),
  checkedAt: z.string().nullable().catch(null),
  failed: z.boolean().catch(false),
  latest: z.object({ version: z.string(), url: z.string() }).nullable().catch(null),
})
type State = z.infer<typeof State>

// /releases/latest 本来就只给正式版（不含预发布与草稿），这里再核对一遍
const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
})

// 正式版的版本号：X.Y.Z，前面可以带 v。别的（dev、edge、git describe 的结果、预发布）为 null
export function releaseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

// latest 比 current 新。两边有一个不是正式版就不算
export function isNewerRelease(latest: string, current: string): boolean {
  const a = releaseVersion(latest)
  const b = releaseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

async function load(db: Db | Tx): Promise<{ enabled: boolean; state: State | null }> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [ENABLED_KEY, STATE_KEY]))
  const enabled = Enabled.safeParse(rows.find((r) => r.key === ENABLED_KEY)?.value)
  const state = State.safeParse(rows.find((r) => r.key === STATE_KEY)?.value)
  return {
    enabled: enabled.success && enabled.data.enabled,
    state: state.success ? state.data : null,
  }
}

export async function saveUpdateCheck(tx: Tx, enabled: boolean): Promise<void> {
  const value = { enabled }
  await tx
    .insert(settings)
    .values({ key: ENABLED_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

const noticeOf = (state: State | null, current: string): UpdateNotice | null =>
  state?.latest && isNewerRelease(state.latest.version, current) ? state.latest : null

export async function updateCheckView(db: Db, current: string = VERSION): Promise<UpdateCheckView> {
  const { enabled, state } = await load(db)
  return {
    enabled,
    applicable: releaseVersion(current) !== null,
    checkedAt: state?.checkedAt ?? null,
    failed: state?.failed ?? false,
    latest: state?.latest?.version ?? null,
    available: enabled ? noticeOf(state, current) : null,
  }
}

// 概览的系统提醒：开着、有新的正式版时给出 notice
export async function updateNotice(
  db: Db,
  current: string = VERSION,
): Promise<{ enabled: boolean; notice: UpdateNotice | null }> {
  const { enabled, state } = await load(db)
  return { enabled, notice: enabled ? noticeOf(state, current) : null }
}

// 占下今天的这一次：上一次请求（不管成没成）在一天以内时占不到。在数据库里判断，几个进程同时来也只有一个占得到
async function claim(db: Db): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into ${settings} (key, value)
    values (${STATE_KEY}, jsonb_build_object('attemptedAt', now()))
    on conflict (key) do update
      set value = ${settings.value} || jsonb_build_object('attemptedAt', now()), updated_at = now()
      where (${settings.value} ->> 'attemptedAt') is null
        or (${settings.value} ->> 'attemptedAt')::timestamptz < now() - interval '1 day'
    returning key`)
  return rows.length > 0
}

async function record(db: Db, result: Pick<State, 'failed' | 'latest'>): Promise<void> {
  const patch = { checkedAt: new Date().toISOString(), ...result }
  await db.execute(sql`
    update ${settings} set value = ${settings.value} || ${JSON.stringify(patch)}::jsonb, updated_at = now()
    where key = ${STATE_KEY}`)
}

// 向 GitHub 取最新的正式版。还没有正式版时（404）为 null；别的失败抛出，文字只有类别，不带响应正文
async function fetchLatest(fetcher: typeof fetch): Promise<UpdateNotice | null> {
  // 不把原来的错误放进 cause：cause 会进日志（见 fetchFailure）
  const res = await fetcher(LATEST_RELEASE, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kioku' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new Error(fetchFailure('GitHub', err, '服务器能否访问 api.github.com'))
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`)
  const release = Release.safeParse(await upstreamJson(res, 'GitHub'))
  if (!release.success) throw new Error('GitHub 的响应格式无法识别')
  const { tag_name: tag, draft, prerelease } = release.data
  if (draft || prerelease || !releaseVersion(tag)) return null
  return { version: tag.replace(/^v/, ''), url: RELEASE_PAGE(tag) }
}

// 开着、当前是正式版、今天还没请求过时请求一次。失败只记日志，不抛出：不影响页面
export async function refreshUpdateCheck(
  db: Db,
  options: { current?: string | undefined; fetch?: typeof fetch | undefined } = {},
): Promise<void> {
  const current = options.current ?? VERSION
  try {
    if (!releaseVersion(current)) return
    if (!(await load(db)).enabled) return
    if (!(await claim(db))) return
    try {
      await record(db, { failed: false, latest: await fetchLatest(options.fetch ?? fetch) })
    } catch (err) {
      // 只有这里自己写的文字（fetchFailure 只取错误类别），不打原来的错误
      console.warn('检查新版本失败：', errorText(err))
      await record(db, { failed: true, latest: (await load(db)).state?.latest ?? null })
    }
  } catch (err) {
    logInternalError('检查新版本出错', err)
  }
}
