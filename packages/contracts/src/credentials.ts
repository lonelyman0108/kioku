import { z } from 'zod'

import { BenchMark, DeletionRetention, EventActor, PageQuery } from './console'
import { ConsoleMemoryView } from './memories'
import { SENSITIVITIES, Sensitivity, type Layer } from './memory'

// 凭据的标识与字段名。记忆正文里用 {{cred:<标识>}} 引用整条凭据，{{cred:<标识>#<字段>}} 引用其中一个字段
export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const CredentialIdentifier = z
  .string()
  .regex(
    CREDENTIAL_NAME_PATTERN,
    '标识只能包含小写字母、数字、_ 和 -，须以字母或数字开头，最长 64 个字符',
  )
export const CredentialFieldName = z
  .string()
  .regex(
    CREDENTIAL_NAME_PATTERN,
    '字段名只能包含小写字母、数字、_ 和 -，须以字母或数字开头，最长 64 个字符',
  )

// 一条凭据最多这么多个字段
export const MAX_CREDENTIAL_FIELDS = 32

// 记忆正文里的凭据占位符。正文里任何位置出现 {{cred: 都算引用（代码里的也算），格式不对时拒绝写入；
// 要在正文里写到这种写法时去掉花括号。这里不带 g 标记，要找出全部时用它的 source 另建
export const CREDENTIAL_PLACEHOLDER_START = '{{cred:'
export const CREDENTIAL_PLACEHOLDER =
  /\{\{cred:([a-z0-9][a-z0-9_-]{0,63})(?:#([a-z0-9][a-z0-9_-]{0,63}))?\}\}/

// 占位符只能放在本人（user）、敏感级至少 private 的记忆里：按记忆的所有者解析，别的归属的读者解析不到。
// 写入检查、导入计划、转存和管理界面的入口都按这一条判断
export function placeholderAllowed(layer: Layer, sensitivity: Sensitivity): boolean {
  return layer === 'user' && SENSITIVITIES.indexOf(sensitivity) >= SENSITIVITIES.indexOf('private')
}

// 放不进时怎么说：服务端拒绝转存和管理界面提前拦下是同一句
export const CONVERT_SCOPE_TEXT =
  '凭据占位符只能放在本人、敏感级不低于私密的记忆中。请先把这条记忆移进本人或调高敏感级，再转存。'

// 空白字符逐个写出来（与 JS 的 \s 同一个集合）：服务端把这条规则的 source 原样交给 PostgreSQL，
// 它的 \s 随数据库的 locale 变，全角空格、BOM 这类字符两边会判断得不一样
const SPACE =
  ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'

// 写法里的标签。secret 后面跟着 key、access key 的（SECRET_KEY、AWS_SECRET_ACCESS_KEY）单列一项：标签和冒号之间只能隔着空白
const PLAINTEXT_LABELS =
  'password|passwd|passphrase|密码|口令|token|api[_ -]?key|secret[_ -]?(?:access[_ -]?)?key|secret'
// 值外面常见的引号、反引号与粗体：占位符写在里面也算占位符。打码时连同值外面的这些一起盖
export const PLAINTEXT_QUOTES = '"\'`“‘「『*'
// 值到这里结束：中文标点与收尾的引号。英文标点常出现在密码里，不算
const VALUE_STOPS = '，。；、！？）】」』》”’'
// 值到这里也结束，但不算遮盖符的结尾：左括号、左引号（「hunter2（旧）」）与 &（查询串里的下一项）
const VALUE_BREAKS = '（【《「『“‘&'
// 中日韩文字：假名、汉字（含扩展 A 与兼容汉字）、谚文音节。只列 BMP 里的：JS 的规则不带 u 标记，
// 补充平面的字是两个代理项，PostgreSQL 按码点算，写进来两边会判断得不一样
const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff'
// 写在引号里的键（JSON 与字典："db_password": …、'api_key': …）：标签后面可以先有一个收尾的引号再接冒号，
// 只要标签前面有开头的引号，中间只隔着字母、数字、_、- 或中文（lookbehind 不定长，JS 与 PostgreSQL 都认）。
// 普通文字里的 the token": abc 不算
const QUOTED_KEY_CLOSER = `(?:(?<=["'\`][A-Za-z0-9_${CJK}-]{0,40})["'\`])?`
// 值前面可以先有这些再接中文：引号、粗体与左括号
const CJK_LEADS = `${PLAINTEXT_QUOTES}（【《\\(\\[`
// 盖掉明文之后留下的遮盖符（转存时的历史快照、会话摘要的打码）：盖过的不再算明文
export const PLAINTEXT_MASK = '***'
// 值到这里就是结尾：空白、行尾、收尾的引号、粗体或中文标点；英文的逗号、句号这些算句子的标点，后面还要是空白或行尾。
// 下面几种「不是值」的写法后面都要紧接着它，否则后面跟着的就是真值（<b>hunter2、""hunter2、${x}abc）
// 收尾的英文引号后面还要接空白、行尾、中文标点或英文的收尾符号：xxx"hunter2"、"""hunter2""" 里的引号不是结尾
const VALUE_ENDS_HERE =
  `(?:[,.;:]*(?:[${SPACE}]|$)|[${VALUE_STOPS}]` +
  `|["'\`](?=[${SPACE}${VALUE_STOPS},.;:\\)\\]}>]|$)` +
  `|\\*\\*(?![^${SPACE}${VALUE_STOPS},.;:]))`
// 整段都是遮盖：***、********、xxxx、...、………，紧接着就是值的结尾。
// 所以 ***hunter2***、***x、xxxxy 照样算明文：真密码可能这样开头，不能借遮盖符躲过提醒和拦截
const WHOLE_MASK = `(?:\\*{3,}|x{3,}|\\.{3,}|…{3,})${VALUE_ENDS_HERE}`
// 代码笔记里写的不是值：类型名（password: string、token: Optional[str]、(password: string)）。
// 后面可以先有 []，或者方括号、尖括号里的类型参数（只能是类型名，可以再嵌一层：List[Dict[str, int]]、
// Map<string, string>），再接一串收尾符号 ) ] } > , ;，最后都要接值的结尾：
// string123、Str#1234、none!23、any=x、str[hunter2]、Map<hunter2>、none)hunter2 照样算
const TYPE_WORDS =
  '(?:string|str|number|int|integer|float|bool|boolean|bytes|null|none|nil|undefined|void|any|unknown|object' +
  '|optional|secretstr|list|dict|map|record|array|set|promise|partial|readonly|tuple|sequence|mapping|iterable)'
// 类型参数：类型名，后面可以再带一层方括号或尖括号里的类型名
const TYPE_ARGS = (inner: string) => `[\\[<]${inner}(?:[ ,|]{1,3}${inner}){0,4}[\\]>]`
const TYPE_ARG = `${TYPE_WORDS}(?:${TYPE_ARGS(TYPE_WORDS)})?`
const TYPE_NAMES =
  TYPE_WORDS + `(?:\\[\\]|${TYPE_ARGS(TYPE_ARG)})?` + `[\\)\\]}>,;]{0,8}${VALUE_ENDS_HERE}`
// 一行之内的一段：引用里的名字与参数
const IN_LINE = (max: number, closer: string) => `[^${closer}\\n\\r\\u2028\\u2029]{1,${max}}`
// 变量名，与写在引号里的变量名（getenv("DB_PASSWORD")、os.environ['X']）
const VARIABLE_NAME = '[A-Za-z_][A-Za-z0-9_]{0,127}'
const QUOTED_NAME = `(?:"[A-Za-z_][A-Za-z0-9_.-]{0,127}"|'[A-Za-z_][A-Za-z0-9_.-]{0,127}')`
// 变量与环境变量的引用，都要是整段值，里面不能写着字面的值（${X:-默认值}、getenv("X", "默认值")、$(echo 值) 都算明文）：
// $NAME、${NAME}、%NAME%、process.env.NAME、process.env["NAME"]、os.environ["NAME"]、
// os.getenv("NAME")、getenv("NAME")、env("NAME")，以及读文件或密码库的 $(…)：里面要有 /、不带引号，最多 128 个字
// （$(cat /run/secrets/db)、$(pass show a/b)、$(op read op://…)）。
// 后面可以先有几个收尾的括号与 , ;（f(os.getenv("X"))、{ key: $X },），再接值的结尾。
// 已知的限制：$ 后面全是字母、数字或 _ 的整段值（$ecretPass1）也按变量算：规则不分大小写，
// 分不出 $DB_PASS 和这种密码，而 shell 片段里的 $VAR 很常见。$(…) 里写着路径的命令整段按不是值算，
// 命令参数里夹着的明文认不出（$(curl 带着账号密码的参数 …)）。
// 带字面值的引用与模板（$(echo x)、getenv("X", "x")）会报出来，但值的结尾按空白与引号猜，转存前要人看过
const COMMAND_PART = `[^\\(\\)"'\`\\n\\r\\u2028\\u2029]{0,64}`
const VARIABLE_REFS =
  `(?:\\$${VARIABLE_NAME}` +
  `|\\$\\{${VARIABLE_NAME}\\}` +
  `|\\$\\(${COMMAND_PART}/${COMMAND_PART}\\)` +
  `|%${VARIABLE_NAME}%` +
  `|process\\.env\\.${VARIABLE_NAME}` +
  `|(?:process\\.env|os\\.environ)\\[${QUOTED_NAME}\\]` +
  `|(?:os\\.getenv|getenv|env)\\(${QUOTED_NAME}\\)` +
  `)[\\)\\]},;]{0,8}${VALUE_ENDS_HERE}`
// 尖括号占位（<你的密码>）：同一行内、不超过 64 个字，整段就是它
const ANGLE_PLACEHOLDER = `<${IN_LINE(64, '<>')}>${VALUE_ENDS_HERE}`
// 模板与 CI 表达式（${{ secrets.token }}、Ansible、Helm、Jinja、Go 模板的 {{ vault_password }}）：
// 里面只能有字母、数字、_、.、空格与不带参数的过滤器 |，最多 128 个字，整段就是它。
// 带引号或括号的（{{ x | default('值') }}）可能写着字面的值，照样算
const TEMPLATE_EXPRESSION = `\\$?\\{\\{[A-Za-z0-9_. |]{1,128}\\}\\}${VALUE_ENDS_HERE}`
// 一个或几个连着写的凭据占位符（{{cred:a#user}}:{{cred:a#pass}}），中间隔着不超过 3 个分隔符。
// 规则不分大小写，大写的假占位符 {{CRED:…}} 也按占位符排除（写入时由占位符的格式检查拒绝）
const ONE_PLACEHOLDER = CREDENTIAL_PLACEHOLDER.source.replace(/\((?!\?)/g, '(?:')
const PLACEHOLDER_RUN = `${ONE_PLACEHOLDER}(?:[:@/,;=&|-]{0,3}${ONE_PLACEHOLDER}){0,8}`
// 值就是占位符：不写在引号里的（可以带粗体）后面接值的结尾；写在引号里的，引号里的值是整段内容
// （口令短语可以有空格），所以占位符后面只能有空白，再紧接收尾的引号："{{cred:a}} hunter2" 照样算
const PLACEHOLDER_VALUE =
  `\\*{0,3}[${SPACE}]*${PLACEHOLDER_RUN}${VALUE_ENDS_HERE}` +
  `|["'\`“‘「『][${SPACE}]*${PLACEHOLDER_RUN}[${SPACE}]*["'\`”’」』]`
// 「密码：…」后面不是值的几种：凭据占位符、整段遮盖、类型名、变量引用、尖括号占位、模板表达式、
// 空的引号（里面只有空白的也算），都要是整段值（后面紧接值的结尾）：{{cred:db}}hunter2 照样算。
// 前面可以先有引号与粗体。占位符另见 PLACEHOLDER_VALUE
const NOT_A_VALUE =
  `${WHOLE_MASK}|${TYPE_NAMES}|${VARIABLE_REFS}|${ANGLE_PLACEHOLDER}|${TEMPLATE_EXPRESSION}` +
  `|(?:"[${SPACE}]*"|'[${SPACE}]*')${VALUE_ENDS_HERE}`

// 疑似明文的类别：label 是「密码：…」「token = …」这类写法，其余是有固定前缀或结构的令牌
export const PLAINTEXT_KINDS = [
  'label',
  'sk',
  'github',
  'gitlab',
  'slack',
  'aws',
  'jwt',
  'private_key',
  'kioku',
] as const
export const PlaintextKind = z.enum(PLAINTEXT_KINDS)
export type PlaintextKind = z.infer<typeof PlaintextKind>
type TokenKind = Exclude<PlaintextKind, 'label'>

// 「密码：…」这类写法：值写在下一行的也算；后面不是值的（见 NOT_A_VALUE）不算；
// 值以中文开头的不算（「密码：见 Vaultwarden 条目」），前面隔着引号、粗体或左括号也一样。
// 代码表达式（config.password、getToken()）照样算，确实不是凭据时由写入方确认
// 写法写在 Markdown 的强调里：冒号在强调里（**Password:** x、- **Token:** x）时，冒号后面先有收尾的强调符
// 再接空白；冒号在强调外（**Password**: x、*Password*: x、_Password_: x）时，标签后面先有收尾的强调符。下面的排除都从跳过这些符号之后算：
// 值不能就是「强调符加空白」，不然不跳过强调符的那条路会把它当成值的第一个字，绕开排除
const EMPHASIS_AFTER_COLON = `(?:(?:\\*\\*|__|\\*)(?=[${SPACE}]))?`
const EMPHASIS_BEFORE_COLON = '(?:\\*\\*|__|\\*|_)?'
const LABEL_RULE =
  `(?:${PLAINTEXT_LABELS})${QUOTED_KEY_CLOSER}${EMPHASIS_BEFORE_COLON}[${SPACE}]*[:：=]` +
  `${EMPHASIS_AFTER_COLON}[${SPACE}]*(?!(?:\\*\\*|__|\\*)[${SPACE}])` +
  `(?!${PLACEHOLDER_VALUE})(?![${PLAINTEXT_QUOTES}]*(?:${NOT_A_VALUE}))(?![${CJK_LEADS}]*[${CJK}])[^${SPACE}]`

// 令牌前后不能紧挨着字母、数字、_ 与 -：task-…、my_ghp_… 这类是别的词的一部分
const TOKEN_START = '(?<![A-Za-z0-9_-])'
const TOKEN_END = '(?![A-Za-z0-9_-])'
// 已知格式的令牌。规则不区分大小写（PostgreSQL 用 ~*），前缀的大小写不作数，靠长度与结构压低误报
const TOKEN_RULES: Record<TokenKind, string> = {
  // OpenAI、Anthropic、DeepSeek 这类：sk- 之后可以先有几段带连字符的前缀（sk-proj-、sk-ant-api03-），
  // 要有一段至少 16 个字母与数字连着。sk-learn 这类短词不算。
  // Stripe 的私钥与受限密钥（sk_live_、sk_test_、rk_live_、rk_test_）也算这一类；公开的 pk_ 不算
  sk:
    `${TOKEN_START}(?:sk-(?:[A-Za-z0-9]+[-_]){0,8}[A-Za-z0-9]{16,}` +
    `|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})`,
  // GitHub：ghp_、gho_、ghu_、ghs_、ghr_ 加 36 位，细粒度的 github_pat_ 加 82 位（这里放宽到 40 位）
  github: `${TOKEN_START}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})`,
  // GitLab 个人访问令牌：glpat- 加 20 位
  gitlab: `${TOKEN_START}glpat-[A-Za-z0-9_-]{20,}`,
  // Slack：xoxb-、xoxa-、xoxp-、xoxr-、xoxs- 加数字与字母的几段
  slack: `${TOKEN_START}xox[baprs]-[A-Za-z0-9-]{20,}`,
  // AWS 长期访问密钥的 ID：AKIA 加 16 位。临时的 ASIA 不收：不区分大小写时 Asia 开头的长词会被误报
  aws: `${TOKEN_START}AKIA[A-Z0-9]{16}${TOKEN_END}`,
  // JWT：三段 base64url，前两段是 JSON（eyJ 开头）
  jwt: `${TOKEN_START}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
  // 私钥块：BEGIN … PRIVATE KEY（PGP 的带 BLOCK）的开头一行，后面要跟着正文。只写了开头一行的不算，
  // 文档里常提到这种写法；旧式加密的 PEM（下一行是 Proc-Type:）也不算，它的正文本来就加了密
  private_key: `-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[${SPACE}]*[A-Za-z0-9+/=]{16,}`,
  // Kioku 自己的访问密钥：kioku_<12 位前缀>_<40 位密钥>（服务端 auth/keys.ts）。只有前缀的不算
  kioku: `${TOKEN_START}kioku_[A-Za-z0-9]{12}_[A-Za-z0-9]{40}${TOKEN_END}`,
}
const TOKEN_KINDS = Object.keys(TOKEN_RULES) as TokenKind[]

// 正文像有明文密码或 Token：上面两类规则合在一起。启发式规则，宁可多报：用来提醒、拦下新写进来的明文，
// 以及挡住带着明文从 secret 降级（管理界面里由空间 owner 确认后可以强制）。
// 服务端把 source 原样交给 PostgreSQL（~*），所以只用两边都认的写法：(?:…)、(?=…)、(?!…)、(?<!…)、
// 方括号与 \uXXXX；不用 \b、\d、\w、\s（PostgreSQL 的 \b 是退格，\s 随 locale 变）、命名分组与 u 标记，
// 重复次数不超过 255。不加捕获分组：类别在 JS 里按开头另认
// SQL 里拆成两条（写法一条、令牌一条）再用 or 连起来：PostgreSQL 对一整条大的多选匹配得慢，
// 两万条记忆的正文拆开后快一倍以上。合起来就是 PLAINTEXT_CREDENTIAL
export const PLAINTEXT_CREDENTIAL_PARTS: readonly string[] = [
  LABEL_RULE,
  TOKEN_KINDS.map((kind) => TOKEN_RULES[kind]).join('|'),
]
export const PLAINTEXT_CREDENTIAL = new RegExp(PLAINTEXT_CREDENTIAL_PARTS.join('|'), 'i')

// 正文里疑似明文的一处：值在 [start, end) 这一段（JS 字符串的下标），line 是 start 所在的行（从 1 起，按 \n 分行），
// kind 是类别，field 是建议用的字段名。规则只认得出值从哪里开始，「密码：…」的值到哪里结束是猜的，要让人看过再转存
export interface PlaintextCredentialMatch {
  start: number
  end: number
  line: number
  kind: PlaintextKind
  field: string
}

const PLAINTEXT_ALL = new RegExp(PLAINTEXT_CREDENTIAL.source, 'gi')
const PLAINTEXT_LABEL = new RegExp(`^(?:${PLAINTEXT_LABELS})`, 'i')
// 在指定位置开始匹配（y 标记），不切出子串：正文很长、匹配很多时切子串是平方级的
const TOKEN_AT = TOKEN_KINDS.map(
  (kind) => [kind, new RegExp(`(?:${TOKEN_RULES[kind]})`, 'iy')] as const,
)
const TOKEN_ANCHORED = TOKEN_KINDS.map(
  (kind) => [kind, new RegExp(`^(?:${TOKEN_RULES[kind]})`, 'i')] as const,
)
// 值写在这些符号里时取里面的部分
const VALUE_WRAPPERS: readonly (readonly [string, string])[] = [
  ['***', '***'],
  ['**', '**'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]
// 不写在符号里的值结尾可能带着的收尾符号与配对的开头
const UNPAIRED_CLOSERS: readonly (readonly [string, string])[] = [
  ['**', '**'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]
// 写在符号里的值最长这么多个字符，再长就按没写在符号里算：找收尾的符号不往后扫太远
const WRAPPED_VALUE_MAX = 1024
// 不写在符号里的值也最长这么多个字符：比较新增时要按值查表、去掉落单的引号时要往回找配对的开头。
// 更长的值只比较前 1024 个字，转存也只取这么多
const VALUE_MAX = 1024
const LINE_BREAK = /[\n\r\u2028\u2029]/g
// 值到这里结束：空白、中文标点、左括号与左引号、&、占位符
const VALUE_END = new RegExp(`[${SPACE}${VALUE_STOPS}${VALUE_BREAKS}]|\\{\\{cred:`, 'g')
// 延伸的值到这里结束：和 VALUE_END 一样，只是不看 VALUE_BREAKS（比较新增时用，见 addedPlaintextCredentials）
const EXTENDED_END = new RegExp(`[${SPACE}${VALUE_STOPS}]|\\{\\{cred:`, 'g')
const PLACEHOLDER_START = /\{\{cred:/g
const PLACEHOLDER_AT = new RegExp(CREDENTIAL_PLACEHOLDER.source, 'y')
// 令牌后面紧跟着的连字符与下划线也是值的一部分
const TOKEN_TAIL = /[A-Za-z0-9_-]*/y
// 私钥块的结尾：从正文开头起只经过 base64 字符与空白就能到达的 END 行
const PRIVATE_KEY_END = /[A-Za-z0-9+/=\s]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/iy
// 没有 END 行时：这一行剩下的 base64 字符，再加上之后整行都是 base64 字符的各行
const BASE64_RUN = /[A-Za-z0-9+/=]*/y
const BASE64_LINE = /\r?\n[A-Za-z0-9+/=]+(?=\r?\n|$)/y

const TOKEN_FIELDS: Record<TokenKind, string> = {
  sk: 'api_key',
  github: 'token',
  gitlab: 'token',
  slack: 'token',
  aws: 'access_key_id',
  jwt: 'token',
  private_key: 'private_key',
  kioku: 'api_key',
}

function plaintextField(label: string): string {
  const word = label.toLowerCase()
  if (word.startsWith('secret')) return 'secret'
  if (word === 'token') return 'token'
  return word.startsWith('api') ? 'api_key' : 'password'
}

// 往后找下一处的位置。只在问的位置不比上一次早时复用上一次的结果：上一次从 from 找到 at，
// from 与 at 之间没有，问 [from, at] 里的位置答案还是 at。按先后问时整段只扫一遍
function forwardSearch(text: string, pattern: RegExp): (from: number) => number {
  let searchedFrom = -1
  let found = -1
  return (from) => {
    if (searchedFrom !== -1 && from >= searchedFrom && from <= found) return found
    pattern.lastIndex = from
    const m = pattern.exec(text)
    searchedFrom = from
    found = m ? m.index : text.length
    return found
  }
}

// 一段正文的扫描：值的结尾、收尾的符号与行尾都按先后往后找
function scanner(text: string) {
  const valueEnd = forwardSearch(text, new RegExp(VALUE_END.source, 'g'))
  const extendedEnd = forwardSearch(text, new RegExp(EXTENDED_END.source, 'g'))
  const placeholderAt = forwardSearch(text, new RegExp(PLACEHOLDER_START.source, 'g'))
  const lineEnd = forwardSearch(text, new RegExp(LINE_BREAK.source, 'g'))
  const closers = new Map<string, (from: number) => number>()
  const closerAt = (close: string, from: number) => {
    let find = closers.get(close)
    if (!find) {
      const escaped = close.replace(/[*]/g, '\\*')
      find = forwardSearch(text, new RegExp(escaped, 'g'))
      closers.set(close, find)
    }
    return find(from)
  }

  // 结尾的逗号、句号是句子的标点；感叹号、问号常是密码的一部分，留着
  const trimSentence = (first: number, end: number) => {
    while (end > first + 1 && ',.;:'.includes(text[end - 1]!)) end--
    return Math.max(end, first + 1)
  }
  // 结尾是落单的收尾引号或粗体（写法写在行内代码里：`api_key: abc`）：值里没有和它配对的开头时去掉，
  // 再去掉它前面句子的标点。只改值的范围，认不认得出不变
  const trimCloser = (first: number, end: number) => {
    for (const [open, close] of UNPAIRED_CLOSERS) {
      const at = end - close.length
      if (at <= first || !text.startsWith(close, at)) continue
      // 配对的开头在 [first, at) 里：按先后往后找，不切子串
      if (closerAt(open, first) < at) continue
      return trimSentence(first, at)
    }
    return end
  }

  // 从 at 起跳过连着的占位符
  const skipPlaceholders = (at: number) => {
    for (;;) {
      PLACEHOLDER_AT.lastIndex = at
      const placeholder = PLACEHOLDER_AT.exec(text)
      if (!placeholder) return at
      at += placeholder[0].length
    }
  }

  // 紧接在规则认出的第一个字之后，值到哪里结束。extendedEnd 是延伸的值的结尾：写在符号里的与 end 相同，
  // 不写在符号里的不在左括号、左引号与 & 处停。不是值时（符号里只有空白与占位符）为 null
  const labelValue = (
    first: number,
  ): { start: number; end: number; extendedEnd: number } | null => {
    const line = lineEnd(first)
    for (const [open, close] of VALUE_WRAPPERS) {
      if (!text.startsWith(open, first)) continue
      const start = first + open.length
      const end = closerAt(close, start)
      if (end <= start || end >= line || end - start > WRAPPED_VALUE_MAX) continue
      // 开头的占位符与它后面的空白不算值（"{{cred:db}} hunter2" 的值是 hunter2）；值里再有占位符时到占位符为止，
      // 和不写在符号里一样（去掉结尾的空白）
      let valueStart = skipPlaceholders(start)
      if (valueStart > start) {
        while (valueStart < end && /\s/.test(text[valueStart]!)) valueStart++
      }
      if (valueStart >= end) return null
      const placeholder = placeholderAt(valueStart)
      let stop = placeholder < end ? placeholder : end
      while (stop > valueStart && /\s/.test(text[stop - 1]!)) stop--
      if (stop === valueStart) return null
      return { start: valueStart, end: stop, extendedEnd: stop }
    }
    // 值以占位符开头、后面还有字（{{cred:db}}hunter2）：占位符之后的部分是值
    const at = skipPlaceholders(first)
    if (at > first && (at >= line || valueEnd(at) === at)) return null
    const capped = (end: number) => Math.min(end, at + VALUE_MAX)
    return {
      start: at,
      end: trimCloser(at, trimSentence(at, capped(valueEnd(at)))),
      extendedEnd: trimCloser(at, trimSentence(at, capped(extendedEnd(at)))),
    }
  }

  // 令牌从 start 起，整串都是值
  const tokenValue = (kind: TokenKind, start: number, matched: number) => {
    let end = start + matched
    if (kind === 'private_key') {
      PRIVATE_KEY_END.lastIndex = end
      const close = PRIVATE_KEY_END.exec(text)
      if (close) {
        end += close[0].length
      } else {
        BASE64_RUN.lastIndex = end
        end += BASE64_RUN.exec(text)![0].length
        for (;;) {
          BASE64_LINE.lastIndex = end
          const line = BASE64_LINE.exec(text)
          if (!line) break
          end += line[0].length
        }
      }
    } else if (kind !== 'aws' && kind !== 'kioku') {
      TOKEN_TAIL.lastIndex = end
      end += TOKEN_TAIL.exec(text)![0].length
    }
    return { start, end, extendedEnd: end }
  }

  return { labelValue, tokenValue, lineEnd }
}

// 按先后数行号：每一处都接着上一处往后数，整段只扫一遍
function lineCounter(text: string): (index: number) => number {
  let line = 1
  let next = text.indexOf('\n')
  return (index) => {
    while (next !== -1 && next < index) {
      line++
      next = text.indexOf('\n', next + 1)
    }
    return line
  }
}

// 和 PLAINTEXT_CREDENTIAL 同一条规则，找出每一处的位置、类别与字段名。
// 一处的值里又像一处时（例如 secret: x-----BEGIN …）不重复算；overlapping 为 true 时也列出这些，
// 按开头的先后排，可能和前一处重叠：打码要把它们也盖住
export function findPlaintextCredentials(
  text: string,
  options: { overlapping?: boolean } = {},
): PlaintextCredentialMatch[] {
  return scanPlaintext(text, options).map(publicMatch)
}

type ScannedMatch = PlaintextCredentialMatch & { extendedEnd: number }

// 对外只给 PlaintextCredentialMatch 的字段，延伸的值的结尾只在比较新增时用
const publicMatch = ({
  start,
  end,
  line,
  kind,
  field,
}: ScannedMatch): PlaintextCredentialMatch => ({
  start,
  end,
  line,
  kind,
  field,
})

function scanPlaintext(text: string, options: { overlapping?: boolean }): ScannedMatch[] {
  const found: ScannedMatch[] = []
  const lineAt = lineCounter(text)
  const scan = scanner(text)
  let last = 0
  for (const m of text.matchAll(PLAINTEXT_ALL)) {
    const label = PLAINTEXT_LABEL.exec(m[0])?.[0]
    let span: { start: number; end: number; extendedEnd: number }
    let kind: PlaintextKind
    if (label) {
      kind = 'label'
      const value = scan.labelValue(m.index + m[0].length - 1)
      if (!value) continue
      span = value
      // 写法后面的值本身是已知格式的令牌（token: ghp_…、secret: -----BEGIN …）：按令牌算，
      // 值取整个令牌（私钥块跨好几行，按写法只取得到第一段）。前面的引号与粗体不算令牌的一部分
      let at = span.start
      while (at < text.length && PLAINTEXT_QUOTES.includes(text[at]!)) at++
      for (const [token, rule] of TOKEN_AT) {
        rule.lastIndex = at
        const hit = rule.exec(text)
        if (!hit) continue
        kind = token
        span = scan.tokenValue(token, at, hit[0].length)
        break
      }
    } else {
      // 各类的开头互不相同，按开头认出是哪一类
      const token = TOKEN_ANCHORED.find(([, rule]) => rule.test(m[0]))![0]
      kind = token
      span = scan.tokenValue(token, m.index, m[0].length)
    }
    const overlaps = span.start < last
    if (overlaps && !options.overlapping) continue
    found.push({
      ...span,
      line: lineAt(span.start),
      kind,
      field: kind === 'label' ? plaintextField(label!) : TOKEN_FIELDS[kind],
    })
    last = Math.max(last, span.end)
  }
  return found
}

// 后面加注解的开头：全角的左括号与左引号（「hunter2（旧）」）。& 不算，hunter2&NEW 是另一个值
const ANNOTATION_OPENERS = '（【《「『“‘'
const ASCII_ALNUM = /[A-Za-z0-9]/

// 这次写入新增的疑似明文：after 里检出的一处，满足下面任一条就是原来就有的，否则算新增。
// 比较用延伸的值（不在左括号、左引号与 & 处停，见 labelValue），不用截断的值：截断会把 hunter2&old 与
// hunter2&NEWSECRET 都截成 hunter2。
// (a) 延伸的值和 before 里某一处的延伸值相同；
// (b) 延伸的值在第一个 ANNOTATION_OPENERS 处截开，前面是 before 里某一处的延伸值，后面的注解里没有 ASCII 字母
//     或数字（hunter2（旧）、hunter2（已作废））。带字母或数字的（（新密码Xk9mQ2vLp）、（old）、（2024 年改的））
//     可能写着新的值，算新增；
// (c) before 里某一处的延伸值，以这一处的延伸值加一个 VALUE_BREAKS 的字开头：拆开或截短
//     （token=abc&password=xyz 拆成两行）。
// 都按查表与二分做，不两两比：正文很长、很多处时也是线性对数的。
// before 为 null 表示新建。服务端拒绝写入与管理界面保存前的逐处处理都按它判断，两边才一致；
// 报出来的每一处仍是截断的值（显示与转存用）
export function addedPlaintextCredentials(
  before: string | null,
  after: string,
): PlaintextCredentialMatch[] {
  const existing =
    before === null
      ? []
      : scanPlaintext(before, {}).map((m) => before.slice(m.start, m.extendedEnd))
  const exact = new Set(existing)
  const sorted = [...exact].sort()
  // sorted 里有没有以 prefix 开头的
  const hasPrefix = (prefix: string) => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid]! < prefix) lo = mid + 1
      else hi = mid
    }
    return lo < sorted.length && sorted[lo]!.startsWith(prefix)
  }
  const annotated = (value: string) => {
    let cut = -1
    for (let i = 0; i < value.length; i++) {
      if (ANNOTATION_OPENERS.includes(value[i]!)) {
        cut = i
        break
      }
    }
    return cut > 0 && exact.has(value.slice(0, cut)) && !ASCII_ALNUM.test(value.slice(cut + 1))
  }
  const isExisting = (value: string) =>
    exact.has(value) || annotated(value) || [...VALUE_BREAKS].some((c) => hasPrefix(value + c))
  return scanPlaintext(after, {})
    .filter((m) => !isExisting(after.slice(m.start, m.extendedEnd)))
    .map(publicMatch)
}

// 写入被拒时指出的一处：只有行号与类别，不带值
export const PlaintextFinding = z
  .object({ line: z.number().int(), kind: PlaintextKind })
  .meta({ id: 'PlaintextFinding' })
export type PlaintextFinding = z.infer<typeof PlaintextFinding>

// 记忆写入的错误：和 ErrorResponse 一样有 error；正文里有新增的疑似明文被拒时（400）再带上 plaintext，
// 按在正文里的先后排列。别的错误没有这一项
export const MemoryWriteError = z
  .object({ error: z.string(), plaintext: z.array(PlaintextFinding).optional() })
  .meta({ id: 'MemoryWriteError' })
export type MemoryWriteError = z.infer<typeof MemoryWriteError>

// 凭据的来源：hosted 是值由 Kioku 加密保存；vault 是值在成员连接的密码库里，Kioku 只记连接与条目的 id
export const CREDENTIAL_SOURCES = ['hosted', 'vault'] as const
export const CredentialSource = z.enum(CREDENTIAL_SOURCES)
export type CredentialSource = z.infer<typeof CredentialSource>

// 密码库条目里的字段：login.username、login.password、login.totp、notes，自定义字段写成 field:<名字>。
// 和服务端 credential/bitwarden/types.ts 的 VaultFieldRef 同一种写法
export const VAULT_STANDARD_FIELDS = [
  'login.username',
  'login.password',
  'login.totp',
  'notes',
] as const
export const VAULT_CUSTOM_FIELD_PREFIX = 'field:'
// 自定义字段的名字最长这么多个字符
const VAULT_CUSTOM_FIELD_MAX = 200
const CONTROL_CHARS = /\p{Cc}/u

export function isVaultFieldRef(ref: string): boolean {
  if ((VAULT_STANDARD_FIELDS as readonly string[]).includes(ref)) return true
  if (!ref.startsWith(VAULT_CUSTOM_FIELD_PREFIX)) return false
  const name = ref.slice(VAULT_CUSTOM_FIELD_PREFIX.length)
  return name.length > 0 && name.length <= VAULT_CUSTOM_FIELD_MAX && !CONTROL_CHARS.test(name)
}
export const VaultFieldRef = z
  .string()
  .refine(
    isVaultFieldRef,
    '条目字段只能是 login.username、login.password、login.totp、notes 或 field:<名字>',
  )
export type VaultFieldRef = z.infer<typeof VaultFieldRef>

// 字段：占位符里用的名字，密码库来源再加上条目里对应的字段（itemField）；托管的 itemField 为 null
export const CredentialField = z.object({
  name: CredentialFieldName,
  itemField: VaultFieldRef.nullable(),
})
export type CredentialField = z.infer<typeof CredentialField>

const STANDARD_FIELD_NAMES: Record<string, string> = {
  'login.username': 'username',
  'login.password': 'password',
  'login.totp': 'totp',
  notes: 'notes',
}

function uniqueFieldName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!taken.has(name)) return name
  }
}

// 按条目里的字段推出凭据的字段：login.* 与 notes 取固定的名字（username、password、totp、notes），
// 自定义字段的名字符合字段名的规则时照用；不符合时转成小写、别的字符换成 -，还是不行就叫 field，重名的加 -2、-3。
// 认不出的字段跳过，顺序同传入的顺序。服务端新建时没给字段对应就按它推，管理界面的预览也用它，两边才一致
export function defaultCredentialFields(refs: readonly string[]): CredentialField[] {
  const taken = new Set<string>()
  const names = new Map<string, string>()
  for (const ref of refs) {
    const fixed = STANDARD_FIELD_NAMES[ref]
    if (!fixed || names.has(ref)) continue
    const name = uniqueFieldName(fixed, taken)
    taken.add(name)
    names.set(ref, name)
  }
  for (const ref of refs) {
    if (names.has(ref) || !isVaultFieldRef(ref) || ref in STANDARD_FIELD_NAMES) continue
    const normalized = ref
      .slice(VAULT_CUSTOM_FIELD_PREFIX.length)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+/, '')
      .slice(0, 64)
    const base = CREDENTIAL_NAME_PATTERN.test(normalized) ? normalized : 'field'
    const name = uniqueFieldName(base, taken)
    taken.add(name)
    names.set(ref, name)
  }
  return refs.flatMap((ref) => {
    const name = names.get(ref)
    if (!name) return []
    names.delete(ref)
    return [{ name, itemField: ref }]
  })
}

// ---- 到期与轮换 ----

// 到期前这么多天起算「快到期」，进待处理
export const CREDENTIAL_EXPIRING_DAYS = 7

// 到期的状态，按服务端读出时的时间算：expiring 还没到期、离到期不到 CREDENTIAL_EXPIRING_DAYS 天（含正好 7 天）；
// expired 已过到期时间（到期时间那一刻起算已到期）。没设到期时间、或者离到期还远的为 null。
// 到期之后照常能取（上游不一定真的失效），取用的结果里注明已到期。
// 判断有 SQL（待处理的条数与列表的筛选）与 JS（视图里的这个字段）两份，服务端的一致性测试逐条比对
export const CREDENTIAL_EXPIRY_STATES = ['expiring', 'expired'] as const
export const CredentialExpiry = z.enum(CREDENTIAL_EXPIRY_STATES)
export type CredentialExpiry = z.infer<typeof CredentialExpiry>

// 到期时间：带时区的 ISO 时间。可以设成已经过去的时间（记下一个已经到期的令牌）；null 表示不到期
export const CredentialExpiresAt = z.iso
  .datetime({ offset: true, message: '到期时间格式不正确' })
  .refine((v) => {
    const year = new Date(v).getUTCFullYear()
    return year >= 2000 && year <= 9999
  }, '到期时间超出范围')
  .nullable()

// 写进密码库条目的网址，只收 http:// 与 https://，不带空白与控制字符。
// 登录类的条目按主机加端口匹配自动填充（Bitwarden 的「主机」匹配）；令牌类的条目照样记下网址，但不参与匹配，
// 免得令牌被填进登录框。没有去处、由 Kioku 托管时网址不保存（托管的凭据没有网址）
export const CREDENTIAL_URL_MAX = 2000
export const CredentialUrl = z
  .string()
  .trim()
  .max(CREDENTIAL_URL_MAX, `网址最多 ${CREDENTIAL_URL_MAX} 个字符`)
  .refine((v) => /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(v), '网址要以 http:// 或 https:// 开头')
  .refine((v) => !CONTROL_CHARS.test(v), '网址不能包含控制字符')

// 写进密码库的新条目里，这两个字段名写成登录条目的用户名与密码；字段里有其中一个就是登录类，
// 否则是令牌类。别的字段名一律写成隐藏的自定义字段（field:<字段名>），包括 totp：
// 条目里的 TOTP 密钥（login.totp）不由 Kioku 写，名为 totp 的字段和托管的一样，取用时给原值
export const VAULT_LOGIN_FIELD_NAMES = {
  username: 'login.username',
  password: 'login.password',
} as const

// 新建的凭据写到了哪里。hosted：Kioku 托管，没设去处，或者在测试台里（bench 为 true：测试台不写密码库，
// 回滚模式撤不回外部服务里的写入）；vault：写成了去处集合里的新条目，collectionName 是写入时集合的名称。
// 通过 Key 的响应也给它，所以不带连接与条目的 id（管理界面看 ConsoleCredential.vault）
export const CredentialStoredIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hosted'), bench: z.boolean() }),
  z.object({ kind: z.literal('vault'), collectionName: z.string() }),
])
export type CredentialStoredIn = z.infer<typeof CredentialStoredIn>

const CredentialBase = z.object({
  id: z.uuid(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: CredentialSource,
  // 每次修改加一。密码库的凭据在 Kioku 看到条目的修改时间变了时（取用、列条目、写回）也加一：
  // 值在别处改过，带着旧版本号的修改返回 409，要先重新读取
  version: z.number().int(),
  // 到期时间与到期的状态，见 CredentialExpiry
  expiresAt: z.string().nullable(),
  expiry: CredentialExpiry.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// 凭据的概况：标识、名称、说明、字段名、来源与到期，不含值，也不含密码库的条目。
// 通过 Key 列出、新建、修改与取用时给的都是它。标识、名称、说明与字段名都是明文，不要把值写进这些地方
export const CredentialSummary = CredentialBase.extend({ fields: z.array(z.string()) })
export type CredentialSummary = z.infer<typeof CredentialSummary>

// 管理界面看到的：字段对应、指向的密码库条目、限定给哪些应用、删除时间、引用数、轮换与改值的时间
export const ConsoleCredential = CredentialBase.extend({
  fields: z.array(CredentialField),
  // 密码库来源指向的连接与条目；托管的为 null。条目的名称与取不取得到值看连接的条目列表
  vault: z.object({ connectionId: z.uuid(), itemId: z.string() }).nullable(),
  // 只给这些应用用；null 表示不限定
  appIds: z.array(z.uuid()).nullable(),
  deletedAt: z.string().nullable(),
  // 正文里引用这个标识的有效记忆数（不含 secret 的）；大于 0 时删不掉
  referenceCount: z.number().int(),
  // 标了「需要轮换」的时间；没标的为 null。只在管理界面标与清除，访问密钥改不了。
  // 值改过就自动清掉：托管的是值变了的那次修改，密码库的是 Kioku 看到条目的修改时间变了（取用、列条目、写回时）
  rotationRequestedAt: z.string().nullable(),
  // 上次改值的时间：托管的是新建或最近一次改了值的修改；密码库的是 Kioku 最近看到的条目修改时间，
  // 起标识以来还没读到过条目时为 null。凭据详情据此列出上次改值以来的取用（CredentialEventQuery）
  valueChangedAt: z.string().nullable(),
})
export type ConsoleCredential = z.infer<typeof ConsoleCredential>

// 新建的结果：凭据与它写到了哪里。给已有的条目起标识时也给 vault，collectionName 是条目所在的集合：
// 条目在几个集合里时，是去处的那个集合优先，否则按名称排在最前的那个
export const CreatedCredential = ConsoleCredential.extend({ storedIn: CredentialStoredIn })
export type CreatedCredential = z.infer<typeof CreatedCredential>

export const ConsoleCredentialList = z.object({
  items: z.array(ConsoleCredential),
  // 太多时只给前面的一部分
  truncated: z.boolean(),
})
export type ConsoleCredentialList = z.infer<typeof ConsoleCredentialList>

// 列出凭据的筛选。attention=true 只列待处理的「凭据」一类：没删除、快到期、已到期或标了需要轮换的，
// 和 InboxCounts.credentials 同一个条件。只有凭据的所有者看得到自己的，和列表本身一样
export const CredentialListQuery = z.object({
  attention: z.enum(['true']).optional(),
})
export type CredentialListQuery = z.infer<typeof CredentialListQuery>

// 已删除的凭据：过了保留期按删除时间永久清除，见 DeletionRetention
export const DeletedCredentialList = ConsoleCredentialList.extend({ retention: DeletionRetention })
export type DeletedCredentialList = z.infer<typeof DeletedCredentialList>

const CredentialName = z.string().trim().min(1, '名称不能为空').max(100, '名称最多 100 个字')
const CredentialDescription = z.string().max(2000, '说明最多 2000 个字').nullable()
const CredentialValue = z.string().min(1, '值不能为空').max(16_384, '一个值最多 16384 个字符')
const AppIds = z.array(z.uuid()).max(100, '最多限定 100 个应用').nullable()
// 密码库条目的 id（Bitwarden 与 Vaultwarden 都是 uuid）
export const VaultItemId = z
  .string()
  .regex(/^[0-9A-Za-z-]{1,64}$/, '条目 id 只能包含字母、数字与 -，最长 64 个字符')

const fieldCount = (values: Record<string, unknown>) =>
  Object.keys(values).length <= MAX_CREDENTIAL_FIELDS

const distinctNames = (fields: { name: string }[]) =>
  new Set(fields.map((f) => f.name)).size === fields.length

// 托管的值：字段名到值。新建凭据与空间的导入导出都按它检查
export const HostedCredentialValues = z
  .record(CredentialFieldName, CredentialValue)
  .refine((v) => Object.keys(v).length > 0, '至少需要一个字段')
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

// 修改托管的值：只给要改的字段，值为 null 表示删掉这个字段，没给的字段不变
export const HostedCredentialValuesUpdate = z
  .record(CredentialFieldName, CredentialValue.nullable())
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

// 密码库来源的字段对应：凭据里的字段名对应条目里的哪个字段
export const VaultCredentialFields = z
  .array(z.object({ name: CredentialFieldName, itemField: VaultFieldRef }))
  .min(1, '至少需要一个字段')
  .max(MAX_CREDENTIAL_FIELDS, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
  .refine(distinctNames, '字段名不能重复')

export const HostedCredentialSource = z.object({
  kind: z.literal('hosted'),
  values: HostedCredentialValues,
})

// 给密码库的条目起标识：连接、条目与字段对应。不给字段对应时按条目里现有的字段推出（defaultCredentialFields）
export const VaultCredentialSource = z.object({
  kind: z.literal('vault'),
  connectionId: z.uuid(),
  itemId: VaultItemId,
  fields: VaultCredentialFields.optional(),
})

// 新建一条带值的凭据：成员设了去处（VaultConnection.destination）时写成去处集合里的新条目，凭据的来源是 vault；
// 没设时由 Kioku 托管。请求里不选去处（每个成员最多一个，agent 不用知道往哪写）。
// 写进密码库时字段按 VAULT_LOGIN_FIELD_NAMES 对应，条目名称取凭据的名称；url 见 CredentialUrl。
// 去处所在的连接不可用（需要重新登录、已停用、已断开、无法连接）、集合只读或不见了时整次失败，不退回托管：
// 值落在哪里由去处决定，悄悄换地方会让人以为它在密码库里。
// 测试台里一律托管（CredentialStoredIn 的 bench）
export const NewCredentialSource = z.object({
  kind: z.literal('new'),
  values: HostedCredentialValues,
  url: CredentialUrl.optional(),
})

// 管理界面新建时的来源：new 给出全部字段的值（写到去处或托管），vault 给已有的条目起标识（连接、条目与可选的字段对应）
export const CredentialSourceInput = z.discriminatedUnion('kind', [
  NewCredentialSource,
  VaultCredentialSource,
])
export type CredentialSourceInput = z.infer<typeof CredentialSourceInput>

// 响应是 CreatedCredential
export const CreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  source: CredentialSourceInput,
  // 只给哪些应用用，不填表示不限定。只能在管理界面设：通过 Key 新建的只给这个应用用
  appIds: AppIds.optional(),
  expiresAt: CredentialExpiresAt.optional(),
})
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

// 来源不能改，要换条目就删掉，再用同一个标识新建。fields 只给密码库的，给托管的返回 400；
// fields 与 values 不能在同一次修改里一起给（values 按哪一份字段对应写会说不清），一起给时返回 400。
// values：托管的照常改 Kioku 里的值；密码库的写回原条目（要空间所有者，通过 Key 要凭据能力「管理」），规则见下：
// - 只改给了的字段，别的字段与 Kioku 不认识的内容原样带回；改密码时旧密码进条目的密码历史；
// - 只能改字段对应里已有的字段，不能删字段（值为 null）、不能改对应到 login.totp 的字段，违反时返回 400；
// - 条目在别处改过（Kioku 最近看到的修改时间对不上）返回 409，说明要先重新读取，不覆盖；
// - 条目所在的集合只读返回 409（和别的连接、条目状态的问题一样是 409，不用 403：403 留给 Kioku 自己的权限）；
// - 测试台里返回 400，不写密码库。
// 值变了就清掉「需要轮换」
export const UpdateCredentialRequest = z.object({
  // 界面上看到的版本号，期间被改过就返回 409
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
  // 整个替换
  fields: VaultCredentialFields.optional(),
  // 只能在管理界面改：被诱导的 agent 不能给自己放宽
  appIds: AppIds.optional(),
  // null 清掉到期时间
  expiresAt: CredentialExpiresAt.optional(),
  // 标或清除「需要轮换」，只能在管理界面改。已经标着时再标不改标记的时间
  needsRotation: z.boolean().optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

export const CONVERT_VALUE_MIN_LENGTH = 4

// 要转存或按值查找的一段明文。正文里这段值出现几处换几处，历史快照里的也一起换掉，所以太短的不收：
// 只有几个字符时换掉的多半是别的内容。报错都不带值
export const ConvertibleValue = CredentialValue.min(
  CONVERT_VALUE_MIN_LENGTH,
  `要转存的值至少 ${CONVERT_VALUE_MIN_LENGTH} 个字符，更短的值请手动新建凭据`,
)
  .refine((v) => v === v.trim(), '要转存的值前后不能有空白')
  .refine((v) => !/\p{Cs}/u.test(v), '要转存的值含不完整的字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_START), '要转存的值不能含凭据占位符')

// 按值查找同值的凭据与密码库条目：只给管理界面的空间 owner，一次最多 20 个值
export const CREDENTIAL_MATCH_MAX = 20
export const MatchCredentialValuesRequest = z.object({
  values: z
    .array(ConvertibleValue)
    .min(1, '至少需要一个值')
    .max(CREDENTIAL_MATCH_MAX, `一次最多 ${CREDENTIAL_MATCH_MAX} 个值`),
})
export type MatchCredentialValuesRequest = z.infer<typeof MatchCredentialValuesRequest>

// 一个值对上的地方，按字面比较（不去空白、不分大小写以外的任何归一化）。
// credentials：当前账号的有效凭据里同值的字段，托管的与密码库来源的都算，可以直接写成 {{cred:<标识>#<字段>}}。
// vaultItems：当前账号连接读得到的条目里同值、但还不能直接引用的字段：条目还没起标识（credential 为 null），
// 或者起了标识、这个字段却没有对应到凭据的字段（credential 给出那条凭据，要先在凭据里加上字段对应）。
// 已经对应到凭据字段的条目字段只列在 credentials 里，不重复列
export const CredentialValueMatch = z.object({
  credentials: z.array(
    z.object({
      id: z.uuid(),
      identifier: z.string(),
      name: z.string(),
      field: z.string(),
    }),
  ),
  vaultItems: z.array(
    z.object({
      connectionId: z.uuid(),
      itemId: z.string(),
      itemName: z.string(),
      itemField: z.string(),
      credential: z.object({ id: z.uuid(), identifier: z.string() }).nullable(),
    }),
  ),
})
export type CredentialValueMatch = z.infer<typeof CredentialValueMatch>

export const CredentialValueMatches = z.object({
  // 和请求的 values 一一对应
  items: z.array(CredentialValueMatch),
  // 这次读不了的连接数（不可用、需要重新登录、无法连接等）：它们的条目和指着它们的凭据都没比，对不上不等于没有
  unavailableConnections: z.number().int(),
  // 读不到值的托管凭据条数（没配主密钥、解不开）：这些也没比，对不上不等于没有
  unreadableCredentials: z.number().int(),
})
export type CredentialValueMatches = z.infer<typeof CredentialValueMatches>

// 转存的去处。
// new：新建一条凭据，值存在 field 这个字段里。和 NewCredentialSource 一样：设了去处时写成去处集合里的新条目
// （field 是 username、password 时写成登录条目，别的写成隐藏的自定义字段），没设时由 Kioku 托管；
// 去处不可用时整次失败，不退回托管。写进密码库在事务之前做完，之后的事务失败时条目留在密码库里，
// 错误体带上它（CredentialWriteError.vaultItem），界面据此提示：可以在凭据页给它起标识，或者到密码库里删掉。
// credential：换成当前账号一条已有凭据的 field 字段（托管或密码库来源都行）。
// vault：给当前账号连接里还没起标识的条目起标识，换成 itemField 对应的字段。字段对应不给时按条目里现有的字段推出
// （defaultCredentialFields），给了要包含 itemField；名称不给时用条目的名称。条目已经有凭据时返回 409，改用 credential。
// credential 与 vault 由服务端核对这个字段现在的值确实等于 value，不等时返回 400（文字不带值）：
// 转存会把值从历史里抹掉，绑错了就找不回来
export const ConvertTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    identifier: CredentialIdentifier,
    name: CredentialName,
    description: CredentialDescription.optional(),
    field: CredentialFieldName,
    url: CredentialUrl.optional(),
    expiresAt: CredentialExpiresAt.optional(),
  }),
  z.object({
    kind: z.literal('credential'),
    credentialId: z.uuid(),
    field: CredentialFieldName,
  }),
  z
    .object({
      kind: z.literal('vault'),
      connectionId: z.uuid(),
      itemId: VaultItemId,
      itemField: VaultFieldRef,
      identifier: CredentialIdentifier,
      name: CredentialName.optional(),
      description: CredentialDescription.optional(),
      fields: VaultCredentialFields.optional(),
    })
    .refine((t) => !t.fields || t.fields.some((f) => f.itemField === t.itemField), {
      path: ['fields'],
      message: '字段对应里要有要转存的条目字段',
    }),
])
export type ConvertTarget = z.infer<typeof ConvertTarget>

// 去处里写成明文的部分：标识、名称、说明与字段名（密码库的再加上条目字段）
function convertTargetTexts(target: ConvertTarget): string[] {
  switch (target.kind) {
    case 'new':
      return [
        target.identifier,
        target.name,
        target.description ?? '',
        target.field,
        target.url ?? '',
      ]
    case 'credential':
      return [target.field]
    case 'vault':
      return [
        target.identifier,
        target.name ?? '',
        target.description ?? '',
        target.itemField,
        ...(target.fields ?? []).flatMap((f) => [f.name, f.itemField]),
      ]
  }
}

// 把记忆正文里的一段明文换成凭据占位符：只给管理界面的空间 owner。expectedVersion 是看到这段值时的版本，
// 期间被改过就返回 409。去处见 ConvertTarget
export const ConvertToCredentialRequest = z
  .object({
    memoryId: z.uuid(),
    expectedVersion: z.number().int(),
    value: ConvertibleValue,
    target: ConvertTarget,
  })
  // 去处里的这些都是明文，占位符里还带着标识和字段名：写进去就白转存了。
  // 用条目名称作名称时（vault 没给 name）由服务端再查一次
  .refine((r) => !convertTargetTexts(r.target).some((t) => t.includes(r.value)), {
    path: ['value'],
    message: '标识、名称、说明、字段名与网址不能包含要转存的值',
  })
export type ConvertToCredentialRequest = z.infer<typeof ConvertToCredentialRequest>

// 转存的结果，不含值
export const ConvertedToCredential = z.object({
  memory: ConsoleMemoryView,
  // 正文里引用的凭据：新建的（new、vault）或已有的（credential）
  credential: ConsoleCredential,
  // 这次是不是新建了凭据
  created: z.boolean(),
  // 去处是 new 时，新凭据写到了哪里；起标识与用已有凭据时为 null（值本来就在那里）
  storedIn: CredentialStoredIn.nullable(),
  // 占位符里用的字段名：{{cred:<credential.identifier>#<field>}}
  field: z.string(),
  // 正文里换掉了几处
  replaced: z.number().int(),
  // 历史里改写了几个事件的快照
  scrubbedEvents: z.number().int(),
  // 历史里还有几个版本的正文疑似有别的明文（不含现在这一版）：只换掉了这一个值，换过的旧密码这类还留着
  plaintextVersions: z.number().int(),
  // 调用方有权看到的别的记忆（已删除、过期的也算）里还有几条含这个值：这次不动它们，要提示。
  // 比如 Dream 合并的来源被软删除了，撤销删除就回来。secret 的正文是密文，不数；占位符里的不算
  otherMemories: z.number().int(),
})
export type ConvertedToCredential = z.infer<typeof ConvertedToCredential>

// 通过 Key 新建（kioku_credential_save 与 REST）：只给这个应用用。写到哪里同 NewCredentialSource：
// 设了去处写进密码库，没设由 Kioku 托管，请求里不选。响应是 KeyCreatedCredential
export const KeyCreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  values: HostedCredentialValues,
  url: CredentialUrl.optional(),
  expiresAt: CredentialExpiresAt.optional(),
})
export type KeyCreateCredentialRequest = z.infer<typeof KeyCreateCredentialRequest>

export const KeyCreatedCredential = CredentialSummary.extend({ storedIn: CredentialStoredIn })
export type KeyCreatedCredential = z.infer<typeof KeyCreatedCredential>

// 通过 Key 修改：按标识找凭据，不能改字段对应、限定的应用与「需要轮换」。
// values 对托管的改 Kioku 里的值，对密码库的写回原条目，规则同 UpdateCredentialRequest（测试台里改密码库的值返回 400）
export const KeyUpdateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
  // null 清掉到期时间
  expiresAt: CredentialExpiresAt.optional(),
})
export type KeyUpdateCredentialRequest = z.infer<typeof KeyUpdateCredentialRequest>

// 写进密码库之后，Kioku 自己的事务失败了（例如期间别的请求用掉了同一个标识）：条目已经在集合里，不撤回
// （删条目又是一次外部写入，也可能失败）。新建与转存的错误体带上它，界面据此提示到凭据页给它起标识、或到密码库里删掉
export const OrphanVaultItem = z.object({
  connectionId: z.uuid(),
  itemId: z.string(),
  itemName: z.string(),
  collectionName: z.string(),
})
export type OrphanVaultItem = z.infer<typeof OrphanVaultItem>

// 写入（新建、修改、转存）失败的原因，界面据此给出不同的下一步：
// version 读到之后被别的请求改过（凭据或记忆的版本号），重新读取再改；item_conflict 条目在别处改过，重新读取凭据再改；
// read_only 集合只读或不可用，重新读取没有用，要改专用账号的权限或换去处；value_too_long 值超出密码库的长度上限（400），
// 缩短值，或清除去处改由 Kioku 托管。别的错误不带原因
export const CREDENTIAL_WRITE_REASONS = [
  'version',
  'item_conflict',
  'read_only',
  'value_too_long',
] as const
export const CredentialWriteReason = z.enum(CREDENTIAL_WRITE_REASONS)
export type CredentialWriteReason = z.infer<typeof CredentialWriteReason>

// 凭据新建、修改与转存的错误体：error 之外，有上面的原因时带 reason（Key 的错误体也带）；
// 管理界面里写进了密码库却没建成凭据时带 vaultItem。
// 通过 Key 的错误体不带它（Key 的响应里没有连接与条目的 id），只在 error 的文字里写明集合与条目的名称、
// 要所有者在管理界面给它起标识：agent 照原样重试会在集合里再建一个
export const CredentialWriteError = z.object({
  error: z.string(),
  reason: CredentialWriteReason.optional(),
  vaultItem: OrphanVaultItem.optional(),
})
export type CredentialWriteError = z.infer<typeof CredentialWriteError>

// 取用时说明的用途，记进访问事件。只有空白的当作没给
export const CREDENTIAL_PURPOSE_MAX = 200
export const CredentialPurpose = z
  .string()
  .trim()
  .max(CREDENTIAL_PURPOSE_MAX, `用途最多 ${CREDENTIAL_PURPOSE_MAX} 个字`)
  .refine((v) => !CONTROL_CHARS.test(v), '用途不能包含换行等控制字符')
  .transform((v) => v || undefined)

export const CredentialIdentifierQuery = z.object({
  identifier: CredentialIdentifier,
  // 只取一个字段；不填时取全部字段
  field: CredentialFieldName.optional(),
  purpose: CredentialPurpose.optional(),
})

// kioku run 一次取几个字段：每项是一条凭据的一个字段，顺序就是返回的顺序
export const CREDENTIAL_RESOLVE_MAX = 32
export const CredentialFieldRef = z.object({
  identifier: CredentialIdentifier,
  field: CredentialFieldName,
})
export type CredentialFieldRef = z.infer<typeof CredentialFieldRef>

export const ResolveCredentialsRequest = z.object({
  refs: z
    .array(CredentialFieldRef)
    .min(1, '至少需要一项')
    .max(CREDENTIAL_RESOLVE_MAX, `一次最多 ${CREDENTIAL_RESOLVE_MAX} 项`)
    .refine(
      (refs) => new Set(refs.map((r) => `${r.identifier}#${r.field}`)).size === refs.length,
      '同一个标识与字段不能重复',
    ),
  purpose: CredentialPurpose.optional(),
})
export type ResolveCredentialsRequest = z.infer<typeof ResolveCredentialsRequest>

// 要么全给，要么一个都不给：任何一项取不到时整次失败，返回错误
export const ResolvedCredentials = z.object({
  values: z.array(CredentialFieldRef.extend({ value: z.string() })),
})
export type ResolvedCredentials = z.infer<typeof ResolvedCredentials>

export const KeyDeleteCredentialQuery = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.coerce.number().int().optional(),
})

// 引用一条凭据的记忆：凭据所有者本人的记忆里没删除、不是 secret、仍有效的
export const CredentialReference = z.object({
  id: z.uuid(),
  uri: z.string(),
  title: z.string(),
  sensitivity: Sensitivity,
  updatedAt: z.string(),
})
export type CredentialReference = z.infer<typeof CredentialReference>

export const CredentialReferenceList = z.object({
  items: z.array(CredentialReference),
  truncated: z.boolean(),
})
export type CredentialReferenceList = z.infer<typeof CredentialReferenceList>

// 管理界面查看值：托管的与密码库的都给，totp 给现算的验证码；记一条访问事件
export const CredentialValues = z.object({ values: z.record(z.string(), z.string()) })
export type CredentialValues = z.infer<typeof CredentialValues>

// 通过 Key 取用一条凭据：概况、值与提醒。totp 给的是现算的验证码，不是条目里的密钥。
// 测试台里取用一律不给值，values 为 null；真实的调用总有值，取不到时返回错误。
// 已到期的照常给值，credential.expiry 为 expired，notice 里注明
export const CredentialAccess = z.object({
  credential: CredentialSummary,
  values: z.record(z.string(), z.string()).nullable(),
  notice: z.string(),
})
export type CredentialAccess = z.infer<typeof CredentialAccess>

export const KeyCredentialList = z.object({
  items: z.array(CredentialSummary),
  truncated: z.boolean(),
})
export type KeyCredentialList = z.infer<typeof KeyCredentialList>

// 取用的结果：交出了值；凭据存在、取用却被拒；向密码库取值失败
export const CREDENTIAL_ACCESS_RESULTS = ['ok', 'denied', 'failed'] as const
export const CredentialAccessResult = z.enum(CREDENTIAL_ACCESS_RESULTS)
export type CredentialAccessResult = z.infer<typeof CredentialAccessResult>

// 被拒与失败的原因。被拒：capability 凭据能力不够；scope 访问密钥读不到本人的私密记忆；
// context 会话上下文不允许；app 限定给了别的应用。失败：item_unavailable 条目不可用（被删、移出集合）；
// field_missing 条目里没有这个字段；reauth_required 需要重新登录；disabled 连接已停用；disconnected 连接已断开；
// unreachable 密码库无法连接；vault_error 密码库返回的内容认不出或校验不过；master_key 主密钥不可用；
// internal_error Kioku 自己出错（数据库错误这类不是密码库的问题）
export const CREDENTIAL_ACCESS_REASONS = [
  'capability',
  'scope',
  'context',
  'app',
  'item_unavailable',
  'field_missing',
  'reauth_required',
  'disabled',
  'disconnected',
  'unreachable',
  'vault_error',
  'master_key',
  'internal_error',
] as const
export const CredentialAccessReason = z.enum(CREDENTIAL_ACCESS_REASONS)
export type CredentialAccessReason = z.infer<typeof CredentialAccessReason>

// 事件类型：create、update、delete、undelete、access（交出值、被拒或失败，包括管理界面查看与随空间导出）。
// 访问事件记下这次取用时值的版本：托管的是凭据当时的值版本（最近一次改了值的那次修改的版本号），
// 密码库的是读到的条目修改时间；被拒、失败没读到值的不记。这些只在服务端比较，视图里给出比较的结果 sinceValueChange
export const CredentialEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  createdAt: z.string(),
  actor: EventActor,
  // 取用经由哪里：kioku_credential、rest、run、console、space_export；其他事件为 null
  via: z.string().nullable(),
  // 取用了哪些字段
  fields: z.array(z.string()),
  // 取用时说明的用途；没给的与其他事件为 null
  purpose: z.string().nullable(),
  // 取用的结果与原因：交出了值时 reason 为 null；其他事件两个都为 null
  result: CredentialAccessResult.nullable(),
  reason: CredentialAccessReason.nullable(),
  // 通过 Key 取用时的会话上下文（chatType，不带会话上下文的为 none）；管理界面里的与其他事件为 null
  chatType: z.string().nullable(),
  // 修改了哪些部分：name、description、values、fields、appIds、expiresAt、needsRotation。
  // 密码库凭据的 values 是写回了条目；Kioku 看到条目在别处改过不记事件（值不经过 Kioku）
  changes: z.array(z.string()),
  // 访问事件交出的是不是现在的值：结果为 ok、记下的值版本等于凭据现在的（托管的值版本，或密码库的
  // ConsoleCredential.valueChangedAt 对应的条目修改时间）时为 true，旧的值为 false；
  // 被拒、失败、没记下值版本的与其他事件为 null。值可能泄露时据此看影响到哪些应用
  sinceValueChange: z.boolean().nullable(),
  // 测试台写下的：真实客户端写的为 null
  bench: BenchMark.nullable(),
})
export type CredentialEvent = z.infer<typeof CredentialEvent>

export const CredentialEventList = z.object({
  items: z.array(CredentialEvent),
  nextCursor: z.string().nullable(),
})
export type CredentialEventList = z.infer<typeof CredentialEventList>

// 访问记录的筛选：sinceValueChange=true 只列 sinceValueChange 为 true 的访问事件（上次改值以来交出的），
// 不给时列全部事件。按 id 倒序翻页，cursor 和筛选一起换
export const CredentialEventQuery = PageQuery.extend({
  sinceValueChange: z.enum(['true']).optional(),
})
export type CredentialEventQuery = z.infer<typeof CredentialEventQuery>

// ---- 密码库连接 ----

// 连接的状态：ok 可用；reauth_required 刷新令牌失效（改了主密码、在设备列表里注销了 Kioku），要重新登录；
// disabled 出现了个人条目，或组织角色是所有者、管理员，清掉之后恢复；disconnected 成员断开了，令牌与密钥已清掉。
// 连不上服务器不单独算一种：状态不变，记进 lastError，之后成功一次就清掉
export const VAULT_CONNECTION_STATUSES = [
  'ok',
  'reauth_required',
  'disabled',
  'disconnected',
] as const
export const VaultConnectionStatus = z.enum(VAULT_CONNECTION_STATUSES)
export type VaultConnectionStatus = z.infer<typeof VaultConnectionStatus>

// 停用的原因：账号里有不属于组织的条目；在某个组织里可访问全部集合（所有者、管理员，或开了「访问全部集合」的成员）
export const VAULT_DISABLED_REASONS = ['personal_items', 'organization_role'] as const
export const VaultDisabledReason = z.enum(VAULT_DISABLED_REASONS)
export type VaultDisabledReason = z.infer<typeof VaultDisabledReason>

// 和服务端 credential/bitwarden/types.ts 的 VaultErrorKind 一一对应
export const VAULT_ERROR_KINDS = [
  'invalid_credentials',
  'two_factor_invalid',
  'unsupported_two_factor',
  'reauth_required',
  'item_unavailable',
  'read_only',
  'item_conflict',
  // 写入时值加密之后超出密码库的长度上限（客户端发请求之前检查），只在写回时出现
  'value_too_long',
  'unsupported_format',
  'integrity',
  'unreachable',
  'server_error',
] as const
export const VaultErrorKind = z.enum(VAULT_ERROR_KINDS)
export type VaultErrorKind = z.infer<typeof VaultErrorKind>

// 两步验证只支持验证器应用：邮件验证码要另外请求发送，几种方式并存时服务端不会自动发
export const VAULT_TWO_FACTOR_PROVIDERS = ['authenticator'] as const
export const VaultTwoFactorProvider = z.enum(VAULT_TWO_FACTOR_PROVIDERS)
export type VaultTwoFactorProvider = z.infer<typeof VaultTwoFactorProvider>

export const VAULT_ITEM_TYPES = ['login', 'note', 'card', 'identity', 'ssh_key'] as const
export const VaultItemType = z.enum(VAULT_ITEM_TYPES)
export type VaultItemType = z.infer<typeof VaultItemType>

// 账号读得到的一个集合。readOnly：这个账号在集合里只能看，不能新建或修改条目，不能设为去处
export const VaultCollection = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  readOnly: z.boolean(),
})
export type VaultCollection = z.infer<typeof VaultCollection>

