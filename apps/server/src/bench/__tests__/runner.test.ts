import {
  BENCH_TOOLS,
  BenchStep,
  ENTRY_KINDS,
  ValidTo,
  type BenchReplayStep,
  type EntryBrowseResponse,
  type EntryView,
  type LensKeyScopes,
  type RecallCandidate,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { formatBrowse, formatEntry, TOOL_INTERNAL_ERROR } from '../../mcp/format'
import { formatBootBlock } from '../../recall/boot'
import { formatRecallBlock } from '../../recall/recall'
import {
  restFailure,
  restSuccess,
  toolOutcome,
  type BenchExecutor,
  type ResolvedStep,
  type StepOutcome,
} from '../executor'
import { handshakeProblem } from '../httpExecutor'
import { BENCH_EXPIRES_AFTER_MS, captureAfter, expand, runSteps, unmetRequirement } from '../runner'

const FULL: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: null,
  admin: false,
  credentials: 'manage',
}
const READONLY: LensKeyScopes = { ...FULL, writeKinds: [], maxSensitivity: 'private' }

const textOutcome = (text: string): StepOutcome =>
  toolOutcome('kioku_get', { content: [{ type: 'text', text }] })
const errorOutcome = (text: string): StepOutcome =>
  toolOutcome('kioku_get', { content: [{ type: 'text', text }], isError: true })

// 假的执行方式：按调用顺序给结果，记下收到的步骤
function fakeExecutor(
  answer: (step: ResolvedStep, index: number) => StepOutcome = () => textOutcome('好'),
  options: {
    scopes?: LensKeyScopes
    circleKind?: 'personal' | 'shared'
    stops?: ('aborted' | 'timeout' | null)[]
  } = {},
) {
  const seen: ResolvedStep[] = []
  const calls: string[] = []
  let stopAt = 0
  const executor: BenchExecutor = {
    whoami: async () =>
      ({
        primaryCircle: {
          id: 'c-1',
          slug: 'home',
          name: '家',
          kind: options.circleKind ?? 'shared',
        },
        linkedCircles: [],
        client: { runtimeFamily: 'claudecode' },
        scopes: options.scopes ?? FULL,
      }) as unknown as WhoAmI,
    execute: async (step, execution) => {
      seen.push(step)
      calls.push(execution?.replaying ? '重放' : '步骤')
      return answer(step, seen.length - 1)
    },
    replayDone: async () => {
      calls.push('重放结束')
    },
    stopReason: async () => options.stops?.[stopAt++] ?? null,
  }
  return { executor, seen, calls }
}

const steps = (...input: z.input<typeof BenchStep>[]) => input.map((s) => BenchStep.parse(s))
const run = (
  executor: BenchExecutor,
  input: BenchStep[],
  replay: BenchReplayStep[] = [],
  mode: 'rollback' | 'real' = 'rollback',
) => runSteps(executor, { mode, steps: input, replay, run: 'abc123' })

describe('expand', () => {
  const vars = new Map([
    ['run', '12345678'],
    ['version', '3'],
    ['name', 'x'],
  ])

  it('把字符串里的变量换掉，对象与数组里的也换，别的值不动', () => {
    expect(
      expand({ id: 'item-${run}', list: ['${name}', 1, null], nested: { deep: '${name}!' } }, vars),
    ).toEqual({ id: 'item-12345678', list: ['x', 1, null], nested: { deep: 'x!' } })
  })

  it('没有这个变量的原样留着', () => {
    expect(expand('正文里写着 ${other}', vars)).toBe('正文里写着 ${other}')
    expect(expand('${other}', vars)).toBe('${other}')
  })

  it('整个字符串就是一个取到整数的变量时按数字代入，${run} 总是字符串', () => {
    expect(expand('${version}', vars)).toBe(3)
    expect(expand('v-${version}', vars)).toBe('v-3')
    expect(expand('${run}', vars)).toBe('12345678')
    expect(expand('${name}', vars)).toBe('x')
  })
})

