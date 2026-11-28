import {
  BOOT_MODES,
  CHANGE_SUMMARY_MAX,
  checkCaptureIntegrity,
  CREDENTIAL_PLACEHOLDER_PREFIX,
  DISCLOSURE_MAX,
  DREAM_KINDS,
  DREAM_SECRET_WARNING_LABEL_MAX,
  DREAM_SECRET_WARNING_LOCATION_MAX,
  DREAM_SECRET_WARNING_SNIPPET_MAX,
  DREAM_SECRET_WARNINGS_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  ENTRY_TITLE_NEW_MAX,
  extractCredentialPlaceholders,
  extractMarkdownOutline,
  findSecretMatches,
  normalizeShortId,
  normalizeSlugList,
  parseEpisodeSignals,
  SCENE_TAGS_MAX,
  SceneSlug,
  TOPICS_MAX,
  TopicTag,
  type ArchivedHistoryNote,
  type BootMode,
  type DreamSecretWarning,
  type DreamSuggestionKind,
  type EntryKind,
  type ProposedLinkItem,
} from '@kioku/contracts'

import { stripThinkTags, type ChatMessage } from '../models/client'
import { clipChars, inlineText } from '../recall/text'

export interface DreamPromptItem {
  id: string
  shortId: string
  kind: EntryKind
  title: string
  summary?: string | null | undefined
  content: string
  disclosure: string | null
  bootMode?: BootMode | undefined
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  deviceKey?: string | null | undefined
  version: number
  verifiedAt?: string | null | undefined
  updatedAt: string
  truncated: boolean
  outboundShortIds?: string[] | undefined
  outline?: string | undefined
}

export interface ReconcileSourceItem {
  shortId: string
  title: string
  summary?: string | null | undefined
  content: string
  lastChangeSummary?: string | null | undefined
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  deviceKey?: string | null | undefined
  verifiedAt?: string | null | undefined
  updatedAt: string
}

export interface ReconcileCandidateItem {
  shortId: string
  title: string
  summary?: string | null | undefined
  content: string
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  deviceKey?: string | null | undefined
  verifiedAt?: string | null | undefined
  updatedAt: string
  relationHint?: string | undefined
}

export interface ReconcileConflictHit {
  targetShortId: string
  sectionHeading: string | null
  conflictReason: string
}

export type ReconcileLocateParseResult =
  { status: 'ok'; conflicts: ReconcileConflictHit[] } | { status: 'invalid'; reason: string }

export interface ReconcilePatchProposal {
  oldText: string
  newText: string
  proposedSummary: string | null
  changeSummary: string
  reason: string
}

export type ReconcilePatchParseResult =
  | { status: 'patch'; patch: ReconcilePatchProposal }
  | { status: 'not_needed' }
  | { status: 'invalid'; reason: string }

export interface BrokenLinkHint {
  targetShortId: string
  status: 'missing' | 'deleted'
  targetTitle: string | null
}

export interface HabitDistillProvenance {
  realms: string[]
  episodeCount: number
  distinctSessions: number
  projects: string[]
  devices: string[]
  dateRange: string | null
}

export interface ParsedDreamProposal {
  kind: DreamSuggestionKind
  entryIds: string[]
  keepId: string | null
  proposedTitle: string | null
  proposedSummary: string | null
  proposedContent: string | null
  proposedDisclosure: string | null
  proposedChangeSummary: string | null
  archivedNotes: ArchivedHistoryNote[] | null
  proposedTopics: string[] | null
  proposedEnvs: string[] | null
  proposedRealms: string[] | null
  proposedProjects: string[] | null
  proposedRuntimes: string[] | null
  proposedLinks: ProposedLinkItem[] | null
  proposedBootMode: BootMode | null
  secretWarnings?: DreamSecretWarning[] | null | undefined
  actionDiscriminator?: string | undefined
  reason: string
}

const DREAM_KIND_SET: ReadonlySet<string> = new Set(DREAM_KINDS)
const BOOT_MODE_SET: ReadonlySet<string> = new Set(BOOT_MODES)
const MAX_REASON_CHARS = 300
const MAX_ARCHIVED_NOTES = 20
const MAX_PROPOSED_LINKS = 6

const SYSTEM_PROMPT = [
  '你是 Kioku 记忆整理助手。请审阅给出的记忆词条（entry）与近期会话摘要（episode），只在确实值得整理时提出少量高价值建议。',
  '只输出 JSON：{"suggestions":[...]}，没有建议时输出 {"suggestions":[]}。',
  '',
  '允许以下 6 种整理建议类型（kind）：',
  '1. "distill_episode"：把 1 条或多条有长期价值的会话摘要（episode）提炼为一条永久正式记忆。须提供 target_short_ids、title（简短稳定、禁日期）、content、reason，推荐提供 summary（1–2 句现行结论）、change_summary、disclosure、topics（1–5 个简洁粗粒度分类标签）、envs、realms、projects、runtimes；若属跨项目的通用规则可显式传 projects: []（跨环境可传 envs: []），但严禁放宽 realms；仅当属简短、高频生效的核心工作流铁律时可额外提供 proposed_boot_mode: "full"（其余省略或 "none"）。',
  '2. "merge_duplicates"：合并 2 条以上内容高度重叠且 realms 一致的正式记忆（entry）。须提供 target_short_ids、keep_short_id、title、content、reason，推荐提供 summary、change_summary、disclosure、topics（主动收敛为 1–5 个核心分类标签，不要把旧标签全数堆砌）、envs、realms、projects、runtimes。不得合并被截断或仅互补的独立主题页。',
  '3. "mark_stale"：某条正式记忆已被更新的记忆推翻或明显过时失效。须提供 target_short_ids（1 条）与 reason。',
  '4. "update"：根据更新的会话摘要或关联邻居记忆（含双链邻居间的事实矛盾），对某条现有正式记忆做具体事实补充或修正。须提供 target_short_ids（1 条）、content、reason；基于较新记忆的事实对另一条旧记忆提 update 时必须填 source_short_id 标明事实来源短 ID；推荐提供 title、summary、change_summary、disclosure、topics、envs、realms、projects、runtimes。',
  '5. "link_entries"：为互补主题或存在明显上下游依赖、却尚未互链的正式记忆补充双链。须提供 target_short_ids（1 条待追加双链的词条）、links（数组，每项含 target_short_id、relation、可选 anchor_heading、可选 reason）与 reason。',
  '6. "adjust_boot_mode"：某条常驻词条过长或属参考手册，建议调整其启动加载层级（full -> index 或 none）。须提供 target_short_ids（1 条）、proposed_boot_mode（"none"|"index"|"full"）、reason；改为 index 时强烈建议同步给出 summary（1–2 句现行概要）。',
  '',
  '严格约束：',
  '- 宁缺毋滥，不要为细枝末节的措辞调整提建议；保持精炼，提炼抽象规则与防踩坑原因，绝不扩写流水账。',
  '- 禁止将特定机器、局域网主机、本机路径/端口或单次环境特例泛化为全局或整个操作系统规则；提炼与更新时必须在 title、summary、disclosure 与正文中明确保留适用机器与前提条件，并在 envs 中避免给单机特例盲目打上过于宽泛的通用标签。',
  '- 合并必须克制：只合并真正重复或高度重叠的词条；互补主题页优先用 link_entries 建双链而非硬揉成大汇总页。',
  '- 标题必须简短稳定，不夹带日期、版本号或改动日志；正文维护现行有效状态，不在首行重复标题。',
  '- 严禁编造任何密码、API Key 或令牌；原文中的 [[m-xxxxxx]] 双链与 {{cred:...}} 占位符必须完整保留。',
  '- target_short_ids 与 links[].target_short_id 必须全部取自下方提供的列表。',
  '- 不需要调整 envs、projects、runtimes、topics 时请直接省略对应字段，勿填占位空数组；仅在明确要放宽为跨项目、跨环境或跨客户端时才显式传 []（realms 严禁放宽）。',
  '- 若审阅的正文中出现疑似真实非示例的明文密码、密钥、令牌或含密码连接串，可在对应建议中附带可选字段 "secret_warnings":[{"label":"类型说明","location":"所在小节","masked_snippet":"仅保留前3字符并打码的短提示"}]；无疑似明文时省略。',
  '- secret_warnings 严禁原样输出完整明文密码或密钥，必须打码或仅标注所在小节。',
].join('\n')

