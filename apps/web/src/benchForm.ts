import type { BenchStep, BenchTool, ChatType, SessionContextInput } from '@kioku/contracts'

// 调用台的表单：页面上的会话上下文、按工具的 inputSchema 生成的表单、表单与 JSON 来回切换。
// 只看结构、不校验：校验交给服务端，工具报错就显示，不合法的请求体也能发出去测。
// 不用 JSON Schema 校验库：ajv 这类库靠 new Function 生成代码，管理界面的内容安全策略不允许

export interface ContextForm {
  // null：不带会话上下文，本机 agent 的钩子就是这样
  chatType: ChatType | null
  platform: string
  groupId: string
  groupName: string
  senderId: string
  senderName: string
}

// 默认用和内置场景相同的固定账号：对象没有删除接口，真实模式下随手填的账号会留下永久的假对象
export const contextDefaults = (): ContextForm => ({
  chatType: null,
  platform: 'bench',
  groupId: 'bench-group',
  groupName: '测试台的群',
  senderId: 'bench-user',
  senderName: '测试台的群友',
})

export const chatTypeLabels: Record<ChatType, string> = {
  direct: '私聊',
  group: '群聊',
  channel: '频道',
  cron: '定时任务',
  subagent: '子 Agent',
}

export const usesGroup = (chatType: ChatType | null) =>
  chatType === 'group' || chatType === 'channel'
export const usesSender = (chatType: ChatType | null) =>
  chatType === 'direct' || usesGroup(chatType)

const platformRef = (id: string, name: string) => ({ id, ...(name ? { name } : {}) })

// 表单换成请求里的 context。不校验：缺群、缺平台的请求也是要测的，服务端返回和 REST 相同的错误。
// 定时任务与子 agent 不看别的字段，私聊不看群
export function contextOf(form: ContextForm): SessionContextInput | undefined {
  if (!form.chatType) return undefined
  const { chatType } = form
  if (!usesSender(chatType)) return { chatType }
  return {
    chatType,
    ...(form.platform ? { platform: form.platform } : {}),
    ...(usesGroup(chatType) && form.groupId
      ? { group: platformRef(form.groupId, form.groupName) }
      : {}),
    ...(form.senderId ? { sender: platformRef(form.senderId, form.senderName) } : {}),
  }
}

// 折叠时显示的一句话
export function contextSummary(form: ContextForm): string {
  if (!form.chatType) return '不带（与本机 Agent 的钩子相同）'
  const parts: string[] = [chatTypeLabels[form.chatType]]
  if (usesSender(form.chatType) && form.platform) parts.push(form.platform)
  if (usesGroup(form.chatType) && form.groupId) parts.push(`群 ${form.groupName || form.groupId}`)
  if (usesSender(form.chatType) && form.senderId) {
    parts.push(`发言人 ${form.senderName || form.senderId}`)
  }
  return parts.join(' · ')
}

export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'json'

export interface FormField {
  // 表单状态的键
  name: string
  label: string
  // 值在请求体里的位置：工具的参数都在第一层，生命周期事件的项目信息在 project 下面
  path: readonly string[]
  kind: FieldKind
  required: boolean
  // 可以显式传 null：和不填不是一回事，kioku_update 的 valid_to 传 null 是清掉
  nullable: boolean
  description: string | null
  multiline: boolean
  options: readonly string[]
  placeholder: string | null
  // 表单一开始就填好的值
  initial: string
}

