import {
  isNewerRelease,
  releaseVersion,
  type UpdateCheckView,
  type UpdateNotice,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { errorText, logInternalError, type Db, type Tx } from '../db/client'
import { settings } from '../db/schema'
import { VERSION } from '../version'
import { fetchFailure, upstreamJson } from './endpoint'

// 检查新版本：实例设置里的开关，默认关闭（自托管服务默认不向第三方发请求）。打开后向 GitHub 请求最新的正式版：
// 上一次成功之后隔一天，失败或没有完成之后隔一小时；从关到开时马上可以再查。结果存在实例设置里，系统信息与概览读它

const REPO = 'lonelyman0108/kioku'
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = (tag: string) =>
  `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`
const ENABLED_KEY = 'update-check'
const STATE_KEY = 'update-check-state'
// 请求 GitHub 最多等这么久
const FETCH_TIMEOUT_MS = 10_000

const Enabled = z.object({ enabled: z.boolean() })
// 只认这几项。attemptedAt、checkedAt 由数据库的 now() 写下；latest 是已知的最新正式版，从未查到过时为 null
const State = z.object({
  attemptedAt: z.string().nullable().catch(null),
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

// 时间都按数据库的钟比：attemptedAt、checkedAt 是数据库写的
const attempted = sql`(${settings.value} ->> 'attemptedAt')::timestamptz`
const checked = sql`(${settings.value} ->> 'checkedAt')::timestamptz`
// 上一次尝试已经完成（成没成都算）
const completed = sql`(${checked} is not null and ${checked} >= ${attempted})`
const succeeded = sql`(${completed} and not coalesce((${settings.value} ->> 'failed')::boolean, false))`
// 该再查一次了：从未尝试过（或开关从关到开清掉了），上一次成功隔了一天，失败或没完成隔了一小时
const DUE = sql`(${attempted} is null or ${attempted} < now() - case when ${succeeded} then interval '1 day' else interval '1 hour' end)`
// 正在请求：尝试了、还没完成，并且在一分钟以内（请求最多 10 秒，更久的是服务中途停了）
const CHECKING = sql`(${attempted} is not null and not ${completed} and ${attempted} > now() - interval '1 minute')`

export interface UpdateStatus {
  enabled: boolean
  // 有没有结果那一行（claim 按它选插入还是更新）
  exists: boolean
  state: State | null
  due: boolean
  checking: boolean
}

export async function loadUpdateStatus(db: Db | Tx): Promise<UpdateStatus> {
  const rows = await db.execute<{
    key: string
    value: unknown
    due: boolean
    checking: boolean
  }>(sql`
    select key, value, ${DUE} as due, ${CHECKING} as checking
    from ${settings} where key in (${ENABLED_KEY}, ${STATE_KEY})`)
  const enabled = Enabled.safeParse(rows.find((r) => r.key === ENABLED_KEY)?.value)
  const row = rows.find((r) => r.key === STATE_KEY)
  const state = State.safeParse(row?.value)
  return {
    enabled: enabled.success && enabled.data.enabled,
    exists: row !== undefined,
    state: state.success ? state.data : null,
    due: row ? row.due : true,
    checking: row ? row.checking : false,
  }
}

// 打开或关闭。从关到开时清掉上一次尝试的时间：马上可以再查，不等间隔
export async function saveUpdateCheck(tx: Tx, enabled: boolean): Promise<void> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, ENABLED_KEY)).for('update')
  const was = Enabled.safeParse(row?.value)
  const value = { enabled }
  await tx
    .insert(settings)
    .values({ key: ENABLED_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  if (enabled && !(was.success && was.data.enabled)) {
    await tx.execute(sql`
      update ${settings} set value = ${settings.value} - 'attemptedAt', updated_at = now()
      where key = ${STATE_KEY}`)
  }
}

const noticeOf = (state: State | null, current: string): UpdateNotice | null =>
  state?.latest && isNewerRelease(state.latest.version, current) ? state.latest : null

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null)

export function updateCheckView(status: UpdateStatus, current: string = VERSION): UpdateCheckView {
  const { enabled, state, checking } = status
  const attemptedAt = iso(state?.attemptedAt ?? null)
  const checkedAt = iso(state?.checkedAt ?? null)
  // 上一次尝试没有完成、也不在请求中：服务中途停了，按失败显示
  const interrupted = attemptedAt !== null && !checking && (!checkedAt || checkedAt < attemptedAt)
  return {
    enabled,
    applicable: releaseVersion(current) !== null,
    checking: enabled && checking,
    checkedAt,
    attemptedAt,
    failed: Boolean(state?.failed) || interrupted,
    latest: state?.latest?.version ?? null,
    available: enabled ? noticeOf(state, current) : null,
  }
}

// 概览的系统提醒：开着、有新的正式版时给出
export const updateNotice = (status: UpdateStatus, current: string = VERSION) =>
  status.enabled ? noticeOf(status.state, current) : null

// 占下这一次：到了间隔才占得到。在数据库里判断，几个进程同时来也只有一个占得到；不到间隔时不碰这一行
async function claim(db: Db, exists: boolean): Promise<boolean> {
  const rows = exists
    ? await db.execute(sql`
        update ${settings} set value = ${settings.value} || jsonb_build_object('attemptedAt', now()),
          updated_at = now()
        where key = ${STATE_KEY} and ${DUE}
        returning key`)
    : await db.execute(sql`
        insert into ${settings} (key, value) values (${STATE_KEY}, jsonb_build_object('attemptedAt', now()))
        on conflict (key) do nothing
        returning key`)
  return rows.length > 0
}

// 记下这一次的结果。latest 只在查到了正式版时换掉：失败、还没有正式版、回来的不是正式版时留着已知的
async function record(db: Db, failed: boolean, latest: UpdateNotice | null): Promise<void> {
  const patch = latest ? sql` || ${JSON.stringify({ latest })}::jsonb` : sql``
  await db.execute(sql`
    update ${settings}
    set value = ${settings.value} || jsonb_build_object('checkedAt', now(), 'failed', ${failed}::boolean)${patch},
      updated_at = now()
    where key = ${STATE_KEY}`)
}

// 向 GitHub 取最新的正式版。还没有正式版（404）、回来的是草稿、预发布或不是 X.Y.Z 时为 null；
// 别的失败抛出，文字只有类别，不带响应正文。超时与连不上分开说
async function fetchLatest(fetcher: typeof fetch, timeoutMs: number): Promise<UpdateNotice | null> {
  const signal = AbortSignal.timeout(timeoutMs)
  const timedOut = `GitHub 在 ${Math.ceil(timeoutMs / 1000)} 秒内未返回`
  // 不把原来的错误放进 cause：cause 会进日志（见 fetchFailure）
  const res = await fetcher(LATEST_RELEASE, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kioku' },
    signal,
  }).catch((err: unknown) => {
    if (signal.aborted) throw new Error(timedOut)
    throw new Error(fetchFailure('GitHub', err, '服务器能否访问 api.github.com'))
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`)
  const body = await upstreamJson(res, 'GitHub').catch((err: unknown) => {
    if (signal.aborted) throw new Error(timedOut)
    throw err
  })
  const release = Release.safeParse(body)
  if (!release.success) throw new Error('GitHub 的响应格式无法识别')
  const { tag_name: tag, draft, prerelease } = release.data
  if (draft || prerelease || !releaseVersion(tag)) return null
  return { version: tag.replace(/^v/, ''), url: RELEASE_PAGE(tag) }
}

// 正在请求的检查：测试清库前等它们写完
const pending = new Set<Promise<void>>()
export async function settleUpdateChecks(): Promise<void> {
  await Promise.all([...pending])
}

async function runCheck(db: Db, fetcher: typeof fetch, timeoutMs: number): Promise<void> {
  try {
    let latest: UpdateNotice | null
    try {
      latest = await fetchLatest(fetcher, timeoutMs)
    } catch (err) {
      // 只有这里自己写的文字（fetchFailure 只取错误类别），不打原来的错误
      console.warn('检查新版本失败：', errorText(err))
      await record(db, true, null)
      return
    }
    await record(db, false, latest)
  } catch (err) {
    logInternalError('检查新版本出错', err)
  }
}

// 测试里换掉：请求用的 fetch、当作当前版本的版本号、请求的时限
export interface UpdateCheckOptions {
  current?: string | undefined
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

// 开着、当前是正式版、到了间隔时在后台请求一次，不等 GitHub 回来：只等占下这一次（一条语句）。
// status 是调用方刚读到的状态，给了就不再读一次。返回是否开始了请求。失败只记日志，不抛出：不影响页面
export async function startUpdateCheck(
  db: Db,
  options: UpdateCheckOptions = {},
  status?: UpdateStatus,
): Promise<boolean> {
  try {
    if (!releaseVersion(options.current ?? VERSION)) return false
    const { enabled, due, exists } = status ?? (await loadUpdateStatus(db))
    if (!enabled || !due) return false
    if (!(await claim(db, exists))) return false
  } catch (err) {
    logInternalError('检查新版本出错', err)
    return false
  }
  const run = runCheck(db, options.fetch ?? fetch, options.timeoutMs ?? FETCH_TIMEOUT_MS)
  pending.add(run)
  void run.finally(() => pending.delete(run))
  return true
}
