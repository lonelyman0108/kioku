import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import webPackage from '../../package.json'
import benchForm from '../benchForm?raw'
import benchResult from '../benchResult?raw'
import benchScenarios from '../benchScenarios?raw'
import benchSession from '../benchSession?raw'
import activityEntry from '../components/ActivityEntry.vue?raw'
import appSimulator from '../components/AppSimulator.vue?raw'
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
const buttonOf = (elements: TemplateNode[], label: string) =>
  elements.find(
    (el) =>
      el.tag === 'UButton' &&
      walk(el).some((n) => n.type === TEXT && n.content?.trim().includes(label)),
  )!
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
    const toggle = toolbar.elements.find((el) => el.tag === 'USwitch')!
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

  it('确认文字列出后果', () => {
    const modalBody = toolbar.elements.find((el) => el.tag === 'li' && bound(el, 'key') === 'line')
    expect(modalBody).toBeDefined()
    expect(benchToolbar).toContain('REAL_MODE_CONSEQUENCES')
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
    const form = calls.elements.find((el) => el.tag === 'form')!
    expect(handler(form, 'submit')).toBe('onSubmit')
    expect(bodyOf(calls.script, 'onSubmit')).toContain('if (!real.value)')
    const button = calls.elements.find(
      (el) => el.tag === 'UButton' && handler(el, 'click') === 'onRunClick',
    )!
    // 真实模式下不是提交按钮：不然回车的隐式提交会点它
    expect(bound(button, 'type')).toBe("real ? 'button' : 'submit'")
    expect(bodyOf(calls.script, 'onRunClick')).toContain('if (real.value)')
  })

  it('校验不拦在浏览器：表单不带 required 的原生校验', () => {
    const form = calls.elements.find((el) => el.tag === 'form')!
    expect(form.props?.some((p) => p.name === 'novalidate')).toBe(true)
  })

  it('连续调用走带重放的那条路', () => {
    expect(bodyOf(calls.script, 'run')).toContain('await call(')
    expect(bodyOf(useBench, 'call')).toContain('replayFor(session.value, mode.value)')
    expect(bodyOf(useBench, 'call')).toContain('recordRun(session.value, outcome.result)')
    expect(bodyOf(useBench, 'call')).toContain('runBlocker(session.value, mode.value)')
  })

  it('页面上写明工具调用不带会话上下文', () => {
    expect(benchCalls).toContain('工具调用不带会话上下文，真实的 MCP 也不带')
    expect(benchContextForm).toContain('工具调用不带')
  })
})

describe('场景的运行与导出', () => {
  const scenarios = sfc(benchScenariosView)

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
    expect(bodyOf(scenarios.script, 'runScenario')).toContain('execute(scenario.steps)')
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
    const stepView = scenarios.elements.find((el) => el.tag === 'BenchStepView')!
    expect(bound(stepView, 'view')).toBe('view')
  })

  it('导入的上传不用预览：这里是普通的文件输入，不建 blob 地址', () => {
    expect(benchScenariosView).not.toContain('createObjectURL')
    expect(benchScenariosView).not.toContain('UFileUpload')
    const input = scenarios.elements.find((el) => el.tag === 'input')!
    expect(handler(input, 'change')).toBe('onFile')
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

  it('权限探测不列断言的对错，只有还没发出去就失败的步骤靠它说明原因', () => {
    const list = view.elements.find((el) =>
      el.props?.some((p) => p.name === 'if' && p.exp?.content.includes('step.assertions.length')),
    )
    expect(list?.props?.find((p) => p.name === 'if')?.exp?.content).toBe(
      "step.assertions.length && (view !== 'probe' || !responded)",
    )
  })

  it('每一类都显示：内部错误、向量、session、改动、capture、原始响应、原因', () => {
    for (const field of [
      'step.internalError',
      'step.vectorSkipped',
      'step.reason',
      'step.changes',
      'step.changes.turn',
      'step.assertions',
    ]) {
      expect(benchStepView).toContain(field)
    }
    expect(view.script).toContain('props.step.session')
    expect(view.script).toContain('props.step.captured')
    expect(view.script).toContain('props.step.raw')
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
    const tabs = page.elements.find((el) => el.tag === 'UTabs')!
    const wrapper = page.elements.find((el) => el.children?.includes(tabs))!
    const dir = (name: string) => wrapper.props?.find((p) => p.name === name)?.exp?.content
    expect(dir('if')).toBe('mounted')
    expect(dir('show')).toBe('ready')
    for (const tag of ['BenchCalls', 'BenchScenarios']) {
      const el = page.elements.find((e) => e.tag === tag)!
      expect(el.props?.some((p) => p.name === 'show')).toBe(true)
    }
  })

  it('改过文本框就不再是那个预设了：再选它能换回原样', () => {
    const scenarios = sfc(benchScenariosView)
    expect(bodyOf(scenarios.script, 'edit')).toContain('presetId.value = undefined')
    const area = scenarios.elements.find((el) => el.tag === 'UTextarea')!
    expect(handler(area, 'update:model-value')).toBe('(v) => edit(String(v))')
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
