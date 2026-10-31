import { describe, expect, it } from 'vitest'
import { createSSRApp, h, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import webPackage from '../../package.json'
import benchAgent from '../benchAgent?raw'
import benchForm from '../benchForm?raw'
import benchResult from '../benchResult?raw'
import benchScenarios from '../benchScenarios?raw'
import benchSession from '../benchSession?raw'
import activityEntry from '../components/ActivityEntry.vue?raw'
import appSimulator from '../components/AppSimulator.vue?raw'
import benchAbandoned from '../components/BenchAbandoned.vue?raw'
import benchAgentView from '../components/BenchAgent.vue?raw'
import benchAgentBusy from '../components/BenchAgentBusy.vue?raw'
import benchAgentExchange from '../components/BenchAgentExchange.vue?raw'
import benchCalls from '../components/BenchCalls.vue?raw'
import benchContextForm from '../components/BenchContextForm.vue?raw'
import benchField from '../components/BenchField.vue?raw'
import BenchNotice from '../components/BenchNotice.vue'
import benchNotice from '../components/BenchNotice.vue?raw'
import benchRawText from '../components/BenchRawText.vue?raw'
import BenchRunLine from '../components/BenchRunLine.vue'
import benchRunLine from '../components/BenchRunLine.vue?raw'
import benchScenariosView from '../components/BenchScenarios.vue?raw'
import BenchStatus from '../components/BenchStatus.vue'
import benchStatus from '../components/BenchStatus.vue?raw'
import benchStepView from '../components/BenchStepView.vue?raw'
import benchTag from '../components/BenchTag.vue?raw'
import benchToolbar from '../components/BenchToolbar.vue?raw'
import noteLine from '../components/strata/NoteLine.vue?raw'
import UriPath from '../components/strata/UriPath.vue'
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
const buttonOfLabel = (elements: TemplateNode[], label: string) =>
  must(
    elements.find(
      (el) =>
        el.tag === 'UButton' &&
        el.props?.some((p) => p.name === 'aria-label' && p.value?.content === label),
    ),
    `按钮「${label}」`,
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

const classOf = (el: TemplateNode) => el.props?.find((p) => p.name === 'class')?.value?.content
const withClass = (elements: TemplateNode[], name: string) =>
  must(
    elements.find((el) => classOf(el)?.split(' ').includes(name)),
    `class="${name}"`,
  )
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
// 样式：媒体查询里的一段，顶格写的一条规则（不含媒体查询里的）
const styleOf = (source: string) =>
  parse(source)
    .descriptor.styles.map((style) => style.content)
    .join('\n')
const mediaOf = (source: string, condition: string) => {
  const style = styleOf(source)
  const from = style.indexOf(`@media (${condition}) {`)
  expect(from, `样式里要有 @media (${condition})`).toBeGreaterThanOrEqual(0)
  return style.slice(from, style.indexOf('\n}', from))
}
const ruleOf = (source: string, selector: string) => {
  const css = styleOf(source)
  const from = css.search(new RegExp(`^${selector.replace(/[.*+()]/g, '\\$&')} \\{`, 'm'))
  expect(from, `样式里要有 ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(from, css.indexOf('\n}', from))
}

const SOURCES = {
  benchAgent,
  benchForm,
  benchResult,
  benchScenarios,
  benchSession,
  useBench,
  benchPage,
  benchAbandoned,
  benchAgentView,
  benchAgentBusy,
  benchAgentExchange,
  benchCalls,
  benchContextForm,
  benchField,
  benchNotice,
  benchRawText,
  benchRunLine,
  benchScenariosView,
  benchStatus,
  benchStepView,
  benchTag,
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
    expect(handler(buttonOf(toolbar.elements, '切换到真实模式'), 'click')).toBe('confirmReal')
  })

  it('切回回滚会清掉记录时要确认，确认框说清楚清掉什么；取消不动', () => {
    const request = bodyOf(useBench, 'requestMode')
    expect(request).toMatch(/else if \(modeLoss\.value\) \{[^}]*confirmingRollback\.value = true/)
    expect(request).toContain("else mode.value = 'rollback'")
    const modal = must(
      toolbar.elements.find(
        (el) => el.tag === 'UModal' && bound(el, 'open') === 'confirmingRollback',
      ),
      '切回回滚的确认框',
    )
    // 显示打开时存的那一份：确认之后 modeLoss 马上没了，对话框还在关闭
    expect(shownIn(modal)).toEqual(['rollbackLoss'])
    const nodes = walk(modal)
    expect(handler(buttonOf(nodes, '切回回滚模式'), 'click')).toBe('confirmRollback')
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
    expect(alert.tag).toBe('BenchNotice')
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

  it('真实模式的标记放在滚动区外面：内容滚动时一直看得到', () => {
    const { descriptor } = parse(benchPage)
    const page = sfc(benchPage)
    const banner = withIf(page.elements, 'real')
    expect(textOf(banner)).toContain('真实模式')
    expect(banner.props?.find((p) => p.name === 'role')?.value?.content).toBe('status')
    const scroller = must(
      page.elements.find(
        (el) => walk(el).some((n) => n.tag === 'BenchToolbar') && el !== page.elements[0],
      ),
      '滚动区',
    )
    const classOf = (el: TemplateNode) => el.props?.find((p) => p.name === 'class')?.value?.content
    // 标记和滚动区是兄弟，标记在前；滚动的只有滚动区，它们的上一层不滚
    const siblings = page.elements[0]!.children!.filter((n) => n.type === ELEMENT)
    expect(siblings).toEqual([banner, scroller])
    const style = descriptor.styles[0]!.content
    const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(style)?.[1] ?? ''
    expect(rule(classOf(scroller)!)).toContain('overflow-y: auto')
    expect(rule(classOf(page.elements[0]!)!)).not.toContain('overflow')
    expect(rule(classOf(banner)!)).toContain('flex: none')
    // 下面的内容（工具栏、作废的运行、分页）都在滚动区里
    for (const tag of ['BenchToolbar', 'BenchAbandoned', 'UTabs', 'BenchCalls']) {
      expect(walk(scroller).map((n) => n.tag)).toContain(tag)
    }
  })
})

describe('调用台的运行', () => {
  const calls = sfc(benchCalls)

  it('按钮只认自己的运行；别的运行占着时禁用、不转圈', () => {
    const button = withHandler(calls.elements, 'click', 'onRunClick')
    expect(bound(button, 'loading')).toBe('callRunning')
    expect(bound(button, 'disabled')).toBe('Boolean(unavailable || blocker || running)')
  })

  it('被模型对话占着时说明一句，能停止：放在运行按钮旁边', () => {
    const form = withTag(calls.elements, 'form')
    expect(walk(form).map((n) => n.tag)).toContain('BenchAgentBusy')
    expect(walk(form)).toContain(withHandler(calls.elements, 'click', 'onRunClick'))
  })

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
    expect(textOf(calls.elements[0]!)).toContain('工具调用不带会话上下文，与真实 MCP 一致')
    const form = sfc(benchContextForm)
    expect(textOf(form.elements[0]!)).toContain('工具调用不带')
    expect(textOf(form.elements[0]!)).toContain('与真实 MCP 一致')
  })

  it('会话上下文在表单上面：文案说的是「上方的会话上下文」', () => {
    const context = withTag(calls.elements, 'BenchContextForm')
    const form = withTag(calls.elements, 'form')
    expect(textOf(form)).toContain('上方的会话上下文')
    // 走读的顺序就是文档顺序；两个在同一栏里，窄屏排成一栏时也还在上面
    expect(calls.elements.indexOf(context)).toBeLessThan(calls.elements.indexOf(form))
    const column = must(
      calls.elements.find((el) => el.children?.includes(form)),
      '表单的上一层',
    )
    expect(column.children).toContain(context)
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
    expect(readOnly.tag).toBe('BenchTag')
    expect(textOf(readOnly)).toContain('只读')
    const destructive = withIf(calls.elements, `${name}.destructive`)
    expect(destructive.tag).toBe('BenchTag')
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
    expect(handler(buttonOf(calls.elements, '使用 JSON'), 'click')).toBe('showJson')
    expect(handler(buttonOf(calls.elements, '使用表单'), 'click')).toBe('showForm')
    expect(handler(buttonOf(calls.elements, '重置'), 'click')).toBe('resetDraft')
    expect(bodyOf(calls.script, 'showJson')).toContain(
      'jsonFromForm(target.value, draft.value, sessionContext.value)',
    )
    const back = bodyOf(calls.script, 'showForm')
    expect(back).toContain('formFromJson(target.value, draft.value, sessionContext.value)')
    expect(back).toContain('formError.value = made.error')
    const alert = withIf(calls.elements, 'formError')
    expect(alert.tag).toBe('BenchNotice')
    expect(bound(alert, 'title')).toBe('formError')
    expect(bound(withIf(calls.elements, 'failure'), 'title')).toBe('failure')
  })

  it('JSON 模式说的是 JSON 里的 context，只有表单模式才说带上面的', () => {
    const scope = withDirective(calls.elements, 'else-if', 'target.usesContext')
    const [json, form] = scope.children!.filter((n) => n.type === ELEMENT)
    expect(directive(json!, 'if')).toBe('draft.json')
    expect(textOf(json!)).toContain('仅发送此 JSON 中的 context')
    expect(textOf(json!)).toContain('上方的会话上下文不生效')
    expect(form!.props?.some((p) => p.name === 'else')).toBe(true)
    expect(textOf(form!)).toContain('此调用带上方的会话上下文')
    // 这句只在表单模式下出现
    expect(benchCalls.match(/此调用带上方的会话上下文/g)).toHaveLength(1)
  })

  it('JSON 里的 context 和页面上的不同时警告', () => {
    const alert = withIf(calls.elements, 'contextDiffers')
    expect(alert.tag).toBe('BenchNotice')
    expect(alert.props?.find((p) => p.name === 'color')?.value?.content).toBe('warning')
    const title = alert.props?.find((p) => p.name === 'title')?.value?.content
    expect(title).toContain('与上方的会话上下文不同')
    expect(title).toContain('按 JSON 执行')
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
    expect(bound(button, 'disabled')).toBe('Boolean(unavailable || blocker || running)')
    const alert = withIf(calls.elements, 'unavailable')
    expect(alert.tag).toBe('BenchNotice')
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
    expect(alert.tag).toBe('BenchNotice')
    expect(bound(alert, 'title')).toBe('toolsError')
    expect(bound(alert, 'actions')).toBe('retryTools')
    expect(blockOf(calls.script, 'const retryTools = ')).toContain('tools.refetch()')
  })
})

describe('离开页面前提醒', () => {
  it('页面上只注册一份：提醒的状态是全局的一个，注册两份会互相覆盖', () => {
    const sources = [
      benchCalls,
      benchScenariosView,
      benchAgentView,
      benchToolbar,
      benchPage,
      benchAbandoned,
    ]
    for (const source of sources) expect(source).not.toContain('useUnsavedChangesGuard')
    expect(useBench.match(/useUnsavedChangesGuard\(/g)).toHaveLength(1)
    // 只能在页面的 setup 里建
    expect(benchPage).toContain('provideBench()')
  })

  it('场景文本框改过算：替换前问的也是同一个判断', () => {
    const scenarios = sfc(benchScenariosView)
    expect(scenarios.script).toContain('scenarioEdited(text.value, loaded.value)')
    expect(scenarios.script).toContain('watchEffect(() => (unsaved.scenario = edited.value))')
    expect(bodyOf(scenarios.script, 'replaceText')).toContain('if (edited.value && !window.confirm')
  })

  it('调用台的 JSON 草稿改过算：所有调用的草稿都看，转成 JSON 时记下起点', () => {
    const calls = sfc(benchCalls)
    expect(calls.script).toContain('shallowReactive(new Map<string, Draft>())')
    expect(calls.script).toContain(
      'watchEffect(() => (unsaved.drafts = [...drafts.values()].some(draftEdited)))',
    )
    expect(bodyOf(calls.script, 'showJson')).toContain('draft.value.base = made.text')
  })
})

describe('切换调用', () => {
  const calls = sfc(benchCalls)

  it('写错的说明总是清掉；运行失败的说明只在回滚模式清掉：真实模式下可能已经执行了一部分', () => {
    const body = blockOf(calls.script, 'watch(targetId, ')
    expect(body).toContain('formError.value = null')
    expect(body).toContain('if (!real.value) failure.value = null')
  })

  it('失败的说明带上是哪一个调用的：运行期间切走了，或者真实模式下切走之后还留着', () => {
    const body = bodyOf(calls.script, 'run')
    expect(body).toContain('const forTarget = target.value.id')
    expect(body).toMatch(
      /!real\.value && targetId\.value === forTarget\s+\? outcome\.message\s+: `\$\{forTarget\}：\$\{outcome\.message\}`/,
    )
  })

  it('失败的说明留到真的发出下一次运行：表单写错了没有发出去，不算', () => {
    const body = bodyOf(calls.script, 'run')
    const clears = body.indexOf('failure.value = null')
    expect(clears).toBeGreaterThan(body.indexOf('if (!built.ok)'))
    expect(clears).toBeLessThan(body.indexOf('await call('))
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
    expect(alert.tag).toBe('BenchNotice')
    expect(bound(alert, 'title')).toBe('diverged.title')
    expect(bound(alert, 'description')).toBe('diverged.description')
    expect(bound(alert, 'actions')).toBe('divergedActions')
    expect(divergedActions()).toMatch(/label: '接受[^}]*onClick: acceptDiverged,/)
    expect(divergedActions()).toMatch(/label: '清空当前会话'[^}]*onClick: clear,/)
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
    expect(alert.tag).toBe('BenchNotice')
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
    // 状态按 stepBadge 的调用看法算，不看 status：没带断言时服务端一律算通过
    expect(bound(withTag(walk(button), 'BenchStatus'), 'badge')).toBe(
      "stepBadge(entry.step, 'call')",
    )
    expect(shownIn(button)).toEqual(expect.arrayContaining(['entry.step.label', 'entry.step.ms']))
    const dropped = withIf(calls.elements, 'session.dropped')
    expect(shownIn(dropped)).toEqual(['session.dropped'])
  })

  it('时间线：写入在日志里才标已保留，接受分叉时去掉的标已去掉', () => {
    const list = withIf(calls.elements, 'timeline.length')
    const kept = withIf(walk(list), 'entry.kept')
    expect(textOf(kept)).toContain('写入已保留')
    const removed = withDirective(walk(list), 'else-if', 'entry.removed')
    expect(textOf(removed)).toContain('写入已移除')
  })

  it('下面显示选中的那一条的结果', () => {
    const block = withIf(calls.elements, 'shown')
    const view = withTag(walk(block), 'BenchStepView')
    expect(bound(view, 'step')).toBe('shown.step')
    expect(bound(view, 'mode')).toBe('mode')
    expect(view.props?.find((p) => p.name === 'view')?.value?.content).toBe('call')
    expect(bound(withTag(walk(block), 'BenchRunLine'), 'result')).toBe('shown')
  })
})

describe('场景的运行与导出', () => {
  const scenarios = sfc(benchScenariosView)
  const modalOf = (open: string) =>
    must(
      scenarios.elements.find((el) => el.tag === 'UModal' && bound(el, 'open') === open),
      `:open="${open}" 的确认框`,
    )

  it('按钮只认自己的运行；别的运行占着时禁用、不转圈', () => {
    const button = withHandler(scenarios.elements, 'click', 'startRun')
    expect(bound(button, 'loading')).toBe('scenarioRunning')
    expect(bound(button, 'disabled')).toBe('!text.trim() || running')
  })

  it('被模型对话占着时说明一句，能停止：放在运行按钮旁边', () => {
    const parent = must(
      scenarios.elements.find((el) =>
        el.children?.includes(withHandler(scenarios.elements, 'click', 'startRun')),
      ),
      '运行按钮的上一层',
    )
    expect(parent.children?.map((n) => n.tag)).toContain('BenchAgentBusy')
  })

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
    expect(valid).toContain('return parsed.ok ? parsed.scenario : null')
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

  it('导出之后不再算改过：两条导出的路都走 save，存完才记下', () => {
    const body = bodyOf(scenarios.script, 'save')
    expect(body.indexOf('loaded.value = text.value')).toBeGreaterThan(body.indexOf('saveFile('))
    // 改过的判断比的就是这两个，离开页面与载入别的场景都看它
    expect(scenarios.script).toContain('scenarioEdited(text.value, loaded.value)')
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
    expect(onFile).toContain("errors.value = ['无法读取此文件']")
    // 有错的内容也放进文本框，就地改
    expect(onFile).toContain('replaceText(parsed.ok ? formatScenario(parsed.scenario) : content)')
    // 合法的时候清掉：文件过大这类报错不会因为文本框没动就一直留着
    expect(bodyOf(scenarios.script, 'validScenario')).toContain(
      'errors.value = parsed.ok ? [] : parsed.errors',
    )
    const alert = withIf(scenarios.elements, 'errors.length')
    expect(alert.tag).toBe('BenchNotice')
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
    const conclusion = must(
      walk(section).find((el) => shownIn(el).includes('summary.title') && el.tag === 'p'),
      '结论',
    )
    expect(shownIn(conclusion)).toEqual(['summary.title'])
    // 语气跟着结论走：失败是砖红，告警是赭色
    expect(bound(conclusion, 'class')).toBe('`tone-${summary.color}`')
    const style = parse(benchScenariosView).descriptor.styles[0]!.content
    expect(style).toMatch(/\.tone-error \{\s+color: var\(--ui-error\)/)
    expect(style).toMatch(/\.tone-warning \{\s+color: var\(--ui-warning\)/)
    expect(scenarios.script).toContain('runSummary(outcome.value.result, view.value)')
    expect(bound(withTag(walk(section), 'BenchRunLine'), 'result')).toBe('outcome.result')
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
    expect(textOf(modal)).toContain('已写入的内容不会撤回')
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
    expect(textOf(realNote)).toContain('可读取已落库的写入')
    expect(textOf(realNote)).toContain('结果不进入调用台的时间线')
    expect(textOf(realNote)).not.toContain('事务')
    const rollbackNote = must(
      scenarios.elements.find((el) => el.tag === 'p' && el.props?.some((p) => p.name === 'else')),
      'v-else 的那一句说明',
    )
    expect(textOf(rollbackNote)).toContain('在单独的事务中运行')
    expect(textOf(rollbackNote)).toContain('不带调用台当前会话的写入')
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

  it('原文经 BenchRawText 放在 pre 里原样显示：只有这一处放 pre', () => {
    const pres = sfc(benchRawText).elements.filter((el) => el.tag === 'pre')
    // 带标题折叠的、不带标题的
    expect(pres).toHaveLength(2)
    for (const pre of pres) expect(shownIn(pre)).toEqual(['text'])
    expect(styleOf(benchRawText)).toMatch(/white-space: pre-wrap/)
    for (const source of [benchStepView, benchAgentExchange]) {
      expect(sfc(source).elements.map((el) => el.tag)).not.toContain('pre')
    }
    const texts = view.elements
      .filter((el) => el.tag === 'BenchRawText')
      .map((el) => bound(el, 'text'))
    expect(texts.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(texts)).not.toContain('trim')
  })

  it('原文的样式与折叠只有一份', () => {
    for (const source of [benchStepView, benchAgentExchange]) {
      expect(source).not.toContain('PRE_CLASS')
      expect(styleOf(source)).not.toContain('.fold')
    }
    const raw = sfc(benchRawText)
    const fold = withTag(raw.elements, 'details')
    expect(directive(fold, 'if')).toBe('title')
    expect(bound(fold, 'open')).toBe('open')
    expect(shownIn(withTag(walk(fold), 'summary'))).toEqual(['title'])
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
    const summary = withTag(view.elements, 'summary')
    expect(bound(withTag(walk(summary), 'BenchStatus'), 'badge')).toBe('badge')
    expect(view.script).toContain('stepBadge(props.step, props.view)')
    expect(shownIn(summary)).toEqual(['number', 'step.label', 'meta'])
    expect(view.script).toContain('`HTTP ${httpStatus}`')
    expect(view.script).toContain('`${ms} ms`')
    expect(blockOf(view.script, 'const meta = ')).toContain("join(' · ')")
  })

  it('按断言通过的步骤报了错：折叠时也看得出来，只有场景的看法才标', () => {
    const tag = withIf(view.elements, "error && view === 'judged'")
    expect(walk(withTag(view.elements, 'summary'))).toContain(tag)
    expect(textOf(tag)).toContain('报错')
  })

  it('跳过与没有执行的原因', () => {
    expect(shownIn(withIf(view.elements, 'step.reason'))).toEqual(['step.reason'])
  })

  it('内部错误显示原因，别的报错显示说明', () => {
    const alert = withIf(view.elements, 'step.internalError')
    expect(alert.tag).toBe('BenchNotice')
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
    (el) => el.tag === 'BenchRawText' && directive(el, 'if') === 'responded',
  )

  it('收到的原文，空的时候说明', () => {
    const text = must(
      responses.find((el) => attr(el, 'title') === '收到的原文'),
      '收到的原文',
    )
    expect(bound(text, 'text')).toBe('step.text || emptyText')
    // 默认展开
    expect(text.props?.some((p) => p.name === 'open')).toBe(true)
  })

  it('原始响应', () => {
    const raw = must(
      responses.find((el) => attr(el, 'title') === '原始响应'),
      '原始响应',
    )
    expect(bound(raw, 'text')).toBe('raw')
    // 默认收起
    expect(raw.props?.some((p) => p.name === 'open' || p.arg?.content === 'open')).toBe(false)
    expect(view.script).toContain('JSON.stringify(props.step.raw, null, 2)')
    // 没有响应的步骤没有原文可看
    expect(view.script).toContain('props.step.raw !== null')
  })

  it('结果里的 URI', () => {
    const list = withIf(view.elements, 'step.uris?.length')
    const uri = withTag(walk(withFor(walk(list), 'uri in step.uris')), 'UriPath')
    expect(bound(uri, 'uri')).toBe('uri')
    // 要看全：不能缩成省略号
    expect(uri.props?.some((p) => p.name === 'wrap')).toBe(true)
  })

  it('session.start 的字数上限、没展开的节点、放不下的附加块', () => {
    expect(view.script).toContain('sessionNotes(props.step.session, props.step.text)')
    const section = withIf(view.elements, 'session')
    const nodes = walk(section)
    expect(shownIn(section)).toContain('session.size')
    expect(textOf(withIf(nodes, 'session.overLimit'))).toContain('超出部分客户端可能截断')
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
    expect(shownIn(section)).toContain("mode === 'rollback' ? '真实执行时的改动' : '此步的改动'")
    expect(textOf(withIf(nodes, '!step.changes'))).toContain('无法列出此步的改动')
    expect(withIf(nodes, 'turnNotBuffered(step)')).toBeDefined()
    expect(shownIn(withIf(nodes, '!changes.length && !step.changes.turn')).join()).toContain(
      'changesNotListed(step.changes)',
    )
    expect(textOf(withIf(nodes, 'changesNotListed(step.changes)'))).toContain('此模式下不列出')
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
    const shown = bound(withTag(walk(turn), 'BenchRawText'), 'text')
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
      expect.arrayContaining([
        'BenchToolbar',
        'UTabs',
        'BenchCalls',
        'BenchScenarios',
        'BenchAgent',
      ]),
    )
    expect(page.script).toContain("{ label: '模型对话', value: 'agent' }")
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
    for (const tag of ['BenchCalls', 'BenchScenarios', 'BenchAgent']) {
      const tabContent = withTag(page.elements, tag)
      expect(tabContent.props?.some((p) => p.name === 'show')).toBe(true)
      expect(wrapper.children).toContain(tabContent)
    }
    expect(directive(withTag(page.elements, 'BenchAgent'), 'show')).toBe("tab === 'agent'")
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
    const alert = withTag(walk(run), 'BenchNotice')
    expect(bound(alert, 'title')).toBe('run.title')
    expect(bound(alert, 'description')).toBe('run.description')
    expect(alert.props?.some((p) => p.name === 'close')).toBe(true)
    expect(handler(alert, 'update:open')).toBe('(v) => !v && dismissAbandoned(run.id)')
    const steps = withFor(walk(run), 'step in run.result.steps')
    expect(steps.tag).toBe('BenchStepView')
    expect(steps.props?.find((p) => p.name === 'mode')?.value?.content).toBe('real')
    expect(bound(steps, 'view')).toBe('run.view')
    expect(bound(withTag(walk(withIf(walk(run), 'run.result')), 'BenchRunLine'), 'result')).toBe(
      'run.result',
    )
  })

  it('请求还没回来的时候也说一声', () => {
    const alert = withIf(abandoned.elements, 'abandonedInFlight')
    expect(alert.tag).toBe('BenchNotice')
    expect(alert.props?.find((p) => p.name === 'title')?.value?.content).toContain('可能正在写入')
  })
})

describe('被模型对话占着时的说明', () => {
  const busy = sfc(benchAgentBusy)

  it('只在模型对话进行时显示，说清楚为什么，能停止', () => {
    const alert = withIf(busy.elements, 'agentSending')
    expect(alert.tag).toBe('BenchNotice')
    expect(alert.props?.find((p) => p.name === 'title')?.value?.content).toContain('模型对话进行中')
    expect(bound(alert, 'actions')).toBe('actions')
    const actions = blockOf(busy.script, 'const actions = ')
    expect(actions).toContain('onClick: stopAgent')
    // 点过之后不能再点：已经发出去的运行取消不了，要等它回来
    expect(actions).toContain('disabled: agentStopping.value')
  })
})

describe('模型对话的页面', () => {
  const view = sfc(benchAgentView)
  const exchange = sfc(benchAgentExchange)
  const alertWith = (expression: string) => {
    const alert = must(
      view.elements.find((el) => el.tag === 'BenchNotice' && directive(el, 'if') === expression),
      `v-if="${expression}" 的提示`,
    )
    return alert
  }

  it('用不用得了由 GET bench/agent 决定：用不了时显示原因，不显示输入区', () => {
    expect(view.script).toContain('api.benchAgent(spaceId.value, appId.value!, keyId.value!)')
    expect(view.script).toContain('AGENT_UNAVAILABLE_NOTES[reason]')
    const alert = withDirective(view.elements, 'else-if', 'unavailable')
    expect(alert.tag).toBe('BenchNotice')
    expect(bound(alert, 'title')).toBe('unavailable.title')
    expect(bound(alert, 'description')).toBe('unavailable.description')
    expect(bound(alert, 'actions')).toBe('unavailableActions')
    // 只有 notAdmin 进不了实例设置
    expect(blockOf(view.script, 'const unavailableActions = ')).toContain(
      "info.data.value?.reason === 'notAdmin'",
    )
    expect(blockOf(view.script, 'const unavailableActions = ')).toContain(
      "to: { name: 'settings' }",
    )
    // 模型名、系统提示与输入区都只在用得了时才有
    const guarded = view.elements.filter((el) => directive(el, 'if') === 'available && loop')
    expect(guarded).toHaveLength(2)
    for (const label of ['模型', '发给模型的消息']) {
      const inside = guarded
        .flatMap(walk)
        .filter((el) =>
          el.props?.some((p) => p.name === 'aria-label' && p.value?.content === label),
        )
      expect(inside, `${label} 的输入框`).toHaveLength(1)
    }
    expect(guarded.flatMap(walk).some((el) => handler(el, 'click') === 'send')).toBe(true)
  })

  it('读取失败时能重新读；读到过的内容不被错误盖掉', () => {
    const alert = withIf(view.elements, 'infoError')
    expect(bound(alert, 'title')).toBe('infoError')
    expect(bound(alert, 'actions')).toBe('retryInfo')
    expect(blockOf(view.script, 'const retryInfo = ')).toContain('info.refetch()')
    // 和用不用得了的说明不是二选一
    expect(withDirective(view.elements, 'else-if', 'unavailable')).toBeDefined()
    expect(blockOf(view.script, 'const infoError = ')).toContain(
      'if (!info.isError.value) return null',
    )
  })

  it('循环的说明：按运行时，近似的那种用提醒的颜色说清楚', () => {
    const note = must(
      view.elements.find((el) => shownIn(el).includes('AGENT_LOOP_NOTES[loop]') && el.tag === 'p'),
      '循环的说明',
    )
    expect(bound(note, 'class')).toBe("loop === 'approximate' ? 'text-warning' : 'text-muted'")
    // 完整的循环在提示层里
    expect(shownIn(note)).toContain('AGENT_LOOP_DETAILS[loop]')
    expect(benchAgent).toMatch(/approximate:\s+'[^']*近似/)
  })

  it('会话上下文：mcp 不发生命周期事件，不显示', () => {
    expect(directive(withTag(view.elements, 'BenchContextForm'), 'if')).toBe("loop !== 'tools'")
  })

  it('开始前要点一下：提示写明接口地址、模型名与内容，点了才放开发送；任何一个变了再问', () => {
    const alert = alertWith('consent && needsConsent && !agentSending')
    expect(bound(alert, 'description')).toBe('consentText(consent, mode)')
    expect(bound(alert, 'actions')).toBe('consentActions')
    const actions = blockOf(view.script, 'const consentActions = ')
    expect(actions).toContain('`发送至 ${model.value}，开始对话`')
    expect(actions).toContain('onClick: () => consent.value && consentTo(consent.value)')
    // 同意的键：服务端给的接口地址、这里的模型名、服务端给的循环
    const target = blockOf(view.script, 'const consent = ')
    expect(target).toContain('endpoint: info.data.value?.endpoint ?? null')
    expect(target).toContain('model: model.value')
    expect(target).toContain('loop: loop.value')
    expect(view.script).toContain('consentNeeded(agent.value, consent.value)')
    expect(blockOf(view.script, 'const canSend = ')).toContain('!needsConsent.value')
    expect(bodyOf(view.script, 'send')).toContain('if (!canSend.value || !loop.value) return')
  })

  it('运行期间模型名、系统提示都不能改', () => {
    const fields = view.elements.filter((el) =>
      el.props?.some(
        (p) => p.name === 'aria-label' && ['模型', '系统提示'].includes(p.value?.content ?? ''),
      ),
    )
    expect(fields).toHaveLength(2)
    for (const field of fields) expect(bound(field, 'disabled')).toBe('running')
    expect(bodyOf(useBench, 'clearAgent')).toContain('if (running.value) return')
    expect(bodyOf(useBench, 'consentTo')).toContain('if (agentSending.value) return')
    expect(blockOf(view.script, 'const canSend = ')).toContain('!running.value')
    expect(bodyOf(useBench, 'sendToAgent')).toContain('if (running.value || !target) return null')
  })

  it('模型名清空时退回默认：发出去的总是一个模型名', () => {
    expect(view.script).toContain('modelText.value.trim() || defaultModel.value')
    const input = must(
      view.elements.find((el) => bound(el, 'model-value') === 'modelText'),
      '模型名的输入框',
    )
    expect(handler(input, 'update:model-value')).toBe('(v) => (modelEdit = String(v))')
    expect(bodyOf(view.script, 'send')).toContain('model: model.value')
  })

  it('发送：真实模式下只有点按钮才发，回车不发', () => {
    expect(handler(withHandler(view.elements, 'click', 'send'), 'click')).toBe('send')
    expect(bound(withHandler(view.elements, 'click', 'send'), 'disabled')).toBe('!canSend')
    const keydown = bodyOf(view.script, 'onKeydown')
    expect(keydown).toContain('real.value')
    expect(keydown).toContain('event.metaKey || event.ctrlKey')
    // 没有表单：回车的隐式提交点不到按钮
    expect(view.elements.some((el) => el.tag === 'form')).toBe(false)
  })

  it('这条消息没有进历史时文字放回输入框，可以再发一次；已经又写了别的就不动', () => {
    expect(bodyOf(view.script, 'send')).toContain(
      'if (!finished?.inHistory && !input.value) input.value = text',
    )
  })

  it('停止：只有发消息时才有，点了之后不能再点', () => {
    const button = withHandler(view.elements, 'click', 'stopAgent')
    expect(directive(button, 'if')).toBe('agentSending')
    expect(bound(button, 'disabled')).toBe('agentStopping')
    expect(bodyOf(useBench, 'stopAgent')).toContain('agentController.value.abort()')
  })

  it('取消传给模型请求：api 把 signal 带给 fetch', () => {
    expect(bodyOf(useBench, 'agentTurn')).toContain(
      'api.benchAgentTurn(target.space, target.app.id, target.key.id, body, signal)',
    )
    expect(bodyOf(useBench, 'sendToAgent')).toContain('signal: controller.signal')
  })

  it('换了应用、Key 或模式：对话清掉，进行中的取消', () => {
    const watcher = blockOf(
      useBench.replaceAll('\n  ', '\n'),
      'watch([spaceId, appId, keyId, mode]',
    )
    expect(watcher).toContain('agentController.value?.abort()')
    expect(watcher).toContain('agent.value = emptyConversation()')
    expect(useBench).toContain('onScopeDispose(() => agentController.value?.abort())')
    const onGeneration = blockOf(view.script, 'watch(generation, ')
    expect(onGeneration).toContain('exporting.value = null')
    expect(onGeneration).toContain('exportNote.value = null')
  })

  it('工具走 execute 的同一段：真实模式中途作废的规则相同，label 与 view 都传', () => {
    const send = bodyOf(useBench, 'sendToAgent')
    expect(send).toContain('runAs(id, target, steps, what(label), replay)')
    expect(send).toContain("const what = (label: string) => ({ label, view: 'call' as const })")
    // 只认这一次的状态：作废之后旧的循环写不回来
    expect(send).toContain('if (current.value === id) agent.value = next')
    expect(bodyOf(useBench, 'execute')).toContain('runAs(id, target, steps, what, replay)')
    expect(bodyOf(useBench, 'runAs')).toContain('abandonedRun(')
  })

  it('离开提醒与切换确认都算上对话', () => {
    const records = blockOf(useBench.replaceAll('\n  ', '\n'), 'const modeLoss = ')
    expect(records).toContain('agentMessages: agent.value.exchanges.length')
    expect(records).toContain('agent.value.session.replay.length')
    expect(useBench).toMatch(
      /useUnsavedChangesGuard\(\s+computed\([^]*agent\.value\.exchanges\.length > 0/,
    )
  })

  it('清空：运行期间不能，连提示一起清掉', () => {
    const button = buttonOf(view.elements, '清空对话')
    expect(handler(button, 'click')).toBe('requestClear')
    expect(bound(button, 'disabled')).toBe('running || !agent.exchanges.length')
    const clear = bodyOf(view.script, 'clear')
    expect(clear).toContain('if (running.value) return')
    expect(clear).toContain('clearAgent()')
    expect(bodyOf(useBench, 'clearAgent')).toContain('agent.value = emptyConversation()')
  })

  it('真实模式下可能写过库时清空先确认，说清楚运行标记也没了；回滚模式不问', () => {
    const request = bodyOf(view.script, 'requestClear')
    expect(request).toContain('if (agent.value.mayHaveWritten) confirmingClear.value = true')
    expect(request).toContain('else clear()')
    const modal = must(
      view.elements.find((el) => el.tag === 'UModal' && bound(el, 'open') === 'confirmingClear'),
      '清空的确认框',
    )
    expect(textOf(modal)).toContain('可能已写入数据库')
    expect(textOf(modal)).toContain('运行标记是在变更记录中对应这些写入的唯一线索')
    expect(textOf(modal)).toContain('不会撤回')
    const nodes = walk(modal)
    expect(handler(buttonOf(nodes, '清空'), 'click')).toBe('clear')
    expect(handler(buttonOf(nodes, '取消'), 'click')).toBe('confirmingClear = false')
    // 分叉提示里的清空走同一条路
    expect(blockOf(view.script, 'const divergedActions = ')).toContain('onClick: requestClear')
    // 换了应用、Key 或模式时对话已经清掉了，确认框不留着
    expect(blockOf(view.script, 'watch(generation, ')).toContain('confirmingClear.value = false')
  })

  it('存成场景：先检测明文，有就问，确认了才保存', () => {
    const button = buttonOf(view.elements, '存为场景')
    expect(handler(button, 'click')).toBe('startExport')
    expect(bound(button, 'disabled')).toBe('running || !hasCalls')
    const body = bodyOf(view.script, 'startExport')
    expect(body).toContain('agentScenario(agent.value, new Date())')
    expect(body).toContain('plaintextIn(scenario)')
    expect(body).toContain(
      'if (findings.length) exporting.value = { scenario, findings, dropped: made.dropped }',
    )
    expect(handler(buttonOf(view.elements, '仍然导出'), 'click')).toBe(
      'exporting && saveScenario(exporting.scenario, exporting.dropped)',
    )
    expect(view.script.match(/saveFile\(/g)).toHaveLength(1)
    const modal = must(
      view.elements.find((el) => el.tag === 'UModal' && bound(el, 'open') === 'exporting !== null'),
      '明文的确认框',
    )
    const finding = withFor(walk(modal), 'finding in exporting?.findings ?? []')
    expect(shownIn(finding)).toEqual(['finding.step', 'finding.label', 'finding.what'])
  })

  it('超过场景的步数上限时说明少了几个，能关掉；真的存了才说，取消的话什么都没存', () => {
    const body = bodyOf(view.script, 'startExport')
    expect(body).toContain('made.dropped')
    expect(body).not.toContain('droppedNote')
    // 这里的写入只有存不成的那一句
    expect(body.match(/exportNote\.value =/g)).toHaveLength(1)
    expect(body).toContain('exportNote.value = `无法存为场景')
    const save = bodyOf(view.script, 'saveScenario')
    expect(save.indexOf('exportNote.value = droppedNote(dropped)')).toBeGreaterThan(
      save.indexOf('saveFile('),
    )
    const alert = alertWith('exportNote')
    expect(bound(alert, 'title')).toBe('exportNote')
    expect(handler(alert, 'update:open')).toBe('(v) => !v && (exportNote = null)')
  })

  it('用不用得了每次都重新读：从实例设置配好模型回来时不能还显示没配', () => {
    expect(blockOf(view.script, 'const info = ')).toContain('staleTime: 0')
  })

  it('重放分叉：第几步与原因都显示，能接受或清空；再发还是同样报错时禁止发送', () => {
    // 内部错误的分叉不说再运行一次：这条消息可能已经留在历史
    expect(view.script).toContain("divergenceNotice(agent.value.session, '可继续发送下一条')")
    const alert = alertWith('diverged')
    expect(bound(alert, 'title')).toBe('diverged.title')
    expect(bound(alert, 'description')).toBe('diverged.description')
    expect(bound(alert, 'actions')).toBe('divergedActions')
    const actions = blockOf(view.script, 'const divergedActions = ')
    expect(actions).toContain('onClick: acceptAgentDiverged')
    expect(actions).toContain('onClick: requestClear')
    // 运行期间不能动：第几步是按发出请求时的日志算的
    expect(actions.match(/disabled: running\.value/g)).toHaveLength(2)
    expect(blockOf(view.script, 'const canSend = ')).toContain(
      '!blockingDivergence(agent.value.session)',
    )
    // 接受走调用台的同一条规则，运行期间不动
    expect(benchAgent).toContain('session: acceptDivergence(session)')
    expect(bodyOf(useBench, 'acceptAgentDiverged')).toContain('if (running.value) return')
    expect(bodyOf(useBench, 'acceptAgentDiverged')).toContain('acceptAgentDivergence(agent.value)')
    // 轨迹上去掉的那一步有标记
    const call = withFor(exchange.elements, 'call in round.calls')
    expect(textOf(withDirective(walk(call), 'else-if', 'call.trace?.removed'))).toContain(
      '写入已移除',
    )
  })

  it('运行中做不了会动对话的事：写入放不进重放日志时提示并禁用', () => {
    expect(view.script).toContain('runBlocker(agent.value.session, mode.value)')
    expect(bound(alertWith('blocker'), 'title')).toBe('blocker')
    expect(blockOf(view.script, 'const canSend = ')).toContain('!blocker.value')
  })

  it('用量与重放的情况都显示', () => {
    expect(view.script).toContain('usageSummary(agent.value.usage)')
    expect(view.script).toContain('sessionUsage(agent.value.session, mode.value)')
    const shown = view.elements.filter((el) => el.tag === 'p').flatMap(shownIn)
    expect(shown).toEqual(expect.arrayContaining(['usage', 'replayUsage']))
  })

  it('轨迹：每一轮有助手文字、折叠的思考过程、工具调用与用量', () => {
    const list = must(
      view.elements.find((el) => el.tag === 'BenchAgentExchange'),
      '轨迹',
    )
    expect(directive(list, 'for')).toBe('exchange in agent.exchanges')
    const round = withFor(exchange.elements, '(round, index) in exchange.rounds')
    const nodes = walk(round)
    const reasoning = withIf(nodes, 'round.reasoning')
    expect(reasoning.tag).toBe('BenchRawText')
    expect(bound(reasoning, 'text')).toBe('round.reasoning')
    // 折叠：不带 open
    expect(reasoning.props?.some((p) => p.name === 'open' || p.arg?.content === 'open')).toBe(false)
    expect(shownIn(withIf(nodes, 'round.text'))).toEqual(['round.text'])
    expect(textOf(withDirective(nodes, 'else-if', '!round.calls.length'))).toContain(
      '模型未返回文字',
    )
    // 拒绝回答时显示原因，不说没有返回文字
    const refusal = withDirective(nodes, 'else-if', 'round.refusal')
    expect(textOf(refusal)).toContain('模型拒绝回答')
    expect(shownIn(refusal)).toEqual(['round.refusal'])
    const siblings = round.children!.filter((n) => n.type === ELEMENT)
    expect(siblings.indexOf(refusal)).toBeGreaterThan(siblings.indexOf(withIf(nodes, 'round.text')))
    expect(siblings.indexOf(refusal)).toBeLessThan(
      siblings.indexOf(withDirective(nodes, 'else-if', '!round.calls.length')),
    )
    expect(shownIn(round)).toContain('roundMeta(round)')
  })

  it('工具调用：名字、参数与结果，结果用 BenchStepView 的显示规则', () => {
    const call = withFor(exchange.elements, 'call in round.calls')
    const nodes = walk(call)
    expect(shownIn(call).join()).toContain('call.name')
    const args = withTag(nodes, 'BenchRawText')
    expect(bound(args, 'text')).toBe('argumentsText(call)')
    expect(args.props?.some((p) => p.name === 'open' || p.arg?.content === 'open')).toBe(false)
    const step = withIf(nodes, 'call.trace')
    expect(step.tag).toBe('BenchStepView')
    expect(bound(step, 'step')).toBe('call.trace.step')
    expect(bound(step, 'mode')).toBe('mode')
    expect(step.props?.find((p) => p.name === 'view')?.value?.content).toBe('call')
    expect(bound(step, 'open')).toBe('callOpen(call.trace.step)')
    // 没有执行：说明原因；还在执行：说在执行
    expect(shownIn(withDirective(nodes, 'else-if', 'call.reply'))).toEqual(['call.reply'])
    expect(textOf(nodes.find((n) => n.props?.some((p) => p.name === 'else'))!)).toContain('执行中')
  })

  it('生命周期事件与 turn.end 也是同样的显示规则；turn.end 没发的原因写在轨迹上', () => {
    const lifecycle = withFor(exchange.elements, 'trace in exchange.lifecycle')
    expect(lifecycle.tag).toBe('BenchStepView')
    expect(bound(lifecycle, 'step')).toBe('trace.step')
    // 要看的是出了问题的那几步：别的折叠
    expect(bound(lifecycle, 'open')).toBe('callOpen(trace.step)')
    const turnEnd = withIf(exchange.elements, 'exchange.turnEnd')
    const turnEndStep = withTag(walk(turnEnd), 'BenchStepView')
    expect(bound(turnEndStep, 'step')).toBe('exchange.turnEnd.step')
    expect(bound(turnEndStep, 'open')).toBe('callOpen(exchange.turnEnd.step)')
    expect(shownIn(withIf(exchange.elements, 'exchange.turnEndNote'))).toEqual([
      'exchange.turnEndNote',
    ])
  })

  it('运行标记：真实模式下显示在轨迹上，到活动里对得上', () => {
    const marks = exchange.elements.flatMap(shownIn).join()
    expect(marks).toContain('exchange.lifecycle[0]?.run')
    expect(marks).toContain('roundRun(round)')
    expect(marks).toContain('exchange.turnEnd.run')
    expect(benchAgentExchange.match(/mode === 'real'/g)).toHaveLength(3)
  })

  it('结束时的提示与没进历史的说明', () => {
    const alert = withIf(exchange.elements, 'exchange.notice')
    expect(alert.tag).toBe('BenchNotice')
    expect(bound(alert, 'title')).toBe('exchange.notice')
    expect(bound(alert, 'color')).toBe('noticeColor(exchange.end)')
    expect(textOf(withIf(exchange.elements, 'exchange.end && !exchange.inHistory'))).toContain(
      '未进入历史',
    )
    expect(shownIn(withIf(exchange.elements, 'exchange.phase'))).toEqual([
      'agentPhaseLabels[exchange.phase]',
    ])
  })

  it('召回块留不留在历史写清楚；这条消息没进历史时不说留在历史', () => {
    const note = withDirective(exchange.elements, 'else-if', 'exchange.attached')
    expect(shownIn(note)).toEqual(['attachedNote(loop)'])
    const parent = must(
      exchange.elements.find((el) => el.children?.includes(note)),
      '说明的上一层',
    )
    const siblings = parent.children!.filter((n) => n.type === ELEMENT)
    expect(directive(siblings[siblings.indexOf(note) - 1]!, 'if')).toBe(
      'exchange.end && !exchange.inHistory',
    )
  })
})

