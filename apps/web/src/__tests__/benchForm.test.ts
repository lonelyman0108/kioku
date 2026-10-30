import { BenchRunRequest, BenchToolList, SessionContextInput } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  assemble,
  bodyOf,
  buildStep,
  callTargets,
  contextDefaults,
  contextOf,
  contextSummary,
  fieldsOf,
  formFromJson,
  initialState,
  jsonContextDiffers,
  jsonFromForm,
  newDraft,
  stateOfBody,
  targetUnavailable,
  type FormField,
  type FormState,
} from '../benchForm'
import toolList from './benchTools.fixture.json'

// 真实的 tools/list 的快照：可空的 anyOf、type 数组、record、对象数组都在里面
const { tools } = BenchToolList.parse({ tools: toolList })
const targets = callTargets(tools)
const targetOf = (id: string) => targets.find((t) => t.id === id)!
const fieldsFor = (id: string) => targetOf(id).fields!
const fieldOf = (id: string, name: string) => fieldsFor(id).find((f) => f.name === name)!

// 只改给定的几项，其余按表单一开始的样子
const stateOf = (
  fields: readonly FormField[],
  values: Record<string, string>,
  nulls: Record<string, boolean> = {},
): FormState => ({ values: { ...initialState(fields).values, ...values }, nulls })

const GROUP = contextOf({ ...contextDefaults(), chatType: 'group' })

describe('选中的调用不在目录里', () => {
  const noTools = callTargets([])
  const get = targetOf('kioku_get')
  const start = targetOf('session.start')

  it('目录里有：能运行，不管目录是什么状态（读取失败时手上还有旧的）', () => {
    expect(targetUnavailable(get, targets, 'ready')).toBeNull()
    expect(targetUnavailable(get, targets, 'failed')).toBeNull()
  })

  it('选中的不是工具：目录没读到也能运行', () => {
    expect(targetUnavailable(start, noTools, 'pending')).toBeNull()
    expect(targetUnavailable(start, noTools, 'failed')).toBeNull()
    expect(targetUnavailable(targetOf('/whoami'), noTools, 'pending')).toBeNull()
  })

  it('目录还在读取：说明，不能运行', () => {
    expect(targetUnavailable(get, noTools, 'pending')).toBe(
      '工具目录还在读取，读到之前不能运行 kioku_get。',
    )
  })

  it('目录读取失败：说明，不能运行', () => {
    expect(targetUnavailable(get, noTools, 'failed')).toBe(
      '工具目录读取失败，读到之前不能运行 kioku_get。',
    )
  })

  it('这把 Key 没有这个工具：说明，不能运行', () => {
    expect(targetUnavailable(get, [start], 'ready')).toBe(
      '这把 Key 的工具目录里没有 kioku_get，不能运行：换一个调用。',
    )
  })
})

