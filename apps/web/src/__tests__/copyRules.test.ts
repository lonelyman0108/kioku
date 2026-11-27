import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

// 界面文字禁用词检查：避免把内部字段名、口语或废弃术语写进界面
const ENGLISH_TERMS = /(?<![\w/`.])(disclosure|priority|secret|boot)(?![\w/:`])/i
const URI = /(?<![\w/`.])URI(?![\w`])/
const ACCESS_KEY = /(?<![\w/`.])Keys?(?![\w`])/i

// 上游模型接口的 API Key 字段仅在模型设置页中允许出现
const UPSTREAM_KEYS: [file: string, names: RegExp][] = [
  ['/components/ModelSettings.vue', /API Key/g],
]

const BANNED: [RegExp, string][] = [
  [/读得到|读不到|看得到|看不到/, '不讲权限逻辑：写「可见」「有权读取」「无权读取」，或者不写'],
  [/你/, '不用第二人称：写「当前账号」或省略'],
  [/像有|像凭据/, '写「疑似」'],
  [
    /[一这那每几]把|共 ?\S* ?把|^\s*把\s*(有效|可用|未吊销)\S*\s*(Key|访问密钥)|\d\s*把/,
    '访问密钥的量词用「个」',
  ],
  [/从没/, '写「从未」'],
  [/还没/, '写「暂无」或「尚未」'],
  [/删不掉|用不了|没做成|占着|放不下|读不出|存不成|列不出|解不开|去看看/, '口语，换成产品用语'],
  [/策展/, '写「记忆」'],
  [/词条/, '界面可见文案写「记忆」'],
  [/宿主/, '写「客户端」'],
  [/主人/, '写「本人」或「所有者」'],
  [/待审/, '写「待确认」'],
  [/待处理/, '统一使用「整理」「整理页」「待确认建议」'],
  [/触发场景/, '正式记忆写「召回时机」，会话摘要写「信号要点」'],
  [/查重\/关联/, '写「查重与关联」'],
  [/预清洗/, '写「结构检查」或「自动修复」'],
  [/脏标题|待规范存量|历史流水账/, '使用中性产品用语（标题、待规范记忆、旧日志）'],
  [/所有环境|全部通用/, '写「全局通用」'],
  [/按说明微调/, '写「按说明修订」'],
  [/反向链接/, '写「反链」'],
  [/撤销删除/, '写「恢复」'],
  [/重新生效/, '写「恢复生效」'],
  [/权限矩阵/, '写「权限范围」'],
  [/启动上下文|启动节点/, '写「启动加载」'],
  [/有效到|有效至/, '写「有效期」或「有效期至」'],
  [/设备码|设备授权|授权码/, '写「浏览器授权」「确认码」'],
  [/分区/, '不再使用「分区」'],
  [URI, '界面正文不使用 URI'],
  [/情节/, '写「会话」或「会话摘要」'],
  [/画像/, '写「本人」'],
  [ENGLISH_TERMS, '使用中文产品术语'],
  [ACCESS_KEY, '写「访问密钥」；上游模型字段名只在 ModelSettings.vue 中允许'],
  [/(?<![\w/`.])domains?(?![\w`])/i, '不再使用 domain'],
  [/(?<![\w/`.])Dream(?![\w`])/i, '写「整理」'],
  [/(?<![\w/`.])Bots?(?![\w`])/i, '写「机器人」'],
  [/(?<![\w/`.])(?<!API )Token(?![\w`])/, '写「令牌」'],
]

const VISIBLE_ATTRS = new Set([
  'label',
  'title',
  'placeholder',
  'description',
  'help',
  'text',
  'alt',
  'header',
  'aria-label',
])

const sources = import.meta.glob<string>('../**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function scriptFragments(source: string): { line: number; text: string }[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  return code.split('\n').flatMap((raw, i) => {
    const fragments = raw
      .replace(/(^|\s)\/\/.*$/, '')
      .match(/[^<>"'`={}]*[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef][^<>"'`={}]*/g)
    return (fragments ?? []).map((text) => ({ line: i + 1, text }))
  })
}

interface TemplateNode {
  type: number
  content?: string | { content?: string }
  loc: { start: { line: number } }
  props?: {
    type: number
    name: string
    value?: { content: string }
    arg?: { content?: string }
    exp?: { content?: string }
  }[]
  children?: TemplateNode[]
}

const literals = (expression: string) =>
  [...expression.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '…'),
  )

function templateText(source: string): { line: number; text: string }[] {
  const ast = parse(source).descriptor.template?.ast as TemplateNode | undefined
  const out: { line: number; text: string }[] = []
  const add = (node: TemplateNode, text: string) =>
    out.push({ line: node.loc.start.line, text: text.replace(/\s+/g, ' ') })
  const walk = (node: TemplateNode) => {
    if (node.type === 2 && typeof node.content === 'string') add(node, node.content)
    if (node.type === 5 && typeof node.content === 'object') {
      for (const text of literals(node.content.content ?? '')) add(node, text)
    }
    for (const prop of node.props ?? []) {
      if (prop.type === 6 && prop.value && VISIBLE_ATTRS.has(prop.name)) {
        add(node, prop.value.content)
      }
      if (prop.type === 7 && prop.name === 'bind' && VISIBLE_ATTRS.has(prop.arg?.content ?? '')) {
        for (const text of literals(prop.exp?.content ?? '')) add(node, text)
      }
    }
    node.children?.forEach(walk)
  }
  if (ast) walk(ast)
  return out
}

function visibleText(path: string, source: string) {
  if (!path.endsWith('.vue')) return scriptFragments(source)
  const script = source.slice(0, source.indexOf('<template>'))
  return [...scriptFragments(script), ...templateText(source)]
}

describe('界面文字', () => {
  const files = Object.entries(sources).filter(
    ([path]) => !path.includes('.test.') && !path.includes('__tests__') && !path.endsWith('.d.ts'),
  )

  it('扫到了全部界面文件', () => {
    expect(files.length).toBeGreaterThan(25)
    expect(files.filter(([path]) => path.endsWith('.vue')).length).toBeGreaterThan(15)
  })

  it('不再出现淘汰的写法', () => {
    const found: string[] = []
    for (const [path, source] of files) {
      const upstream = UPSTREAM_KEYS.find(([file]) => path.endsWith(file))?.[1]
      for (const { line, text } of visibleText(path, source)) {
        for (const [pattern, hint] of BANNED) {
          const checked = pattern === ACCESS_KEY && upstream ? text.replace(upstream, '') : text
          if (pattern.test(checked)) {
            found.push(`${path}:${line} ${hint}：${text.trim().slice(0, 60)}`)
          }
        }
      }
    }
    expect(found).toEqual([])
  })
})
