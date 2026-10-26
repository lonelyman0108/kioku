# Kioku 设计

> 状态：草案，待定问题已全部决定　　建立：2026-10-26
> 本文是总体设计，回答「系统由哪些概念组成、记忆怎么分层和授权、各应用怎么接入」。实现进度见 `docs/plans/`，长期决策拆成 `docs/adr/`。

## 1. 背景与目标

Kioku 的前身是给编码 agent 用的单用户记忆服务（Lore）。它验证了几件事是对的：URI 寻址的记忆树、会话启动注入（boot）、每轮召回（recall）、「先读正文再信任」、disclosure（这条记忆该在什么场景想起）、后台整理（Dream）。但它的底子是单用户、单人格：

- 鉴权只有一个全局令牌，所有记忆在同一个命名空间，`core://soul` 全库只有一份；
- 接入方类型写死在代码里；
- 没有「谁能看什么」的概念，私人信息和人格设定混在一起。

Kioku 要服务的场景变了：同一套记忆要同时给编码 agent（Claude Code、Codex）、个人助理（OpenClaw、Hermes）和群聊机器人（AstrBot）使用。由此得出四个目标：

1. **多账号**：多个人类账号各有独立的记忆空间；同一个 bot 面对的每个群友、每个群也各有独立记忆。
2. **多人格**：人格是一等对象，可继承，可被多个应用借用。
3. **分层授权**：群聊可以借用人格，但读不到主人的私人信息；隔离由服务端强制，不靠提示词。
4. **低门槛接入**：不会主动写记忆的模型（群聊 bot）也能用——服务端从对话里自动抽取。

非目标：不做通用知识库 / RAG 文档检索；不做 agent 运行时本身。

## 2. 参考了什么

| 来源 | 借鉴 | 没有照搬的原因 |
|---|---|---|
| OpenClaw | 群聊、子 agent、定时任务会话在代码里剔除 `MEMORY.md`；记忆带来源（owner / agent / untrusted / system），只有前两种自动注入 | 它只管启动注入一处，工具检索不受限；隔离粒度是文件，不是单条记忆 |
| Hermes | 精简模式跳过记忆但保留 soul：人格与记忆解耦 | 记忆是本地小文件，没有多用户 |
| mem0 | `user_id / agent_id / run_id` 组合作用域；自动抽取 + ADD/UPDATE/DELETE/NONE 合并决策 | 曾出现调用方用 metadata 把记忆塞进别人作用域的漏洞——作用域必须来自鉴权身份，不能来自请求参数 |
| Graphiti / Zep | 双时间轴：事实带 `valid_at / invalid_at`，被新事实推翻时标记失效而不是删除 | 不引入图数据库，用 PG 列表达 |
| Honcho | 人和 bot 都是 peer；A 对 B 的认知只来自 A 亲眼看到的内容（观察者视角） | 推理成本高，只在对象记忆上采用视角概念 |
| Letta | 记忆块可挂给多个 agent，分只读 / 读写 | — |
| AstrBot | 会话标识 `平台:消息类型:会话ID`；Persona 表；`on_llm_request` 等钩子 | 本体没有长期记忆，社区插件的人格 / 会话过滤默认关闭 |

## 3. 核心概念

```
账号 Account ──拥有──▶ 空间 Space ──包含──▶ 记忆 Memory
                          │
                          ├── 人格 Persona（可继承）
                          ├── 应用 App（一个接入方，如 claudecode、astrbot-qq）
                          │      └── API Key（绑定 App + 人格 + 授权上限）
                          ├── 对象 Subject（bot 面对的人或群；跨平台身份可合并）
                          └── 会话 Session（一次对话，带上下文：私聊 / 群聊 / 定时任务）
```

- **账号**：登录管理界面的人。一个账号默认一个空间，也可以被邀请进别人的空间（共享知识）。空间成员有 `owner` / `editor` / `viewer` 三种角色。
- **画像归个人**：共享空间里，`owner` 层和 `private` 层按成员各存一份，只有本人的 Key 和上下文能读；`base`、`persona`、`app` 和共享知识是空间级的。bot 的「主人」就是创建该应用的成员。
- **空间**：隔离边界。所有表带 `space_id`，PostgreSQL 行级安全（RLS）兜底，应用层漏写条件也不会串空间。
- **人格**：soul、口吻、自我认知、boot 节点集合、写入策略。支持 `extends`：例如「豆包·群聊版」继承「豆包」，只覆盖收敛的部分。
- **应用**：一个接入方实例，取代写死的客户端枚举。带运行时家族（claudecode / codex / openclaw / hermes / astrbot / mcp / …），用于决定生命周期输出格式。
- **对象**：bot 视角下的「别人」：某个 QQ 用户、某个 TG 群。主人本人也是一个对象，并标记为 owner。同一个人在多个平台的账号可以合并成一个对象：阶段 2 由主人在管理界面手动合并；阶段 3 增加验证码自助绑定（在 A 平台发 `/bind` 拿一次性码，到 B 平台发送）。合并只合并身份，每条记忆的来源作用域保持不变，隐私规则照旧生效。
- **会话上下文**：每次请求由插件上报 `chat_type`（`direct` / `group` / `channel` / `cron` / `subagent`）、`group_ref`、`sender_ref`。