describe('capture', () => {
  it('按固定前缀取到行尾，去掉两头的空白；有好几处时取第一处', () => {
    expect(
      captureAfter(
        '记忆圈: home，物种: entry，敏感级: private，priority: 2，版本: 3\n\n正文 版本: 9',
        '版本: ',
      ),
    ).toBe('3')
    expect(captureAfter('ID: m-abc234  \n', 'ID: ')).toBe('m-abc234')
    expect(captureAfter('已新建凭据，版本 1', '版本 ')).toBe('1')
  })

  it('找不到时是 null，空值也算取到', () => {
    expect(captureAfter('没有', '版本: ')).toBeNull()
    expect(captureAfter('版本: \n', '版本: ')).toBe('')
  })

  it('在恶意构造的结果上也是线性的：不执行模式，长文本照样很快', () => {
    const started = performance.now()
    expect(captureAfter(`${'a'.repeat(1_000_000)}b`, '(a+)+$')).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('requires', () => {
  it('记忆圈类型、物种与最高敏感级都满足才算满足', () => {
    expect(unmetRequirement({ readKinds: ['entry'] }, READONLY, 'shared')).toBeNull()
    expect(unmetRequirement({ circleKind: 'personal' }, READONLY, 'shared')).toContain(
      '个人圈（personal）',
    )
    expect(unmetRequirement({ circleKind: 'personal' }, READONLY, 'personal')).toBeNull()
    expect(unmetRequirement({ writeKinds: ['entry'] }, READONLY)).toContain(
      '无权写入正式记忆（entry）',
    )
    expect(
      unmetRequirement({ readKinds: ['fact'] }, { ...READONLY, readKinds: ['entry'] }),
    ).toContain('无权读取联系人事实（fact）')
    expect(unmetRequirement({ maxSensitivity: 'secret' }, READONLY)).toContain(
      '低于机密级（secret）',
    )
    expect(unmetRequirement({ maxSensitivity: 'private' }, READONLY)).toBeNull()
    expect(unmetRequirement({ maxSensitivity: 'public' }, READONLY)).toBeNull()
    expect(unmetRequirement({}, READONLY)).toBeNull()
  })
})

describe('断言', () => {
  it('没带断言的步骤只要不是内部错误就算通过，业务错误也算', async () => {
    const { executor } = fakeExecutor(() => errorOutcome('未找到词条：m-234567'))
    const result = await run(executor, steps({ kind: 'whoami' }))
    expect(result.steps[0]).toMatchObject({ status: 'passed', isError: true, assertions: [] })
    expect(result.ok).toBe(true)
  })

  it('内部错误一律算失败，「应当报错」也不算通过，也不再看别的断言', async () => {
    const { executor } = fakeExecutor(() => errorOutcome(TOOL_INTERNAL_ERROR))
    const result = await run(
      executor,
      steps({ kind: 'tool', tool: 'kioku_get', expect: { error: true, contains: ['内部'] } }),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      internalError: true,
      assertions: [{ message: '服务内部错误', ok: false }],
    })
    expect(result.ok).toBe(false)
  })

  it('REST 的 500 算内部错误，别的状态码是业务错误', () => {
    expect(restFailure(500, '服务内部错误').internalError).toBe(true)
    expect(restFailure(404, '不存在').internalError).toBe(false)
    expect(restFailure(404, '不存在')).toMatchObject({ isError: true, httpStatus: 404 })
  })

  it('报错与否、包含、不包含、短 ID 列表，都展开变量；失败的说明不带实际结果', async () => {
    const { executor } = fakeExecutor((_, i) =>
      textOutcome(i === 0 ? 'ID: m-234567' : 'ID: m-234567\n标题: abc123\n\n秘密的实际内容'),
    )
    const result = await run(
      executor,
      steps(
        { kind: 'tool', tool: 'kioku_create', capture: { hit: 'ID: ' } },
        {
          kind: 'tool',
          tool: 'kioku_get',
          expect: {
            error: false,
            contains: ['abc123', '没有这句'],
            notContains: ['秘密的实际内容', '也没有这句'],
            shortIds: ['${hit}', 'm-89abcd'],
            notShortIds: ['${hit}', 'm-777777'],
          },
        },
      ),
    )
    const step = result.steps[1]!
    expect(step.status).toBe('failed')
    expect(step.shortIds).toEqual(['m-234567'])
    expect(step.assertions.filter((a) => !a.ok).map((a) => a.message)).toEqual([
      '应包含「没有这句」',
      '不应包含「秘密的实际内容」',
      '短 ID 列表应有 m-89abcd',
      '短 ID 列表不应有 ${hit}',
    ])
    expect(step.assertions.filter((a) => a.ok)).toHaveLength(5)
  })

  it('说明与 label 用展开之前的模板：capture 取到的值不进这两处，比较时照常展开', async () => {
    const VALUE = 'hunter2-value'
    const CAPTURED_ID = 'm-234567'
    const { executor, seen } = fakeExecutor((_, i) =>
      i === 0
        ? textOutcome(`值：${VALUE}\nID: ${CAPTURED_ID}`)
        : textOutcome(`ID: ${CAPTURED_ID}\n\n回显 ${VALUE}`),
    )
    const result = await run(
      executor,
      steps(
        { kind: 'tool', tool: 'kioku_credential', capture: { pw: '值：', cid: 'ID: ' } },
        {
          kind: 'tool',
          tool: 'kioku_get',
          label: '用 ${pw} 登录 ${run}',
          arguments: { id: '${pw}' },
          expect: {
            contains: ['没有 ${pw}', '回显 ${pw}'],
            notContains: ['${pw}', '${run}'],
            shortIds: ['${cid}', 'm-89abcd'],
            notShortIds: ['${cid}', 'm-89abcd'],
          },
        },
      ),
    )
    const step = result.steps[1]!
    expect(seen[1]).toMatchObject({ arguments: { id: VALUE } })
    expect(step.label).toBe('用 ${pw} 登录 abc123')
    expect(step.assertions).toEqual([
      { message: '应包含「没有 ${pw}」', ok: false },
      { message: '应包含「回显 ${pw}」', ok: true },
      { message: '不应包含「${pw}」', ok: false },
      { message: '不应包含「abc123」', ok: true },
      { message: '短 ID 列表应有 ${cid}', ok: true },
      { message: '短 ID 列表应有 m-89abcd', ok: false },
      { message: '短 ID 列表不应有 ${cid}', ok: false },
      { message: '短 ID 列表不应有 m-89abcd', ok: true },
    ])
    expect(JSON.stringify([step.label, step.assertions, step.reason])).not.toContain(VALUE)
  })

  it('kioku_boot 分不清短 ID 列表：shortIds 与 notShortIds 断言都明确失败，不算没有', async () => {
    const { executor } = fakeExecutor(() =>
      toolOutcome('kioku_boot', { content: [{ type: 'text', text: '<kioku-boot>\n## 规范' }] }),
    )
    const result = await run(
      executor,
      steps({
        kind: 'tool',
        tool: 'kioku_boot',
        expect: { shortIds: ['m-234567'], notShortIds: ['m-345678'] },
      }),
    )
    const step = result.steps[0]!
    expect(step).toMatchObject({ status: 'failed', shortIds: null })
    expect(step.assertions.map((a) => a.ok)).toEqual([false, false])
    expect(step.assertions[0]!.message).toContain('短 ID 列表应有 m-234567')
    expect(step.assertions[0]!.message).toContain('无法区分')
    expect(step.assertions[1]!.message).toContain('短 ID 列表不应有 m-345678')
  })

  it('报错与否对不上时失败', async () => {
    const ok = fakeExecutor(() => textOutcome('好'))
    const wanted = await run(ok.executor, steps({ kind: 'whoami', expect: { error: true } }))
    expect(wanted.steps[0]!.assertions).toEqual([{ message: '应当报错', ok: false }])
    const bad = fakeExecutor(() => errorOutcome('坏了'))
    const unwanted = await run(bad.executor, steps({ kind: 'whoami', expect: { error: false } }))
    expect(unwanted.steps[0]!.assertions).toEqual([{ message: '不应报错', ok: false }])
  })
})

describe('变量与 capture', () => {
  it('${run} 与前面取到的变量展开之后才执行', async () => {
    const { executor, seen } = fakeExecutor((_, i) =>
      i === 0 ? textOutcome('ID: m-234567\n敏感级: private，版本: 7\n\n正文') : textOutcome('好'),
    )
    const result = await run(
      executor,
      steps(
        {
          kind: 'tool',
          tool: 'kioku_create',
          arguments: { title: 'note-${run}' },
          capture: { version: '版本: ', id: 'ID: ' },
        },
        {
          kind: 'tool',
          tool: 'kioku_update',
          arguments: { id: '${id}', expected_version: '${version}' },
          expect: { contains: ['好'] },
        },
      ),
    )
    expect(seen[0]).toMatchObject({ arguments: { title: 'note-abc123' } })
    expect(seen[1]).toMatchObject({ arguments: { id: 'm-234567', expected_version: 7 } })
    expect(result.steps[0]!.captured).toEqual({ version: '7', id: 'm-234567' })
    expect(result.run).toBe('abc123')
  })

  it('${expires} 是几小时后的时间，一次运行里相同，合法的 valid_to', async () => {
    const before = Date.now()
    const { executor, seen } = fakeExecutor()
    await run(
      executor,
      steps(
        { kind: 'tool', tool: 'kioku_create', arguments: { valid_to: '${expires}' } },
        { kind: 'tool', tool: 'kioku_create', arguments: { valid_to: '${expires}' } },
      ),
    )
    const [first, second] = seen.map((s) => (s.kind === 'tool' ? s.arguments.valid_to : null))
    expect(first).toBe(second)
    const validTo = ValidTo.parse(first)
    const at = new Date(validTo).getTime()
    expect(at).toBeGreaterThanOrEqual(before + BENCH_EXPIRES_AFTER_MS)
    expect(at).toBeLessThanOrEqual(Date.now() + BENCH_EXPIRES_AFTER_MS)
  })

  it('取不到算这一步失败；依赖它的步骤不执行，也算失败', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('什么都没有'))
    const result = await run(
      executor,
      steps(
        { kind: 'whoami', capture: { version: '版本: ' } },
        { kind: 'tool', tool: 'kioku_get', arguments: { id: 'note-${version}' } },
        { kind: 'whoami' },
      ),
    )
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'passed'])
    // 界面（benchResult.ts）靠这个开头认出 capture 没取到，改了要一起改
    expect(result.steps[0]!.assertions[0]!.message).toMatch(/^capture version：/)
    expect(result.steps[1]!.assertions).toEqual([{ message: '变量 ${version} 未取到', ok: false }])
    expect(seen).toHaveLength(2)
  })

  it('取变量的步骤被跳过时，依赖它的步骤也跳过，不算失败', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('版本: 1'), { scopes: READONLY })
    const result = await run(
      executor,
      steps(
        {
          kind: 'tool',
          tool: 'kioku_create',
          requires: { writeKinds: ['entry'] },
          capture: { version: '版本: ' },
        },
        { kind: 'tool', tool: 'kioku_update', arguments: { expected_version: '${version}' } },
      ),
    )
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'skipped'])
    expect(result.steps[0]!.reason).toContain('无权写入正式记忆（entry）')
    expect(result.steps[1]!.reason).toContain('${version}')
    expect(seen).toHaveLength(0)
    expect(result.ok).toBe(true)
    expect(result.counts).toEqual({ passed: 0, failed: 0, skipped: 2, notRun: 0 })
  })

  it('断言比较的是文字：整个模板就是一个 capture 变量时也不按数字代入', async () => {
    const { executor } = fakeExecutor((_, i) =>
      textOutcome(i === 0 ? '版本: 00123' : '正文里只有 123'),
    )
    const result = await run(
      executor,
      steps(
        { kind: 'whoami', capture: { pin: '版本: ' } },
        { kind: 'whoami', expect: { contains: ['${pin}'] } },
        { kind: 'whoami', expect: { notContains: ['${pin}'] } },
      ),
    )
    expect(result.steps.map((step) => step.status)).toEqual(['passed', 'failed', 'passed'])
  })

  describe('之前取到过的变量', () => {
    const uses = { kind: 'tool', tool: 'kioku_get', arguments: { id: 'note-${version}' } } as const

    it('后一步没取到：旧值作废，依赖它的步骤不执行、算失败', async () => {
      const { executor, seen } = fakeExecutor((_, i) =>
        textOutcome(i === 0 ? '版本: 1' : '什么都没有'),
      )
      const result = await run(
        executor,
        steps(
          { kind: 'whoami', capture: { version: '版本: ' } },
          { kind: 'whoami', capture: { version: '版本: ' } },
          uses,
        ),
      )
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'failed'])
      expect(result.steps[2]!.assertions).toEqual([
        { message: '变量 ${version} 未取到', ok: false },
      ])
      expect(seen).toHaveLength(2)
    })

    it('后一步被跳过：旧值作废，依赖它的也跳过', async () => {
      const { executor, seen } = fakeExecutor(() => textOutcome('版本: 1'), { scopes: READONLY })
      const result = await run(
        executor,
        steps(
          { kind: 'whoami', capture: { version: '版本: ' } },
          {
            kind: 'tool',
            tool: 'kioku_update',
            requires: { writeKinds: ['entry'] },
            capture: { version: '版本: ' },
          },
          uses,
        ),
      )
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'skipped'])
      expect(result.steps[2]!.reason).toContain('${version}')
      expect(seen).toHaveLength(1)
    })

    it('后一步因为依赖没取到而没执行：它声明的变量的旧值也作废', async () => {
      const { executor, seen } = fakeExecutor((_, i) =>
        textOutcome(i === 0 ? '版本: 1\n别的: 2' : '什么都没有'),
      )
      const result = await run(
        executor,
        steps(
          { kind: 'whoami', capture: { version: '版本: ', other: '别的: ' } },
          { kind: 'whoami', capture: { other: '别的: ' } },
          {
            kind: 'tool',
            tool: 'kioku_get',
            arguments: { id: 'note-${other}' },
            capture: { version: '版本: ' },
          },
          uses,
        ),
      )
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'failed', 'failed'])
      expect(seen).toHaveLength(2)
    })

    it('作废之后又取到时恢复可用，用新值', async () => {
      const { executor, seen } = fakeExecutor((_, i) =>
        textOutcome(i === 0 ? '版本: 1' : i === 1 ? '什么都没有' : '版本: 3'),
      )
      const result = await run(
        executor,
        steps(
          { kind: 'whoami', capture: { version: '版本: ' } },
          { kind: 'whoami', capture: { version: '版本: ' } },
          { kind: 'whoami', capture: { version: '版本: ' } },
          uses,
        ),
      )
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'passed', 'passed'])
      expect(seen[3]).toMatchObject({ arguments: { id: 'note-3' } })
    })
  })

  describe('执行前再判一次（refuse）', () => {
    const refuse = (step: BenchStep) =>
      step.kind === 'recall' && (step.body as { query?: unknown }).query === '不让发'
        ? '不让发的原因'
        : null

    it('按展开之后的步骤判：这一步不执行、算失败，文字说明原因，它声明的变量算没取到', async () => {
      const { executor, seen } = fakeExecutor((_, i) =>
        textOutcome(i === 0 ? '查询: 不让发' : '好'),
      )
      const result = await runSteps(executor, {
        mode: 'real',
        run: 'abc123',
        replay: [],
        refuse,
        steps: steps(
          { kind: 'whoami', capture: { query: '查询: ' } },
          { kind: 'recall', label: '发', body: { query: '${query}' }, capture: { x: '好' } },
          { kind: 'tool', tool: 'kioku_get', arguments: { id: 'note-${x}' } },
          { kind: 'whoami', label: '后面照常跑' },
        ),
      })
      expect(result.steps[1]).toMatchObject({
        status: 'failed',
        isError: false,
        internalError: false,
        text: '',
        assertions: [{ message: '不让发的原因', ok: false }],
      })
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'failed', 'passed'])
      expect(seen.map((s) => s.kind)).toEqual(['whoami', 'whoami'])
      expect(result.ok).toBe(false)
    })
  })
})

