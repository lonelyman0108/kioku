import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

// 界面文字的禁用词，规则见 docs/plans/界面改版.md 的「术语」「文案规范」。
// 这些写法是把代码逻辑直接翻成了大白话，或者是内部叫法，改过一遍之后不能再写回去
// 英文字段名。Secret Access Key 是对象存储自己的字段名，不算
const ENGLISH_TERMS = /(?<![\w/`.])(disclosure|priority|secret(?! access key)|boot)(?![\w/:`])/i

const BANNED: [RegExp, string][] = [
  [/读得到|读不到|看得到|看不到/, '不讲权限逻辑：写「可见」「有权读取」「无权读取」，或者不写'],
  [/你/, '不用第二人称：写「当前账号」或省略'],
  [/像有|像凭据/, '写「疑似」'],
  // 插值把数字切开之后，片段以「把」开头；「把 Key 吊销」里的「把」是动词，不算
  [/[一这那每几]把|共 ?\S* ?把|^\s*把\s*(有效|可用|未吊销)\S*\s*Key|\d\s*把/, 'Key 的量词用「个」'],
  [/从没/, '写「从未」'],
  [/还没/, '写「暂无」或「尚未」'],
  [/删不掉|用不了|没做成|占着|放不下|读不出|存不成|列不出|解不开|去看看/, '口语，换成产品用语'],
  [/策展/, '写「记忆」'],
  [/宿主/, '写「客户端」'],
  [/接入方/, '写「应用」或「客户端」'],
  [/主人/, '写「本人」或「所有者」'],
  [/待审/, '写「待处理」或「待确认内容」'],
  [/撤销删除/, '写「恢复」'],
  [/重新生效/, '写「恢复生效」'],
  [/让出/, '写「释放」'],
  [/推翻/, '写「取代」'],
  [/权限矩阵/, '写「权限范围」'],
  [/(?<!JSON\s)对象(?!存储)/, '写「联系人」'],
  [/不可信/, '写「未确认」'],
  [/启动上下文|启动节点/, '写「启动加载」'],
  [/应用与\s*Key|召回分析/, '导航名是「应用」「召回」'],
  [/有效到/, '写「有效期」'],
  [ENGLISH_TERMS, '用术语表的中文名'],
]

// 给人看的属性。其余属性多半是代码取值，比如 color、v-if
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

// 发给模型的提示词和工具结果不是界面文字，改了会影响模型行为；这几句按原样留着
const ALLOWED = [
  '你是一个有长期记忆的助手',
  '运行请求放不下这个调用',
  '写入放不进重放日志',
  '工具请求失败，没有拿到结果',
]

const sources = import.meta.glob<string>('../**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// 脚本部分：去掉注释之后取含中文的字符串片段，代码里的字段名不算。按行取，换行处切开的说法查不到
function scriptFragments(source: string): { line: number; text: string }[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  return code.split('\n').flatMap((raw, i) => {
    const fragments = raw
      .replace(/(^|\s)\/\/.*$/, '')
      .match(/[^<>"'`={}]*[\u4e00-\u9fa5][^<>"'`={}]*/g)
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

// 表达式里的字符串字面量：绑定的属性和插值里也可能直接写文字
const literals = (expression: string) =>
  [...expression.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '')

// 模板部分走语法树：文字节点是完整的，Prettier 换行切不开一句话
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
    expect(files.length).toBeGreaterThan(80)
    expect(files.filter(([path]) => path.endsWith('.vue')).length).toBeGreaterThan(50)
  })

  it('不再出现淘汰的写法', () => {
    const found: string[] = []
    for (const [path, source] of files) {
      // 测试台直接展示接口，英文参数名照原样显示；其余的词同样不能写
      const rules = /\/Bench[^/]*\.vue$/.test(path)
        ? BANNED.filter(([pattern]) => pattern !== ENGLISH_TERMS)
        : BANNED
      for (const { line, text } of visibleText(path, source)) {
        if (ALLOWED.some((a) => text.includes(a))) continue
        for (const [pattern, hint] of rules) {
          if (pattern.test(text)) found.push(`${path}:${line} ${hint}：${text.trim().slice(0, 60)}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