## 4. 记忆分层与授权

### 4.1 两个维度

只用「层」不够：「主人喜欢简洁的回答」属于用户习惯但在群里无害，「主人家的内网地址」同样关于主人却绝不能外泄。所以把**归属**和**可见性**拆开。

**层（layer）——这条记忆属于谁**

| 层 | 内容 | 例子 |
|---|---|---|
| `base` | 通用行为准则、记忆使用规则 | 「先读正文再信任」 |
| `persona` | 某个人格的设定，可继承 | soul、口吻、口头禅 |
| `app` | 某个应用独有 | 编码 agent 的提交规范；群聊 bot 的群规 |
| `owner` | 主人画像：习惯、偏好、关系 | 「回答用中文、先给结论」 |
| `private` | 主人的私人事务 | 基础设施、账号、家庭、项目 |
| `subject` | bot 对某个对象的认知 | 「群友 A 在学日语」 |
| `episode` | 会话摘要、时间线，带 TTL | 「10-26 讨论了 Kioku 设计」 |

**敏感级（sensitivity）——能给谁看**

| 级别 | 含义 |
|---|---|
| `public` | 任何上下文都可见（含陌生人群聊） |
| `internal` | 只给受信应用 / 受信上下文 |
| `private` | 只有主人的私密上下文 |
| `secret` | 永不自动注入、永不进召回候选，只能被授权 Key 按 URI 显式读取；内容加密存储（见下） |

`secret` 的存储：内容用应用层信封加密写库，主密钥来自环境变量 `KIOKU_MASTER_KEY`，每条记录一个数据密钥。`secret` 不建向量、不进全文索引，所以加密几乎不损失功能；数据库或备份泄露也不会暴露明文。更换主密钥时由后台任务重新包装数据密钥。其他敏感级明文存储，靠权限控制，因为它们要参与召回和搜索。

每条记忆还有**来源作用域**（origin scope）：`global`、`app:<id>`、`group:<ref>`、`direct:<subject>`。对象记忆和情节记忆默认只在来源作用域内可见——群友 A 私聊说的事，在群里召回不到，也不会出现在和 B 的对话里。

### 4.2 授权如何计算

```
有效权限 = API Key 的上限  ∩  会话上下文规则  ∩  人格 / 应用配置
```

- **API Key 上限**：可读层、可写层、最高敏感级、可见空间。Key 是唯一可信输入。
- **会话上下文规则**：插件上报的 `chat_type` 只能**收紧**权限，不能放宽。上报 `group` 就按群聊规则走；上报 `direct` 也不会超过 Key 的上限。
- **检索时裁剪**：召回、搜索、按 URI 读取都先套权限过滤再排序。拿不到的记忆不会出现在候选里，提示词注入无从下手。

默认配置示例：

| 应用 / 场景 | 可读层 | 最高敏感级 | 可写 |
|---|---|---|---|
| 编码 agent（本机） | 全部 | `private` | base – private |
| 个人助理 · 主人私聊 | 全部 | `private` | owner、private、episode |
| 个人助理 · 群聊 | base、persona、app、subject（本群） | `public` | subject（本群）、episode |
| 群聊 bot · 群聊 | base、persona（借用人格）、app、subject（本群） | `public` | subject（本群）、episode |
| 群聊 bot · 陌生人私聊 | base、persona、app、subject（此人） | `public` | subject（此人） |
| 群聊 bot · 主人私聊 | 同上，可配置提升 | `public`，可配置提升到 `internal` | 同上 |

最后一行：平台账号（如 QQ 号）能证明身份的强度一般，默认不提升，由主人在应用配置里显式开启。

### 4.3 写入的信任