type Schema = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// 可空的写法有两种：anyOf 里带一项 null，或者 type 是带 null 的数组。可空的算可选
function unwrapNullable(schema: Schema): { inner: Schema; nullable: boolean } {
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants)) {
    const others = variants.filter((v) => !(isRecord(v) && v.type === 'null'))
    const only = others[0]
    if (others.length !== 1 || variants.length !== 2 || !isRecord(only)) {
      return { inner: schema, nullable: false }
    }
    const merged: Schema = { ...only }
    if (schema.description !== undefined) merged.description = schema.description
    if (schema.default !== undefined) merged.default = schema.default
    return { inner: merged, nullable: true }
  }
  if (Array.isArray(schema.type)) {
    const others = schema.type.filter((t) => t !== 'null')
    if (others.length === 1 && schema.type.length === 2) {
      return { inner: { ...schema, type: others[0] }, nullable: true }
    }
  }
  return { inner: schema, nullable: false }
}

function kindOf(schema: Schema): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) return 'enum'
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'json'
  }
}

// 复杂字段的骨架，只做占位文字，不会发出去
function skeleton(raw: unknown, depth = 0): unknown {
  if (!isRecord(raw) || depth > 3) return null
  const { inner } = unwrapNullable(raw)
  switch (inner.type) {
    case 'array':
      return [skeleton(inner.items, depth + 1)]
    case 'object':
      return isRecord(inner.properties)
        ? Object.fromEntries(
            Object.entries(inner.properties).map(([key, value]) => [
              key,
              skeleton(value, depth + 1),
            ]),
          )
        : { 字段名: skeleton(inner.additionalProperties, depth + 1) }
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    default:
      return null
  }
}

function placeholderOf(kind: FieldKind, schema: Schema): string | null {
  if (kind === 'json') return JSON.stringify(skeleton(schema))
  if (schema.default !== undefined) return `默认 ${JSON.stringify(schema.default)}`
  if (schema.format === 'date-time') return '例如 2026-12-31T23:59:00+08:00'
  return null
}

// 比这个长的字符串用多行输入框
const LONG_TEXT = 500

function fieldOf(name: string, raw: unknown, required: boolean): FormField {
  const { inner, nullable } = unwrapNullable(isRecord(raw) ? raw : {})
  const kind = kindOf(inner)
  return {
    name,
    label: name,
    path: [name],
    kind,
    required: required && !nullable,
    nullable,
    description: typeof inner.description === 'string' ? inner.description : null,
    multiline:
      kind === 'string' && typeof inner.maxLength === 'number' && inner.maxLength > LONG_TEXT,
    options:
      kind === 'enum' ? (inner.enum as string[]) : kind === 'boolean' ? ['true', 'false'] : [],
    placeholder: placeholderOf(kind, inner),
    initial: '',
  }
}

// 按 inputSchema 生成字段，复杂字段（数组、对象）用 JSON 文本框。看不懂的 schema 返回 null，这个工具只能写 JSON。
// 不追求覆盖全部 JSON Schema：只认顶层的 properties
export function fieldsOf(inputSchema: unknown): FormField[] | null {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return null
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : []
  return Object.entries(inputSchema.properties).map(([name, schema]) =>
    fieldOf(name, schema, required.includes(name)),
  )
}

// 表单现在的内容：一律是字符串，空串表示不填。nulls 记下要显式传 null 的字段
export interface FormState {
  values: Record<string, string>
  nulls: Record<string, boolean>
}

export const initialState = (fields: readonly FormField[]): FormState => ({
  values: Object.fromEntries(fields.map((field) => [field.name, field.initial])),
  nulls: {},
})

function setAt(target: Record<string, unknown>, path: readonly string[], value: unknown) {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (!isRecord(node[key])) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path.at(-1)!] = value
}