const CLUSTER_AUDIT_SYSTEM_PROMPT = [
  '你是 Kioku 跨记忆查重与冲突审阅助手。下面是一组语义或主题高度接近的记忆词条（2–4 条），请判断它们是否真正重复、存在事实矛盾，或是互补主题页需要互链。',
  '只输出 JSON：{"suggestions":[...]}，若各自独立清晰且无需调整则输出 {"suggestions":[]}。',
  '',
  '允许输出的 kind：',
  '- "merge_duplicates"：仅当 2 条及以上词条表述同一主题、内容高度重叠且 realms 一致、未被截断时才合并；须给 target_short_ids、keep_short_id、title、summary、content、change_summary、reason，推荐同时将 topics 收敛为 1–5 个核心分类标签，且必须完整保留全部被合并词条中的外部 [[m-xxxxxx]] 双链与 {{cred:...}} 凭据占位符。',
  '- "link_entries"：若词条属于互补的独立主题页（例如架构与排错、服务端与客户端），绝不硬揉合并，而是输出 link_entries 建议（target_short_ids=[1条]、links=[{target_short_id, relation, anchor_heading?, reason}]、reason）。',
  '- "update"：若一条较新词条明确推翻或修正了另一条的旧配置/旧路径，对旧词条输出 update（须填 source_short_id 标明事实来源短 ID，并保留所有原有双链与凭据占位符）。',
  '- "mark_stale"：若某条已完全被另一条替代且无独立价值，输出 mark_stale。',
  '',
  '反膨胀守卫：合并或更新后的正文应提炼抽象规则、决策结论与防踩坑依据，去掉重复段落，不得无故拉长或引入日志流水。不需要调整作用域或主题时直接省略对应字段，勿填占位空数组 []。',
].join('\n')

const LINK_AUDIT_SYSTEM_PROMPT = [
  '你是 Kioku 双链关联审阅助手。给定一条核心记忆（含现行出链与可能的断链清单）以及若干尚未建立双链的候选记忆，请判断是否值得补充少量高价值双链（最多 4 条），或修正已失效断链。',
  '只输出 JSON：{"suggestions":[...]}，无需补链时输出 {"suggestions":[]}。',
  '',
  '规则：',
  '1. 只在两条记忆存在真实依赖、架构上下游、排错对照或同一项目核心分工时才建议 link_entries，泛泛相似一律忽略。',
  '2. link_entries 格式：{"kind":"link_entries","target_short_ids":["m-源词条"],"links":[{"target_short_id":"m-目标","relation":"简短关系语境(≤24字)","anchor_heading":"可选已有二级小节名","reason":"为什么值得互链"}],"reason":"整体补链理由"}。',
  '3. 若核心记忆存在指向已删除/不存在目标的断链，且候选中有明确的替代记忆，可额外提出一条 link_entries 指向替代记忆并在 reason 中说明原断链短 ID。',
  '4. 绝不可引用列表中不存在的短 ID，也不可建议已存在的出链。',
].join('\n')

const EPISODE_RECONCILE_SYSTEM_PROMPT = [
  '你是 Kioku 会话摘要对账助手。给定一条近期会话摘要（episode）以及最相关的既有正式记忆（优先含常驻记忆），请判断：',
  '1. 会话中的新结论是否推翻、修正或补充了某条既有正式记忆？若是，优先输出 "update" 更新该既有词条（并可带 source_short_id 标明摘要短 ID），严禁丢失原有双链与 {{cred:...}} 凭据占位符。',
  '2. 若摘要包含值得长期沉淀的独立经验且不应揉进任何已有词条，则输出 "distill_episode" 提炼为新正式记忆；跨项目通用规则可显式传 projects: []（跨环境可传 envs: []，但绝不放宽 realms），简短高频工作流铁律可附 proposed_boot_mode: "full"（其余省略或 "none"）。',
  '3. 若摘要仅为一次性临时排错且未推翻既有记忆，输出 {"suggestions":[]}。',
  '4. 禁止将特定机器、局域网主机、本机路径/端口或单次环境特例泛化为全局或整个操作系统规则；提炼与更新时必须在 title、summary、disclosure 与正文中明确保留适用机器与前提条件，并在 envs 中避免给单机特例盲目打上过于宽泛的通用标签。',
  '',
  '只输出 JSON：{"suggestions":[...]}。所有结论须提炼为稳定规则与防踩坑原因，严禁写入逐轮对话流水账；不调整作用域或主题时直接省略对应字段，勿填占位空数组 []。',
].join('\n')

const HABIT_DISTILL_SYSTEM_PROMPT = [
  '你是 Kioku 跨会话习惯沉淀助手。用户在同场域的多次不同会话中重复表达了相近的工作流偏好、协作习惯或纠偏要求，下方给出聚簇后的近期会话摘要与最相关的既有正式记忆。',
  '只输出 JSON：{"suggestions":[...]}；若这些要求纯属巧合、仅为一次性具体任务或不值得沉淀为长期规则，输出 {"suggestions":[]}。',
  '',
  '决策顺序：',
  '1. 优先检查下方既有正式记忆是否已覆盖同类工作流或习惯域：若已存在匹配词条，优先输出 "update"（target_short_ids=["m-已有短ID"]），将重复出现的偏好自然融入其中，严禁丢失原有 [[m-xxxxxx]] 双链与 {{cred:...}} 凭据占位符。',
  '2. 若无匹配的既有正式记忆，输出 "distill_episode" 提炼为一条简洁常青的新正式记忆：',
  '   - target_short_ids 须列出全部支撑该习惯的源会话摘要短 ID（至少 2 条）；',
  '   - title 简短稳定（禁日期），summary 写 1–2 句现行结论，content 提炼清晰可执行的抽象规则与原因（严禁写逐轮过程流水账），topics 给 1–3 个简洁小写标签；',
  '   - 作用域精准性：跨 ≥ 2 个不同项目或属通用工作流习惯时，显式传 projects: []（与特定机器或系统无关时亦可传 envs: []），简短高频核心工作流铁律（≤ 600 字）可附 proposed_boot_mode: "full"；仅限单一项目时保持 projects: ["该项目"]；涉及特定单机或本机路径端口时严禁泛化；严禁放宽 realms（省略或保留原场域）。',
  '3. reason 须简洁写明来源统计（如「近期在 3 次会话（涉及项目 kioku、kioku-plugins）中重复提出该流程习惯，建议沉淀为常驻规范」或「…建议并入既有习惯记忆」）。',
  '4. 不调整某维度时直接省略对应字段，勿在 update 中填占位空数组 []。',
].join('\n')

const BOOT_AUDIT_SYSTEM_PROMPT = [
  '你是 Kioku 启动加载分层审阅助手。以下记忆当前均设为「全文常驻（full）」，会在每次命中场景的会话开始时全文注入上下文。',
  '请审阅每条词条的性质与篇幅：',
  '- 简短跨会话核心铁律、硬约束应保留为 "full"（无需提建议）。',
  '- 长篇运维手册、端口/拓扑清单、阶段性参考资料或超过 1,200 字的详述文档，建议降级为 "index"（目录常驻，启动仅注入标题+1–2句现行概要，按需再读全文），并在建议中提供精炼的 summary。',
  '- 极少用到或仅特定排错才查的文档，可建议降级为 "none"（按需召回）。',
  '',
  '只输出 JSON：{"suggestions":[{"kind":"adjust_boot_mode","target_short_ids":["m-xxxxxx"],"proposed_boot_mode":"index","summary":"1-2句现行概要","reason":"降级理由"}]}。无需调整时输出 {"suggestions":[]}。',
].join('\n')