- 每条写入记录 `provenance`：`owner`（主人在受信上下文写的）、`agent`（受信 agent 写的）、`untrusted`（来自群聊、陌生人）、`system`（Dream、抽取任务）。
- `untrusted` 来源只能写进 `subject` 和 `episode`，不能写进 `base`、`persona`、`owner`、`private`。
- 只有 `owner`、`agent` 来源的记忆参与跨作用域的自动注入；`untrusted` 内容要经主人确认或 Dream 审核后才能提升。这是对记忆投毒的防线。

### 4.4 时效

- 事实记忆带 `valid_from / valid_to`。新事实推翻旧事实时，旧的设 `valid_to` 并保留历史，按时间点查询仍可见。
- 召回默认只取当前有效的事实；排序加入时间衰减，可按层配置。
- `episode` 有 TTL，到期由 Dream 压缩成摘要或归档。

## 5. 记忆的形态

保留两种形态，存同一张表、共用权限模型：

1. **策展记忆**（curated）：URI 树节点，例如 `core://agent`、`preferences://user`、`projects://kioku`。由会认真写记忆的 agent 通过工具维护，有 priority、disclosure、glossary。适合 base / persona / app / owner / private。
2. **抽取记忆**（extracted）：扁平的事实条目，由服务端从对话抽取，挂在对象或会话上。适合 subject / episode。可被 Dream 提炼、合并成策展节点。

URI 在空间内唯一。人格私有节点放在人格命名空间下（如 `persona://doubao/soul`），解决「全库只有一份 soul」。

## 6. 生命周期与接入

### 6.1 生命周期协议

沿用 Lore 已验证的思路：插件只做薄转发，服务端决定注入什么、输出成什么格式。

- 单一端点 `POST /v1/lifecycle/event`，事件 `session.start`、`prompt.submit`、`turn.end`。
- `turn.end` 是新增的：带本轮用户消息和回复，触发异步抽取。
- 服务端失败时插件静默降级，不向 agent 注入错误。

### 6.2 三种接口

| 接口 | 给谁 | 说明 |
|---|---|---|
| MCP（HTTP） | 会调工具的 agent | `kioku_boot`、`kioku_get`、`kioku_search`、`kioku_create`、`kioku_update`、`kioku_delete`、`kioku_move`；权限由 Key 决定 |
| REST + OpenAPI | 插件、脚本、管理界面 | 由 zod 定义生成 OpenAPI，再生成 TS / Python SDK |
| 生命周期端点 | 有钩子的运行时 | 见 6.1 |

### 6.3 群聊 bot 插件（AstrBot）

- `on_llm_request`：用会话标识映射出 `chat_type / group_ref / sender_ref`，调 `prompt.submit` 拿召回结果，注入系统提示。
- 回复发送后：调 `turn.end` 提交本轮对话，服务端异步抽取。
- 平台用户 ID 映射到对象；同一个人多平台的 ID 可在管理界面合并。
- 插件用 OpenAPI 生成的 Python SDK，自身不含记忆逻辑。

### 6.4 自动抽取

`turn.end` 只把本轮对话追加进会话缓冲区，不立即调用 LLM。缓冲区攒满 N 轮，或会话空闲若干分钟后，合并成一次抽取任务（pg-boss）：LLM 抽取候选事实 → 与相关对象已有记忆比对，决定 ADD / UPDATE（设旧条目 `valid_to`）/ NONE → 写入。群聊消息密，批量处理比逐轮抽取大约省一个数量级的调用。

成本控制两道：

- 每个对象每天有写入条数上限，防刷；
- 每个空间有月度 token 预算（抽取与 Dream 共用，管理界面可调）。用到 80% 时告警；超出后降级为只写会话摘要（`episode`），不再做事实抽取，直到下个周期或主人调高预算。

默认开启；模型主动调工具写入作为补充，不计入抽取预算。

## 7. 召回

继承 Lore 的多路召回，在最前面加权限过滤：

1. 权限过滤：空间、层、敏感级、来源作用域、有效期；
2. 多路检索：向量（pgvector）、全文（zhparser）、glossary 关键词、对象直连（当前发言人与本群）；
3. 打分合并：相关度 × 层权重 × priority × 时间衰减；
4. 预算截断后输出 `<recall>` 块，记录召回事件。

召回事件按天汇总，原始明细保留期可配置（Lore 实例里明细一年能涨到数十万行，从未清理）。

## 8. 后台任务

用 pg-boss（队列存在 PostgreSQL 里），不需要 Redis：

- 抽取：见 6.4。
- Dream：按空间 / 人格分别运行，做合并、提炼、过时检测、`untrusted` 内容审核建议。
- 嵌入：embedding 渠道支持多个、按顺序回退；「同一模型改名」和「换模型全量重嵌入」都是一键任务，带进度。
- 保留期清理、备份（导出到 S3 兼容存储）、按空间导入导出。