function valueAt(source: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = source
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

export type Assembled = { ok: true; body: Record<string, unknown> } | { ok: false; error: string }

// 表单换成请求的内容。没填的不发，必填的没填也发出去，由服务端报错：不合法的请求也是要测的。
// 数字解析不了时原样发（类型不对同样由服务端报）。只有 JSON 文本框写错才发不出去
export function assemble(fields: readonly FormField[], state: FormState): Assembled {
  const body: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.nullable && state.nulls[field.name]) {
      setAt(body, field.path, null)
      continue
    }
    const raw = state.values[field.name] ?? ''
    if (field.kind === 'string' || field.kind === 'enum') {
      if (raw) setAt(body, field.path, raw)
      continue
    }
    const text = raw.trim()
    if (!text) continue
    if (field.kind === 'number') {
      const number = Number(text)
      setAt(body, field.path, Number.isFinite(number) ? number : raw)
    } else if (field.kind === 'boolean') {
      setAt(body, field.path, text === 'true')
    } else {
      try {
        setAt(body, field.path, JSON.parse(text))
      } catch {
        return { ok: false, error: `${field.label} 不是合法的 JSON` }
      }
    }
  }
  return { ok: true, body }
}

// 请求的内容放回表单。放不下的（类型不对、不在枚举里）留空，由 stateOfBody 比对出来
function stateFromBody(fields: readonly FormField[], body: Record<string, unknown>): FormState {
  const state: FormState = { values: {}, nulls: {} }
  for (const field of fields) {
    const value = valueAt(body, field.path)
    if (value === undefined) continue
    if (value === null) {
      if (field.nullable) state.nulls[field.name] = true
    } else if (field.kind === 'json') {
      state.values[field.name] = JSON.stringify(value, null, 2)
    } else if (
      field.kind === 'number'
        ? typeof value === 'number'
        : field.kind === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && (field.kind !== 'enum' || field.options.includes(value))
    ) {
      state.values[field.name] = String(value)
    }
  }
  return state
}

// 比较时不看键的顺序
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

export type TargetGroup = 'lifecycle' | 'tool' | 'rest'

// 调用台能发的调用：工具来自真实的 tools/list，生命周期事件与 REST 是这里写的简单表单
export interface CallTarget {
  id: string
  group: TargetGroup
  description: string | null
  readOnly: boolean
  destructive: boolean
  // null：inputSchema 看不懂，只能写 JSON
  fields: FormField[] | null
  // /boot 与 /whoami 没有请求内容
  hasBody: boolean
  // 带不带页面上的会话上下文：工具不带，真实的 MCP 也不带
  usesContext: boolean
  // 请求体里固定的部分
  fixed: Record<string, unknown>
  toStep(body: unknown): BenchStep
}

export const targetGroups: { value: TargetGroup; label: string }[] = [
  { value: 'lifecycle', label: '生命周期事件' },
  { value: 'tool', label: 'MCP 工具' },
  { value: 'rest', label: 'REST' },
]

function textField(name: string, label: string, extra: Partial<FormField> = {}): FormField {
  return {
    name,
    label,
    path: [name],
    kind: 'string',
    required: false,
    nullable: false,
    description: null,
    multiline: false,
    options: [],
    placeholder: null,
    initial: '',
    ...extra,
  }
}

const sessionIdField = (required: boolean) =>
  textField('sessionId', 'sessionId', {
    required,
    initial: 'bench-session',
    description: '客户端的会话标识',
  })

const staticTarget = (
  id: string,
  group: TargetGroup,
  description: string,
  rest: Pick<CallTarget, 'fields' | 'hasBody' | 'usesContext' | 'fixed' | 'toStep'>,
): CallTarget => ({ id, group, description, readOnly: false, destructive: false, ...rest })

const lifecycleTarget = (id: string, description: string, fields: FormField[]) =>
  staticTarget(id, 'lifecycle', description, {
    fields,
    hasBody: true,
    usesContext: true,
    fixed: { event: id },
    toStep: (body) => ({ kind: 'lifecycle', body }),
  })