describe('跳过与没有执行', () => {
  it('不满足 requires 的步骤记跳过，不执行，不算失败', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('好'), {
      scopes: READONLY,
      circleKind: 'shared',
    })
    const result = await run(
      executor,
      steps(
        { kind: 'whoami' },
        { kind: 'tool', tool: 'kioku_create', requires: { writeKinds: ['entry'] } },
        { kind: 'boot', requires: { maxSensitivity: 'secret' } },
        { kind: 'whoami', requires: { circleKind: 'personal' } },
      ),
    )
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'skipped', 'skipped'])
    expect(seen).toHaveLength(1)
    expect(result.ok).toBe(true)
  })

  it('根事务中止：这一步算失败（错误被吞掉时也是），后面的记为没有执行，整次运行不算通过', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('看起来成功了'), {
      stops: [null, 'aborted'],
    })
    const result = await run(
      executor,
      steps(
        { kind: 'whoami' },
        { kind: 'boot', requires: { maxSensitivity: 'secret' } },
        { kind: 'boot' },
      ),
    )
    expect(seen).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      internalError: true,
      internalDetail: 'aborted',
    })
    expect(result.steps[0]!.assertions[0]!.message).toContain('根事务已中止')
    expect(result.steps.slice(1).map((s) => s.status)).toEqual(['notRun', 'notRun'])
    expect(result.steps[1]!.reason).toContain('根事务出错')
    expect(result.ok).toBe(false)
    expect(result.counts).toEqual({ passed: 0, failed: 1, skipped: 0, notRun: 2 })
  })

  it('超过总时长：这一步的结果保留，后面的记为没有执行', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('好'), {
      stops: [null, 'timeout'],
    })
    const result = await run(executor, steps({ kind: 'whoami' }, { kind: 'boot' }))
    expect(seen).toHaveLength(1)
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'notRun'])
    expect(result.steps[1]!.reason).toContain('总时长')
    expect(result.ok).toBe(false)
  })

  it('一开始就已经停了时一步也不执行', async () => {
    const { executor, seen } = fakeExecutor(() => textOutcome('好'), { stops: ['aborted'] })
    const result = await run(executor, steps({ kind: 'whoami' }))
    expect(seen).toHaveLength(0)
    expect(result.steps[0]!.status).toBe('notRun')
  })
})

