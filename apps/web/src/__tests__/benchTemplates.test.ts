import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import webPackage from '../../package.json'
import benchForm from '../benchForm?raw'
import benchResult from '../benchResult?raw'
import benchScenarios from '../benchScenarios?raw'
import benchSession from '../benchSession?raw'
import activityEntry from '../components/ActivityEntry.vue?raw'
import appSimulator from '../components/AppSimulator.vue?raw'
import benchAbandoned from '../components/BenchAbandoned.vue?raw'
import benchCalls from '../components/BenchCalls.vue?raw'
import benchContextForm from '../components/BenchContextForm.vue?raw'
import benchField from '../components/BenchField.vue?raw'
import benchScenariosView from '../components/BenchScenarios.vue?raw'
import benchStepView from '../components/BenchStepView.vue?raw'
import benchToolbar from '../components/BenchToolbar.vue?raw'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import useBench from '../composables/useBench?raw'
import { icons } from '../icons'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import benchPage from '../pages/BenchPage.vue?raw'
import routes from '../routes?raw'

// 模板解析出来的节点：看标签、属性与事件，不依赖排版。没有组件测试的环境，所以看模板本身
interface TemplateNode {
  type: number
  tag?: string
  content?: string
  children?: TemplateNode[]
  props?: {
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const TEXT = 2
const INTERPOLATION = 5
const walk = (node: TemplateNode): TemplateNode[] => [node, ...(node.children ?? []).flatMap(walk)]
const sfc = (source: string) => {
  const { descriptor } = parse(source)
  const root = descriptor.template!.ast as unknown as TemplateNode
  return {
    elements: walk(root).filter((n) => n.type === ELEMENT),
    script: descriptor.scriptSetup?.content ?? '',
  }
}
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
// 找不到时按断言失败，说清楚少了什么
const must = (found: TemplateNode | undefined, what: string) => {
  expect(found, `模板里要有 ${what}`).toBeDefined()
  return found!
}
const buttonOf = (elements: TemplateNode[], label: string) =>
  must(
    elements.find(
      (el) =>
        el.tag === 'UButton' &&
        walk(el).some((n) => n.type === TEXT && n.content?.trim().includes(label)),
    ),
    `按钮「${label}」`,
  )
const withTag = (elements: TemplateNode[], tag: string) =>
  must(
    elements.find((el) => el.tag === tag),
    `<${tag}>`,
  )
const withHandler = (elements: TemplateNode[], event: string, expression: string) =>
  must(
    elements.find((el) => handler(el, event) === expression),
    `@${event}="${expression}"`,
  )
// 指令的表达式：if、else-if、for、show、model
const directive = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.exp?.content
const withDirective = (elements: TemplateNode[], name: string, expression: string) =>
  must(
    elements.find((el) => directive(el, name) === expression),
    `v-${name}="${expression}"`,
  )
const withIf = (elements: TemplateNode[], expression: string) =>
  withDirective(elements, 'if', expression)
const withFor = (elements: TemplateNode[], expression: string) =>
  withDirective(elements, 'for', expression)
// 节点里写死的文字与显示的表达式（{{ }}）
const textOf = (el: TemplateNode) =>
  walk(el)
    .filter((n) => n.type === TEXT)
    .map((n) => n.content)
    .join('')
const shownIn = (el: TemplateNode) =>
  walk(el)
    .filter((n) => n.type === INTERPOLATION)
    .map((n) => (n.content as unknown as { content: string }).content)
// 脚本里一段顶层的东西（watch 的回调、computed 的定义）：到第一个顶格的右括号为止
const blockOf = (script: string, start: string) => {
  const from = script.indexOf(start)
  expect(from, `脚本里要有 ${start}`).toBeGreaterThanOrEqual(0)
  const end = script.slice(from).search(/\n[\]})]/)
  return script.slice(from, from + end)
}
// 函数体：按缩进找到和函数同一层的右花括号，不依赖里面写了什么
const bodyOf = (script: string, name: string) => {
  const found = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(script)
  if (!found) throw new Error(`找不到函数 ${name}`)
  return script.slice(found.index, script.indexOf(`\n${found[1]}}`, found.index))
}

const SOURCES = {
  benchForm,
  benchResult,
  benchScenarios,
  benchSession,
  useBench,
  benchPage,
  benchAbandoned,
  benchCalls,
  benchContextForm,
  benchField,
  benchScenariosView,
  benchStepView,
  benchToolbar,
}

describe('调用内容只在内存里', () => {
  it.each(Object.entries(SOURCES))('%s 不碰浏览器存储', (_name, source) => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
  })
})