describe('读取失败', () => {
  const toolbar = sfc(benchToolbar)

  it('错误放在上面，读到过的内容照常显示', () => {
    const appsError = withIf(toolbar.elements, 'apps.isError.value')
    expect(appsError.tag).toBe('BenchNotice')
    const keysError = withIf(toolbar.elements, 'keys.isError.value')
    expect(keysError.tag).toBe('BenchNotice')
    // 缓存是空的又刷新失败时只剩这一句：要能重新读
    expect(bound(appsError, 'actions')).toBe('retryApps')
    expect(bound(keysError, 'actions')).toBe('retryKeys')
    expect(toolbar.script).toContain('const retryApps = computed(() => retryOf(apps))')
    expect(toolbar.script).toContain('const retryKeys = computed(() => retryOf(keys))')
    const retry = blockOf(toolbar.script, 'const retryOf = ')
    expect(retry).toContain('query.refetch()')
    expect(retry).toContain('loading: query.isFetching.value')
    expect(blockOf(sfc(benchCalls).script, 'const toolsError = ')).toContain(
      'tools.isError.value ? catalogFailure(tools.error.value) : null',
    )
    expect(withIf(sfc(benchScenariosView).elements, 'presets.isError.value').tag).toBe(
      'BenchNotice',
    )
  })

  it('「暂无」只在真的读到空时说：读取中、读取失败时不说', () => {
    // 缓存是空的又刷新失败时也不说：不知道到底有没有，不能把人引去再建一个
    const noApps = withDirective(
      toolbar.elements,
      'else-if',
      'apps.data.value && !owned.length && !apps.isError.value',
    )
    expect(textOf(noApps)).toContain('暂无应用')
    const noKeys = withIf(
      toolbar.elements,
      'keys.data.value && !usable.length && !keys.isError.value',
    )
    expect(textOf(noKeys)).toContain('暂无有效 Key')
    const keySelect = must(
      toolbar.elements.find(
        (el) =>
          el.tag === 'USelect' &&
          el.props?.some((p) => p.name === 'aria-label' && p.value?.content === 'Key'),
      ),
      'Key 的下拉框',
    )
    expect(bound(keySelect, 'placeholder')).toBe(
      "keys.data.value && !keys.isError.value ? '暂无有效 Key' : ''",
    )
  })
})