const LIFECYCLE_TARGETS: CallTarget[] = [
  lifecycleTarget('session.start', '会话开始：客户端收到启动加载内容。', [
    sessionIdField(false),
    textField('dirName', '目录名', {
      path: ['project', 'dirName'],
      description: '目录名与仓库名用于召回当前项目相关的记忆，可不填',
    }),
    textField('repoName', '仓库名', { path: ['project', 'repoName'] }),
  ]),
  lifecycleTarget('prompt.submit', '每轮输入：客户端收到本轮的召回块。', [
    sessionIdField(false),
    textField('prompt', 'prompt', { required: true, multiline: true }),
  ]),
  lifecycleTarget(
    'turn.end',
    '一轮结束：本轮写入对话缓冲，累积成批后抽取。需带私聊、群聊或频道的会话上下文。',
    [
      sessionIdField(true),
      textField('user', 'user', { required: true, multiline: true }),
      textField('reply', 'reply', { required: true, multiline: true }),
    ],
  ),
]

const REST_TARGETS: CallTarget[] = [
  staticTarget('/recall', 'rest', '按查询召回候选，与 POST /v1/recall 相同。', {
    fields: [
      textField('query', 'query', { required: true, multiline: true }),
      textField('limit', 'limit', { kind: 'number', placeholder: '默认 8' }),
    ],
    hasBody: true,
    usesContext: true,
    fixed: {},
    toStep: (body) => ({ kind: 'recall', body }),
  }),
  staticTarget('/boot', 'rest', '启动加载的节点，含结构化 entries，与 GET /v1/boot 相同。', {
    fields: [],
    hasBody: false,
    usesContext: false,
    fixed: {},
    toStep: () => ({ kind: 'boot' }),
  }),
  staticTarget('/whoami', 'rest', '当前 Key 的应用与当前上限，与 GET /v1/whoami 相同。', {
    fields: [],
    hasBody: false,
    usesContext: false,
    fixed: {},
    toStep: () => ({ kind: 'whoami' }),
  }),
]

function toolTarget(tool: BenchTool): CallTarget {
  const annotations = isRecord(tool.annotations) ? tool.annotations : {}
  return {
    id: tool.name,
    group: 'tool',
    description: tool.description ?? null,
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
    fields: fieldsOf(tool.inputSchema),
    hasBody: true,
    usesContext: false,
    fixed: {},
    toStep: (body) => ({
      kind: 'tool',
      tool: tool.name,
      arguments: body as Record<string, unknown>,
    }),
  }
}

export const callTargets = (tools: readonly BenchTool[]): CallTarget[] => [
  ...LIFECYCLE_TARGETS,
  ...tools.map(toolTarget),
  ...REST_TARGETS,
]

// 工具目录的状态：还在读取、读取失败、读到了
export type CatalogState = 'pending' | 'failed' | 'ready'

// 选中的调用现在为什么不能运行，能运行时是 null。工具来自真实的 tools/list：目录还在读取、读取失败，
// 或者这把 Key 没有这个工具时它不在目录里。不能退回别的调用：发出去的就是另一个请求了，
// 带群聊上下文时还会新建删不掉的对象
export function targetUnavailable(
  target: Pick<CallTarget, 'id'>,
  targets: readonly Pick<CallTarget, 'id'>[],
  catalog: CatalogState,
): string | null {
  if (targets.some((t) => t.id === target.id)) return null
  if (catalog === 'pending') return `工具目录读取中，完成前无法运行 ${target.id}。`
  if (catalog === 'failed') return `工具目录读取失败，成功读取前无法运行 ${target.id}。`
  return `当前 Key 的工具目录中没有 ${target.id}，无法运行。请选择其他调用。`
}

// 一个调用的草稿。切到别的调用再切回来时还在，只在内存里：可能有明文，不进浏览器存储
export interface Draft {
  json: boolean
  state: FormState
  text: string
  // 进入 JSON 模式时的内容：和它不同才算改过
  base: string
}

export function newDraft(target: CallTarget): Draft {
  const text = target.fields === null ? '{}' : ''
  return {
    json: target.fields === null,
    state: initialState(target.fields ?? []),
    text,
    base: text,
  }
}