describe('重放', () => {
  const entry: BenchReplayStep = {
    kind: 'tool',
    tool: 'kioku_create',
    arguments: { title: 'note-${run}', content: 'x' },
    shortId: 'm-234567',
  }

  it('先执行，结果不返回；参数不再展开', async () => {
    const { executor, seen } = fakeExecutor()
    const result = await run(executor, steps({ kind: 'whoami' }), [entry, entry])
    expect(seen.map((s) => s.kind)).toEqual(['tool', 'tool', 'whoami'])
    expect(seen[0]).toMatchObject({ arguments: { title: 'note-${run}' }, shortId: 'm-234567' })
    expect(result.steps).toHaveLength(1)
    expect(result.replayDiverged).toBeNull()
    expect(result.ok).toBe(true)
  })

  it('有步骤报错就停下：后面的重放与当前步骤都不执行，返回第几步', async () => {
    const { executor, seen } = fakeExecutor((_, i) =>
      i === 1 ? errorOutcome('短 ID 已被占用') : textOutcome('好'),
    )
    const result = await run(executor, steps({ kind: 'whoami' }, { kind: 'boot' }), [
      entry,
      entry,
      entry,
    ])
    expect(seen).toHaveLength(2)
    expect(result.replayDiverged).toEqual({
      index: 1,
      text: '短 ID 已被占用',
      internalError: false,
    })
    expect(result.steps.map((s) => s.status)).toEqual(['notRun', 'notRun'])
    expect(result.steps[0]!.reason).toContain('第 2 步')
    expect(result.ok).toBe(false)
  })

  it('重放时根事务中止或超时也算分叉', async () => {
    const { executor } = fakeExecutor(() => textOutcome('好'), { stops: [null, 'timeout'] })
    const result = await run(executor, steps({ kind: 'whoami' }), [entry, entry])
    expect(result.replayDiverged).toMatchObject({ index: 1, internalError: true })
    expect(result.replayDiverged!.text).toContain('总时长')
  })

  it('只记成功的写步骤并带上新建词条的 shortId；读步骤、报错的步骤与真实模式都不记', async () => {
    const answers: Record<string, StepOutcome> = {
      kioku_create: toolOutcome('kioku_create', {
        content: [{ type: 'text', text: 'ID: m-234567\n标题: t\n版本: 1' }],
      }),
      kioku_update: errorOutcome('未找到词条'),
      kioku_get: textOutcome('好'),
    }
    const { executor } = fakeExecutor((step) =>
      step.kind === 'tool' ? answers[step.tool]! : restSuccess('lifecycle', LIFECYCLE_OK),
    )
    const input = steps(
      { kind: 'tool', tool: 'kioku_create', arguments: { title: 't-${run}', content: 'x' } },
      { kind: 'tool', tool: 'kioku_update', arguments: { id: 'm-234567' } },
      { kind: 'tool', tool: 'kioku_get', arguments: { id: 'm-234567' } },
      { kind: 'lifecycle', body: TURN_END },
      { kind: 'lifecycle', body: { event: 'prompt.submit', prompt: '你好' } },
    )
    const result = await run(executor, input)
    expect(result.steps.map((s) => s.replay)).toEqual([
      {
        kind: 'tool',
        tool: 'kioku_create',
        arguments: { title: 't-abc123', content: 'x' },
        shortId: 'm-234567',
      },
      null,
      null,
      { kind: 'lifecycle', body: TURN_END },
      null,
    ])
    const real = await run(executor, input, [], 'real')
    expect(real.steps.every((s) => s.replay === null)).toBe(true)
  })

  it('标成内部错误的写步骤不记：根事务中止时错误可能被吞掉，结果看起来是成功的', async () => {
    const { executor } = fakeExecutor(() => textOutcome('看起来写成了'), {
      stops: [null, 'aborted'],
    })
    const result = await run(
      executor,
      steps({ kind: 'tool', tool: 'kioku_create', arguments: { content: 'a' } }),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      isError: false,
      internalError: true,
      replay: null,
    })
  })

  it('断言不成立但确实写成了的步骤照样记：写入是真的，后面的步骤要读得到', async () => {
    const { executor } = fakeExecutor(() =>
      toolOutcome('kioku_create', {
        content: [{ type: 'text', text: 'ID: m-345678\n标题: t\n版本: 1' }],
      }),
    )
    const result = await run(
      executor,
      steps({
        kind: 'tool',
        tool: 'kioku_create',
        arguments: { content: 'a' },
        expect: { contains: ['没有这句'] },
      }),
    )
    expect(result.steps[0]).toMatchObject({ status: 'failed', internalError: false })
    expect(result.steps[0]!.replay).toEqual({
      kind: 'tool',
      tool: 'kioku_create',
      arguments: { content: 'a' },
      shortId: 'm-345678',
    })
  })

  it('告诉执行方式哪些是重放的；全部重放完调一次 replayDone，在第一个真实步骤之前', async () => {
    const { executor, calls } = fakeExecutor()
    await run(executor, steps({ kind: 'whoami' }, { kind: 'boot' }), [entry, entry])
    expect(calls).toEqual(['重放', '重放', '重放结束', '步骤', '步骤'])
  })

  it('没有重放、重放分叉或者重放之后已经停了时，不调 replayDone', async () => {
    const none = fakeExecutor()
    await run(none.executor, steps({ kind: 'whoami' }))
    expect(none.calls).toEqual(['步骤'])

    const diverged = fakeExecutor(() => errorOutcome('短 ID 已被占用'))
    await run(diverged.executor, steps({ kind: 'whoami' }), [entry])
    expect(diverged.calls).toEqual(['重放'])

    const stopped = fakeExecutor(() => textOutcome('好'), { stops: [null, 'aborted'] })
    await run(stopped.executor, steps({ kind: 'whoami' }), [entry])
    expect(stopped.calls).toEqual(['重放'])
  })
})