const TIDY_SYSTEM_PROMPT = [
  '你是 Kioku 记忆结构规范化助手。给定一条完整记忆词条，请将其重构为「稳定短标题 + 现行概要 + 干净常青正文 + 独立归档历史说明 + 简洁主题与触发场景」。',
  '只输出单个 JSON 对象：',
  '{"needed":true|false,"title":"简短稳定主题名","summary":"1-2句现行结论","content":"重构后的Markdown正文","topics":["可选1-5个简洁分类标签"],"disclosure":"可选触发场景(≤120字，仅none/index词条缺失或模糊时补充)","change_summary":"本次规范整理说明","archived_notes":[{"occurred_at":"YYYY-MM-DDTHH:mm:ssZ或null","note":"剥离出的单条历史变更说明"}],"reason":"为什么建议规范此条"}',
  '若该词条标题干净、已有合适概要、正文不含明显冗余历史流水账、主题已精简（≤5 个且无杂乱脏词）且触发场景清晰，直接输出 {"needed":false}。',
  '',
  '强制规则：',
  '1. title：名词短语主题名，建议 ≤24 字（绝不超 80 字），彻底去掉日期、括号里的更新日志、PR/commit 编号和过渡状态。',
  '2. summary：1–2 句（≤300 字）精准概括「现在是什么」，用于启动加载目录和检索速览。',
  '3. content（核心边界）：',
  '   - 严禁在正文首行重复 # <标题>；建议用清晰的 ## 二级小节组织（如现行配置/规则、关键约束与原因）。',
  '   - 必须保留所有仍在生效的配置、端口、地址、规则以及「防踩坑原因/禁令（Rationale）」——未来不知道会导致改坏系统的原因绝不能删！',
  '   - 将已退役组件、已停用旧流程、逐日迁移/排障过程流水账从正文剥离，压缩为简明条目放入 archived_notes（保留对应日期）。',
  '   - 原文出现的所有 [[m-xxxxxx]] 双链与 {{cred:...}} 凭据占位符必须 100% 完整保留，严禁丢失或改写格式。',
  '4. topics（可选）：将膨胀、杂乱、同义重复或含路径/句子的旧主题收敛为 1–5 个粗粒度小写分类标签（优先复用下方给出的库内高频主题参考，避免新造同义词；无须改动时可省略该字段）。',
  '5. disclosure（可选）：对于按需召回（boot_mode=none）或目录常驻（boot_mode=index）词条，若当前缺少触发场景或过于笼统，用 1 句简明描述「何时需要召回此记忆」（≤120 字）；已有清晰触发场景或全文常驻（boot_mode=full）词条可省略或填 null。',
  '6. archived_notes：每条只写精炼单行（≤200 字），日期已知时填 ISO 8601（如 2026-10-21T00:00:00Z），未知填 null；无剥离历史时给 []。',
  '7. secret_warnings（可选）：仅当正文存在疑似真实非示例的明文密码、密钥、令牌或含密码连接串时附带数组 [{"label":"类型说明","location":"所在小节","masked_snippet":"仅保留前3字符并打码的短提示"}]；无疑似明文时省略。严禁在 secret_warnings 中原样输出完整明文，必须打码或仅标注所在小节。',
].join('\n')

const RECONCILE_LOCATE_SYSTEM_PROMPT = [
  '你是 Kioku 跨记忆事实冲突定位助手。给定一条新近更新的基准记忆以及若干相关候选记忆（提供概要与二级小节大纲或正文摘录），请判断是否需要修订候选记忆中的过时陈述。',
  '只输出单个 JSON 对象：{"conflicts":[{"target_short_id":"m-xxxxxx","section_heading":"命中的二级小节标题（无二级小节时填 null）","conflict_reason":"简明说明哪条具体事实已被基准记忆推翻或过时"}]}。',
  '无明确冲突时必须输出 {"conflicts":[]}。',
  '',
  '严格规则：',
  '1. 仅当基准记忆中已确定的现行结论明确推翻或过时化候选记忆的某个具体陈述（例如地址、端口、路径、工具、依赖、架构或流程决策变更）时才返回冲突定位。',
  '2. 仅主题相关、互补信息、属于不同机器/环境特例或缺乏明确矛盾时，必须返回 {"conflicts":[]}，宁缺毋滥。',
  '3. target_short_id 必须严格取自下方候选记忆列表；每条候选记忆至多返回一条最关键的冲突定位。',
  '4. 候选记忆存在二级小节大纲时，section_heading 须准确填对应的二级小节标题；若候选记忆没有二级小节，section_heading 填 null。',
  '5. 结合「核实于/更新于」时间判断新旧方向，不得用旧结论覆盖更新的事实，也不得将单机特例泛化到无关主机。',
].join('\n')

const RECONCILE_PATCH_SYSTEM_PROMPT = [
  '你是 Kioku 单小节事实修订助手。给定一条基准记忆的现行结论、疑似过时的目标记忆单个二级小节原文（或无小节时的短全文）以及冲突线索，请核实该小节是否确实包含被推翻或过时的具体事实。',
  '若核查小节原文后确认确实需要最小局部修订，输出单个 JSON 对象：',
  '{"needed":true,"old_text":"原小节中逐字匹配的片段","new_text":"修订后的片段","proposed_summary":"可选，仅当目标现行概要同步过时时填写","change_summary":"一句话说明修订内容","reason":"为何需要修订（请注明基准记忆短 ID）"}',
  '若小节原文实际上已经一致、并不存在明确矛盾或证据不足，必须输出 {"needed":false}。',
  '',
  '严格规则：',
  '1. old_text 必须逐字复制自下方给出的目标小节原文，且在该小节内唯一出现（必要时多包含相邻行上下文确保唯一）。',
  '2. new_text 只修订确实过时的具体陈述，保持其余正常内容与原有格式不变，禁止大幅重写或扩写流水账。',
  '3. 严禁删除或破坏原文中的 [[m-xxxxxx]] 双链与 {{cred:...}} 凭据占位符，严禁编造任何密码、密钥或令牌。',
  '4. 仅当目标记忆的现行概要也一并过时才填 proposed_summary；概要仍准确时省略或填 null。',
].join('\n')

export function sameRealms(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizeSlugList(a)
  const right = normalizeSlugList(b)
  return left.length === right.length && left.every((v, i) => v === right[i])
}

// 场域流向守卫：donor（提供事实/被引用目标）的可见范围必须覆盖 recipient（被写入/被追加双链词条），禁止窄场域信息渗入更宽或通用词条
export function canFlowRealmInto(
  recipientRealms: readonly string[],
  donorRealms: readonly string[],
): boolean {
  const donor = normalizeSlugList(donorRealms)
  if (!donor.length) return true
  const recipient = normalizeSlugList(recipientRealms)
  if (!recipient.length) return false
  const donorSet = new Set(donor)
  return recipient.every((r) => donorSet.has(r))
}

function formatSemanticTimeLabel(verifiedAt: string | null | undefined, updatedAt: string): string {
  return verifiedAt ? `核实于 ${verifiedAt.slice(0, 10)}` : `更新于 ${updatedAt.slice(0, 10)}`
}