// 这份草稿的 JSON 改过：只在内存里，离开页面就没了，要先问一声
export const draftEdited = (draft: Pick<Draft, 'json' | 'text' | 'base'>) =>
  draft.json && draft.text !== draft.base

// 请求的内容：固定的部分、表单的字段、页面上的会话上下文
export function bodyOf(
  target: CallTarget,
  state: FormState,
  context: SessionContextInput | undefined,
): Assembled {
  const assembled = assemble(target.fields ?? [], state)
  if (!assembled.ok) return assembled
  return {
    ok: true,
    body: {
      ...target.fixed,
      ...assembled.body,
      ...(target.usesContext && context ? { context } : {}),
    },
  }
}

// 请求的内容放回表单。放回去再组装一次要和原来相同才算放得下：多余的字段、类型不对、
// context 和页面上的不同都放不下，不悄悄丢内容
export function stateOfBody(
  target: CallTarget,
  body: unknown,
  context: SessionContextInput | undefined,
): FormState | null {
  if (!target.fields || !isRecord(body)) return null
  const state = stateFromBody(target.fields, body)
  const back = bodyOf(target, state, context)
  return back.ok && sameJson(back.body, body) ? state : null
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: '不是合法的 JSON' }
  }
}

// 切到 JSON：表单现在的内容写成 JSON
export function jsonFromForm(
  target: CallTarget,
  draft: Draft,
  context: SessionContextInput | undefined,
): { ok: true; text: string } | { ok: false; error: string } {
  const body = bodyOf(target, draft.state, context)
  return body.ok ? { ok: true, text: JSON.stringify(body.body, null, 2) } : body
}

// 切回表单：放不下就留在 JSON
export function formFromJson(
  target: CallTarget,
  draft: Draft,
  context: SessionContextInput | undefined,
): { ok: true; state: FormState } | { ok: false; error: string } {
  const parsed = parseJson(draft.text)
  if (!parsed.ok) return parsed
  const state = stateOfBody(target, parsed.value, context)
  return state
    ? { ok: true, state }
    : {
        ok: false,
        error: `此 JSON 无法转为表单（含多余字段、类型不符${target.usesContext ? '，或 context 与上方的会话上下文不同' : ''}）。请继续编辑 JSON，或点击「重置」。`,
      }
}

export type BuiltStep = { ok: true; step: BenchStep } | { ok: false; error: string }

// 这个调用要发的步骤。JSON 模式下原样发：生命周期事件与 /recall 不合法的请求体也是要测的，
// 只有工具的参数必须是对象（运行请求的契约要求），不然整个运行都发不出去
export function buildStep(
  target: CallTarget,
  draft: Draft,
  context: SessionContextInput | undefined,
): BuiltStep {
  if (!target.hasBody) return { ok: true, step: target.toStep(undefined) }
  if (draft.json) {
    const parsed = parseJson(draft.text)
    if (!parsed.ok) return parsed
    if (target.group === 'tool' && !isRecord(parsed.value)) {
      return { ok: false, error: '工具参数必须是 JSON 对象' }
    }
    return { ok: true, step: target.toStep(parsed.value) }
  }
  const body = bodyOf(target, draft.state, context)
  return body.ok ? { ok: true, step: target.toStep(body.body) } : body
}

// JSON 模式发的是这段 JSON，页面上的会话上下文不起作用。两边不同时要说出来：页面上选了群聊、摘要也显示群聊，
// 请求却按 JSON 里的执行（没写 context 就是不带，读得到私人层），会得出错误的权限结论
export function jsonContextDiffers(
  target: CallTarget,
  draft: Draft,
  context: SessionContextInput | undefined,
): boolean {
  if (!target.usesContext || !draft.json) return false
  const parsed = parseJson(draft.text)
  // 语法错的发不出去，运行时会说
  if (!parsed.ok) return false
  const sent = isRecord(parsed.value) ? parsed.value.context : undefined
  return !sameJson(sent, context)
}