## 9. 技术栈

| 部分 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node 22 LTS | 与插件生态（OpenClaw、opencode）同语言；可复用 Lore 的召回、Dream 算法 |
| HTTP | Hono + `@hono/zod-openapi` | 轻量，一份 zod 定义同时出校验、类型和 OpenAPI |
| ORM | Drizzle | SQL 透明，便于写 RLS 和向量查询 |
| 数据库 | PostgreSQL 16 + pgvector + zhparser | 向量、中文全文检索、队列同一个库 |
| 队列 | pg-boss | 去掉 Redis 依赖 |
| MCP | 官方 TypeScript SDK | 最成熟 |
| 管理界面 | Vue 3 + Vite + Nuxt UI 4（纯 Vue 模式） | 自带 Tree、Table、Editor、Dashboard、CommandPalette；构建成静态 SPA 由后端托管，单容器部署 |
| 前端配套 | TanStack Query Vue、Pinia（少量本地状态）、vue-router、VueUse、vue-i18n、vue-echarts | 服务端状态交给 Query；中文优先，留英文 |
| 包管理 | pnpm workspace | monorepo |

目录结构由维护者建立，建议的划分：服务端、管理界面、共享契约（zod schema）、SDK、各运行时插件。

## 10. 管理界面

- 记忆浏览器：树 + 节点编辑（Markdown）、历史版本与对比、层 / 敏感级 / 作用域标签。
- 人格：继承关系、boot 集合、各应用借用情况。
- 应用与 Key：授权上限编辑器（层 × 敏感级矩阵）、会话上下文规则预览——「这个 Key 在群聊里能看到哪些节点」。
- 对象：群友 / 群列表、跨平台合并、每个对象的记忆与抽取记录。
- 召回调试台：输入一句话 + 选择上下文，看各路候选、权限过滤掉了什么、最终注入什么。
- 待审队列：`untrusted` 内容、Dream 的修改建议。
- 全局搜索（⌘K）、暗色模式、手机可用。

## 11. 从 Lore 迁移

- 一次性导入工具：Lore 的节点、路径、glossary、历史事件进入默认空间。
- 映射规则：`core://agent` → base；`core://soul` → 默认人格；`core://agent/<runtime>` → 对应应用的 app 层；`preferences://` → owner；其余 domain 默认 private，导入后在界面里逐条调整。
- 召回事件只迁移汇总，不迁明细。
- 迁移期间两边并行，确认后再切换各客户端。

## 12. 分阶段

| 阶段 | 内容 | 结束标志 |
|---|---|---|
| 1 · 底座 | 账号、空间与成员角色、RLS、人格、应用与 Key、策展记忆 CRUD、`secret` 加密、MCP、生命周期 `session.start / prompt.submit`、召回（含权限过滤）、最小管理界面、Lore 导入 | 编码 agent 从 Lore 切到 Kioku 后体验不倒退 |
| 2 · 群聊 | 对象与会话上下文、手动合并对象、`turn.end` 与批量抽取、抽取预算、AstrBot 插件、Python SDK、对象管理界面 | 群聊里能借用人格、按群友记忆，且读不到私人层 |
| 3 · 时效与运维 | 有效期与过时检测、验证码自助绑定、Dream 按空间运行、嵌入多渠道与重嵌入任务、主密钥轮换、保留期、备份、导入导出 | 换嵌入模型、迁移服务不再需要手工 SQL |
| 4 · 可选 | Skills 服务端、矛盾检测、多空间共享 | — |

## 13. 已决问题

| 日期 | 问题 | 结论 | 正文位置 |
|---|---|---|---|
| 2026-10-26 | 跨平台身份怎么合并 | 阶段 2 手动合并，阶段 3 加验证码自助绑定 | 3 节「对象」 |
| 2026-10-26 | `secret` 是否加密 | 只有 `secret` 应用层信封加密，不进索引 | 4.1 节 |
| 2026-10-26 | 共享空间里画像算谁的 | 画像与私人层归个人，其余空间级；成员三种角色 | 3 节「账号」 |
| 2026-10-26 | 自动抽取的成本 | 批量抽取 + 空间月度 token 预算，超出降级为只记摘要 | 6.4 节 |
| 2026-10-26 | 许可证 | Apache-2.0，复用的 Lore 代码在 NOTICE 保留 MIT 声明 | 仓库根目录 |

新的待定问题在这里追加，定下来后移进上表。