function formatSceneTags(item: {
  bootMode?: BootMode | undefined
  projects: readonly string[]
  envs: readonly string[]
  deviceKey?: string | null | undefined
  realms: readonly string[]
  runtimes: readonly string[]
  topics: readonly string[]
}): string[] {
  const tags: string[] = []
  if (item.bootMode && item.bootMode !== 'none') tags.push(`boot=${item.bootMode}`)
  if (item.projects.length) tags.push(`project=${item.projects.join(',')}`)
  if (item.envs.length) tags.push(`env=${item.envs.join(',')}`)
  const deviceKey = item.deviceKey?.trim()
  if (deviceKey) tags.push(`device=${deviceKey}`)
  if (item.realms.length) tags.push(`realm=${item.realms.join(',')}`)
  if (item.runtimes.length) tags.push(`runtime=${item.runtimes.join(',')}`)
  if (item.topics.length) tags.push(`topic=${item.topics.join(',')}`)
  return tags
}

function formatItem(item: DreamPromptItem, compact = false): string {
  const tags = formatSceneTags(item)
  const timeLabel = formatSemanticTimeLabel(item.verifiedAt, item.updatedAt)
  const head = `[${item.shortId}] (${item.kind}${item.truncated ? ', 已截断' : ''}, ${item.content.length}字) ${item.title} | ${timeLabel}${tags.length ? ` | ${tags.join(' ')}` : ''}`
  const sum = item.summary ? `\n现行概要：${item.summary}` : ''
  let disc = ''
  if (item.disclosure) {
    if (item.kind === 'episode') {
      const signals = parseEpisodeSignals(item.disclosure)
      if (signals.directives.length || signals.facts.length) {
        if (signals.directives.length) disc += `\n提取偏好与指令：${signals.directives.join('；')}`
        if (signals.facts.length) disc += `\n提取事实要点：${signals.facts.join('；')}`
      } else {
        disc = `\n触发场景：${item.disclosure}`
      }
    } else {
      disc = `\n触发场景：${item.disclosure}`
    }
  }
  const outbound = item.outboundShortIds?.length
    ? `\n已有出链：${item.outboundShortIds.join(', ')}`
    : ''
  if (compact) {
    const preview = item.summary?.trim()
      ? ''
      : `\n摘录：${clipChars(inlineText(item.content), 220)}`
    return `${head}${sum}${disc}${preview}`
  }
  const body = item.outline ? `【超长正文大纲】\n${item.outline}` : item.content
  return `${head}${sum}${disc}${outbound}\n${body}`
}

export function buildOutlineSummary(content: string): string {
  const sections = extractMarkdownOutline(content)
  if (!sections.length) return clipChars(content, 1_500)
  return sections
    .slice(0, 24)
    .map((s) => `- ## ${s.heading}（${s.charCount} 字）${s.preview ? `：${s.preview}` : ''}`)
    .join('\n')
}