describe('按 inputSchema 生成表单', () => {
  it('工具目录来自 tools/list，带只读与破坏性的提示', () => {
    expect(targets.filter((t) => t.group === 'tool').map((t) => t.id)).toEqual(
      tools.map((t) => t.name),
    )
    expect(targetOf('kioku_get').readOnly).toBe(true)
    expect(targetOf('kioku_get').destructive).toBe(false)
    expect(targetOf('kioku_delete').destructive).toBe(true)
    expect(targetOf('kioku_delete').readOnly).toBe(false)
    expect(targetOf('kioku_create').readOnly).toBe(false)
    expect(targetOf('kioku_get').description).toContain('按 URI 读取')
  })

  it('没有参数的工具没有字段', () => {
    expect(fieldsFor('kioku_boot')).toEqual([])
  })

  it('字符串、数字、枚举与必填', () => {
    const query = fieldOf('kioku_search', 'query')
    expect(query).toMatchObject({ kind: 'string', required: true, multiline: true })
    expect(query.description).toContain('要找的内容')
    expect(fieldOf('kioku_search', 'limit')).toMatchObject({ kind: 'number', required: false })
    expect(fieldOf('kioku_create', 'layer')).toMatchObject({ kind: 'enum', required: false })
    expect(fieldOf('kioku_create', 'layer').options).toContain('private')
    expect(fieldOf('kioku_create', 'priority').placeholder).toBe('默认 2')
    expect(fieldOf('kioku_create', 'uri')).toMatchObject({ required: true, multiline: false })
    expect(fieldOf('kioku_create', 'valid_to').placeholder).toContain('2026-12-31')
  })

  it('可空的两种写法都算可选，说明取外层的', () => {
    const anyOf = fieldOf('kioku_update', 'valid_to')
    expect(anyOf).toMatchObject({ kind: 'string', nullable: true, required: false })
    expect(anyOf.description).toContain('填 null 清掉')
    expect(fieldOf('kioku_update', 'disclosure')).toMatchObject({
      kind: 'string',
      nullable: true,
    })
    expect(fieldOf('kioku_credential_save', 'description')).toMatchObject({
      kind: 'string',
      nullable: true,
      required: false,
    })
    // 就算写在 required 里，可空的也不算必填
    const [field] = fieldsOf({
      properties: { a: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
      required: ['a'],
    })!
    expect(field).toMatchObject({ kind: 'number', nullable: true, required: false })
  })

  it('数组与对象用 JSON 文本框，占位文字是骨架', () => {
    expect(fieldOf('kioku_create', 'glossary')).toMatchObject({
      kind: 'json',
      placeholder: '[""]',
    })
    expect(fieldOf('kioku_credential_save', 'values')).toMatchObject({
      kind: 'json',
      placeholder: '{"字段名":""}',
    })
    expect(fieldOf('kioku_credential_save', 'fields').placeholder).toBe(
      '[{"name":"","source_field":""}]',
    )
  })

  it('布尔与说不清的类型', () => {
    const fields = fieldsOf({
      properties: {
        flag: { type: 'boolean' },
        mixed: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        unknown: {},
      },
    })!
    expect(fields.map((f) => f.kind)).toEqual(['boolean', 'json', 'json'])
    expect(fields[0]!.options).toEqual(['true', 'false'])
  })

  it('看不懂的 schema 只能写 JSON', () => {
    expect(fieldsOf({ type: 'object' })).toBeNull()
    expect(fieldsOf(undefined)).toBeNull()
    const [target] = callTargets([{ name: 'odd', inputSchema: { type: 'string' } }]).filter(
      (t) => t.group === 'tool',
    )
    expect(target!.fields).toBeNull()
    expect(newDraft(target!)).toMatchObject({ json: true, text: '{}' })
  })
})

describe('表单换成请求', () => {
  const fields = fieldsOf({
    properties: {
      text: { type: 'string' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      level: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'string' } },
      gone: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['text'],
  })!

  it('没填的不发，必填的也不替用户拦：由服务端报错', () => {
    expect(assemble(fields, stateOf(fields, {}))).toEqual({ ok: true, body: {} })
  })

  it('按字段的类型转换，字符串原样不去空白', () => {
    const state = stateOf(fields, {
      text: '  两边有空格  ',
      count: ' 3 ',
      flag: 'false',
      level: 'b',
      list: '["x"]',
    })
    expect(assemble(fields, state)).toEqual({
      ok: true,
      body: { text: '  两边有空格  ', count: 3, flag: false, level: 'b', list: ['x'] },
    })
  })

  it('解析不了的数字原样发，类型错误由服务端报', () => {
    expect(assemble(fields, stateOf(fields, { count: 'abc' }))).toEqual({
      ok: true,
      body: { count: 'abc' },
    })
  })

  it('JSON 写错了发不出去，说明是哪个字段', () => {
    expect(assemble(fields, stateOf(fields, { list: '[oops' }))).toEqual({
      ok: false,
      error: 'list 不是合法的 JSON',
    })
  })

  it('可空的字段可以显式传 null，优先于填的内容；不可空的不理会', () => {
    expect(assemble(fields, stateOf(fields, { gone: 'x' }, { gone: true }))).toEqual({
      ok: true,
      body: { gone: null },
    })
    expect(assemble(fields, stateOf(fields, { text: 'x' }, { text: true }))).toEqual({
      ok: true,
      body: { text: 'x' },
    })
  })
})

describe('表单与 JSON 来回切换', () => {
  const update = targetOf('kioku_update')

  it('表单写成 JSON，再放回表单，内容不变', () => {
    const draft = {
      ...newDraft(update),
      state: stateOf(
        update.fields!,
        { uri: 'core://a', priority: '3', glossary_add: '["词语"]', sensitivity: 'private' },
        { valid_to: true },
      ),
    }
    const json = jsonFromForm(update, draft, undefined)
    expect(json.ok && JSON.parse(json.text)).toEqual({
      uri: 'core://a',
      priority: 3,
      glossary_add: ['词语'],
      sensitivity: 'private',
      valid_to: null,
    })
    const back = formFromJson(update, { ...draft, text: json.ok ? json.text : '' }, undefined)
    expect(back.ok && bodyOf(update, back.state, undefined)).toEqual(
      bodyOf(update, draft.state, undefined),
    )
  })

  it('键的顺序不算不同', () => {
    expect(stateOfBody(update, { priority: 1, uri: 'a://b' }, undefined)).not.toBeNull()
  })

  it.each([
    ['多余的字段', { uri: 'a://b', extra: 1 }],
    ['类型不对', { uri: 'a://b', priority: '${version}' }],
    ['不在枚举里', { uri: 'a://b', sensitivity: 'top' }],
    ['表单表示不了的空串', { uri: '' }],
    ['不可空的字段写了 null', { uri: null }],
    ['不是对象', [1]],
  ])('%s：放不回表单，不悄悄丢内容', (_name, body) => {
    expect(stateOfBody(update, body, undefined)).toBeNull()
  })

  it('放不下时留在 JSON，并说明原因；写错的 JSON 也一样', () => {
    const draft = { ...newDraft(update), json: true, text: '{"uri":"a://b","extra":1}' }
    const refused = formFromJson(update, draft, undefined)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toContain('表单放不下')
    expect(!refused.ok && refused.error).not.toContain('context')
    expect(formFromJson(update, { ...draft, text: '{oops' }, undefined)).toEqual({
      ok: false,
      error: '不是合法的 JSON',
    })
  })

  it('生命周期事件：项目信息放在 project 下面，event 与 context 不进表单', () => {
    const start = targetOf('session.start')
    const state = stateOf(start.fields!, { dirName: 'kioku' })
    const body = bodyOf(start, state, GROUP)
    expect(body).toEqual({
      ok: true,
      body: {
        event: 'session.start',
        sessionId: 'bench-session',
        project: { dirName: 'kioku' },
        context: GROUP,
      },
    })
    const back = stateOfBody(start, body.ok ? body.body : null, GROUP)
    expect(back?.values).toMatchObject({ dirName: 'kioku', sessionId: 'bench-session' })
  })

  it('context 和页面上的不同、event 改了、project 有多余的字段：放不回表单', () => {
    const start = targetOf('session.start')
    const body = { event: 'session.start', context: GROUP }
    expect(stateOfBody(start, body, undefined)).toBeNull()
    expect(stateOfBody(start, { event: 'session.start' }, GROUP)).toBeNull()
    expect(stateOfBody(start, { event: 'prompt.submit' }, undefined)).toBeNull()
    expect(
      stateOfBody(start, { event: 'session.start', project: { other: 'x' } }, undefined),
    ).toBeNull()
    const refused = formFromJson(
      start,
      { ...newDraft(start), text: JSON.stringify(body) },
      undefined,
    )
    expect(!refused.ok && refused.error).toContain('context')
  })
})

describe('发出去的步骤', () => {
  const buildWith = (
    id: string,
    values: Record<string, string>,
    context: SessionContextInput | undefined,
  ) => {
    const target = targetOf(id)
    return buildStep(
      target,
      { ...newDraft(target), state: stateOf(target.fields!, values) },
      context,
    )
  }
  const build = (id: string, values: Record<string, string>) => buildWith(id, values, GROUP)
  const stepOf = (built: ReturnType<typeof build>) => {
    if (!built.ok) throw new Error(built.error)
    return built.step
  }

  it('工具步骤不带会话上下文：真实的 MCP 也不带', () => {
    expect(stepOf(build('kioku_get', { uri: 'core://agent' }))).toEqual({
      kind: 'tool',
      tool: 'kioku_get',
      arguments: { uri: 'core://agent' },
    })
    expect(targets.filter((t) => t.group === 'tool').every((t) => !t.usesContext)).toBe(true)
  })

  it('生命周期事件与 /recall 带页面上的会话上下文', () => {
    expect(stepOf(build('prompt.submit', { prompt: '你好' }))).toEqual({
      kind: 'lifecycle',
      body: {
        event: 'prompt.submit',
        sessionId: 'bench-session',
        prompt: '你好',
        context: GROUP,
      },
    })
    expect(stepOf(build('turn.end', { user: '问', reply: '答' }))).toEqual({
      kind: 'lifecycle',
      body: {
        event: 'turn.end',
        sessionId: 'bench-session',
        user: '问',
        reply: '答',
        context: GROUP,
      },
    })
    expect(stepOf(build('/recall', { query: '查', limit: '5' }))).toEqual({
      kind: 'recall',
      body: { query: '查', limit: 5, context: GROUP },
    })
  })

  it('没选上下文时不带 context 字段', () => {
    const step = stepOf(buildWith('prompt.submit', { prompt: '你好' }, undefined))
    expect(step).toEqual({
      kind: 'lifecycle',
      body: { event: 'prompt.submit', sessionId: 'bench-session', prompt: '你好' },
    })
  })

  it('/boot 与 /whoami 没有请求内容', () => {
    expect(stepOf(build('/boot', {}))).toEqual({ kind: 'boot' })
    expect(stepOf(build('/whoami', {}))).toEqual({ kind: 'whoami' })
  })

  it('每种调用都过得了运行请求的契约', () => {
    const steps = targets.map((target) => stepOf(buildStep(target, newDraft(target), GROUP)))
    expect(steps).toHaveLength(targets.length)
    expect(BenchRunRequest.safeParse({ steps }).success).toBe(true)
  })

  it('JSON 模式：生命周期事件与 /recall 原样发，不合法的请求体也是要测的', () => {
    const target = targetOf('turn.end')
    const step = buildStep(target, { ...newDraft(target), json: true, text: '"不是对象"' }, GROUP)
    expect(step).toEqual({ ok: true, step: { kind: 'lifecycle', body: '不是对象' } })
    const recall = buildStep(
      targetOf('/recall'),
      { ...newDraft(targetOf('/recall')), json: true, text: '{"limit":999}' },
      GROUP,
    )
    expect(recall).toEqual({ ok: true, step: { kind: 'recall', body: { limit: 999 } } })
  })

  it('JSON 模式：工具的参数要是对象，语法错的发不出去', () => {
    const target = targetOf('kioku_get')
    const draft = { ...newDraft(target), json: true, text: '[1]' }
    expect(buildStep(target, draft, undefined)).toEqual({
      ok: false,
      error: '工具的参数要是一个 JSON 对象',
    })
    expect(buildStep(target, { ...draft, text: '{oops' }, undefined)).toEqual({
      ok: false,
      error: '不是合法的 JSON',
    })
    expect(buildStep(target, { ...draft, text: '{"uri":1}' }, GROUP)).toEqual({
      ok: true,
      step: { kind: 'tool', tool: 'kioku_get', arguments: { uri: 1 } },
    })
  })

  it('JSON 文本框写错的字段发不出去', () => {
    const built = build('kioku_create', { uri: 'a://b', content: 'x', glossary: '[oops' })
    expect(built).toEqual({ ok: false, error: 'glossary 不是合法的 JSON' })
  })
})

describe('JSON 模式与页面上的会话上下文', () => {
  const DIRECT = contextOf({ ...contextDefaults(), chatType: 'direct' })
  const differs = (id: string, text: string, context: SessionContextInput | undefined) =>
    jsonContextDiffers(targetOf(id), { ...newDraft(targetOf(id)), json: true, text }, context)
  const PROMPT = { event: 'prompt.submit', prompt: '你好' }

  it('JSON 没写 context、页面上选了群聊：发出去的确实不带，要提醒', () => {
    const text = JSON.stringify(PROMPT)
    const target = targetOf('prompt.submit')
    const built = buildStep(target, { ...newDraft(target), json: true, text }, GROUP)
    expect(built).toEqual({ ok: true, step: { kind: 'lifecycle', body: PROMPT } })
    expect(differs('prompt.submit', text, GROUP)).toBe(true)
    expect(differs('/recall', JSON.stringify({ query: '查' }), GROUP)).toBe(true)
  })

  it('JSON 写了 context、页面上不带或者选了别的：要提醒', () => {
    const text = JSON.stringify({ ...PROMPT, context: GROUP })
    expect(differs('prompt.submit', text, undefined)).toBe(true)
    expect(differs('prompt.submit', text, DIRECT)).toBe(true)
    expect(differs('prompt.submit', JSON.stringify({ context: null }), undefined)).toBe(true)
  })

  it('两边相同时不提醒，键的顺序不算不同', () => {
    expect(differs('prompt.submit', JSON.stringify(PROMPT), undefined)).toBe(false)
    expect(differs('prompt.submit', JSON.stringify({ ...PROMPT, context: GROUP }), GROUP)).toBe(
      false,
    )
    const { chatType, platform, group, sender } = GROUP as {
      chatType: string
      platform: string
      group: { id: string; name: string }
      sender: { id: string; name: string }
    }
    const reordered = {
      context: {
        sender: { name: sender.name, id: sender.id },
        group: { name: group.name, id: group.id },
        platform,
        chatType,
      },
    }
    expect(differs('prompt.submit', JSON.stringify(reordered), GROUP)).toBe(false)
  })

  it('从表单切过来时相同，切完再改页面上的就不同了', () => {
    const target = targetOf('turn.end')
    const made = jsonFromForm(target, newDraft(target), GROUP)
    if (!made.ok) throw new Error(made.error)
    expect(differs('turn.end', made.text, GROUP)).toBe(false)
    expect(differs('turn.end', made.text, DIRECT)).toBe(true)
    expect(differs('turn.end', made.text, undefined)).toBe(true)
  })

  it('不是对象的请求体没有 context：页面上选了才算不同', () => {
    expect(differs('turn.end', '"不是对象"', GROUP)).toBe(true)
    expect(differs('turn.end', '[1]', GROUP)).toBe(true)
    expect(differs('turn.end', '"不是对象"', undefined)).toBe(false)
  })

  it('语法错的发不出去，不用提醒', () => {
    expect(differs('prompt.submit', '{oops', GROUP)).toBe(false)
  })

  it('表单模式带的就是页面上的，不用提醒', () => {
    const target = targetOf('prompt.submit')
    const text = JSON.stringify(PROMPT)
    expect(jsonContextDiffers(target, { ...newDraft(target), text }, GROUP)).toBe(false)
  })

  it('工具与不带上下文的 REST 不看页面上的，不用提醒', () => {
    expect(differs('kioku_get', '{"uri":"core://agent"}', GROUP)).toBe(false)
    expect(differs('/boot', '{}', GROUP)).toBe(false)
  })
})

describe('会话上下文', () => {
  const form = (chatType: Parameters<typeof contextOf>[0]['chatType']) => ({
    ...contextDefaults(),
    chatType,
  })

  it('不带时没有 context', () => {
    expect(contextOf(form(null))).toBeUndefined()
    expect(contextSummary(form(null))).toContain('不带')
  })

  it('群聊带平台、群与发言人，默认的固定账号过得了校验', () => {
    const context = contextOf(form('group'))
    expect(context).toEqual({
      chatType: 'group',
      platform: 'bench',
      group: { id: 'bench-group', name: '测试台的群' },
      sender: { id: 'bench-user', name: '测试台的群友' },
    })
    expect(SessionContextInput.safeParse(context).success).toBe(true)
    expect(contextSummary(form('group'))).toBe('群聊 · bench · 群 测试台的群 · 发言人 测试台的群友')
  })

  it('私聊不带群，定时任务与子 agent 只有类型', () => {
    expect(contextOf(form('direct'))).toEqual({
      chatType: 'direct',
      platform: 'bench',
      sender: { id: 'bench-user', name: '测试台的群友' },
    })
    expect(contextOf(form('cron'))).toEqual({ chatType: 'cron' })
    expect(contextOf(form('subagent'))).toEqual({ chatType: 'subagent' })
    expect(contextSummary(form('cron'))).toBe('定时任务')
  })

  it('没填的不带：缺群、缺平台的请求也要能发出去，由服务端报错', () => {
    const blank = { ...form('group'), platform: '', groupId: '', senderName: '' }
    const context = contextOf(blank)
    expect(context).toEqual({ chatType: 'group', sender: { id: 'bench-user' } })
    expect(SessionContextInput.safeParse(context).success).toBe(false)
  })
})
