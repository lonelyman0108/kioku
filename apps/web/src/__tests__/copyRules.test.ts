import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

// 界面文字的禁用词，规则见 docs/plans/界面改版.md 的「术语」「文案规范」。
// 这些写法是把代码逻辑直接翻成了大白话，或者是内部叫法，改过一遍之后不能再写回去
const BANNED: [RegExp, string][] = [
  [/读得到|读不到|看得到|看不到/, '不讲权限逻辑：写「可见」「有权读取」「无权读取」，或者不写'],
  [/你/, '不用第二人称：写「当前账号」或省略'],
  [/像有|像凭据/, '写「疑似」'],
  [/[一这那每几]把|共 ?\S* ?把|^\s*把\s*(有效\s*)?Key/, 'Key 的量词用「个」'],
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
  [/(?<!JSON )对象(?!存储)/, '写「联系人」'],
  [/不可信/, '写「未确认」'],
  [/启动上下文|启动节点/, '写「启动加载」'],
  [/应用与 Key|召回分析/, '导航名是「应用」「召回」'],
  [/有效到/, '写「有效期」'],
  [/(?<![\w/`])(disclosure|priority|secret|boot)(?![\w/:`])/i, '用术语表的中文名'],
]

// 英文字段名：只在模板的文字和给人看的属性里查。脚本里的英文字符串大多是代码，查不了；
// 测试台直接展示接口，参数名照原样显示。Secret Access Key 是对象存储自己的字段名
const ENGLISH_TERMS = /\b(disclosure|priority|secret(?! access key)|boot)\b/i
const VISIBLE_ATTRS = new Set([
  'label',
  'title',
  'placeholder',
  'description',
  'help',
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

// 去掉注释之后，取含中文的文字片段：引号、尖括号、花括号之间的内容，这样代码里的字段名不算
function chineseFragments(source: string): { line: number; text: string }[] {
  const code = source
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  return code.split('\n').flatMap((raw, i) => {
    const fragments = raw.replace(/(^|\s)\/\/.*$/, '').match(/[^<>"'`={}]*[一-龥][^<>"'`={}]*/g)
    return (fragments ?? []).map((text) => ({ line: i + 1, text }))
  })
}

interface TemplateNode {
  type: number
  content?: string
  loc: { start: { line: number } }
  props?: { type: number; name: string; value?: { content: string } }[]
  children?: TemplateNode[]
}

function templateText(source: string): { line: number; text: string }[] {
  const ast = parse(source).descriptor.template?.ast as TemplateNode | undefined
  const out: { line: number; text: string }[] = []
  const walk = (node: TemplateNode) => {
    if (node.type === 2 && node.content) {
      out.push({ line: node.loc.start.line, text: node.content })
    }
    for (const prop of node.props ?? []) {
      if (prop.type === 6 && prop.value && VISIBLE_ATTRS.has(prop.name)) {
        out.push({ line: node.loc.start.line, text: prop.value.content })
      }
    }
    node.children?.forEach(walk)
  }
  if (ast) walk(ast)
  return out
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
      for (const { line, text } of chineseFragments(source)) {
        if (ALLOWED.some((a) => text.includes(a))) continue
        for (const [pattern, hint] of BANNED) {
          if (pattern.test(text)) found.push(`${path}:${line} ${hint}：${text.trim().slice(0, 60)}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('模板里不直接显示英文字段名', () => {
    const found: string[] = []
    for (const [path, source] of files) {
      if (!path.endsWith('.vue') || /\/Bench[^/]*\.vue$/.test(path)) continue
      for (const { line, text } of templateText(source)) {
        if (ENGLISH_TERMS.test(text)) found.push(`${path}:${line} ${text.trim().slice(0, 60)}`)
      }
    }
    expect(found).toEqual([])
  })
})