describe('贴底的区块', () => {
  const places = [
    ['调用台', benchCalls, 'call-end', ['contextDiffers', 'unavailable', 'formError', 'failure']],
    ['场景', benchScenariosView, 'scenario-end', ['mismatch', 'errors.length', 'failure']],
    [
      '模型对话',
      benchAgentView,
      'composer',
      ['consent && needsConsent && !agentSending', 'blocker', 'diverged', 'exportNote'],
    ],
  ] as const

  it.each(places)(
    '%s：提示收进封顶的滚动区，键盘进得去，没有提示时不留空的停靠点',
    (_name, source, end, notices) => {
      const block = withClass(sfc(source).elements, end)
      const notes = withClass(walk(block), 'end-notes')
      const rule = ruleOf(source, '.end-notes')
      // 不按窗口高度的比例封顶：矮窗口里栏只有 350 到 400，不能几乎盖满
      expect(rule).toContain('max-height: min(30dvh, 14rem)')
      expect(rule).toContain('overflow-y: auto')
      expect(attr(notes, 'tabindex')).toBe('0')
      expect(attr(notes, 'role')).toBe('region')
      expect(attr(notes, 'aria-label')).toBeTruthy()
      expect(ruleOf(source, '.end-notes:empty')).toContain('display: none')
      for (const condition of notices) {
        const notice = withIf(walk(notes), condition)
        expect(notice.tag).toBe('BenchNotice')
        // 叠在一起，和下面的 BenchAgentBusy 之间不多一条线、一段空白
        expect(notice.props?.some((p) => p.name === 'flush')).toBe(true)
      }
      // 里面只有提示：换了结构也不能把按钮放进去
      expect(notes.children!.filter((n) => n.type === ELEMENT).map((el) => el.tag)).toEqual(
        notices.map(() => 'BenchNotice'),
      )
    },
  )

  it.each(places.slice(0, 2))(
    '%s：运行按钮和停止模型对话都在滚动区外面，一直够得着',
    (_name, source, end) => {
      const block = withClass(sfc(source).elements, end)
      expect(ruleOf(source, `.${end}`)).toContain('position: sticky')
      expect(ruleOf(source, `.${end}`)).toContain('bottom: 0')
      const notes = withClass(walk(block), 'end-notes')
      const busy = withTag(walk(block), 'BenchAgentBusy')
      expect(walk(notes)).not.toContain(busy)
      expect(busy.props?.some((p) => p.name === 'flush')).toBe(true)
      expect(walk(notes).map((el) => el.tag)).not.toContain('UButton')
      // 紧跟在提示后面：两者之间没有别的东西
      const kids = block.children!.filter((n) => n.type === ELEMENT)
      expect(kids.indexOf(busy)).toBe(kids.indexOf(notes) + 1)
    },
  )

  it('模型对话：文本框、发送、停止都在滚动区外面，放不下时只有提示缩小', () => {
    const { elements } = sfc(benchAgentView)
    const composer = withClass(elements, 'composer')
    const notes = withClass(walk(composer), 'end-notes')
    const kids = composer.children!.filter((n) => n.type === ELEMENT)
    expect(kids.indexOf(notes)).toBe(0)
    const input = must(
      elements.find((el) => attr(el, 'aria-label') === '发给模型的消息'),
      '发给模型的消息',
    )
    expect(kids).toContain(input)
    const actions = withClass(walk(composer), 'composer-actions')
    expect(kids).toContain(actions)
    expect(walk(actions)).toContain(withHandler(elements, 'click', 'send'))
    expect(walk(actions)).toContain(withHandler(elements, 'click', 'stopAgent'))
    expect(walk(notes).map((el) => el.tag)).not.toContain('UButton')
    // 输入区不自己滚：滚起来按钮就可能出视野。它能被压缩，压缩时只有提示让出高度
    const rule = ruleOf(benchAgentView, '.composer')
    expect(rule).toContain('max-height: 65%')
    expect(rule).toContain('flex: 0 1 auto')
    expect(rule).toContain('min-height: 0')
    expect(rule).not.toContain('overflow')
    const noteRule = ruleOf(benchAgentView, '.end-notes')
    expect(noteRule).toContain('flex: 0 1 auto')
    expect(noteRule).toContain('min-height: 0')
    expect(ruleOf(benchAgentView, '.message-input')).toContain('flex: none')
    expect(ruleOf(benchAgentView, '.composer-actions')).toContain('flex: none')
    const narrow = mediaOf(benchAgentView, 'max-width: 1240px')
    expect(narrow).toMatch(/\.composer \{[^}]*max-height: 70dvh/)
    expect(narrow).not.toMatch(/\.composer \{[^}]*overflow/)
  })
})