describe('管理界面的内容安全策略', () => {
  it.each(Object.entries(SOURCES))('%s 不 eval、不渲染 HTML', (_name, source) => {
    expect(source).not.toMatch(/new Function\(|\beval\(|v-html/)
  })

  it('不依赖 JSON Schema 校验库：它们靠 new Function 生成代码', () => {
    const dependencies = { ...webPackage.dependencies, ...webPackage.devDependencies }
    expect(Object.keys(dependencies).filter((name) => /ajv|jsonschema/.test(name))).toEqual([])
    for (const source of Object.values(SOURCES)) expect(source).not.toMatch(/from 'ajv/)
  })
})

describe('真实模式要确认', () => {
  const toolbar = sfc(benchToolbar)

  it('开关只发请求，切到真实只有确认这一条路', () => {
    const toggle = withTag(toolbar.elements, 'USwitch')
    expect(handler(toggle, 'update:model-value')).toBe('requestMode')
    // 开关显示的是真实的模式，确认之前不会先拨过去
    expect(bound(toggle, 'model-value')).toBe('real')
    expect(useBench.match(/mode\.value = 'real'/g)).toHaveLength(1)
    expect(bodyOf(useBench, 'confirmReal')).toContain("mode.value = 'real'")
    const request = bodyOf(useBench, 'requestMode')
    expect(request).toContain('if (wantReal) confirmingReal.value = true')
    expect(request).not.toContain("'real'")
    expect(handler(buttonOf(toolbar.elements, '切到真实模式'), 'click')).toBe('confirmReal')
  })

  it('切回回滚会清掉记录时要确认，确认框说清楚清掉什么；取消不动', () => {
    const request = bodyOf(useBench, 'requestMode')
    expect(request).toContain('else if (modeLoss.value) confirmingRollback.value = true')
    expect(request).toContain("else mode.value = 'rollback'")
    const modal = must(
      toolbar.elements.find(
        (el) => el.tag === 'UModal' && bound(el, 'open') === 'confirmingRollback',
      ),
      '切回回滚的确认框',
    )
    expect(shownIn(modal)).toEqual(['modeLoss'])
    const nodes = walk(modal)
    expect(handler(buttonOf(nodes, '切回回滚'), 'click')).toBe('confirmRollback')
    expect(handler(buttonOf(nodes, '取消'), 'click')).toBe('confirmingRollback = false')
    expect(bodyOf(useBench, 'confirmRollback')).toContain("mode.value = 'rollback'")
  })

  it('切到真实的确认框也说清掉什么，不只看时间线', () => {
    const modal = must(
      toolbar.elements.find((el) => el.tag === 'UModal' && bound(el, 'open') === 'confirmingReal'),
      '切到真实的确认框',
    )
    expect(shownIn(withIf(walk(modal), 'modeLoss'))).toEqual(['modeLoss'])
  })

  it('会清掉的记录按共享的结果与报错算：分页用的就是这一份', () => {
    const records = blockOf(useBench.replaceAll('\n  ', '\n'), 'const modeLoss = ')
    expect(records).toContain('session.value.timeline.length')
    expect(records).toContain('scenarioOutcome.value')
    expect(records).toContain('callFailure.value || scenarioFailure.value')
    expect(sfc(benchCalls).script).toMatch(/\bcallFailure: failure,[^}]*\} = useBench\(\)/)
    const scenarios = sfc(benchScenariosView).script
    expect(scenarios).toMatch(/\bscenarioFailure: failure,[^}]*\} = useBench\(\)/)
    expect(scenarios).toMatch(/\bscenarioOutcome: outcome,[^}]*\} = useBench\(\)/)
  })

  it('确认文字列出后果', () => {
    const line = withFor(toolbar.elements, 'line in REAL_MODE_CONSEQUENCES')
    expect(line.tag).toBe('li')
    expect(shownIn(line)).toEqual(['line'])
  })

  it('应用与 Key 的下拉框接到选择上', () => {
    const select = (label: string) =>
      must(
        toolbar.elements.find(
          (el) =>
            el.tag === 'USelect' &&
            el.props?.some((p) => p.name === 'aria-label' && p.value?.content === label),
        ),
        `下拉框「${label}」`,
      )
    expect(bound(select('应用'), 'model-value')).toBe('appId')
    expect(bound(select('应用'), 'items')).toBe('appItems')
    expect(handler(select('应用'), 'update:model-value')).toBe('(v) => selectApp(String(v))')
    expect(bound(select('Key'), 'model-value')).toBe('keyId')
    expect(bound(select('Key'), 'items')).toBe('keyItems')
    expect(handler(select('Key'), 'update:model-value')).toBe('(v) => selectKey(String(v))')
  })

  it('选择失效的提示能关掉', () => {
    const alert = withIf(toolbar.elements, 'selectionNotice')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('selectionNotice')
    expect(alert.props?.some((p) => p.name === 'close')).toBe(true)
    expect(handler(alert, 'update:open')).toBe('(v) => !v && (selectionNotice = null)')
  })

  it('换了应用或 Key 回到回滚，会话换一份新的', () => {
    expect(useBench).toMatch(
      /watch\(\[spaceId, appId, keyId\], \(\) => \{\s+mode\.value = 'rollback'/,
    )
    expect(useBench).toMatch(
      /watch\(\[spaceId, appId, keyId, mode\], \(\) => \{\s+current\.value = null\s+session\.value = emptySession\(\)/,
    )
  })

  it('运行期间不能换应用、Key 与模式', () => {
    for (const el of toolbar.elements.filter((e) => e.tag === 'USelect' || e.tag === 'USwitch')) {
      expect(bound(el, 'disabled')).toContain('running')
    }
  })

  it('真实模式的标记放在页头：内容滚动时一直看得到', () => {
    const { descriptor } = parse(benchPage)
    const root = descriptor.template!.ast as unknown as TemplateNode
    const header = walk(root).find(
      (n) => n.tag === 'template' && n.props?.some((p) => p.arg?.content === 'header'),
    )!
    const banner = walk(header).find((n) => n.props?.some((p) => p.exp?.content === 'real'))
    expect(banner).toBeDefined()
    expect(walk(banner!).some((n) => n.content?.includes('真实模式'))).toBe(true)
  })
})

describe('调用台的运行', () => {
  const calls = sfc(benchCalls)

  it('真实模式下回车不执行，只有点按钮才执行', () => {
    const form = withTag(calls.elements, 'form')
    expect(handler(form, 'submit')).toBe('onSubmit')
    expect(bodyOf(calls.script, 'onSubmit')).toContain('if (!real.value)')
    const button = withHandler(calls.elements, 'click', 'onRunClick')
    // 真实模式下不是提交按钮：不然回车的隐式提交会点它
    expect(bound(button, 'type')).toBe("real ? 'button' : 'submit'")
    expect(bodyOf(calls.script, 'onRunClick')).toContain('if (real.value)')
  })

  it('校验不拦在浏览器：表单不带 required 的原生校验', () => {
    const form = withTag(calls.elements, 'form')
    expect(form.props?.some((p) => p.name === 'novalidate')).toBe(true)
  })

  it('连续调用走带重放的那条路', () => {
    expect(bodyOf(calls.script, 'run')).toContain('await call(')
    expect(bodyOf(useBench, 'call')).toContain('replayFor(session.value, mode.value)')
    expect(bodyOf(useBench, 'call')).toContain('recordRun(session.value, outcome.result)')
    expect(bodyOf(useBench, 'call')).toContain('runBlocker(session.value, mode.value)')
  })

  it('页面上写明工具调用不带会话上下文', () => {
    // 看模板里的文字：脚本的注释里也有这句
    expect(textOf(calls.elements[0]!)).toContain('工具调用不带会话上下文，真实的 MCP 也不带')
    const form = sfc(benchContextForm)
    expect(textOf(form.elements[0]!)).toContain('工具调用不带：真实的 MCP 也不带')
  })

  it('会话上下文的表单接到共享的状态，折叠时也看得到选了什么', () => {
    const form = sfc(benchContextForm)
    const models = form.elements.map((el) => directive(el, 'model')).filter(Boolean)
    expect(models).toEqual([
      'contextForm.chatType',
      'contextForm.platform',
      'contextForm.groupId',
      'contextForm.groupName',
      'contextForm.senderId',
      'contextForm.senderName',
    ])
    expect(shownIn(withTag(form.elements, 'summary'))).toEqual(['summary'])
    expect(form.script).toContain('contextSummary(contextForm)')
  })
})

describe('调用台的目录与表单', () => {
  const calls = sfc(benchCalls)

  it.each(['t', 'target'])('目录与标题都显示只读与破坏性（%s）', (name) => {
    const readOnly = withIf(calls.elements, `${name}.readOnly`)
    expect(readOnly.tag).toBe('UBadge')
    expect(textOf(readOnly)).toContain('只读')
    const destructive = withIf(calls.elements, `${name}.destructive`)
    expect(destructive.tag).toBe('UBadge')
    expect(textOf(destructive)).toContain('破坏性')
  })

  it('目录来自真实的 tools/list，点一项换成它', () => {
    expect(calls.script).toContain('api.benchTools(spaceId.value, appId.value!, keyId.value!)')
    expect(calls.script).toContain('callTargets(tools.data.value?.tools ?? [])')
    const item = withFor(calls.elements, 't in group.targets')
    const button = withTag(walk(item), 'button')
    expect(handler(button, 'click')).toBe('targetId = t.id')
    expect(shownIn(button)).toEqual(['t.id'])
  })

  it('显示工具的说明', () => {
    const description = withIf(calls.elements, 'target.description')
    expect(shownIn(description)).toEqual(['target.description'])
  })

  it('表单与 JSON 来回切换，放不回去时说明原因', () => {
    expect(handler(buttonOf(calls.elements, '写 JSON'), 'click')).toBe('showJson')
    expect(handler(buttonOf(calls.elements, '用表单'), 'click')).toBe('showForm')
    expect(handler(buttonOf(calls.elements, '重置'), 'click')).toBe('resetDraft')
    expect(bodyOf(calls.script, 'showJson')).toContain(
      'jsonFromForm(target.value, draft.value, sessionContext.value)',
    )
    const back = bodyOf(calls.script, 'showForm')
    expect(back).toContain('formFromJson(target.value, draft.value, sessionContext.value)')
    expect(back).toContain('formError.value = made.error')
    const alert = withIf(calls.elements, 'formError')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('formError')
    expect(bound(withIf(calls.elements, 'failure'), 'title')).toBe('failure')
  })

  it('JSON 模式说的是 JSON 里的 context，只有表单模式才说带上面的', () => {
    const scope = withDirective(calls.elements, 'else-if', 'target.usesContext')
    const [json, form] = scope.children!.filter((n) => n.type === ELEMENT)
    expect(directive(json!, 'if')).toBe('draft.json')
    expect(textOf(json!)).toContain('只发这段 JSON 里的 context')
    expect(textOf(json!)).toContain('上面的会话上下文不起作用')
    expect(form!.props?.some((p) => p.name === 'else')).toBe(true)
    expect(textOf(form!)).toContain('这个调用带上面的会话上下文')
    // 这句只在表单模式下出现
    expect(benchCalls.match(/这个调用带上面的会话上下文/g)).toHaveLength(1)
  })

  it('JSON 里的 context 和页面上的不同时警告', () => {
    const alert = withIf(calls.elements, 'contextDiffers')
    expect(alert.tag).toBe('UAlert')
    expect(alert.props?.find((p) => p.name === 'color')?.value?.content).toBe('warning')
    const title = alert.props?.find((p) => p.name === 'title')?.value?.content
    expect(title).toContain('和上面的会话上下文不同')
    expect(title).toContain('按 JSON 里的执行')
    expect(calls.script).toContain(
      'jsonContextDiffers(target.value, draft.value, sessionContext.value)',
    )
  })
})

describe('选中的工具不在目录里', () => {
  const calls = sfc(benchCalls)

  it('不退回别的调用：表单留着，运行禁用并说明', () => {
    const target = blockOf(calls.script, 'const target = ')
    expect(target).toContain('seen.get(targetId.value)!')
    expect(target).not.toContain('targets.value[0]')
    expect(blockOf(calls.script, 'const unavailable = ')).toContain(
      "tools.data.value ? 'ready' : tools.isError.value ? 'failed' : 'pending'",
    )
    const button = withHandler(calls.elements, 'click', 'onRunClick')
    expect(bound(button, 'disabled')).toBe('Boolean(unavailable || blocker)')
    const alert = withIf(calls.elements, 'unavailable')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('unavailable')
  })

  it('回车也拦：表单提交与按钮走的都是 run', () => {
    expect(bodyOf(calls.script, 'run')).toContain('if (running.value || unavailable.value) return')
  })

  it('目录读取失败时显示原因，能重新读取', () => {
    expect(blockOf(calls.script, 'const toolsError = ')).toContain(
      'catalogFailure(tools.error.value)',
    )
    const alert = withIf(calls.elements, 'toolsError')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('toolsError')
    expect(bound(alert, 'actions')).toBe('retryTools')
    expect(blockOf(calls.script, 'const retryTools = ')).toContain('tools.refetch()')
  })
})

describe('切换调用', () => {
  const calls = sfc(benchCalls)

  it('上一个调用的说明一起清掉：写错的与运行失败的', () => {
    const body = blockOf(calls.script, 'watch(targetId, ')
    expect(body).toContain('formError.value = null')
    expect(body).toContain('failure.value = null')
  })

  it('运行期间切走了，失败的说明带上是哪一个调用的', () => {
    const body = bodyOf(calls.script, 'run')
    expect(body).toContain('const forTarget = target.value.id')
    expect(body).toContain('`${forTarget}：${outcome.message}`')
  })
})

describe('这次会话：分叉、清空、时间线与上限', () => {
  const calls = sfc(benchCalls)
  const divergedActions = () => blockOf(calls.script, 'const divergedActions = ')

  it('换了应用、Key 或模式时清掉报错与选中的那一条：它们属于别的 Key 或别的模式', () => {
    const body = blockOf(calls.script, 'watch(generation, ')
    expect(body).toContain('failure.value = null')
    expect(body).toContain('shownId.value = null')
    // 这一代的会话在 useBench 里已经换成新的
    expect(useBench).toMatch(/session\.value = emptySession\(\)\s+generation\.value\+\+/)
  })

  it('重放分叉：提示第几步与错误，给出接受与清空', () => {
    expect(calls.script).toContain('divergenceNotice(session.value)')
    const alert = withIf(calls.elements, 'diverged')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('diverged.title')
    expect(bound(alert, 'description')).toBe('diverged.description')
    expect(bound(alert, 'actions')).toBe('divergedActions')
    expect(divergedActions()).toMatch(/label: '接受[^}]*onClick: acceptDiverged,/)
    expect(divergedActions()).toMatch(/label: '清空这次会话'[^}]*onClick: clear,/)
    expect(calls.script).toMatch(/\bacceptDiverged,[^}]*\} = useBench\(\)/)
    expect(bodyOf(useBench, 'acceptDiverged')).toContain('acceptDivergence(session.value)')
    expect(bodyOf(useBench, 'clearSession')).toContain('session.value = emptySession()')
  })

  it('运行期间不能接受或清空：结果回来时按发出请求时的日志算', () => {
    // 跟着运行状态变，所以是 computed
    expect(divergedActions()).toContain('computed(() => [')
    expect(divergedActions().match(/disabled: running\.value,/g)).toHaveLength(2)
    expect(bound(buttonOf(calls.elements, '清空'), 'disabled')).toContain('running')
    expect(bodyOf(calls.script, 'clear')).toContain('if (running.value) return')
    expect(bodyOf(useBench, 'clearSession')).toContain('if (running.value) return')
    expect(bodyOf(useBench, 'acceptDiverged')).toContain('if (running.value) return')
  })

  it('清空：按钮接到 clear，连带清掉报错与选中的那一条', () => {
    const button = buttonOf(calls.elements, '清空')
    expect(handler(button, 'click')).toBe('clear')
    expect(bound(button, 'disabled')).toBe('running || !timeline.length')
    const body = bodyOf(calls.script, 'clear')
    expect(body).toContain('clearSession()')
    expect(body).toContain('failure.value = null')
    expect(body).toContain('shownId.value = null')
  })

  it('超限：提示清空并禁用运行', () => {
    expect(calls.script).toContain('runBlocker(session.value, mode.value)')
    const alert = withIf(calls.elements, 'blocker')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'title')).toBe('blocker')
    expect(bound(withHandler(calls.elements, 'click', 'onRunClick'), 'disabled')).toContain(
      'blocker',
    )
  })

  it('这次会话留下了什么', () => {
    expect(calls.script).toContain('sessionUsage(session.value, mode.value)')
    expect(calls.elements.filter((el) => el.tag === 'p').flatMap(shownIn)).toContain('usage')
  })

  it('时间线：新的在上面，每一条有状态、名字、耗时，点一下看结果', () => {
    expect(calls.script).toContain('[...session.value.timeline].reverse()')
    const list = withIf(calls.elements, 'timeline.length')
    expect(list.tag).toBe('ol')
    const item = withFor(walk(list), 'entry in timeline')
    expect(item.tag).toBe('li')
    const button = withTag(walk(item), 'button')
    expect(handler(button, 'click')).toBe('shownId = entry.id')
    expect(shownIn(button)).toEqual(
      expect.arrayContaining([
        "stepBadge(entry.step, 'call').label",
        'entry.step.label',
        'entry.step.ms',
      ]),
    )
    const dropped = withIf(calls.elements, 'session.dropped')
    expect(shownIn(dropped)).toEqual(['session.dropped'])
  })

  it('时间线：写入在日志里才标已保留，接受分叉时去掉的标已去掉', () => {
    const list = withIf(calls.elements, 'timeline.length')
    const kept = withIf(walk(list), 'entry.kept')
    expect(textOf(kept)).toContain('写入已保留')
    const removed = withDirective(walk(list), 'else-if', 'entry.removed')
    expect(textOf(removed)).toContain('写入已去掉')
  })

  it('下面显示选中的那一条的结果', () => {
    const block = withIf(calls.elements, 'shown')
    const view = withTag(walk(block), 'BenchStepView')
    expect(bound(view, 'step')).toBe('shown.step')
    expect(bound(view, 'mode')).toBe('mode')
    expect(view.props?.find((p) => p.name === 'view')?.value?.content).toBe('call')
    expect(shownIn(block)).toEqual(expect.arrayContaining(['shown.run']))
  })
})