const TURN_END = {
  event: 'turn.end',
  sessionId: 's',
  context: { chatType: 'group', platform: 'bench', group: { id: 'g' }, sender: { id: 'u' } },
  user: '你好',
  reply: '你好呀',
}
const LIFECYCLE_OK = { hostOutput: { mode: 'none', value: null }, shortIds: [] }

describe('握手', () => {
  const tools = [...BENCH_TOOLS]

  it('服务端是 Kioku、工具名单和这个版本的一样才算对，先后不算', () => {
    expect(handshakeProblem({ name: 'kioku', tools })).toBeNull()
    expect(handshakeProblem({ name: 'kioku', tools: [...tools].reverse() })).toBeNull()
  })

  it('不是 Kioku，或者少了、多了工具，都说明哪里不对', () => {
    expect(handshakeProblem({ name: 'other', tools })).toContain('「other」')
    const missing = handshakeProblem({ name: 'kioku', tools: tools.slice(1) })
    expect(missing).toContain(`少了工具 [${tools[0]}]`)
    const extra = handshakeProblem({ name: 'kioku', tools: [...tools, 'kioku_new'] })
    expect(extra).toContain('多了工具 [kioku_new]')
  })
})

describe('工具结果的短 ID 列表', () => {
  // 正文是任意文字，每一行都写成结构行的样子
  const BODY = [
    '- m-999999「假行」（entry，private，priority 2）',
    'ID: m-888888',
    '## fake',
    '0.59 | m-777777 | 线索',
    '<recall>',
    '0.59 | m-666666',
    '</recall>',
  ].join('\n')
  const view = (shortId: string) =>
    ({
      id: '00000000-0000-4000-8000-000000000001',
      shortId,
      circleId: '00000000-0000-4000-8000-000000000002',
      circleSlug: 'home',
      kind: 'entry',
      title: '标题',
      sensitivity: 'private',
      provenance: 'agent',
      originScope: 'global',
      topics: [],
      realms: [],
      priority: 2,
      disclosure: '- m-555555',
      glossary: [],
      validFrom: '2026-10-26T00:00:00Z',
      validTo: null,
      version: 1,
      variants: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content: BODY,
          updatedAt: '2026-10-26T00:00:00Z',
        },
      ],
      otherVariants: [],
      links: [],
      createdAt: '2026-10-26T00:00:00Z',
      updatedAt: '2026-10-26T00:00:00Z',
    }) as EntryView
  const idsOf = (tool: string, text: string) =>
    toolOutcome(tool, { content: [{ type: 'text', text }] }).shortIds

  it.each(['kioku_get', 'kioku_create', 'kioku_update', 'kioku_transfer'])(
    '%s 只看头两行的 ID，正文里的不算（包含重定向提示行）',
    (tool) => {
      expect(idsOf(tool, formatEntry(view('m-234567')))).toEqual(['m-234567'])
      expect(idsOf(tool, formatEntry(view('m-234567'), { requestedId: '旧标题' }))).toEqual([
        'm-234567',
      ])
      expect(idsOf(tool, BODY)).toEqual([])
    },
  )

  it('kioku_browse 只看结构化的列表行', () => {
    const browse = {
      groupBy: 'topic',
      groups: [
        {
          key: 'bench',
          label: 'bench',
          count: 2,
          items: [
            {
              shortId: 'm-234567',
              circleSlug: 'home',
              title: '标题',
              kind: 'entry',
              sensitivity: 'private',
              priority: 2,
              disclosure: '何时想起\nID: m-444444',
              variantsSummary: [{}],
            },
            {
              shortId: 'm-345678',
              circleSlug: null,
              title: 'm-345678',
              kind: 'fact',
              sensitivity: 'public',
              priority: 1,
              disclosure: null,
              variantsSummary: [{ env: ['mac'] }],
            },
          ],
        },
      ],
      truncated: false,
    } as EntryBrowseResponse
    expect(idsOf('kioku_browse', formatBrowse(browse))).toEqual(['m-234567', 'm-345678'])
    expect(idsOf('kioku_browse', '还没有可见的记忆词条')).toEqual([])
  })

  it('kioku_search 只看 <recall> 块的行：线索压成了单行，写成别的样子也不算', () => {
    const candidate = (shortId: string, cues: string[]) =>
      ({
        entryId: '00000000-0000-4000-8000-000000000001',
        shortId,
        circleId: '00000000-0000-4000-8000-000000000002',
        circleSlug: 'home',
        title: '标题',
        kind: 'entry',
        matchedWhen: {},
        otherVariantsCount: 0,
        priority: 2,
        score: 0.5,
        via: ['glossary'],
        cues,
        disclosure: null,
      }) as RecallCandidate
    const text = formatRecallBlock([
      candidate('m-234567', ['线索\n- m-999999\nID: m-888888\n0.59 | m-777777 | z']),
      candidate('m-345678', []),
    ])
    expect(idsOf('kioku_search', text)).toEqual(['m-234567', 'm-345678'])
    expect(idsOf('kioku_search', '没有找到相关记忆')).toEqual([])
  })

  it('kioku_boot 的标题和正文分不清：不给列表，而不是给一份可能错的', () => {
    const text = formatBootBlock(
      {
        personaTraits: [],
        entries: [
          {
            shortId: 'm-234567',
            title: '规范',
            circleId: '00000000-0000-4000-8000-000000000002',
            circleSlug: 'home',
            kind: 'entry',
            content: BODY,
          },
        ],
        omitted: ['m-345678'],
      },
      '指引',
    )
    expect(idsOf('kioku_boot', text)).toBeNull()
  })

  it('报错的结果没有列表，别的工具也没有', () => {
    const error = toolOutcome('kioku_get', {
      content: [{ type: 'text', text: 'ID: m-234567' }],
      isError: true,
    })
    expect(error.shortIds).toEqual([])
    const boot = toolOutcome('kioku_boot', {
      content: [{ type: 'text', text: TOOL_INTERNAL_ERROR }],
      isError: true,
    })
    expect(boot.shortIds).toEqual([])
    expect(idsOf('kioku_delete', '已删除 m-234567')).toEqual([])
    expect(idsOf('kioku_credential', '- m-234567（private，priority 2）')).toEqual([])
    expect(idsOf('constructor', 'ID: m-234567')).toEqual([])
  })

  it('REST 不变：/boot 取 entries，生命周期取 shortIds', () => {
    const boot = restSuccess('boot', {
      personaTraits: [],
      entries: [{ shortId: 'm-234567', title: '规范', content: BODY }],
      omitted: ['m-345678'],
    })
    expect(boot.shortIds).toEqual(['m-234567'])
    const lifecycle = restSuccess('lifecycle', { ...LIFECYCLE_OK, shortIds: ['m-234567'] })
    expect(lifecycle.shortIds).toEqual(['m-234567'])
  })
})