describe('提示里的操作', () => {
  it('公共的 NoteLine：操作能换行，按钮比一行还长时能缩，文字由按钮截断', () => {
    const rule = ruleOf(noteLine, '.note-actions')
    expect(rule).toContain('flex-wrap: wrap')
    expect(rule).toContain('min-width: 0')
    expect(rule).toContain('max-width: 100%')
    const slotted = ruleOf(noteLine, '.note-actions :slotted(*)')
    expect(slotted).toContain('min-width: 0')
    expect(slotted).toContain('max-width: 100%')
  })

  it('带模型名的长按钮放在 NoteLine 的操作里', () => {
    const consent = withIf(sfc(benchAgentView).elements, 'consent && needsConsent && !agentSending')
    expect(bound(consent, 'actions')).toBe('consentActions')
    const button = must(
      sfc(benchNotice).elements.find((el) => directive(el, 'for') === 'action in actions'),
      '操作的按钮',
    )
    expect(button.tag).toBe('UButton')
  })

  it('线框的样子只写在 BenchNotice 一处：操作自己不带 variant', () => {
    const button = must(
      sfc(benchNotice).elements.find((el) => directive(el, 'for') === 'action in actions'),
      '操作的按钮',
    )
    expect(attr(button, 'variant')).toBe('outline')
    expect(sfc(benchNotice).script).not.toContain('variant')
    for (const source of Object.values(SOURCES)) expect(source).not.toContain("variant: 'subtle'")
  })

  it('按钮文字被截断时悬停看得全：title 是完整的文字', () => {
    const button = must(
      sfc(benchNotice).elements.find((el) => directive(el, 'for') === 'action in actions'),
      '操作的按钮',
    )
    expect(bound(button, 'title')).toBe('action.label')
  })

  it('叠在别的线下面时用 flush，不从外面改 NoteLine 的样式', () => {
    for (const source of Object.values(SOURCES)) expect(source).not.toContain('.note-line')
    expect(bound(withTag(sfc(benchNotice).elements, 'NoteLine'), 'flush')).toBe('flush')
    expect(bound(withClass(sfc(noteLine).elements, 'note-line'), 'class')).toBe('{ flush }')
    const rule = ruleOf(noteLine, '.note-line.flush')
    expect(rule).toContain('border-top: 0')
    // 下边距和 .note-line + .note-line 的负边距是一对：两个都要去掉，隔着一层包裹时才不多空白
    expect(rule).toContain('margin-bottom: 0')
    expect(ruleOf(noteLine, '.note-line.flush + .note-line.flush')).toContain('margin-top: 0')
    expect(bound(withTag(sfc(benchAgentBusy).elements, 'BenchNotice'), 'flush')).toBe('flush')
    // 贴底区块的顶上都有一条线
    for (const [source, selector] of [
      [benchCalls, '.call-end'],
      [benchScenariosView, '.scenario-end'],
      [benchAgentView, '.composer'],
    ] as const) {
      expect(ruleOf(source, selector)).toContain('border-top: 1px solid')
    }
  })
})