describe('场景的运行与导出', () => {
  const scenarios = sfc(benchScenariosView)
  const modalOf = (open: string) =>
    must(
      scenarios.elements.find((el) => el.tag === 'UModal' && bound(el, 'open') === open),
      `:open="${open}" 的确认框`,
    )

  it('真实模式下运行要确认：运行按钮只走 startRun', () => {
    const script = scenarios.script
    expect(scenarios.elements.filter((el) => handler(el, 'click') === 'startRun')).toHaveLength(1)
    expect(bodyOf(script, 'startRun')).toContain('if (real.value) confirming.value = scenario')
    const callers = scenarios.elements.filter((el) =>
      el.props?.some((p) => p.exp?.content.includes('runScenario')),
    )
    expect(callers.map((el) => handler(el, 'click'))).toEqual([
      'confirming && runScenario(confirming)',
    ])
  })

  it('运行前校验，发的是校验过的步骤；不带调用台的重放', () => {
    const valid = bodyOf(scenarios.script, 'validScenario')
    expect(valid).toContain('parseScenario(text.value)')
    expect(valid).toContain('if (parsed.ok) return parsed.scenario')
    expect(valid).not.toContain('JSON.parse')
    expect(bodyOf(scenarios.script, 'startRun')).toContain('const scenario = validScenario()')
    expect(bodyOf(scenarios.script, 'runScenario')).toContain('execute(scenario.steps, {')
  })

  it('导出前检测明文：有明文时先问，确认了才保存', () => {
    const script = scenarios.script
    expect(handler(buttonOf(scenarios.elements, '导出 JSON'), 'click')).toBe('startExport')
    const body = bodyOf(script, 'startExport')
    expect(body).toContain('plaintextIn(scenario)')
    expect(body).toContain('if (findings.length) exporting.value = { scenario, findings }')
    expect(handler(buttonOf(scenarios.elements, '仍然导出'), 'click')).toBe(
      'exporting && save(exporting.scenario)',
    )
    expect(script.match(/saveFile\(/g)).toHaveLength(1)
    expect(bodyOf(script, 'save')).toContain('saveFile(')
  })

  it('权限探测按只列结果的看法显示', () => {
    expect(scenarios.script).toContain('scenarioView({ probe: outcome.value?.probe ?? false })')
    const stepView = withTag(scenarios.elements, 'BenchStepView')
    expect(bound(stepView, 'view')).toBe('view')
  })

  it('导入的上传不用预览：这里是普通的文件输入，不建 blob 地址', () => {
    expect(benchScenariosView).not.toContain('createObjectURL')
    expect(benchScenariosView).not.toContain('UFileUpload')
    const input = withTag(scenarios.elements, 'input')
    expect(handler(input, 'change')).toBe('onFile')
  })

  it('预设按运行时筛：不适用的不能选，并说明原因', () => {
    expect(scenarios.script).toContain('runtimeMismatch(scenario, runtime.value)')
    const items = blockOf(scenarios.script, 'const presetItems = ')
    expect(items).toContain('.filter((c) => !c.reason)')
    const select = withTag(scenarios.elements, 'USelect')
    expect(bound(select, 'items')).toBe('presetItems')
    expect(scenarios.script).toContain('choices.value.filter((c) => c.reason)')
    const details = withIf(scenarios.elements, 'unusable.length')
    expect(details.tag).toBe('details')
    const item = withFor(walk(details), 'c in unusable')
    expect(shownIn(item)).toEqual(['c.scenario.title', 'c.reason'])
    // 选中的只认适用的那些
    expect(scenarios.script).toContain('c.scenario.id === presetId.value && !c.reason')
  })

  it('文本框里的场景不适用时提醒', () => {
    expect(scenarios.script).toContain('runtimeMismatch(parsed.scenario, runtime.value)')
    expect(bound(withIf(scenarios.elements, 'mismatch'), 'title')).toContain('mismatch')
  })

  it('导入的错误与校验的错误都显示出来', () => {
    const onFile = bodyOf(scenarios.script, 'onFile')
    expect(onFile).toContain('if (!parsed.ok) errors.value = parsed.errors')
    expect(onFile).toContain('errors.value = [`文件超过')
    expect(onFile).toContain("errors.value = ['读不出这个文件']")
    // 有错的内容也放进文本框，就地改
    expect(onFile).toContain('replaceText(parsed.ok ? formatScenario(parsed.scenario) : content)')
    expect(bodyOf(scenarios.script, 'validScenario')).toContain('errors.value = parsed.errors')
    const alert = withIf(scenarios.elements, 'errors.length')
    expect(alert.tag).toBe('UAlert')
    const line = withFor(walk(alert), '(line, i) in errors')
    expect(shownIn(line)).toEqual(['line'])
  })

  it('运行失败的说明', () => {
    expect(bodyOf(scenarios.script, 'runScenario')).toContain('failure.value = done.message')
    expect(bound(withIf(scenarios.elements, 'failure'), 'title')).toBe('failure')
  })

  it('换了应用、Key 或模式时清掉结果、报错与确认框，文本框里的场景留着', () => {
    const body = blockOf(scenarios.script, 'watch(generation, ')
    expect(body).toContain('outcome.value = null')
    expect(body).toContain('failure.value = null')
    expect(body).toContain('confirming.value = null')
    expect(body).not.toContain('text.value')
  })

  it('运行结果：结论与每一步，按断言或只列结果的看法显示', () => {
    const section = withIf(scenarios.elements, 'outcome && summary')
    const alert = withTag(walk(section), 'UAlert')
    expect(bound(alert, 'color')).toBe('summary.color')
    expect(bound(alert, 'title')).toBe('summary.title')
    expect(scenarios.script).toContain('runSummary(outcome.value.result, view.value)')
    const step = withFor(walk(section), 'step in outcome.result.steps')
    expect(step.tag).toBe('BenchStepView')
    expect(bound(step, 'step')).toBe('step')
    expect(bound(step, 'mode')).toBe('mode')
    expect(bound(step, 'view')).toBe('view')
    expect(bound(step, 'open')).toBe('stepOpen(step, view)')
  })

  it('真实模式的确认框列出步骤数与后果', () => {
    const modal = modalOf('confirming !== null')
    const nodes = walk(modal)
    const line = withFor(nodes, 'line in REAL_MODE_CONSEQUENCES')
    expect(line.tag).toBe('li')
    expect(shownIn(line)).toEqual(['line'])
    expect(shownIn(modal)).toEqual(
      expect.arrayContaining(['confirming?.title', 'confirming?.steps.length']),
    )
    expect(shownIn(modal).join()).toContain('writingSteps(confirming)')
    expect(textOf(modal)).toContain('已经写下的不会撤回')
    expect(handler(buttonOf(nodes, '取消'), 'click')).toBe('confirming = null')
  })

  it('明文的提示列出第几步、哪一步与什么内容', () => {
    const modal = modalOf('exporting !== null')
    const finding = withFor(walk(modal), 'finding in exporting?.findings ?? []')
    expect(shownIn(finding)).toEqual(['finding.step', 'finding.label', 'finding.what'])
    expect(handler(buttonOf(walk(modal), '取消'), 'click')).toBe('exporting = null')
  })

  it('两种模式的说明不一样：真实模式没有事务，读得到已经落库的写入', () => {
    const realNote = withIf(scenarios.elements, 'real')
    expect(realNote.tag).toBe('p')
    expect(textOf(realNote)).toContain('步骤各自真实执行')
    expect(textOf(realNote)).toContain('读得到已经落库的写入')
    expect(textOf(realNote)).toContain('结果不进调用台的时间线')
    expect(textOf(realNote)).not.toContain('事务')
    const rollbackNote = must(
      scenarios.elements.find((el) => el.tag === 'p' && el.props?.some((p) => p.name === 'else')),
      'v-else 的那一句说明',
    )
    expect(textOf(rollbackNote)).toContain('它单独一个事务：不带调用台这次会话的写入')
    expect(textOf(rollbackNote)).not.toContain('真实执行')
    // 两句紧挨着：v-else 接的是这个 v-if
    const parent = must(
      scenarios.elements.find((el) => el.children?.includes(realNote)),
      '说明的上一层',
    )
    const siblings = parent.children!.filter((n) => n.type === ELEMENT)
    expect(siblings[siblings.indexOf(realNote) + 1]).toBe(rollbackNote)
  })
})

describe('一步的结果', () => {
  const view = sfc(benchStepView)

  it('原文放在 pre 里原样显示', () => {
    const pres = view.elements.filter((el) => el.tag === 'pre')
    const contents = pres.map((pre) =>
      walk(pre)
        .filter((n) => n.type === 5 || n.type === TEXT)
        .map((n) => n.content),
    )
    expect(pres.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(contents)).not.toContain('trim')
  })

  it('uris 为 null 时不显示列表', () => {
    const list = view.elements.find((el) =>
      el.props?.some((p) => p.name === 'if' && p.exp?.content === 'step.uris?.length'),
    )
    expect(list).toBeDefined()
  })

  it('列哪些断言按看法算：权限探测只说明没发出去、capture 没取到的原因', () => {
    expect(view.script).toContain('shownAssertions(props.step, props.view)')
    expect(withIf(view.elements, 'assertions.length').tag).toBe('ul')
  })

  it('折叠时也看得到状态、步骤名、耗时与状态码', () => {
    expect(shownIn(withTag(view.elements, 'summary'))).toEqual([
      'badge.label',
      'step.label',
      'meta',
    ])
    expect(view.script).toContain('`HTTP ${httpStatus}`')
    expect(view.script).toContain('`${ms} ms`')
    expect(blockOf(view.script, 'const meta = ')).toContain("join(' · ')")
  })

  it('跳过与没有执行的原因', () => {
    expect(shownIn(withIf(view.elements, 'step.reason'))).toEqual(['step.reason'])
  })

  it('内部错误显示原因，别的报错显示说明', () => {
    const alert = withIf(view.elements, 'step.internalError')
    expect(alert.tag).toBe('UAlert')
    expect(bound(alert, 'description')).toBe('internalErrorText(step)')
    expect(view.script).toContain('errorNote(props.step, props.view)')
    expect(shownIn(withDirective(view.elements, 'else-if', 'error'))).toEqual(['error.text'])
  })

  it('断言：每一条的说法与对错', () => {
    const assertion = withFor(view.elements, '(a, i) in assertions')
    expect(shownIn(assertion)).toEqual(['a.message'])
    const icon = withTag(walk(assertion), 'UIcon')
    expect(bound(icon, 'name')).toBe('a.ok ? icons.passed : icons.failed')
  })

  // 收到的原文与原始响应：都只在有响应时显示
  const responses = view.elements.filter(
    (el) => el.tag === 'details' && directive(el, 'if') === 'responded',
  )
  const preOf = (el: TemplateNode) => withTag(walk(el), 'pre')

  it('收到的原文，空的时候说明', () => {
    const text = must(
      responses.find((el) => textOf(el).includes('收到的原文')),
      '收到的原文',
    )
    expect(shownIn(preOf(text))).toEqual(['step.text || emptyText'])
  })

  it('原始响应', () => {
    const raw = must(
      responses.find((el) => textOf(el).includes('原始响应')),
      '原始响应',
    )
    expect(shownIn(preOf(raw))).toEqual(['raw'])
    expect(view.script).toContain('JSON.stringify(props.step.raw, null, 2)')
    // 没有响应的步骤没有原文可看
    expect(view.script).toContain('props.step.raw !== null')
  })

  it('结果里的 URI', () => {
    const list = withIf(view.elements, 'step.uris?.length')
    expect(shownIn(withFor(walk(list), 'uri in step.uris'))).toEqual(['uri'])
  })

  it('session.start 的字数上限、没展开的节点、放不下的附加块', () => {
    expect(view.script).toContain('sessionNotes(props.step.session, props.step.text)')
    const section = withIf(view.elements, 'session')
    const nodes = walk(section)
    expect(shownIn(section)).toContain('session.size')
    expect(textOf(withIf(nodes, 'session.overLimit'))).toContain('超出的部分宿主可能截断')
    expect(shownIn(withIf(nodes, 'session.omitted.length'))).toEqual(["session.omitted.join('、')"])
    expect(shownIn(withIf(nodes, 'session.dropped.length'))).toEqual(["session.dropped.join('、')"])
  })

  it('向量没算到时提示', () => {
    expect(shownIn(withIf(view.elements, 'step.vectorSkipped'))).toEqual(['VECTOR_SKIPPED_NOTE'])
  })

  it('这一步改了什么：两种模式的标题，列不出来与没有改动的说法', () => {
    const section = must(
      view.elements.find((el) => el.tag === 'section' && directive(el, 'if') === 'responded'),
      '这一步改了什么的区块',
    )
    const nodes = walk(section)
    expect(shownIn(section)).toContain("mode === 'rollback' ? '真执行会改什么' : '这一步改了什么'")
    expect(textOf(withIf(nodes, '!step.changes'))).toContain('改动列不出来')
    expect(withIf(nodes, 'turnNotBuffered(step)')).toBeDefined()
    expect(shownIn(withIf(nodes, '!changes.length && !step.changes.turn')).join()).toContain(
      'changesNotListed(step.changes)',
    )
    expect(textOf(withIf(nodes, 'changesNotListed(step.changes)'))).toContain('这个模式不列')
  })

  it('这一步改了什么：每一类的动作、对象、字段、提醒与说明', () => {
    expect(view.script).toContain('changeItems(props.step.changes)')
    const item = withFor(view.elements, '(item, i) in changes')
    expect(item.tag).toBe('li')
    const nodes = walk(item)
    expect(shownIn(item)).toEqual(expect.arrayContaining(['item.action', 'item.target']))
    expect(shownIn(withFor(nodes, 'field in item.fields'))).toEqual(['field'])
    expect(shownIn(withFor(nodes, 'text in item.warnings'))).toEqual(['text'])
    expect(shownIn(withFor(nodes, 'text in item.notes'))).toEqual(['text'])
  })

  it('这一步改了什么：对话缓冲回显这一轮', () => {
    const turn = withIf(view.elements, 'step.changes.turn')
    expect(shownIn(turn)).toContain('step.changes.turn.sessionId')
    const shown = shownIn(preOf(turn)).join()
    expect(shown).toContain('step.changes.turn.user')
    expect(shown).toContain('step.changes.turn.reply')
  })

  it('capture 取到的', () => {
    expect(view.script).toContain('Object.entries(props.step.captured)')
    const section = withIf(view.elements, 'captured.length')
    expect(shownIn(withFor(walk(section), '[name, value] in captured'))).toEqual(['name', 'value'])
  })
})

describe('页面的结构', () => {
  const page = sfc(benchPage)

  it('页面只放分页，不直接调接口：分页组件各管各的，共享的状态在 useBench', () => {
    expect(page.script).toContain('provideBench()')
    expect(page.script).not.toMatch(/api\.|from '\.\.\/api/)
    expect(page.elements.map((el) => el.tag)).toEqual(
      expect.arrayContaining(['BenchToolbar', 'UTabs', 'BenchCalls', 'BenchScenarios']),
    )
  })

  it('换应用读 Key 的时候分页组件不卸载：卸载会丢掉草稿与文本框里的场景', () => {
    const tabs = withTag(page.elements, 'UTabs')
    const wrapper = must(
      page.elements.find((el) => el.children?.includes(tabs)),
      '分页的上一层',
    )
    const dir = (name: string) => wrapper.props?.find((p) => p.name === name)?.exp?.content
    expect(dir('if')).toBe('mounted')
    expect(dir('show')).toBe('ready')
    for (const tag of ['BenchCalls', 'BenchScenarios']) {
      expect(withTag(page.elements, tag).props?.some((p) => p.name === 'show')).toBe(true)
    }
  })

  it('改过文本框就不再是那个预设了：再选它能换回原样', () => {
    const scenarios = sfc(benchScenariosView)
    expect(bodyOf(scenarios.script, 'edit')).toContain('presetId.value = undefined')
    const area = withTag(scenarios.elements, 'UTextarea')
    expect(handler(area, 'update:model-value')).toBe('(v) => edit(String(v))')
  })
})

describe('真实模式中途作废的运行', () => {
  const abandoned = sfc(benchAbandoned)

  it('调用台与场景都走 execute，说明这次运行是什么', () => {
    expect(bodyOf(sfc(benchCalls).script, 'run')).toContain('call([built.step], forTarget)')
    const scenario = bodyOf(sfc(benchScenariosView).script, 'runScenario')
    expect(scenario).toContain('label: scenario.title')
    expect(scenario).toContain('view: scenarioView(scenario)')
    expect(bodyOf(useBench, 'call')).toContain("{ label, view: 'call' }")
  })

  it('警告放在分页外面：这把 Key 没了、分页隐藏时也看得到', () => {
    const page = sfc(benchPage)
    const warning = withTag(page.elements, 'BenchAbandoned')
    const tabs = must(
      page.elements.find((el) => el.children?.includes(withTag(page.elements, 'UTabs'))),
      '分页的上一层',
    )
    expect(walk(tabs)).not.toContain(warning)
    expect(page.elements.find((el) => el.children?.includes(tabs))?.children).toContain(warning)
  })

  it('每一条有说明，能关掉；有结果就列出每一步，按真实模式说', () => {
    const run = withFor(abandoned.elements, 'run in abandoned')
    const alert = withTag(walk(run), 'UAlert')
    expect(bound(alert, 'title')).toBe('run.title')
    expect(bound(alert, 'description')).toBe('run.description')
    expect(alert.props?.some((p) => p.name === 'close')).toBe(true)
    expect(handler(alert, 'update:open')).toBe('(v) => !v && dismissAbandoned(run.id)')
    const steps = withFor(walk(run), 'step in run.result.steps')
    expect(steps.tag).toBe('BenchStepView')
    expect(steps.props?.find((p) => p.name === 'mode')?.value?.content).toBe('real')
    expect(bound(steps, 'view')).toBe('run.view')
    expect(shownIn(withIf(walk(run), 'run.result'))).toContain('run.result.run')
  })

  it('请求还没回来的时候也说一声', () => {
    const alert = withIf(abandoned.elements, 'abandonedInFlight')
    expect(alert.tag).toBe('UAlert')
    expect(alert.props?.find((p) => p.name === 'title')?.value?.content).toContain('可能正在写入')
  })
})

describe('入口', () => {
  it('只有应用主人看得到导航入口', () => {
    expect(consoleLayout).toContain('ownedApps(apps.data.value ?? [], me.data.value?.id)')
    expect(consoleLayout).toMatch(/ownsApp\.value\s*\? \[\{ label: '测试台'/)
  })

  it('选应用只列自己是主人的', () => {
    expect(useBench).toContain('ownedApps(apps.data.value ?? [], me.data.value?.id)')
    expect(useBench).toContain('usableKeys(keys.data.value ?? [])')
    expect(useBench).toContain('list.find((a) => a.id === selection.app)?.id ?? list[0]?.id')
  })

  it('路由', () => {
    expect(routes).toContain("path: 'spaces/:spaceId/bench'")
    expect(routes).toContain("name: 'bench'")
  })

  it('模拟器链接到测试台，带上应用与 Key', () => {
    const { elements } = sfc(appSimulator)
    const link = buttonOf(elements, '在测试台打开')
    expect(bound(link, 'to')).toBe(
      "{ name: 'bench', params: { spaceId }, query: { app: appId, key: keyId } }",
    )
  })
})

describe('活动与访问记录的徽章', () => {
  it.each([
    ['活动', activityEntry, 'item.bench'],
    ['凭据的访问记录', credentialDetail, 'e.bench'],
  ])('%s显示测试台与操作账号', (_name, source, field) => {
    const { elements } = sfc(source)
    const block = elements.find((el) =>
      el.props?.some((p) => p.name === 'if' && p.exp?.content === field),
    )
    expect(block).toBeDefined()
    const nodes = walk(block!)
    const texts = nodes.map((n) => n.content ?? '')
    expect(texts.some((t) => t.includes('测试台'))).toBe(true)
    expect(texts.some((t) => t.includes('操作账号'))).toBe(true)
    expect(JSON.stringify(nodes.map((n) => n.content))).toContain(`benchAccountLabel(${field})`)
  })
})

describe('图标', () => {
  it('测试台用到的都登记了：构建时只打包这份清单', () => {
    const used = Object.values(SOURCES).flatMap((source) =>
      [...source.matchAll(/\bicons\.([A-Za-z]+)/g)].map((m) => m[1]!),
    )
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) expect(Object.keys(icons)).toContain(name)
  })
})