describe('结果的文字', () => {
  it('工具内部错误按固定文字认，只有报错时才算', () => {
    const content = [{ type: 'text', text: TOOL_INTERNAL_ERROR }]
    expect(toolOutcome('kioku_get', { content, isError: true }).internalError).toBe(true)
    expect(toolOutcome('kioku_get', { content }).internalError).toBe(false)
  })

  it('生命周期事件是交给宿主的文字，规则和插件一样', () => {
    const textOf = (hostOutput: unknown) =>
      restSuccess('lifecycle', { hostOutput, shortIds: ['m-234567'] })
    expect(
      textOf({
        mode: 'stdout_json',
        value: { hookSpecificOutput: { additionalContext: '上下文' } },
      }).text,
    ).toBe('上下文')
    expect(
      textOf({
        mode: 'stdout_json',
        value: { injectSteps: [{ systemMessage: { systemMessage: 'inject 文本' } }] },
      }).text,
    ).toBe('inject 文本')
    expect(textOf({ mode: 'stdout_text', value: '纯文本' }).text).toBe('纯文本')
    expect(textOf({ mode: 'return_value', value: { context: '给宿主' } }).text).toBe('给宿主')
    expect(textOf({ mode: 'none', value: null }).text).toBe('')
    expect(textOf({ mode: 'none', value: null }).shortIds).toEqual(['m-234567'])
  })

  it('session.start 多带的那几项单独放，原始响应和真实接口的相同', () => {
    const outcome = restSuccess('lifecycle', {
      ...LIFECYCLE_OK,
      session: { limit: 100, omitted: ['m-234567'], dropped: ['recent'] },
    })
    expect(outcome.session).toEqual({ limit: 100, omitted: ['m-234567'], dropped: ['recent'] })
    expect(outcome.raw).toEqual(LIFECYCLE_OK)
  })

  it('REST 的短 ID 列表：召回的候选、启动词条', () => {
    expect(
      restSuccess('recall', {
        candidates: [{ shortId: 'm-234567' }, { shortId: 'm-345678' }],
        subjects: [],
      }).shortIds,
    ).toEqual(['m-234567', 'm-345678'])
    expect(
      restSuccess('boot', {
        personaTraits: [],
        entries: [{ shortId: 'm-234567' }],
        omitted: ['m-345678'],
      }).shortIds,
    ).toEqual(['m-234567'])
    expect(JSON.parse(restSuccess('whoami', { primaryCircle: { id: 'c' } }).text)).toEqual({
      primaryCircle: { id: 'c' },
    })
  })
})