export function buildDreamMessages(
  changed: readonly DreamPromptItem[],
  neighbors: readonly DreamPromptItem[],
): ChatMessage[] {
  const sections: string[] = ['## 本次待整理的新增/变动记录', ...changed.map((i) => formatItem(i))]
  if (neighbors.length) {
    sections.push(
      '',
      '## 相关已有记忆（含向量近邻、全文相关与双链邻居，供查重、补双链与矛盾核对参考）',
      ...neighbors.map((i) => formatItem(i)),
    )
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildClusterAuditMessages(cluster: readonly DreamPromptItem[]): ChatMessage[] {
  const sections = [
    `## 高相似记忆簇（共 ${cluster.length} 条，请判断重复合并、事实矛盾或互补互链）`,
    ...cluster.map((item) => formatItem(item)),
  ]
  return [
    { role: 'system', content: CLUSTER_AUDIT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildLinkAuditMessages(
  seed: DreamPromptItem,
  candidates: readonly DreamPromptItem[],
  brokenLinks: readonly BrokenLinkHint[] = [],
): ChatMessage[] {
  const sections = ['## 核心记忆', formatItem(seed)]
  if (brokenLinks.length) {
    sections.push(
      '',
      '## 核心记忆当前存在的失效断链',
      ...brokenLinks.map(
        (b) =>
          `- [[${b.targetShortId}]]（${b.status === 'deleted' ? `已移入回收站：${b.targetTitle ?? ''}` : '目标不存在'}）`,
      ),
    )
  }
  sections.push(
    '',
    '## 尚未互链的相关候选记忆（仅摘要信息）',
    ...candidates.map((cand) => formatItem(cand, true)),
  )
  return [
    { role: 'system', content: LINK_AUDIT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildEpisodeReconcileMessages(
  episode: DreamPromptItem,
  targets: readonly DreamPromptItem[],
): ChatMessage[] {
  const sections = ['## 近期会话摘要（待对账）', formatItem(episode)]
  if (targets.length) {
    sections.push(
      '',
      '## 最相关的既有正式记忆（优先核查事实是否已被上述会话推翻或补充）',
      ...targets.map((t) => formatItem(t)),
    )
  }
  return [
    { role: 'system', content: EPISODE_RECONCILE_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildHabitDistillMessages(
  episodes: readonly DreamPromptItem[],
  targets: readonly DreamPromptItem[],
  provenance: HabitDistillProvenance,
): ChatMessage[] {
  const statLines = [
    `场域：${provenance.realms.length ? provenance.realms.join('、') : '通用（未限定场域）'}`,
    `聚合会话摘要数：${provenance.episodeCount} 条（估算独立会话数：${provenance.distinctSessions} 次）`,
    `涉及项目：${provenance.projects.length ? provenance.projects.join('、') : '未标注项目'}`,
  ]
  if (provenance.devices.length) {
    statLines.push(`涉及设备：${provenance.devices.join('、')}`)
  }
  if (provenance.dateRange) {
    statLines.push(`时间跨度：${provenance.dateRange}`)
  }

  const sections = [
    '## 跨会话重复偏好统计',
    statLines.join('\n'),
    '',
    '## 聚合的近期会话摘要（同场域）',
    ...episodes.map((ep) => formatItem(ep)),
  ]
  if (targets.length) {
    sections.push(
      '',
      '## 最相关的既有正式记忆（优先考虑并入更新，避免重复建卡）',
      ...targets.map((t) => formatItem(t)),
    )
  }
  return [
    { role: 'system', content: HABIT_DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildBootAuditMessages(pinnedItems: readonly DreamPromptItem[]): ChatMessage[] {
  const sections = [
    `## 待审阅的全文常驻记忆（共 ${pinnedItems.length} 条，当前均设 boot_mode=full）`,
    ...pinnedItems.map((item) => formatItem(item)),
  ]
  return [
    { role: 'system', content: BOOT_AUDIT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildTidyMessages(
  item: DreamPromptItem,
  frequentTopics: readonly string[] = [],
): ChatMessage[] {
  const sections = [formatItem(item)]
  if (frequentTopics.length) {
    sections.push(
      `## 库内高频主题参考（优先复用已有稳定标签，避免新造同义词）\n${frequentTopics.join('、')}`,
    )
  }
  return [
    { role: 'system', content: TIDY_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

// 仅用于 realms（严格 fail-closed：空数组一律视为未提供，绝不放宽场域边界）
function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const valid: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const parsed = SceneSlug.safeParse(item)
    if (parsed.success) valid.push(parsed.data)
  }
  const items = normalizeSlugList(valid).slice(0, SCENE_TAGS_MAX)
  return items.length ? items : null
}

// 区分省略（null，沿用原值/回退）与显式空数组（[]，模型主动建议放宽或清空该维度）
function asOptionalSlugArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (value.length === 0) return []
  const valid: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const parsed = SceneSlug.safeParse(item)
    if (parsed.success) valid.push(parsed.data)
  }
  if (!valid.length) return null
  return normalizeSlugList(valid).slice(0, SCENE_TAGS_MAX)
}

// 主题标签始终要求非空覆盖，防止模型在 update 等提案中输出占位 topics: [] 意外清空原有标签
function asNonEmptyTopicArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const valid: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const parsed = TopicTag.safeParse(item)
    if (parsed.success) valid.push(parsed.data)
  }
  if (!valid.length) return null
  return normalizeSlugList(valid).slice(0, TOPICS_MAX)
}

function sameSlugList(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizeSlugList(a)
  const right = normalizeSlugList(b)
  return left.length === right.length && left.every((v, i) => v === right[i])
}

// 组装单轮干净修复提示词，避免多轮透传缺失 reasoning_content 导致部分推理模型网关报 400
export function buildSemanticRepairMessages(
  originalMessages: readonly ChatMessage[],
  errorFeedback: string,
): ChatMessage[] {
  const systemMsg = originalMessages.find((m) => m.role === 'system')
  const userParts = originalMessages.filter((m) => m.role === 'user').map((m) => m.content)
  const combinedUser = [
    ...userParts,
    '',
    '## 纠错要求（请重新生成完整合法的 JSON）',
    errorFeedback,
  ].join('\n')
  return [...(systemMsg ? [systemMsg] : []), { role: 'user', content: combinedUser }]
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripThinkTags(raw)
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function normalizeOccurredAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`
  const ts = Date.parse(trimmed)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

const CRED_PLACEHOLDER_STRIP_RE = /\{\{cred:[^}]*\}\}/gi
const CRED_PREFIX_STRIP_RE = /\{\{cred:/gi
const CONTROL_CHAR_RE = /\p{Cc}+/gu
const URI_AUTH_REDACT_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi
const MASK_CHAR_RE = /[*…•]/
const LONG_UNMASKED_RUN_RE = /[A-Za-z0-9_+/=-]{7,}/g
const ASSIGN_SECRET_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_.-]{0,15})=(.{6,})$/
const PLAIN_CONTEXT_WORD_RE = /^[a-z]{1,10}[:：]?$/
const RAW_SECRET_LIKE_TOKEN_RE = /[A-Za-z0-9_+/=!@#$%^&~-]{8,}/

// 净化模型产出的非正文单行文本：移除凭据占位符与全部控制字符，保证落库后可安全通过契约校验
function sanitizeDreamPlainField(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return ''
  const stripped = raw
    .replace(CRED_PLACEHOLDER_STRIP_RE, '')
    .replace(CRED_PREFIX_STRIP_RE, '')
    .replace(CONTROL_CHAR_RE, ' ')
  const normalized = inlineText(stripped)
  if (!normalized || normalized.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) return ''
  return clipChars(normalized, maxChars).trim()
}

function redactMatchedSecrets(text: string): string {
  if (!text) return ''
  const hits = findSecretMatches(text)
  let out = text
  if (hits.length) {
    const chunks: string[] = []
    let cursor = 0
    for (const hit of hits) {
      chunks.push(text.slice(cursor, hit.start))
      chunks.push(hit.label === '私钥块' ? '私钥***' : `${hit.match.slice(0, 3)}***`)
      cursor = hit.end
    }
    chunks.push(text.slice(cursor))
    out = chunks.join('')
  }
  return out.replace(URI_AUTH_REDACT_RE, '$1***@')
}

function sanitizeWarningSnippet(raw: unknown): string | undefined {
  const plain = sanitizeDreamPlainField(raw, 200)
  if (!plain) return undefined
  const redacted = redactMatchedSecrets(plain)
  const sanitizedTokens = redacted.split(/\s+/).map((token) => {
    if (!token) return ''
    if (MASK_CHAR_RE.test(token)) {
      return token.replace(LONG_UNMASKED_RUN_RE, (seg) => seg.slice(0, 3))
    }
    const assignMatch = ASSIGN_SECRET_TOKEN_RE.exec(token)
    if (assignMatch) {
      return `${assignMatch[1]}=${assignMatch[2]!.slice(0, 3)}***`
    }
    if (PLAIN_CONTEXT_WORD_RE.test(token)) return token
    if (RAW_SECRET_LIKE_TOKEN_RE.test(token)) {
      return `${token.slice(0, 3)}***`
    }
    return token
  })
  const joined = sanitizedTokens.filter(Boolean).join(' ').trim()
  if (!joined) return undefined
  return clipChars(joined, DREAM_SECRET_WARNING_SNIPPET_MAX).trim() || undefined
}

// 严格清洗并脱敏整理阶段搭便车返回的疑似明文告警，防止模型违规回显完整密码或长密钥
export function parseSecretWarnings(raw: unknown): DreamSecretWarning[] {
  if (!Array.isArray(raw)) return []
  const warnings: DreamSecretWarning[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (warnings.length >= DREAM_SECRET_WARNINGS_MAX) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const rawLabel = sanitizeDreamPlainField(rec.label, DREAM_SECRET_WARNING_LABEL_MAX * 2)
    const label = clipChars(redactMatchedSecrets(rawLabel), DREAM_SECRET_WARNING_LABEL_MAX).trim()
    if (!label) continue

    const rawLoc = sanitizeDreamPlainField(
      rec.location ?? rec.section,
      DREAM_SECRET_WARNING_LOCATION_MAX * 2,
    )
    const location =
      clipChars(redactMatchedSecrets(rawLoc), DREAM_SECRET_WARNING_LOCATION_MAX).trim() || undefined
    const maskedSnippet = sanitizeWarningSnippet(
      rec.masked_snippet ?? rec.maskedSnippet ?? rec.snippet,
    )

    const key = `${label.toLowerCase()}\0${(location ?? '').toLowerCase()}\0${(maskedSnippet ?? '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    warnings.push({
      label,
      ...(location ? { location } : {}),
      ...(maskedSnippet ? { maskedSnippet } : {}),
    })
  }
  return warnings
}

function parseArchivedNotes(raw: unknown): ArchivedHistoryNote[] {
  if (!Array.isArray(raw)) return []
  const notes: ArchivedHistoryNote[] = []
  for (const item of raw) {
    if (notes.length >= MAX_ARCHIVED_NOTES) break
    if (typeof item === 'string') {
      const cleaned = sanitizeDreamPlainField(item, CHANGE_SUMMARY_MAX)
      if (cleaned) notes.push({ occurredAt: null, note: cleaned })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const text = sanitizeDreamPlainField(rec.note, CHANGE_SUMMARY_MAX)
    if (!text) continue
    notes.push({
      occurredAt: normalizeOccurredAt(rec.occurred_at ?? rec.occurredAt),
      note: text,
    })
  }
  return notes
}

function parseProposedLinks(
  raw: unknown,
  source: DreamPromptItem,
  catalog: ReadonlyMap<string, DreamPromptItem>,
): ProposedLinkItem[] {
  if (!Array.isArray(raw)) return []
  const existing = new Set((source.outboundShortIds ?? []).map(normalizeShortId))
  const seen = new Set<string>()
  const links: ProposedLinkItem[] = []
  for (const item of raw) {
    if (links.length >= MAX_PROPOSED_LINKS) break
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const rawTarget = rec.target_short_id ?? rec.targetShortId
    if (typeof rawTarget !== 'string') continue
    const targetShortId = normalizeShortId(rawTarget)
    if (
      !targetShortId ||
      targetShortId === source.shortId ||
      seen.has(targetShortId) ||
      existing.has(targetShortId)
    ) {
      continue
    }
    const targetItem = catalog.get(targetShortId)
    if (!targetItem || targetItem.kind !== 'entry') continue
    // 严格校验场域流向：禁止向通用/宽场域词条写入指向窄场域词条的双链与标题
    if (!canFlowRealmInto(source.realms, targetItem.realms)) continue
    seen.add(targetShortId)
    const relation = sanitizeDreamPlainField(rec.relation, 64) || null
    const anchorHeading =
      sanitizeDreamPlainField(rec.anchor_heading ?? rec.anchorHeading, 120) || null
    const reason = sanitizeDreamPlainField(rec.reason, 240) || null
    links.push({
      targetShortId,
      targetTitle: clipChars(targetItem.title, 160),
      ...(relation ? { relation } : {}),
      ...(anchorHeading ? { anchorHeading } : {}),
      ...(reason ? { reason } : {}),
    })
  }
  return links
}

export type DreamStandardParseResult =
  { status: 'ok'; proposals: ParsedDreamProposal[] } | { status: 'invalid'; reason: string }

export function evaluateDreamResponse(
  raw: string,
  catalog: ReadonlyMap<string, DreamPromptItem>,
  options: {
    allowedKinds?: ReadonlySet<DreamSuggestionKind> | undefined
    changedShortIds?: ReadonlySet<string> | undefined
  } = {},
): DreamStandardParseResult {
  const parsed = parseJsonObject(raw)
  if (!parsed) return { status: 'invalid', reason: '模型输出非合法 JSON' }
  if (!Array.isArray(parsed.suggestions)) {
    return { status: 'invalid', reason: '模型输出缺少 suggestions 数组' }
  }
  const list = parsed.suggestions
  const normalizedChangedShortIds = options.changedShortIds?.size
    ? new Set([...options.changedShortIds].map(normalizeShortId))
    : null

  const proposals: ParsedDreamProposal[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind =
      typeof rec.kind === 'string' && DREAM_KIND_SET.has(rec.kind)
        ? (rec.kind as DreamSuggestionKind)
        : null
    if (!kind || kind === 'tidy') continue
    if (options.allowedKinds && !options.allowedKinds.has(kind)) continue

    const reason = sanitizeDreamPlainField(rec.reason, MAX_REASON_CHARS)
    if (!reason) continue

    const rawTargets = Array.isArray(rec.target_short_ids)
      ? rec.target_short_ids.filter((v): v is string => typeof v === 'string')
      : []
    const resolved: DreamPromptItem[] = []
    const seenIds = new Set<string>()
    for (const sid of rawTargets) {
      const hit = catalog.get(sid.trim().toLowerCase())
      if (hit && !seenIds.has(hit.id)) {
        seenIds.add(hit.id)
        resolved.push(hit)
      }
    }
    if (!resolved.length) continue

    const proposedTitle = sanitizeDreamPlainField(rec.title, ENTRY_TITLE_MAX) || null
    const proposedSummary = sanitizeDreamPlainField(rec.summary, ENTRY_SUMMARY_MAX) || null
    const proposedContent =
      typeof rec.content === 'string' && rec.content.trim()
        ? clipChars(rec.content.trim(), ENTRY_CONTENT_MAX)
        : null
    const proposedDisclosure = sanitizeDreamPlainField(rec.disclosure, DISCLOSURE_MAX) || null
    const proposedChangeSummary =
      sanitizeDreamPlainField(rec.change_summary, CHANGE_SUMMARY_MAX) || null

    let proposedLinks: ProposedLinkItem[] | null = null
    let proposedBootMode: BootMode | null = null
    let proposedRealms: string[] | null = asNonEmptyStringArray(rec.realms)
    let actionDiscriminator: string | undefined

    if (kind === 'distill_episode') {
      if (!resolved.every((r) => r.kind === 'episode') || !proposedContent) continue
      // 提炼后的场域必须满足全部源会话摘要的可见流向，严禁把受限场域放宽为通用词条
      const fallbackRealms = resolved[0]!.realms
      if (proposedRealms && !resolved.every((ep) => canFlowRealmInto(proposedRealms!, ep.realms))) {
        proposedRealms = null
      }
      const effectiveRealms = proposedRealms ?? fallbackRealms
      if (!resolved.every((ep) => canFlowRealmInto(effectiveRealms, ep.realms))) continue
      const rawDistillMode = rec.proposed_boot_mode ?? rec.proposedBootMode ?? rec.boot_mode
      if (typeof rawDistillMode === 'string' && BOOT_MODE_SET.has(rawDistillMode)) {
        proposedBootMode = rawDistillMode === 'none' ? null : (rawDistillMode as BootMode)
      }
    } else if (kind === 'merge_duplicates') {
      if (resolved.length < 2 || !proposedContent) continue
      if (resolved.some((r) => r.kind !== 'entry' || r.truncated)) continue
      const baseRealms = resolved[0]!.realms
      if (resolved.some((r) => !sameRealms(r.realms, baseRealms))) continue
      const disjointNonEmpty = (a: readonly string[], b: readonly string[]) =>
        a.length > 0 && b.length > 0 && !a.some((v) => b.includes(v))
      let hasScopeConflict = false
      for (let i = 0; i < resolved.length && !hasScopeConflict; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          const a = resolved[i]!
          const b = resolved[j]!
          if (
            disjointNonEmpty(a.envs, b.envs) ||
            disjointNonEmpty(a.projects, b.projects) ||
            disjointNonEmpty(a.runtimes, b.runtimes)
          ) {
            hasScopeConflict = true
            break
          }
        }
      }
      if (hasScopeConflict) continue
      // 合并重复严禁由模型改写场域，始终继承原词条一致场域
      proposedRealms = null
      // 合并提案严禁丢失任何一条被合并词条中的凭据占位符
      const credKey = (p: { slug: string; field: string | null }) =>
        p.field ? `${p.slug}#${p.field}` : p.slug
      const afterCreds = new Set(extractCredentialPlaceholders(proposedContent).map(credKey))
      const lostCred = resolved.some((r) =>
        extractCredentialPlaceholders(r.content).some((p) => !afterCreds.has(credKey(p))),
      )
      if (lostCred) continue
    } else if (kind === 'mark_stale') {
      if (resolved.length !== 1 || resolved[0]!.kind !== 'entry') continue
      proposedRealms = null
    } else if (kind === 'update') {
      // 禁止对已截断/仅传大纲的词条整篇覆写，避免丢失截断尾部内容与引用
      if (
        resolved.length !== 1 ||
        resolved[0]!.kind !== 'entry' ||
        resolved[0]!.truncated ||
        !proposedContent
      ) {
        continue
      }
      const integrity = checkCaptureIntegrity(resolved[0]!.content, proposedContent)
      if (integrity.missingCreds.length > 0 || integrity.missingLinks.length > 0) continue
      const rawSource = rec.source_short_id ?? rec.sourceShortId
      const hasExplicitSource =
        rawSource !== undefined &&
        rawSource !== null &&
        (typeof rawSource !== 'string' || rawSource.trim().length > 0)
      if (hasExplicitSource) {
        if (typeof rawSource !== 'string') continue
        const sourceSid = normalizeShortId(rawSource)
        const sourceItem = catalog.get(sourceSid)
        if (!sourceItem || sourceItem.shortId === resolved[0]!.shortId) continue
        if (!canFlowRealmInto(resolved[0]!.realms, sourceItem.realms)) continue
        actionDiscriminator = `from:${sourceSid}`
      } else if (normalizedChangedShortIds) {
        if (!normalizedChangedShortIds.has(resolved[0]!.shortId)) {
          // 目标为邻居且省略 source_short_id 时 fail-closed：批次内全部变更项的场域均须合法流入目标
          let allChangedCanFlow = true
          for (const changedSid of normalizedChangedShortIds) {
            const changedItem = catalog.get(changedSid)
            if (!changedItem || !canFlowRealmInto(resolved[0]!.realms, changedItem.realms)) {
              allChangedCanFlow = false
              break
            }
          }
          if (!allChangedCanFlow) continue
        } else {
          // 目标在变更批次内且省略 source_short_id 时 fail-closed：同批与邻居中不得混入无法流入目标的更窄或异场域记忆
          let allCatalogCanFlow = true
          for (const otherItem of catalog.values()) {
            if (otherItem.shortId === resolved[0]!.shortId) continue
            if (!canFlowRealmInto(resolved[0]!.realms, otherItem.realms)) {
              allCatalogCanFlow = false
              break
            }
          }
          if (!allCatalogCanFlow) continue
        }
      }
      if (proposedRealms && !canFlowRealmInto(proposedRealms, resolved[0]!.realms)) {
        proposedRealms = null
      }
    } else if (kind === 'link_entries') {
      if (resolved.length !== 1 || resolved[0]!.kind !== 'entry') continue
      const links = parseProposedLinks(rec.links ?? rec.proposed_links, resolved[0]!, catalog)
      if (!links.length) continue
      proposedLinks = links
      proposedRealms = null
      actionDiscriminator = `links:${links
        .map((l) => l.targetShortId)
        .sort()
        .join(',')}`
    } else if (kind === 'adjust_boot_mode') {
      if (resolved.length !== 1 || resolved[0]!.kind !== 'entry') continue
      const rawMode = rec.proposed_boot_mode ?? rec.proposedBootMode ?? rec.boot_mode
      if (typeof rawMode !== 'string' || !BOOT_MODE_SET.has(rawMode)) continue
      const nextMode = rawMode as BootMode
      if (resolved[0]!.bootMode && nextMode === resolved[0]!.bootMode) continue
      proposedBootMode = nextMode
      proposedRealms = null
      actionDiscriminator = `boot:${nextMode}`
    }

    let keepId: string | null = null
    if (kind === 'merge_duplicates') {
      const keepShort =
        typeof rec.keep_short_id === 'string' ? rec.keep_short_id.trim().toLowerCase() : ''
      const keepItem = catalog.get(keepShort)
      keepId = keepItem && seenIds.has(keepItem.id) ? keepItem.id : resolved[0]!.id
    }

    // 仅 distill_episode 允许模型用显式 [] 放宽单会话来源的 envs/projects/runtimes；
    // update 与 merge_duplicates 面向已定型正式记忆，占位 [] 一律视为未改动（null），防止静默泛化为全局
    const parseScopeList = kind === 'distill_episode' ? asOptionalSlugArray : asNonEmptyStringArray
    const allowMetaFields =
      kind === 'distill_episode' || kind === 'merge_duplicates' || kind === 'update'
    const secretWarnings = parseSecretWarnings(rec.secret_warnings ?? rec.secretWarnings)

    proposals.push({
      kind,
      entryIds: resolved.map((r) => r.id),
      keepId,
      proposedTitle,
      proposedSummary,
      proposedContent,
      proposedDisclosure,
      proposedChangeSummary,
      archivedNotes: null,
      proposedTopics: allowMetaFields ? asNonEmptyTopicArray(rec.topics) : null,
      proposedEnvs: allowMetaFields ? parseScopeList(rec.envs) : null,
      proposedRealms: allowMetaFields ? proposedRealms : null,
      proposedProjects: allowMetaFields ? parseScopeList(rec.projects) : null,
      proposedRuntimes: allowMetaFields ? parseScopeList(rec.runtimes) : null,
      proposedLinks,
      proposedBootMode,
      secretWarnings: secretWarnings.length ? secretWarnings : null,
      ...(actionDiscriminator ? { actionDiscriminator } : {}),
      reason,
    })
  }
  return { status: 'ok', proposals }
}

export function parseDreamProposals(
  raw: string,
  catalog: ReadonlyMap<string, DreamPromptItem>,
): ParsedDreamProposal[] {
  const evaluated = evaluateDreamResponse(raw, catalog)
  return evaluated.status === 'ok' ? evaluated.proposals : []
}

export type TidyParseResult =
  | { status: 'proposal'; proposal: ParsedDreamProposal }
  | { status: 'not_needed' }
  | {
      status: 'invalid'
      reason: string
      missingLinks?: string[] | undefined
      missingCreds?: string[] | undefined
    }

export function evaluateTidyResponse(raw: string, target: DreamPromptItem): TidyParseResult {
  const rec = parseJsonObject(raw)
  if (!rec) return { status: 'invalid', reason: '模型输出非合法 JSON' }
  if (rec.needed === false) return { status: 'not_needed' }
  const hasPayloadFields =
    (typeof rec.title === 'string' && rec.title.trim().length > 0) ||
    (typeof rec.summary === 'string' && rec.summary.trim().length > 0) ||
    (typeof rec.content === 'string' && rec.content.trim().length > 0) ||
    Array.isArray(rec.topics) ||
    (typeof rec.disclosure === 'string' && rec.disclosure.trim().length > 0)
  if (typeof rec.needed !== 'boolean' && !hasPayloadFields) {
    return { status: 'invalid', reason: '模型输出缺少 needed 布尔字段' }
  }

  const proposedTitle = sanitizeDreamPlainField(rec.title, ENTRY_TITLE_NEW_MAX) || target.title
  const proposedSummary = sanitizeDreamPlainField(rec.summary, ENTRY_SUMMARY_MAX) || null
  const proposedContent =
    typeof rec.content === 'string' && rec.content.trim()
      ? clipChars(rec.content.trim(), ENTRY_CONTENT_MAX)
      : target.content
  const parsedTopics = asNonEmptyTopicArray(rec.topics)
  const proposedTopics =
    parsedTopics !== null && !sameSlugList(parsedTopics, target.topics) ? parsedTopics : null
  const parsedDisclosure = sanitizeDreamPlainField(rec.disclosure, DISCLOSURE_MAX) || null
  const currentDisclosure = target.disclosure?.trim() || null
  const proposedDisclosure =
    parsedDisclosure && parsedDisclosure !== currentDisclosure ? parsedDisclosure : null
  const proposedChangeSummary =
    sanitizeDreamPlainField(rec.change_summary, CHANGE_SUMMARY_MAX) ||
    '规范标题与正文结构，归档旧日志'
  const archivedNotes = parseArchivedNotes(rec.archived_notes ?? rec.archivedNotes)
  const secretWarnings = parseSecretWarnings(rec.secret_warnings ?? rec.secretWarnings)
  const reason =
    sanitizeDreamPlainField(rec.reason, MAX_REASON_CHARS) || '规范标题与结构并补充现行概要'

  const effectiveSummary = proposedSummary ?? target.summary ?? null
  const unchanged =
    proposedTitle === target.title &&
    proposedContent === target.content &&
    effectiveSummary === (target.summary ?? null) &&
    proposedTopics === null &&
    proposedDisclosure === null
  if (unchanged) return { status: 'not_needed' }

  // 严格完整性守卫：规范精简允许安全压缩历史篇幅，但绝不允许丢失任一既有双链或凭据占位符
  const integrity = checkCaptureIntegrity(target.content, proposedContent)
  if (integrity.missingLinks.length > 0 || integrity.missingCreds.length > 0) {
    return {
      status: 'invalid',
      reason: '草案丢失原有双链或凭据占位符，已拦截',
      ...(integrity.missingLinks.length ? { missingLinks: integrity.missingLinks } : {}),
      ...(integrity.missingCreds.length ? { missingCreds: integrity.missingCreds } : {}),
    }
  }

  return {
    status: 'proposal',
    proposal: {
      kind: 'tidy',
      entryIds: [target.id],
      keepId: null,
      proposedTitle,
      proposedSummary,
      proposedContent,
      proposedDisclosure,
      proposedChangeSummary,
      archivedNotes: archivedNotes.length ? archivedNotes : null,
      proposedTopics,
      proposedEnvs: null,
      proposedRealms: null,
      proposedProjects: null,
      proposedRuntimes: null,
      proposedLinks: null,
      proposedBootMode: null,
      secretWarnings: secretWarnings.length ? secretWarnings : null,
      reason,
    },
  }
}

export function parseTidyProposal(
  raw: string,
  target: DreamPromptItem,
): ParsedDreamProposal | null {
  const res = evaluateTidyResponse(raw, target)
  return res.status === 'proposal' ? res.proposal : null
}

const RECONCILE_SOURCE_PREVIEW_CHARS = 2_000
const RECONCILE_CANDIDATE_NO_H2_EXCERPT_CHARS = 400
const RECONCILE_SECTION_HEADING_MAX_CHARS = 200

function formatReconcileSourceBlock(source: ReconcileSourceItem): string {
  const tags = formatSceneTags(source)
  const timeLabel = formatSemanticTimeLabel(source.verifiedAt, source.updatedAt)
  const truncated = source.content.length > RECONCILE_SOURCE_PREVIEW_CHARS
  const body = truncated
    ? clipChars(source.content, RECONCILE_SOURCE_PREVIEW_CHARS)
    : source.content
  const lines = [
    `[${source.shortId}] ${source.title}${truncated ? '（正文已截断）' : ''} | ${timeLabel}${tags.length ? ` | ${tags.join(' ')}` : ''}`,
  ]
  if (source.lastChangeSummary?.trim()) {
    lines.push(`最近变更说明：${source.lastChangeSummary.trim()}`)
  }
  if (source.summary?.trim()) {
    lines.push(`现行概要：${source.summary.trim()}`)
  }
  lines.push(body)
  return lines.join('\n')
}

function formatReconcileCandidateBlock(cand: ReconcileCandidateItem): string {
  const tags = formatSceneTags(cand)
  const timeLabel = formatSemanticTimeLabel(cand.verifiedAt, cand.updatedAt)
  const rel = cand.relationHint ? ` | ${cand.relationHint}` : ''
  const lines = [
    `[${cand.shortId}] ${cand.title} (${cand.content.length}字) | ${timeLabel}${rel}${tags.length ? ` | ${tags.join(' ')}` : ''}`,
  ]
  if (cand.summary?.trim()) {
    lines.push(`现行概要：${cand.summary.trim()}`)
  }
  const outline = extractMarkdownOutline(cand.content)
  if (outline.length) {
    lines.push('二级小节大纲：')
    for (const sec of outline.slice(0, 24)) {
      lines.push(
        `- ## ${sec.heading}（${sec.charCount} 字）${sec.preview ? `：${sec.preview}` : ''}`,
      )
    }
  } else {
    lines.push(
      `正文摘录（无二级小节）：\n${clipChars(cand.content, RECONCILE_CANDIDATE_NO_H2_EXCERPT_CHARS)}`,
    )
  }
  return lines.join('\n')
}

export function buildReconcileLocateMessages(
  source: ReconcileSourceItem,
  candidates: readonly ReconcileCandidateItem[],
): ChatMessage[] {
  const sections = [
    '## 基准记忆（新近更新的现行结论）',
    formatReconcileSourceBlock(source),
    '',
    `## 关联候选记忆（共 ${candidates.length} 条，仅展示概要与小节大纲）`,
    ...candidates.map((cand) => formatReconcileCandidateBlock(cand)),
  ]
  return [
    { role: 'system', content: RECONCILE_LOCATE_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function parseReconcileLocateResponse(
  raw: string,
  allowedShortIds: ReadonlySet<string>,
): ReconcileLocateParseResult {
  const parsed = parseJsonObject(raw)
  if (!parsed) return { status: 'invalid', reason: '模型输出非合法 JSON' }
  if (!Array.isArray(parsed.conflicts)) {
    if (
      parsed.conflicts === undefined &&
      Array.isArray(parsed.suggestions) &&
      parsed.suggestions.length === 0
    ) {
      return { status: 'ok', conflicts: [] }
    }
    return { status: 'invalid', reason: '模型输出缺少 conflicts 数组' }
  }

  const allowed = new Set([...allowedShortIds].map(normalizeShortId))
  const seen = new Set<string>()
  const conflicts: ReconcileConflictHit[] = []

  for (const item of parsed.conflicts) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const rawTarget = rec.target_short_id ?? rec.targetShortId
    if (typeof rawTarget !== 'string') continue
    const targetShortId = normalizeShortId(rawTarget)
    if (!targetShortId || !allowed.has(targetShortId) || seen.has(targetShortId)) continue

    const conflictReason = sanitizeDreamPlainField(
      rec.conflict_reason ?? rec.conflictReason ?? rec.reason,
      MAX_REASON_CHARS,
    )
    if (!conflictReason) continue

    const rawHeading = rec.section_heading ?? rec.sectionHeading
    const cleanedHeading =
      typeof rawHeading === 'string'
        ? sanitizeDreamPlainField(
            rawHeading.replace(/^#{1,6}[ \t]+/, ''),
            RECONCILE_SECTION_HEADING_MAX_CHARS,
          ) || null
        : null

    seen.add(targetShortId)
    conflicts.push({
      targetShortId,
      sectionHeading: cleanedHeading,
      conflictReason,
    })
  }

  return { status: 'ok', conflicts }
}

export function buildReconcilePatchMessages(
  source: ReconcileSourceItem,
  target: Pick<
    ReconcileCandidateItem,
    | 'shortId'
    | 'title'
    | 'summary'
    | 'envs'
    | 'realms'
    | 'projects'
    | 'runtimes'
    | 'topics'
    | 'deviceKey'
    | 'verifiedAt'
    | 'updatedAt'
  >,
  sectionHeading: string | null,
  sectionContent: string,
  conflictReason: string,
): ChatMessage[] {
  const targetTags = formatSceneTags(target)
  const targetTime = formatSemanticTimeLabel(target.verifiedAt, target.updatedAt)
  const targetMetaLines = [
    `[${target.shortId}] ${target.title} | ${targetTime}${targetTags.length ? ` | ${targetTags.join(' ')}` : ''}`,
  ]
  if (target.summary?.trim()) {
    targetMetaLines.push(`现行概要：${target.summary.trim()}`)
  }

  const sectionLabel = sectionHeading
    ? `小节「## ${sectionHeading}」原文`
    : '完整正文（无二级小节）'
  const sections = [
    '## 基准记忆（现行有效结论）',
    formatReconcileSourceBlock(source),
    '',
    '## 疑似冲突说明',
    conflictReason,
    '',
    '## 待核查目标记忆元信息',
    targetMetaLines.join('\n'),
    '',
    `## 待核查${sectionLabel}`,
    sectionContent,
  ]
  return [
    { role: 'system', content: RECONCILE_PATCH_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function parseReconcilePatchResponse(raw: string): ReconcilePatchParseResult {
  const rec = parseJsonObject(raw)
  if (!rec) return { status: 'invalid', reason: '模型输出非合法 JSON' }
  if (rec.needed === false) return { status: 'not_needed' }

  const oldText =
    typeof rec.old_text === 'string'
      ? rec.old_text
      : typeof rec.oldText === 'string'
        ? rec.oldText
        : ''
  const newText =
    typeof rec.new_text === 'string'
      ? rec.new_text
      : typeof rec.newText === 'string'
        ? rec.newText
        : ''

  if (typeof rec.needed !== 'boolean' && !oldText.trim() && !newText.trim()) {
    return { status: 'invalid', reason: '模型输出缺少 needed 布尔字段' }
  }
  if (!oldText.trim()) return { status: 'invalid', reason: '缺少待替换片段 old_text' }
  if (!newText.trim()) return { status: 'invalid', reason: '缺少替换内容 new_text' }
  if (oldText.replace(/\r\n/g, '\n') === newText.replace(/\r\n/g, '\n')) {
    return { status: 'not_needed' }
  }

  const proposedSummary =
    sanitizeDreamPlainField(rec.proposed_summary ?? rec.proposedSummary, ENTRY_SUMMARY_MAX) || null
  const changeSummary =
    sanitizeDreamPlainField(rec.change_summary ?? rec.changeSummary, CHANGE_SUMMARY_MAX) ||
    '根据关联记忆修订过时事实'
  const reason = sanitizeDreamPlainField(rec.reason, MAX_REASON_CHARS) || changeSummary

  return {
    status: 'patch',
    patch: {
      oldText,
      newText,
      proposedSummary,
      changeSummary,
      reason,
    },
  }
}