describe('运行中的状态', () => {
  // 从根走到这个节点经过的元素（不含它自己）
  const ancestorsOf = (root: TemplateNode, target: TemplateNode): TemplateNode[] | null => {
    for (const child of root.children ?? []) {
      if (child === target) return [root]
      const found = ancestorsOf(child, target)
      if (found) return [root, ...found]
    }
    return null
  }
  const conditional = (el: TemplateNode) =>
    el.props?.some((p) => ['if', 'else-if', 'else'].includes(p.name))

  it.each([
    ['调用台', benchCalls, 'callRunning'],
    ['场景', benchScenariosView, 'scenarioRunning'],
  ])('%s：读屏念得到：role="status" 的元素一直在，只换文字', (_name, source, running) => {
    const { elements } = sfc(source)
    const status = must(
      elements.find((el) => attr(el, 'role') === 'status'),
      'role="status" 的元素',
    )
    expect(shownIn(status)).toEqual([`${running} ? '运行中…' : ''`])
    expect(conditional(status)).toBe(false)
    const ancestors = ancestorsOf(elements[0]!, status)
    expect(ancestors).not.toBeNull()
    for (const el of ancestors!) expect(conditional(el)).toBe(false)
    expect(elements.filter((el) => attr(el, 'role') === 'status')).toHaveLength(1)
    // 没在运行时不占地方，但不能用 display: none：那样就不是一直在了
    expect(styleOf(source)).toMatch(/\.run-status:not\(:empty\) \{/)
    expect(styleOf(source)).not.toMatch(/\.run-status[^{]*\{[^}]*display: none/)
  })

  it('场景：运行时不说暂无结果；结果和暂无结果都排在状态后面', () => {
    const { elements } = sfc(benchScenariosView)
    const result = withClass(elements, 'scenario-result')
    const none = withDirective(walk(result), 'else-if', '!scenarioRunning')
    expect(none.tag).toBe('p')
    expect(textOf(none)).toContain('暂无结果')
    const outcome = withIf(walk(result), 'outcome && summary')
    const kids = result.children!.filter((n) => n.type === ELEMENT)
    expect(kids.indexOf(none)).toBe(kids.indexOf(outcome) + 1)
    const status = must(
      kids.find((el) => attr(el, 'role') === 'status'),
      '状态',
    )
    expect(kids.indexOf(status)).toBe(kids.indexOf(outcome) - 1)
    // 标题跟着结果走，运行中和没有结果时是同一个标题
    const heading = withTag(kids, 'SectionHeading')
    expect(bound(heading, 'title')).toBe("outcome?.title ?? '运行结果'")
  })

  it('调用台：第一次调用时不说暂无调用，已有记录时也说运行中', () => {
    const { elements } = sfc(benchCalls)
    const none = withDirective(elements, 'else-if', '!callRunning')
    expect(textOf(none)).toContain('暂无调用')
    const list = withIf(elements, 'timeline.length')
    const parent = must(
      elements.find((el) => el.children?.includes(list)),
      '时间线的上一层',
    )
    const siblings = parent.children!.filter((n) => n.type === ELEMENT)
    const status = must(
      siblings.find((el) => attr(el, 'role') === 'status'),
      '状态',
    )
    expect(siblings.indexOf(status)).toBe(siblings.indexOf(list) - 1)
    expect(siblings.indexOf(none)).toBe(siblings.indexOf(list) + 1)
  })
})

describe('模型对话的版式', () => {
  it('Tab 顺序和看到的一样：消息在前，侧栏在后；只有窄屏靠 order 把侧栏挪上去', () => {
    const columns = withClass(sfc(benchAgentView).elements, 'agent-columns')
    const kids = columns.children!.filter((n) => n.type === ELEMENT)
    expect(kids.map(classOf)).toEqual(['agent-main', 'agent-side'])
    const narrow = mediaOf(benchAgentView, 'max-width: 1023.98px')
    expect(narrow).toMatch(/\.agent-side \{[^}]*order: -1/)
    expect(styleOf(benchAgentView).replace(narrow, '')).not.toMatch(/\border:/)
  })

  it('跟到最后时留出输入区的高度，只在它盖在消息上时：宽屏留了只会把页头顶走', () => {
    const { elements } = sfc(benchAgentView)
    const end = must(
      elements.find((el) => attr(el, 'ref') === 'end'),
      'ref="end"',
    )
    expect(classOf(end)).toBe('thread-end')
    expect(benchAgentView).not.toContain('scroll-mb')
    const narrow = mediaOf(benchAgentView, 'max-width: 1240px')
    expect(narrow).toMatch(/\.thread-end \{\s+scroll-margin-bottom: 14rem/)
    expect(narrow).toMatch(/\.composer \{[^}]*position: sticky/)
    const outside = styleOf(benchAgentView).replace(narrow, '')
    expect(outside).not.toContain('scroll-margin')
    expect(outside).not.toContain('position: sticky')
  })
})

describe('运行标记那一行', () => {
  it('只有一份：三处都用 BenchRunLine', () => {
    for (const source of [benchCalls, benchScenariosView, benchAbandoned]) {
      expect(sfc(source).elements.map((el) => el.tag)).toContain('BenchRunLine')
      expect(source).not.toContain('run-line')
      expect(source).not.toContain('scopesSummary')
    }
  })

  it('运行标记、应用与权限范围都显示', async () => {
    const app = createSSRApp(BenchRunLine, {
      result: {
        run: 'abc12345',
        whoami: {
          app: { name: '测试应用' },
          scopes: {
            readLayers: ['base'],
            writeLayers: [],
            maxSensitivity: 'internal',
            admin: false,
          },
        },
      },
    })
    const html = await renderToString(app)
    expect(html).toContain('abc12345')
    expect(html).toContain('测试应用')
    expect(html).toContain('可读 1 层，可写 0 层，最高内部')
  })
})

describe('改版之后的约束', () => {
  const pages = [
    ['BenchPage', benchPage],
    ['BenchAbandoned', benchAbandoned],
    ['BenchAgent', benchAgentView],
    ['BenchAgentBusy', benchAgentBusy],
    ['BenchAgentExchange', benchAgentExchange],
    ['BenchCalls', benchCalls],
    ['BenchContextForm', benchContextForm],
    ['BenchField', benchField],
    ['BenchNotice', benchNotice],
    ['BenchRawText', benchRawText],
    ['BenchRunLine', benchRunLine],
    ['BenchScenarios', benchScenariosView],
    ['BenchStatus', benchStatus],
    ['BenchStepView', benchStepView],
    ['BenchTag', benchTag],
    ['BenchToolbar', benchToolbar],
  ] as const

  it.each(pages)('%s 不用彩色徽章、卡片和老外壳', (_name, source) => {
    const tags = sfc(source).elements.map((el) => el.tag)
    for (const old of ['UBadge', 'UCard', 'UAlert', 'UDashboardPanel', 'UDashboardNavbar']) {
      expect(tags).not.toContain(old)
    }
  })

  const render = (component: Component, props: Record<string, unknown>) => {
    const app = createSSRApp(component, props)
    app.component('UIcon', () => h('svg'))
    app.component('UButton', (_, { attrs }) => h('button', String(attrs.label ?? '')))
    return renderToString(app)
  }

  it.each([
    ['success', 'neutral'],
    ['neutral', 'neutral'],
    ['warning', 'warning'],
    ['error', 'error'],
  ])('提示的语气：%s 显示成 %s，通过不上色', async (color, tone) => {
    const html = await render(BenchNotice, { color, title: '标题' })
    expect(html).toMatch(new RegExp(`class="${tone} note-title"`))
    expect(html).toContain('标题')
  })

  it('提示的说明与操作都显示，能关掉的有关闭按钮，关闭只发 update:open', async () => {
    const html = await render(BenchNotice, {
      title: '标题',
      description: '说明',
      actions: [{ label: '重新读取' }],
      close: true,
    })
    expect(html).toContain('说明')
    expect(html).toContain('重新读取')
    expect(handler(buttonOfLabel(sfc(benchNotice).elements, '关闭'), 'click')).toBe(
      "emit('update:open', false)",
    )
    const plain = await render(BenchNotice, { title: '标题' })
    expect(plain).not.toContain('<button')
    expect(plain).not.toContain('note-detail')
    // 只有操作、不能关掉的：不多一个按钮
    const actionOnly = await render(BenchNotice, {
      title: '标题',
      actions: [{ label: '重新读取' }],
    })
    expect(actionOnly.match(/<button/g)).toHaveLength(1)
  })

  it.each([
    ['success', false],
    ['neutral', false],
    ['warning', false],
    ['error', true],
  ])('步骤状态 %s 的文字一直在，只有出错才用砖红', async (color, brick) => {
    const html = await render(BenchStatus, { badge: { label: '状态', color, icon: 'x' } })
    expect(html).toContain('状态')
    expect(/class="[^"]*\berror\b[^"]*"/.test(html)).toBe(brick)
  })

  it('URI 要看全时折行，默认一行放不下先缩上一级路径', async () => {
    const wrapped = await render(UriPath, { uri: 'core://a/b', wrap: true })
    expect(wrapped).toMatch(/class="[^"]*\bwrap\b[^"]*uri-path|class="[^"]*uri-path[^"]*\bwrap\b/)
    const line = await render(UriPath, { uri: 'core://a/b' })
    expect(line).not.toMatch(/class="[^"]*\bwrap\b/)
  })

  it('状态与断言不用绿色：颜色只留给失败', () => {
    expect(benchStatus).not.toMatch(/success/)
    for (const source of [benchStepView, benchCalls, benchAgentExchange, benchScenariosView]) {
      expect(source).not.toContain('text-success')
    }
    const icon = withTag(
      walk(withFor(sfc(benchStepView).elements, '(a, i) in assertions')),
      'UIcon',
    )
    expect(bound(icon, 'class')).toBe("a.ok ? 'text-muted' : 'text-error'")
  })

  it('一串步骤标上第几步：和明文提示、重放分叉说的第几步对得上', () => {
    for (const source of [benchScenariosView, benchAbandoned]) {
      const step = must(
        sfc(source).elements.find((el) => el.tag === 'BenchStepView'),
        'BenchStepView',
      )
      expect(bound(step, 'number')).toBe('step.index + 1')
    }
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
