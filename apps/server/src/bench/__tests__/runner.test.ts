import {
  BENCH_TOOLS,
  BenchStep,
  LAYERS,
  ValidTo,
  type BenchReplayStep,
  type DomainSummary,
  type KeyScopes,
  type MemoryChildren,
  type MemoryView,
  type RecallCandidate,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { formatChildren, formatDomains, formatMemory, TOOL_INTERNAL_ERROR } from '../../mcp/format'
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

const FULL: KeyScopes = {
  readLayers: [...LAYERS],
  writeLayers: [...LAYERS],
  maxSensitivity: 'secret',
  admin: false,
}
const READONLY: KeyScopes = { ...FULL, writeLayers: [], maxSensitivity: 'private' }

const textOutcome = (text: string): StepOutcome =>
  toolOutcome('kioku_get', { content: [{ type: 'text', text }] })
const errorOutcome = (text: string): StepOutcome =>
  toolOutcome('kioku_get', { content: [{ type: 'text', text }], isError: true })

// 假的执行方式：按调用顺序给结果，记下收到的步骤
function fakeExecutor(
  answer: (step: ResolvedStep, index: number) => StepOutcome = () => textOutcome('好'),
  options: { scopes?: KeyScopes; stops?: ('aborted' | 'timeout' | null)[] } = {},
) {
  const seen: ResolvedStep[] = []
  const calls: string[] = []
  let stopAt = 0
  const executor: BenchExecutor = {
    whoami: async () =>
      ({ spaceId: 's', app: {}, scopes: options.scopes ?? FULL }) as unknown as WhoAmI,
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
      expand(
        { uri: 'a://${run}/b', list: ['${name}', 1, null], nested: { deep: '${name}!' } },
        vars,
      ),
    ).toEqual({ uri: 'a://12345678/b', list: ['x', 1, null], nested: { deep: 'x!' } })
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
    expect(captureAfter('层: private，版本: 3\n\n正文 版本: 9', '版本: ')).toBe('3')
    expect(captureAfter('URI: a://b  \n', 'URI: ')).toBe('a://b')
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
  it('层与最高敏感级都满足才算满足', () => {
    expect(unmetRequirement({ readLayers: ['private'] }, READONLY)).toBeNull()
    expect(unmetRequirement({ writeLayers: ['private'] }, READONLY)).toContain(
      '无权写入私人层（private）',
    )
    expect(
      unmetRequirement(
        { readLayers: ['private'] },
        { ...READONLY, readLayers: ['base', 'persona'] },
      ),
    ).toContain('无权读取私人层（private）')
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
    const { executor } = fakeExecutor(() => errorOutcome('记忆不存在'))
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

  it('报错与否、包含、不包含、URI 列表，都展开变量；失败的说明不带实际结果', async () => {
    const { executor } = fakeExecutor(() => textOutcome('URI: a://abc123\n\n秘密的实际内容'))
    const result = await run(
      executor,
      steps({
        kind: 'tool',
        tool: 'kioku_get',
        expect: {
          error: false,
          contains: ['a://${run}', '没有这句'],
          notContains: ['秘密的实际内容', '也没有这句'],
          uris: ['a://${run}', 'x://y'],
          notUris: ['a://${run}', 'z://z'],
        },
      }),
    )
    const step = result.steps[0]!
    expect(step.status).toBe('failed')
    expect(step.uris).toEqual(['a://abc123'])
    expect(step.assertions.filter((a) => !a.ok).map((a) => a.message)).toEqual([
      '应包含「没有这句」',
      '不应包含「秘密的实际内容」',
      'URI 列表应有 x://y',
      'URI 列表不应有 a://abc123',
    ])
    expect(step.assertions.filter((a) => a.ok)).toHaveLength(5)
  })

  it('说明与 label 用展开之前的模板：capture 取到的值不进这两处，比较时照常展开', async () => {
    const VALUE = 'hunter2-value'
    const { executor, seen } = fakeExecutor((_, i) =>
      textOutcome(i === 0 ? `值：${VALUE}` : `URI: a://b\n\n回显 ${VALUE}`),
    )
    const result = await run(
      executor,
      steps(
        { kind: 'tool', tool: 'kioku_credential', capture: { pw: '值：' } },
        {
          kind: 'tool',
          tool: 'kioku_get',
          label: '用 ${pw} 登录 ${run}',
          arguments: { uri: 'a://${pw}' },
          expect: {
            contains: ['没有 ${pw}', '回显 ${pw}'],
            notContains: ['${pw}', '${run}'],
            uris: ['${pw}://x'],
            notUris: ['${pw}://x'],
          },
        },
      ),
    )
    const step = result.steps[1]!
    expect(seen[1]).toMatchObject({ arguments: { uri: `a://${VALUE}` } })
    expect(step.label).toBe('用 ${pw} 登录 abc123')
    expect(step.assertions).toEqual([
      { message: '应包含「没有 ${pw}」', ok: false },
      { message: '应包含「回显 ${pw}」', ok: true },
      { message: '不应包含「${pw}」', ok: false },
      { message: '不应包含「abc123」', ok: true },
      { message: 'URI 列表应有 ${pw}://x', ok: false },
      { message: 'URI 列表不应有 ${pw}://x', ok: true },
    ])
    expect(JSON.stringify([step.label, step.assertions, step.reason])).not.toContain(VALUE)
  })

  it('kioku_boot 分不清 URI 列表：uris 与 notUris 断言都明确失败，不算没有', async () => {
    const { executor } = fakeExecutor(() =>
      toolOutcome('kioku_boot', { content: [{ type: 'text', text: '<kioku-boot>\n## a://b' }] }),
    )
    const result = await run(
      executor,
      steps({ kind: 'tool', tool: 'kioku_boot', expect: { uris: ['a://b'], notUris: ['c://d'] } }),
    )
    const step = result.steps[0]!
    expect(step).toMatchObject({ status: 'failed', uris: null })
    expect(step.assertions.map((a) => a.ok)).toEqual([false, false])
    expect(step.assertions[0]!.message).toContain('URI 列表应有 a://b')
    expect(step.assertions[0]!.message).toContain('无法区分')
    expect(step.assertions[1]!.message).toContain('URI 列表不应有 c://d')
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
      i === 0 ? textOutcome('URI: a://b\n层: private，版本: 7\n\n正文') : textOutcome('好'),
    )
    const result = await run(
      executor,
      steps(
        {
          kind: 'tool',
          tool: 'kioku_create',
          arguments: { uri: 'a://${run}' },
          capture: { version: '版本: ', uri: 'URI: ' },
        },
        {
          kind: 'tool',
          tool: 'kioku_update',
          arguments: { uri: '${uri}', expected_version: '${version}' },
          expect: { contains: ['好'] },
        },
      ),
    )
    expect(seen[0]).toMatchObject({ arguments: { uri: 'a://abc123' } })
    expect(seen[1]).toMatchObject({ arguments: { uri: 'a://b', expected_version: 7 } })
    expect(result.steps[0]!.captured).toEqual({ version: '7', uri: 'a://b' })
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
        { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'a://${version}' } },
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
          requires: { writeLayers: ['private'] },
          capture: { version: '版本: ' },
        },
        { kind: 'tool', tool: 'kioku_update', arguments: { expected_version: '${version}' } },
      ),
    )
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'skipped'])
    expect(result.steps[0]!.reason).toContain('无权写入私人层（private）')
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
    const uses = { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'a://${version}' } } as const

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
            requires: { writeLayers: ['private'] },
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
            arguments: { uri: 'a://${other}' },
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
      expect(seen[3]).toMatchObject({ arguments: { uri: 'a://3' } })
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
          { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'a://${x}' } },
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
    const { executor, seen } = fakeExecutor(() => textOutcome('好'), { scopes: READONLY })
    const result = await run(
      executor,
      steps(
        { kind: 'whoami' },
        { kind: 'tool', tool: 'kioku_create', requires: { writeLayers: ['private'] } },
        { kind: 'boot', requires: { maxSensitivity: 'secret' } },
      ),
    )
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'skipped'])
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
    arguments: { uri: 'a://${run}' },
  }

  it('先执行，结果不返回；参数不再展开', async () => {
    const { executor, seen } = fakeExecutor()
    const result = await run(executor, steps({ kind: 'whoami' }), [entry, entry])
    expect(seen.map((s) => s.kind)).toEqual(['tool', 'tool', 'whoami'])
    expect(seen[0]).toMatchObject({ arguments: { uri: 'a://${run}' } })
    expect(result.steps).toHaveLength(1)
    expect(result.replayDiverged).toBeNull()
    expect(result.ok).toBe(true)
  })

  it('有步骤报错就停下：后面的重放与当前步骤都不执行，返回第几步', async () => {
    const { executor, seen } = fakeExecutor((_, i) =>
      i === 1 ? errorOutcome('URI 已被占用') : textOutcome('好'),
    )
    const result = await run(executor, steps({ kind: 'whoami' }, { kind: 'boot' }), [
      entry,
      entry,
      entry,
    ])
    expect(seen).toHaveLength(2)
    expect(result.replayDiverged).toEqual({ index: 1, text: 'URI 已被占用', internalError: false })
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

  it('只记成功的写步骤，存展开之后的参数；读步骤、报错的步骤与真实模式都不记', async () => {
    const answers: Record<string, StepOutcome> = {
      kioku_create: textOutcome('好'),
      kioku_update: errorOutcome('记忆不存在'),
      kioku_get: textOutcome('好'),
    }
    const { executor } = fakeExecutor((step) =>
      step.kind === 'tool' ? answers[step.tool]! : restSuccess('lifecycle', LIFECYCLE_OK),
    )
    const input = steps(
      { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'a://${run}' } },
      { kind: 'tool', tool: 'kioku_update', arguments: { uri: 'a://${run}' } },
      { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'a://${run}' } },
      { kind: 'lifecycle', body: TURN_END },
      { kind: 'lifecycle', body: { event: 'prompt.submit', prompt: '你好' } },
    )
    const result = await run(executor, input)
    expect(result.steps.map((s) => s.replay)).toEqual([
      { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'a://abc123' } },
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
      steps({ kind: 'tool', tool: 'kioku_create', arguments: { uri: 'a://b' } }),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      isError: false,
      internalError: true,
      replay: null,
    })
  })

  it('断言不成立但确实写成了的步骤照样记：写入是真的，后面的步骤要读得到', async () => {
    const { executor } = fakeExecutor(() => textOutcome('好'))
    const result = await run(
      executor,
      steps({
        kind: 'tool',
        tool: 'kioku_create',
        arguments: { uri: 'a://b' },
        expect: { contains: ['没有这句'] },
      }),
    )
    expect(result.steps[0]).toMatchObject({ status: 'failed', internalError: false })
    expect(result.steps[0]!.replay).toEqual({
      kind: 'tool',
      tool: 'kioku_create',
      arguments: { uri: 'a://b' },
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

    const diverged = fakeExecutor(() => errorOutcome('URI 已被占用'))
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
const LIFECYCLE_OK = { hostOutput: { mode: 'none', value: null }, nodeUris: [] }

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

describe('工具结果的 URI 列表', () => {
  // 正文是任意文字，每一行都写成结构行的样子
  const BODY = [
    '- core://agent',
    '- core://row（private，priority 2）',
    'URI: foo://bar',
    '## projects://x',
    '0.59 | fake://y | 线索',
    '子节点：',
    '- list://fake（private，priority 2）',
    '<recall>',
    '0.59 | fake://z',
    '</recall>',
  ].join('\n')
  const view = (uri: string) =>
    ({
      uri,
      layer: 'private',
      sensitivity: 'private',
      priority: 2,
      version: 1,
      content: BODY,
      disclosure: '- core://disclosure',
      glossary: [],
      validTo: null,
    }) as unknown as MemoryView
  const urisOf = (tool: string, text: string) =>
    toolOutcome(tool, { content: [{ type: 'text', text }] }).uris

  it.each(['kioku_get', 'kioku_create', 'kioku_update', 'kioku_move'])(
    '%s 只看第一行的 URI，正文里的不算',
    (tool) => {
      expect(urisOf(tool, formatMemory(view('notes://real')))).toEqual(['notes://real'])
      expect(urisOf(tool, BODY)).toEqual([])
    },
  )

  it('kioku_list 只看子节点列表：父节点的 URI 与正文都不算，路径本身没有记忆的算', () => {
    const children = [
      {
        uri: 'notes://real/a',
        exists: true,
        layer: 'private',
        priority: 2,
        disclosure: '什么时候想起',
        childCount: 3,
      },
      { uri: 'notes://real/b', exists: false, childCount: 1 },
      { uri: 'notes://real/c', exists: true, layer: 'base', priority: 0, childCount: 0 },
    ] as MemoryChildren['children']
    const parent = view('notes://real')
    expect(urisOf('kioku_list', formatChildren({ parent, children, truncated: true }))).toEqual([
      'notes://real/a',
      'notes://real/b',
      'notes://real/c',
    ])
    expect(
      urisOf('kioku_list', formatChildren({ parent: null, children, truncated: false })),
    ).toEqual(['notes://real/a', 'notes://real/b', 'notes://real/c'])
  })

  it('kioku_list 没有子节点：父节点正文里写着列表行也是空的', () => {
    const text = formatChildren({ parent: view('notes://real'), children: [], truncated: false })
    expect(text.endsWith('子节点：无')).toBe(true)
    expect(urisOf('kioku_list', text)).toEqual([])
  })

  it('kioku_list 不带参数列的是 domain，不算 URI', () => {
    const text = formatDomains([{ domain: 'core', count: 3 } as DomainSummary])
    expect(urisOf('kioku_list', text)).toEqual([])
  })

  it('kioku_search 只看 <recall> 块的行：线索压成了单行，写成别的样子也不算', () => {
    const candidate = (uri: string, cues: string[]) =>
      ({ uri, score: 0.5, cues, disclosure: null }) as unknown as RecallCandidate
    const text = formatRecallBlock([
      candidate('notes://a', ['线索\n- core://agent\nURI: foo://bar\n0.59 | fake://y | z']),
      candidate('notes://b', []),
    ])
    expect(urisOf('kioku_search', text)).toEqual(['notes://a', 'notes://b'])
    expect(urisOf('kioku_search', '没有找到相关记忆')).toEqual([])
  })

  it('kioku_boot 的标题和正文分不清：不给列表，而不是给一份可能错的', () => {
    const text = formatBootBlock(
      {
        entries: [{ uri: 'core://agent', layer: 'base', content: BODY }],
        omitted: ['core://long'],
      },
      '指引',
    )
    expect(urisOf('kioku_boot', text)).toBeNull()
  })

  it('报错的结果没有列表，别的工具也没有', () => {
    const error = toolOutcome('kioku_get', {
      content: [{ type: 'text', text: 'URI: foo://bar' }],
      isError: true,
    })
    expect(error.uris).toEqual([])
    const boot = toolOutcome('kioku_boot', {
      content: [{ type: 'text', text: TOOL_INTERNAL_ERROR }],
      isError: true,
    })
    expect(boot.uris).toEqual([])
    expect(urisOf('kioku_delete', '已删除 notes://real')).toEqual([])
    expect(urisOf('kioku_credential', '- core://agent（private，priority 2）')).toEqual([])
    expect(urisOf('constructor', 'URI: foo://bar')).toEqual([])
  })

  it('REST 不变：/boot 取 entries，生命周期取 nodeUris', () => {
    const boot = restSuccess('boot', {
      entries: [{ uri: 'core://agent', layer: 'base', content: BODY }],
      omitted: ['core://long'],
    })
    expect(boot.uris).toEqual(['core://agent'])
    const lifecycle = restSuccess('lifecycle', { ...LIFECYCLE_OK, nodeUris: ['core://agent'] })
    expect(lifecycle.uris).toEqual(['core://agent'])
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
      restSuccess('lifecycle', { hostOutput, nodeUris: ['a://b'] })
    expect(
      textOf({
        mode: 'stdout_json',
        value: { hookSpecificOutput: { additionalContext: '上下文' } },
      }).text,
    ).toBe('上下文')
    expect(textOf({ mode: 'stdout_text', value: '纯文本' }).text).toBe('纯文本')
    expect(textOf({ mode: 'return_value', value: { context: '给宿主' } }).text).toBe('给宿主')
    expect(textOf({ mode: 'none', value: null }).text).toBe('')
    expect(textOf({ mode: 'none', value: null }).uris).toEqual(['a://b'])
  })

  it('session.start 多带的那几项单独放，原始响应和真实接口的相同', () => {
    const outcome = restSuccess('lifecycle', {
      ...LIFECYCLE_OK,
      session: { limit: 100, omitted: ['a://b'], dropped: ['recent'] },
    })
    expect(outcome.session).toEqual({ limit: 100, omitted: ['a://b'], dropped: ['recent'] })
    expect(outcome.raw).toEqual(LIFECYCLE_OK)
  })

  it('REST 的 URI 列表：召回的候选、启动节点', () => {
    expect(
      restSuccess('recall', { candidates: [{ uri: 'a://b' }, { uri: 'c://d' }], subjects: [] })
        .uris,
    ).toEqual(['a://b', 'c://d'])
    expect(restSuccess('boot', { entries: [{ uri: 'a://b' }], omitted: ['c://d'] }).uris).toEqual([
      'a://b',
    ])
    expect(JSON.parse(restSuccess('whoami', { spaceId: 's' }).text)).toEqual({ spaceId: 's' })
  })
})