// 集合的 id（Bitwarden 与 Vaultwarden 都是 uuid），写法同条目的 id
export const VaultCollectionId = z
  .string()
  .regex(/^[0-9A-Za-z-]{1,64}$/, '集合 id 只能包含字母、数字与 -，最长 64 个字符')

// 新凭据的去处：连接里的一个可以编辑的集合。每个成员最多一个，设在某一个连接上；
// collectionName 是设定或最近一次同步时的名称（同步时跟着集合改名更新）。
// 连接断开、停用或要重新登录时去处留着（重新登录同一个账号就接着用），这期间新建凭据整次失败，不退回托管；
// 同步时发现集合不见了或变成只读也留着，新建时按 read_only、item_unavailable 失败，由人改设或清除
export const VaultDestination = z.object({
  collectionId: z.string(),
  organizationId: z.string(),
  collectionName: z.string(),
})
export type VaultDestination = z.infer<typeof VaultDestination>

// 管理界面看到的连接：只给连接的所有者
export const VaultConnection = z.object({
  id: z.uuid(),
  serverUrl: z.string(),
  email: z.string(),
  status: VaultConnectionStatus,
  // status 为 disabled 时的原因，否则为 null
  disabledReason: VaultDisabledReason.nullable(),
  // 最近一次和服务器通信失败的原因与时间；之后成功一次就清掉
  lastError: z.object({ kind: VaultErrorKind, at: z.string() }).nullable(),
  // 最近一次成功同步的时间
  lastCheckedAt: z.string().nullable(),
  disconnectedAt: z.string().nullable(),
  // 指着它的有效凭据数
  credentialCount: z.number().int(),
  // 新凭据的去处；没设在这个连接上的为 null。一个成员的连接里最多一个不为 null
  destination: VaultDestination.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type VaultConnection = z.infer<typeof VaultConnection>

export const VaultConnectionList = z.object({ items: z.array(VaultConnection) })
export type VaultConnectionList = z.infer<typeof VaultConnectionList>

// 设去处：PUT /spaces/{spaceId}/vault-connections/{connectionId}/destination，只给空间所有者。
// 清除（DELETE）不请求密码库，连接在任何状态下都能清除；设置才要求连接可用。
// 连接要可用；服务端先同步一次（不在事务里请求密码库），集合要在这个账号读得到的集合里、不是只读，
// 不在时 400「集合不存在或不可用」，只读时 400「集合只读」。成功时同一个成员别的连接上的去处一起清掉，
// 响应是这个成员的全部连接（VaultConnectionList）。清除：DELETE 同一个地址，没设也照常返回列表
export const SetVaultDestinationRequest = z.object({ collectionId: VaultCollectionId })
export type SetVaultDestinationRequest = z.infer<typeof SetVaultDestinationRequest>

// 服务器地址：https:// 都收；http:// 只收本机回环地址（localhost、127.0.0.1、[::1]）与不带点的主机名
// （例如 Docker Compose 的服务名 vaultwarden，流量不出 Docker 网络）。不带账号、查询参数与 #，末尾的 / 去掉。
// 主密码与令牌都发到这里，所以别的地址不收明文的 http。
// 不带点的主机名全是数字（或 0x 开头的十六进制）时不收：URL 把它当成 IPv4 地址，规范成带点的写法
// （http://3232235777 → 192.168.1.1），不是服务名。密码库客户端（credential/bitwarden/http.ts）按同一条规则判断。
// 契约不依赖 URL（浏览器与 Node 之外也要能用），按写法判断，服务端请求之前再用 URL 解析一次
const SERVER_URL = /^https:\/\/[^\s/?#@\\]+(?:\/[^\s?#\\]*)?$/i
const LOCAL_HTTP_URL =
  /^http:\/\/(?:(?!(?:\d+|0x[0-9a-f]*)(?:[:/]|$))[a-z0-9-]+|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s?#\\]*)?$/i
export const VaultServerUrl = z
  .string()
  .trim()
  .max(500, '服务器地址最多 500 个字符')
  .refine(
    (v) => SERVER_URL.test(v) || LOCAL_HTTP_URL.test(v),
    '服务器地址要以 https:// 开头（本机地址与不带点的主机名可以用 http://），不带账号、查询参数与 #',
  )
  .transform((v) => v.replace(/\/+$/, ''))

// 密码库账号的邮箱：连接、重新登录与空间导入都按它检查
export const VaultEmail = z
  .string()
  .trim()
  .max(320, '邮箱最多 320 个字符')
  .refine((v) => /^[^\s@]+@[^\s@]+$/.test(v), '邮箱格式不正确')
// 主密码只用来登录这一次，不保存
const MasterPassword = z.string().min(1, '主密码不能为空').max(1024, '主密码最多 1024 个字符')
const VaultTwoFactor = z.object({
  provider: VaultTwoFactorProvider,
  code: z.string().trim().min(1, '验证码不能为空').max(64, '验证码最多 64 个字符'),
})

export const ConnectVaultRequest = z.object({
  serverUrl: VaultServerUrl,
  email: VaultEmail,
  masterPassword: MasterPassword,
  // 第一次不带；服务器要两步验证时，结果给出可用的方式，再带上验证码重新提交
  twoFactor: VaultTwoFactor.optional(),
})
export type ConnectVaultRequest = z.infer<typeof ConnectVaultRequest>

// 重新登录：服务器地址与账号不变，登录到别的账号时拒绝。邮箱在密码库里改过时给新的邮箱
export const ReconnectVaultRequest = z.object({
  email: VaultEmail.optional(),
  masterPassword: MasterPassword,
  twoFactor: VaultTwoFactor.optional(),
})
export type ReconnectVaultRequest = z.infer<typeof ReconnectVaultRequest>

// 连接与重新登录的结果：连上了给出连接；要两步验证时给出可用的方式（只列支持的）
export const VaultConnectResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connected'), connection: VaultConnection }),
  z.object({
    kind: z.literal('two_factor_required'),
    providers: z.array(VaultTwoFactorProvider),
  }),
])
export type VaultConnectResult = z.infer<typeof VaultConnectResult>

// 连接读得到的一个条目：名称与字段名，不含值。credential 是给它起了标识的有效凭据，没起的为 null
export const VaultItemSummary = z.object({
  id: z.string(),
  organizationId: z.string(),
  collectionIds: z.array(z.string()),
  name: z.string(),
  type: VaultItemType,
  // 有值的字段，写法同 VaultFieldRef
  fields: z.array(z.string()),
  revisionDate: z.string(),
  credential: z.object({ id: z.uuid(), identifier: z.string() }).nullable(),
})
export type VaultItemSummary = z.infer<typeof VaultItemSummary>

// 条目列表，连同这个账号读得到的集合（含没有条目的，带是否只读，选去处时用）与组织；回收站里的不算
export const VaultItemList = z.object({
  items: z.array(VaultItemSummary),
  // 组织里解不开的条目数（格式不认识或校验不过），这些不在 items 里
  unreadableCount: z.number().int(),
  collections: z.array(VaultCollection),
  organizations: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type VaultItemList = z.infer<typeof VaultItemList>

// 重新检查连接的结果：连接现在的状态，以及这次同步读到的集合（选去处时用）。
// 同步失败时回 502（见 VaultConnection.lastError），停用的连接照样给出读到的集合
export const VaultCheckResult = z.object({
  connection: VaultConnection,
  collections: z.array(VaultCollection),
})
export type VaultCheckResult = z.infer<typeof VaultCheckResult>
