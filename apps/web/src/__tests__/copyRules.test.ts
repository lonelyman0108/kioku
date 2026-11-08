import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

// 界面文字的禁用词，规则见 docs/design.md 的「界面用语」和 AGENTS.md 的「管理界面的设计与文案」。
// 这些写法是把代码逻辑直接翻成了大白话，或者是内部叫法，改过一遍之后不能再写回去
// 英文字段名。Secret Access Key 是对象存储自己的字段名，不算
const ENGLISH_TERMS = /(?<![\w/`.])(disclosure|priority|secret(?! access key)|boot)(?![\w/:`])/i

// 记忆的位置叫坐标。URI 只留在直接展示接口的测试台与召回调试，以及说 Lore 那边的地方（「Lore 的 URI」）
const URI = /(?<![\w/`.])(?<!Lore 的 )URI(?![\w`])/
const URI_ALLOWED = [/\/Bench[^/]*\.vue$/, /\/bench[^/]*\.ts$/, /\/RecallDebugPanel\.vue$/]

// 应用接入用的 Key 叫访问密钥，单数复数都查，「API Key」也算在内：访问密钥退回旧名时常写成它
const ACCESS_KEY = /(?<![\w/`.])Keys?(?![\w`])/i
// 讲上游自己的密钥的文件，只在这里放过上游的字段名：模型服务商的 API Key（嵌入、抽取设置，测试台的模型对话
// 用的也是抽取模型的），Lore 保存的 API Key（Lore 导入的提示），对象存储的 Access Key ID 与 Secret Access Key
// （备份），主密钥加密的是 API Key 与 Secret Access Key。别的文件写这几个名字照样报
const UPSTREAM_KEYS: [file: string, names: RegExp][] = [
  ['/components/EmbeddingChannelRow.vue', /API Key/g],
  ['/components/EmbeddingSettings.vue', /API Key/g],
  ['/components/ExtractionSettings.vue', /API Key/g],
  ['/benchAgent.ts', /API Key/g],
  ['/components/BenchAgent.vue', /API Key/g],
  ['/components/LoreImport.vue', /API Key/g],
  ['/components/BackupSettings.vue', /Access Key ID|Secret Access Key/g],
  ['/components/MasterKeySettings.vue', /API Key|Secret Access Key/g],
]

const BANNED: [RegExp, string][] = [
  [/读得到|读不到|看得到|看不到/, '不讲权限逻辑：写「可见」「有权读取」「无权读取」，或者不写'],
  [/你/, '不用第二人称：写「当前账号」或省略'],
  [/像有|像凭据/, '写「疑似」'],
  // 插值把数字切开之后，片段以「把」开头；「把访问密钥吊销」里的「把」是动词，不算
  [
    /[一这那每几]把|共 ?\S* ?把|^\s*把\s*(有效|可用|未吊销)\S*\s*(Key|访问密钥)|\d\s*把/,
    '访问密钥的量词用「个」',
  ],
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
  // 外部来源只剩成员连接的密码库，凭据源的说法跟着旧模型一起去掉
  [/凭据源/, '写「密码库」：连上的账号写「连接」，里面的一项写「条目」，分组写「集合」'],
  [/保险库|金库/, '写「密码库」'],
  // 保存前逐处处理疑似明文的两种选择
  [/不是密码|不是令牌|非凭据|并非凭据/, '写「不是凭据」'],
  [/误报/, '写「误判」'],
  // 新建的凭据写到去处（密码库集合）或由 Kioku 托管，不再让人选「新建托管」
  [/新建托管/, '写「新建凭据」，写到哪里说「密码库集合「…」」或「Kioku 托管」'],
  // 凭据的到期与轮换用契约 names.ts 的说法；记忆的有效期才说「过期」
  [/(?<!需)要轮换|需轮换|待轮换/, '写「需要轮换」'],
  [/快过期|凭据已过期|凭据过期/, '凭据写「快到期」「已到期」'],
  [/分区/, '分区去掉了：坐标里开头与标识之间的各级写「位置」，记忆是谁的写「归属」'],
  [/(?<!地|提示|弹出|外)层(?!次)/, '界面上指记忆是谁的写「归属」，不再说「层」'],
  [URI, '记忆的位置写「坐标」；URI 只留在测试台、召回调试与 Lore 那边'],
  [/情节/, '写「会话」或「会话摘要」'],
  [/画像/, '写「本人」'],
  [/私人(?!事务)/, '写「本人」'],
  [/基础(?!文字)/, '写「通用」'],
  [ENGLISH_TERMS, '用术语表的中文名'],
  // 下面几条测试台也要守：没有哪个接口参数叫这些名字
  [ACCESS_KEY, '写「访问密钥」；上游的字段名只在 UPSTREAM_KEYS 列出的文件里写'],
  [/(?<![\w/`.])domains?(?![\w`])/i, '分区去掉了：写「位置」或「归属」'],
  [/(?<![\w/`.])Dream(?![\w`])/i, '写「整理」'],
  [/(?<![\w/`.])Bots?(?![\w`])/i, '写「机器人」'],
  // 凭据里的 Token 叫令牌。Lore 的 API Token 是它自己的字段名；模型用量的 token 是小写，不算
  [/(?<![\w/`.])(?<!API )Token(?![\w`])/, '写「令牌」'],
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

// 脚本部分：去掉注释之后取含中文（汉字或中文标点）的字符串片段，代码里的字段名不算。中文标点也算：
// 插值把 `domain「${…}」重复` 切开之后，英文那一段只带着书名号。按行取，换行处切开的说法查不到。
// 已知的盲区：纯英文的字符串取不到，例如 `newKeyHint('Key', true)` 这类拼进界面文字的函数参数
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

// 表达式里的字符串字面量：绑定的属性和插值里也可能直接写文字。模板字符串里的 ${…} 是代码不是文字，
// 换成占位：不然 key、domain 这类变量名会被当成界面上的词；占位不是空白，「共 ${n} 把」照样查得出
const literals = (expression: string) =>
  [...expression.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '…'),
  )

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
      const rules = BANNED.filter(
        ([pattern]) =>
          !(pattern === ENGLISH_TERMS && /\/Bench[^/]*\.vue$/.test(path)) &&
          !(pattern === URI && URI_ALLOWED.some((allowed) => allowed.test(path))),
      )
      const upstream = UPSTREAM_KEYS.find(([file]) => path.endsWith(file))?.[1]
      for (const { line, text } of visibleText(path, source)) {
        if (ALLOWED.some((a) => text.includes(a))) continue
        for (const [pattern, hint] of rules) {
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
