# Kioku 总体设计

> 面向单人自托管 Coding Agent 与个人助理的扁平长期记忆与托管凭据服务。架构重置背景与取舍见 [ADR-0004](adr/0004-flat-single-owner-v2.md)。

## 1. 背景与目标

同一位开发者通常在多台设备（macOS、Linux、Windows）、多个代码仓库与多个 Coding Agent（Claude Code、Codex、Gemini CLI、Antigravity、OpenCode、pi、Hermes、OpenClaw、DeepSeek Harness、ZCode 等）之间切换，但各客户端的记忆彼此割裂：

- 对话结束上下文即消失，项目约定与个人习惯需要反复叮嘱；
- 公司电脑与个人电脑共用同一套知识库时，工作凭据与个人记忆需要由服务端硬隔离，而不是靠提示词祈祷不泄露；
- 密码、API Token 若直接写进记忆正文，每次召回都会进入模型上下文与日志。

Kioku 提供一套极简、自托管的单人服务端闭环：

1. **扁平词条，信封强结构、信纸自由化**：每条记忆由服务端自动分配不可变 Base30 短 ID（`m-xxxxxx`），信封维护稳定短标题、可选现行概要（`summary`）、召回时机（`disclosure`）、四维场景标签（`envs`、`realms`、`projects`、`runtimes`）、主题标签（`topics`）、事实核实时间（`verified_at`）与最近变更说明（`last_change_summary`）；正文保持自由 Markdown 并用 `[[m-xxxxxx]]` / `[[m-xxxxxx|语境]]` 建立语境双链，演进历史独立沉入语义化 `entry_events`。
2. **服务端静态硬边界**：访问密钥携带静态 `allowed_realms` 与能力开关（`can_write`、`can_resolve_credentials`），在检索、历史查阅与取值前于服务端 JS 与 SQL 双重裁决；凭据执行失败即拒绝（fail-closed）。
3. **在场引擎（Presence Engine）**：会话启动采用三态常驻分层（`boot_mode: 'none' | 'index' | 'full'`，保持 `is_pinned = (boot_mode <> 'none')` 向后兼容）与精准场景分桶编译：默认 7,000 字全文展开预算 + 3,000 字独立目录槽，`index` 固定占单行摘要目录槽永不抢占全文预算，`full` 按「项目/客户端精准匹配 > 环境/场域匹配 > 全局（占全文预算 ≤ 50%）」分桶展开，并附带场景去冲突后的近期会话摘要与当前项目目录；每轮召回融合结构化去噪向量语义、PostgreSQL 原生权重 BM25F、场景亲和加减分与一跳双向语境双链扩散。
4. **Muse 风格加密托管凭据**：正文只写 `{{cred:<slug>}}` 或 `{{cred:<slug>#<field>}}`，明文用 AES-256-GCM 信封加密独立保管，经 `kioku run` 一次性原子注入子进程环境变量，绝不进入模型上下文。
5. **自动摘要、四阶段跨记忆整理与主动单条规范**：对话模型支持全局与按任务（快速任务 / 整理任务）思考等级（`reasoning_effort`）及结构化分层重试；后台从 `turn.end` 提炼会话摘要，定期或按需运行增量 / 规范（`tidy`）/ 跨记忆四阶段漏斗（`cross_memory`）整理，生成 7 类待确认建议（含 `link_entries` 补全双链、`adjust_boot_mode` 调整常驻，合并重复时事务内自动重定向全库反链）；配合零成本结构检查自动修复与断链扫描、编辑页 SSE 单条规范/查重与关联与列表多选批量整理，所有改动经人工确认与乐观锁校验才落库并留存完整快照与 `archive_note` 历史。
6. **自托管零外联**：服务端 + PostgreSQL（`pgvector` + `zhparser`）两个容器，管理界面不向第三方请求字体或图标。

## 2. 数据模型（12 张扁平表，无 RLS）

单人自托管不启用 PostgreSQL 行级安全（RLS），表结构集中在 `apps/server/src/db/schema.ts`，由基线迁移 `apps/server/migrations/0000_baseline.sql`（`_journal.json` 时间戳 `when = 1796000000000`）与后续纯增量迁移（`0001_entry_structure_and_history.sql`、`0002_boot_mode_and_focus.sql`、`0003_cross_memory_dream.sql`）维护；遇到更早旧架构时间戳的数据库时，`db/migrate.ts` 拒绝自动迁移并提示使用空库重新初始化。

| 分组 | 表名 | 职责与核心约束 |
|---|---|---|
| 账号与配置 | `accounts` | 唯一实例所有者（`username`、`display_name`、`password_hash`） |
| | `sessions` | 控制台登录会话（`token_hash` 唯一，30 天有效，`last_active_at` 最多每 5 分钟刷新） |
| | `settings` | 实例配置 KV（`embedding` / `chat_llm` 端点、思考等级 `reasoningEffort` / `taskReasoningEffort` 与加密 API Key、`dream_state`、`device_cookie_secret`） |
| 终端与授权 | `api_keys` | 终端访问密钥（`kioku_<12位前缀>_<40位密钥>`，存 SHA-256 哈希，承载 `runtime_family`、`envs`、`allowed_realms`、`focus_realms`、`can_write`、`can_resolve_credentials`、`revoked_at`） |
| | `device_grants` | 浏览器授权临时申请（`device_hash` 与 8 位 `user_hash` 均存哈希，支持单平台 `runtime_family` 或多平台 `platforms`，含可选 `focus_realms`，审批后 60 秒惰性签发窗口） |
| 核心记忆 | `entries` | 扁平记忆与会话摘要（`short_id` 全局唯一含软删除行、`kind`: `entry \| episode`、`title`、`summary`、`content`、`disclosure`、`boot_mode`: `none \| index \| full`、`is_pinned`（CHECK 同步 `boot_mode <> 'none'`）、`envs`/`realms`/`projects`/`runtimes`（接受任意合法 `SceneSlug`）/`topics`、`device_key`/`project_slug`、`search_tags`、`valid_to`、`verified_at`、`last_change_summary`、`version`、`dream_checked_version`、`deleted_at`、带 `setweight` 权重的 `fts` 生成列） |
| | `entry_embeddings` | 1024 维 pgvector 向量表（主键 `(entry_id, model)`，HNSW `vector_cosine_ops` 索引，含 `content_hash` 增量跳过） |
| | `entry_links` | 正文 `[[m-xxxxxx]]` / `[[m-xxxxxx\|语境]]` 出链边表（主键 `(source_entry_id, target_short_id)`，含可选 `relation`、`context_snippet`，`target_short_id` 索引支持反链与跨软删恢复） |
| | `entry_events` | 单条词条语义化变更历史与版本快照（`create` / `update` / `delete` / `undelete` / `restore` / `archive_note`，记录 `actor`、`change_summary`、`diff_meta`、`occurred_at` 与完整 `EntrySnapshot`） |
| 托管凭据 | `credentials` | AES-256-GCM 信封加密凭据（`slug` 唯一、`label`、`description`、`allowed_realms`、`ciphertext`、`wrapped_key`、`key_id`） |
| 抽取与整理 | `turn_buffer` | `turn.end` 对话轮次缓冲（按 `(device_key, project_slug)` 分桶，单桶最多留最新 100 轮） |
| | `dream_suggestions` | 后台整理生成的 7 类待确认建议（`distill_episode` / `merge_duplicates` / `mark_stale` / `update` / `tidy` / `link_entries` / `adjust_boot_mode`，含 `proposed_summary`、`proposed_change_summary`、`archived_notes`、`proposed_links`、`proposed_boot_mode`，`fingerprint` 唯一去重，`entry_ids` + `entry_versions` 乐观锁版本对齐） |

关键不变量：

- **无歧义短 ID**：字符集 `23456789abcdefghjkmnpqrstvwxyz`（排除 `0/o/1/i/l/u`），新生成 6 位 `m-xxxxxx`，正则接受 6–8 位、大小写不敏感、存储统一小写。
- **纯不可变分层加权全文列**：写入词条时同步计算 `search_tags`（拼接 `short_id`、`topics`、`envs`、`realms`、`projects`、`runtimes`），`fts` 生成列仅对本行文本调用 `setweight(to_tsvector('kioku_zh'::regconfig, ...), ...)`（`title` 权重 A，`summary + disclosure + search_tags` 权重 B，`content` 权重 C）。
- **摘要不可常驻**：数据库 `CHECK` 约束保证 `kind <> 'episode' OR NOT is_pinned`；会话摘要默认有效期 14 天，可在管理界面一键提炼升级为正式记忆（`promoteToEntry: true`）。
- **统一数据库时钟**：有效期与更新时间判定统一使用 `withTx` 事务开头取得的数据库时间戳（`nowOf(tx)` / `transactionMoment`）与 `databaseNow(db)`，不混用应用进程的 `Date.now()`。

## 3. 终端透镜、安全边界与认证防护

### 3.1 静态硬边界（`access/scope.ts`）

访问主体分两类：控制台会话（`ConsolePrincipal`，全权读写，受同源 CSRF 校验 `sameOriginForCookies` 保护）与终端访问密钥（`KeyPrincipal`，Bearer 鉴权）。

所有词条与凭据的可见性规则均在 `access/scope.ts` 中维护 JS 与 SQL 两份完全一致的实现（集成测试 `scope.int.test.ts` 交叉校验）：

| 资源 | 密钥 `allowed_realms = null`（不限） | 密钥 `allowed_realms = ['work', ...]`（限定场域） | 密钥 `allowed_realms = []`（仅通用） |
|---|---|---|---|
| **词条读取**（`canReadEntry` / `readableEntrySql`） | 放行全部未删且有效词条 | 放行 `realms = {}` 的通用词条，以及与 `allowed_realms` 有交集的词条 | 仅放行 `realms = {}` 的通用词条 |
| **词条写入**（`assertEntryWriteAllowed` / `resolveCreateRealms`） | 需 `can_write = true` | 需 `can_write = true`；新建未传 `realms` 时自动继承有效默认场域（`focus_realms ∩ allowed_realms`，无则 `allowed_realms`）；禁止写入或修改为无场域全局词条，所标 `realms` 须全部落在 `allowed_realms` 内 | 需 `can_write = true`，且写入不可标任何 `realms` |
| **凭据列表与取值**（`canAccessCredential` / `credentialRealmConditionSql`，**fail-closed**） | 需 `can_resolve_credentials = true`，放行全部凭据 | 需 `can_resolve_credentials = true`，且凭据自身 `allowed_realms` **必须非空**并与密钥 `allowed_realms` 有交集（未限定场域的凭据一律拒绝） | 一律拒绝（返回空列表 / 404） |

### 3.2 登录防护与会话

- **反向代理 IP 解析**：部署在反向代理后须配置 `KIOKU_TRUSTED_PROXIES`（从 `X-Forwarded-For` 右侧数受信代理层数）并将端口绑定至 `127.0.0.1`。
- **内存两级限流（`auth/rateLimit.ts`）**：15 分钟窗口内同一客户端 + 用户名上限 10 次、同一用户名全局合计上限 30 次；成功登录后下发路径 `/v1/auth`、有效期 180 天的签名设备 Cookie（`kioku_device`，签名绑定当前密码哈希指纹，改密即失效），携带受信设备 Cookie 时越过用户名合计上限、仍受本客户端上限约束。
- **scrypt 并发闸门（`auth/passwordGate.ts`）**：全局最多 4 个并发 + 32 个排队，单客户端最多 2 个；用户名不存在时仍过闸门并占本客户端名额（不占全局名额），避免暴露账号存在性或耗尽 CPU。

## 4. 在场引擎：启动加载与混合召回

### 4.1 场景焦点合成（`synthesizeFocus`）

在场焦点 `SceneFocus` 包含四个内置维度：`envs`、`realms`、`projects`、`runtimes`：

- `envs`：优先取请求显式覆盖，否则取访问密钥配置的 `envs`（内置建议 `mac` / `linux` / `win`，也支持自定义设备/环境标签）；
- `realms`：优先取请求覆盖（若访问密钥配置了非空 `allowed_realms`，先与 `allowed_realms` 取交集，越界覆盖自动忽略），其次取访问密钥的 `focus_realms`（启动聚焦场域），最后回退 `allowed_realms`（仅用于启动聚焦与排序，**绝不放宽静态安全边界**）；
- `runtimes`：优先取请求覆盖（支持任意合法 `SceneSlug` 自定义客户端标识，如 `cursor-cli`），否则取访问密钥的编码 Agent 家族（`claudecode`、`codex`、`gemini`、`agy`、`openclaw`、`hermes`、`opencode`、`pi`、`dsh`、`zcode`）；
- `projects`：从请求 `project`（字符串或 `{ repoName, dirName }`）同时提取归一化后的 `repoName` 与 `dirName` 去重最多 2 个，防 worktree 或本地目录改名漏匹配。

### 4.2 启动加载（`recall/boot.ts`）

`compileBoot` / `compileBootDetailed` 为会话启动编译上下文（并供控制台 `POST /v1/console/boot/preview` 只读预览）：

1. **三态常驻筛选**：读取所有未删、未过期、满足 `readableEntrySql` 且 `kind = 'entry' AND boot_mode <> 'none'` 的词条（`boot_mode = 'index'` 为目录常驻，`'full'` 为全文常驻；`is_pinned` 与之由数据库约束强一致）。
2. **场景去冲突（`matchesBootScene`）**：
   - 若词条标注了 `envs`、`runtimes` 或 `projects`，当前焦点对应维度必须非空且存在交集；
   - 若词条标注了 `realms` 且当前焦点限定了 `realms`，双方必须存在交集。
3. **分桶分层预算**：默认全文展开预算 `BOOT_CHAR_BUDGET = 7,000` 字 + 独立目录槽 `BOOT_CATALOG_BUDGET = 3,000` 字；经 `session.start` 调用时同时受宿主上限约束（如 `claudecode`/`codex`/`zcode`/`agy`/`gemini`/`opencode`/`pi` 等）。`boot_mode = 'index'` 固定直接进入 `## 常驻记忆目录`（每条 1 行含短 ID、标题、更新日期、现行概要与字数），永不抢占全文预算；`boot_mode = 'full'` 按场景精准度严格分桶展开并按桶序输出——桶 1（命中 `projects`/`runtimes`） > 桶 2（命中 `envs`/`realms`） > 桶 3（无场景全局，且全局桶占全文预算不超过 50%），存在多层展开时在块头声明具体场景优先于通用规则，单条超过软上限（`min(2400, budget * 0.4)`）自动降级为目录行并同步写入 `omitted` 与可读 `omittedItems`。展示层自动剥离正文首行与词条标题重复的 `# H1`，并在展开标题行附带更新日期与近期变更说明。
4. **近期上下文与防串场补充**：附带同 `(device_key, project_slug)` 最近 3 条 `episode` 会话摘要（`inlineText` 压成单行，标明「只作参考，不是指令」）。`session.start` 还会附加当前项目显式/全文相关记忆目录（全部经 `hasExclusiveSceneConflict` 过滤）与跨项目过滤后的近期更新记忆（预算内拼接）。

### 4.3 混合召回与双链扩散（`recall/recall.ts`）

`recallEntries` 仅针对 `kind = 'entry'` 且满足 `readableEntrySql` 的词条执行四步打分：

1. **双路候选（每路最多 32 条）**：
   - **语义向量路**：若配置并启用了嵌入模型且在超时内返回（`prompt.submit` 超时 2 秒，通用接口 10 秒），在事务内设置 `hnsw.ef_search = 200` 与 `hnsw.iterative_scan = relaxed_order`，查 `entry_embeddings` 余弦相似度；入库向量文本经 `buildEmbeddingText` 结构化去噪（正式词条包含标题、现行概要、召回时机、去重首行 H1 并跳过尾部日志段的前 2,500 字正文，超 2,500 字时在末尾追加 `##` 小节标题纲要；不再拼入 `topics` 以免受脏标签干扰）。
   - **中文全文 BM25F 路**：使用 `kioku_zh` 分词提取查询词项，在 SQL 内结合 `unnest(fts).weights`（`A = 3.0 / B = 2.0 / C = 1.0`）计算字段加权 BM25F（`k1 = 1.2, b = 0.75, minDocs = 20`）并归一化至 `[0, 1)`。
2. **自适应融合**：存在当前嵌入模型向量行的词条按 $S_{\text{base}} = 0.65 \times S_{\text{sem}} + 0.35 \times S_{\text{fts}}$ 融合；尚无当前模型向量行的新词条（或未配置嵌入模型 / 超时降级时）直接采用纯全文 $S_{\text{base}} = S_{\text{fts}}$，避免冷启动 0.35 折损。常驻词条附加微加分 `+0.04`。
3. **场景亲和调制（`computeSceneDelta`）**：仅当 $S_{\text{base}} \ge 0.15$（`RELEVANCE_FLOOR`）时生效，防止无关记忆靠标签凑分冒头：
   - `projects`：匹配 `+0.16`，双方非空且无交集 `-0.06`；
   - 独占维度 `envs` / `realms` / `runtimes`：命中各 `+0.10`（总加分上限 `+0.25`），冲突各 `-0.12`（独占扣分下限 `-0.20`）。
4. **一跳双向语境双链扩散（`expandOneHopNeighbors`）**：取过阈值（`DEFAULT_MIN_SCORE = 0.22`）最高 3 条种子，沿 `entry_links` 双向查出可读且无独占场景冲突（`hasExclusiveSceneConflict`）的 `entry` 邻居，得分按 `0.55` 衰减、标记 `via: 'link'` 并透出 `linkRelation` 关联语境；所有候选显式附带 `updatedAt` 与 `summary`（回退 `disclosure`），最终按分数降序截断返回（`prompt.submit` 默认 8 条，`kioku_search` 默认 10 条）。

## 5. 极简托管凭据与加密（Muse 风格）

- **明文与记忆彻底分离**：`entries` 表不设机密加密列；记忆正文用 `{{cred:<slug>}}` 或 `{{cred:<slug>#<field>}}` 引用凭据。管理界面编辑器经 `apps/web/src/secretHint.ts`（`detectSecretPrefixes`）在本地检测常见明文前缀（私钥块、AWS、GitHub、Slack、OpenAI、Anthropic、Kioku 密钥），仅轻量提醒、不阻断保存。
- **信封加密（`crypto/envelope.ts`）**：每条凭据与每项模型 API Key 使用独立随机数据密钥以 AES-256-GCM 加密，数据密钥由 `KIOKU_MASTER_KEY` 包裹；AAD 分别绑定 `credential:<凭据id>`、`settings:embedding`、`settings:chat_llm`。
- **启动同步校验与主密钥轮换（`crypto/rotation.ts`）**：`startService` 在对外提供服务前同步运行 `prepareMasterKey`，核对 `credentials` 与 `settings` 中全部加密记录。同时配置 `KIOKU_MASTER_KEY`（新）与 `KIOKU_MASTER_KEY_PREVIOUS`（旧）时，在启动阶段同步重封全部旧包裹密钥（无需后台队列）；缺失或不匹配时抛 `FatalStartupError` 拒绝启动。
- **命令执行注入（`POST /v1/credentials/resolve`）**：Agent 可调用 `kioku_list_credentials` 仅查元数据与说明；执行命令时通过 `kioku-plugins` 的 `kioku run --purpose "<用途>" -e ENV=<slug> -- <命令>` 调 `POST /v1/credentials/resolve` 一次性原子取值（响应头 `Cache-Control: no-store`，`field` 可选，优先匹配 `<slug>-<field>` 或内部 `fields[field]` 再回退主值 `value`，保持返回 `{ values, expired: [] }`），注入子进程环境变量，明文绝不经过模型上下文。

## 6. 接入协议：HTTP 接口、MCP 工具与浏览器授权

### 6.1 HTTP 接口概览（`/v1/openapi.json`）

| 模块 | 鉴权 | 接口 |
|---|---|---|
| 健康与初始化 | 公开 / 初始化码 | `GET /v1/health`、`GET /v1/setup/status`、`POST /v1/setup`、`POST /v1/setup/database/{check,provision}`、`POST /v1/setup/database` |
| 账号与会话 | 公开 / 控制台会话 | `POST /v1/auth/{login,logout,password}`、`GET\|PATCH /v1/auth/me`、`GET /v1/auth/sessions`、`DELETE /v1/auth/sessions/{id}` |
| 记忆管理 | 控制台会话 | `GET\|POST /v1/console/entries`、`POST /v1/console/entries/capture`、`POST /v1/console/entries/hygiene/{preview,apply}`、`POST /v1/console/boot/preview`、`GET\|PATCH\|DELETE /v1/console/entries/{shortId}`、`POST /v1/console/entries/{shortId}/restore`、`GET /v1/console/entries/{shortId}/history`、`POST /v1/console/entries/{shortId}/tidy/{preview,apply}`、`POST /v1/console/entries/{shortId}/cross-check` |
| 整理与建议 | 控制台会话 | `GET /v1/console/inbox`、`POST /v1/console/inbox/{id}/{apply,dismiss}`、`POST /v1/console/dream/run`（支持 `standard` / `tidy` / `cross_memory` 与 `targetShortIds` / `scope`） |
| 托管凭据 | 控制台会话 / Bearer | `GET\|POST /v1/console/credentials`、`PATCH\|DELETE /v1/console/credentials/{id}`、`POST /v1/console/credentials/{id}/reveal`、`POST /v1/credentials/resolve`（Bearer） |
| 访问密钥 | 控制台会话 | `GET\|POST /v1/console/keys`、`PATCH\|DELETE /v1/console/keys/{id}`、`POST /v1/console/keys/{id}/rotate` |
| 模型与数据 | 控制台会话 | `GET\|PUT /v1/console/settings/models`、`POST /v1/console/settings/models/test`、`POST /v1/console/settings/embedding/backfill`、`GET\|POST /v1/console/export`、`POST /v1/console/import/{preview,apply}` |
| 浏览器授权 | 公开 / 控制台会话 | `POST /v1/device/{authorize,token}`、`POST /v1/device/grants/{lookup,approve,deny}`（会话） |
| Agent 接入 | Bearer 访问密钥 | `POST /v1/lifecycle/event`、`GET /v1/boot`、`POST /v1/recall`、`POST /v1/mcp`、`GET /v1/whoami` |

### 6.2 九个 MCP 工具（`POST /v1/mcp`）

MCP 采用无状态 Streamable HTTP（拒绝 `GET` 订阅返回 405，避免客户端高频重连），注册 9 个工具：

| 工具 | 性质 | 作用 |
|---|---|---|
| `kioku_boot` | 只读 | 两遍渐进式编译当前终端透镜的常驻记忆与近期会话摘要 |
| `kioku_search` | 只读 | 按混合检索（结构化向量 + BM25F + 场景亲和 + 一跳语境双链）召回线索（支持临时焦点覆盖，不放宽硬边界） |
| `kioku_get` | 只读 | 按短 ID（`m-xxxxxx`）或精确标题读正文、概要、时效、语境双链与凭据状态；支持 `view: "outline"` 查看大纲及 `section` 按二级小节直取 |
| `kioku_history` | 只读 | 按短 ID 或标题查阅词条的语义化变更时间线（严格执行 `allowed_realms` 隔离，默认轻量列表，传 `version` 查看单版完整快照） |
| `kioku_browse` | 只读 | 按 `project` / `env` / `realm` / `runtime` / `topic` / `kind` 分组浏览可见记忆目录（含更新日期、字数与概要预览） |
| `kioku_create` | 写入 | 新建扁平词条（新写标题限 80 字，支持 `summary`、Markdown、`[[m-xxxxxx\|语境]]` 与 `{{cred:...}}`，附带非阻断结构提醒） |
| `kioku_update` | 写入 | 修改词条内容（支持整篇 `content` 或局部 `patch` 互斥更新）、`summary`、`change_summary`、`verified`、场景标签或有效期（支持 `expected_version` 乐观锁与非阻断结构提醒） |
| `kioku_delete` | 写入 | 软删除词条至回收站 |
| `kioku_list_credentials` | 只读 | 列出当前访问密钥有权使用的凭据标识与说明（仅元数据，绝不返回明文） |

### 6.3 生命周期钩子与浏览器授权

- **生命周期（`POST /v1/lifecycle/event`）**：处理 `session.start`（启动加载 + 近期摘要 + 项目相关 + 近期更新）、`prompt.submit`（每轮召回，语义 2 秒超时降级）与 `turn.end`（写入轮次缓冲），按 `runtimeFamily` 输出 `claudecode`、`codex`、`zcode`、`gemini`、`agy` 所需的宿主格式或通用 `return_value`。
- **浏览器授权（`/v1/device/*` 与 `/authorize`）**：命令行通过 `/v1/device/authorize` 申请单平台或多平台批量授权并展示 8 位确认码；用户在已登录的 `/authorize` 页面手工输入确认码（不接受 URL 参数，批准按钮不在 `<form>` 内防误回车）并配置 `envs` / `allowedRealms` / 读写与凭据开关；审批后进入 60 秒取走窗，命令行轮询 `/v1/device/token` 时在事务内锁行**惰性签发** `api_keys` 并立即删除申请记录，明文不落库、不经过浏览器。

## 7. 自动摘要、记忆整理与后台任务

实例在「设置 › 模型」中配置至多两个 OpenAI 兼容端点：一个嵌入模型（1024 维，更换或停用时清空旧模型向量并触发后台补齐）和一个对话模型（同时驱动随手记、会话摘要抽取与记忆整理）。对话模型支持配置思考等级（`reasoningEffort: 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`，默认 `default` 不注入字段，兼容非推理模型）及按任务覆盖（`fast` 快速任务 / `organize` 整理任务），开启思考时自动按档位补偿 `max_tokens`，并在 `models/client.ts` 实现结构化 `ModelClientError` 分层重试（`408/429/5xx/520–524`、断连、45s SSE 空闲僵死与未见 `[DONE]` 截断走指数退避 + Full Jitter + `Retry-After`；鉴权/配额/上下文超长/`finish_reason=length` 立即失败；遇 `reasoning_effort` 或 `temperature` 不兼容 400 自动剥离降级并缓存 1h；解析前确定性剥离 `<think>` 块）。

pg-boss 运行 5 个队列（`jobs/queue.ts`，通过 `pgBossSsl` 将 `sslmode=require` 统一映射为 `{ rejectUnauthorized: false }`）：

| 队列 | 策略与调度 | 职责 |
|---|---|---|
| `embed-entry` | 批量消费（`EMBED_BATCH`） | 正式词条新建/更新与含结构化信号的活跃 `episode` 异步计算 1024 维向量写入 `entry_embeddings`（`episode` 仅编码剥离出的偏好与事实信号文本，绝不进入日常 `recall`） |
| `embed-backfill` | `singleton` | 启动时或换嵌入模型后补齐活跃正式词条及含信号活跃 `episode` 的缺失向量 |
| `extract-episode` | `stately`，按 `deviceKey\|projectSlug` 去重 | `turn.end` 满 10 轮立即触发或空闲 10 分钟触发，按 `sessionId` 分段调用对话模型单次三槽分拣 `{ title, summary, facts, directives }`，以 `focus_realms ∩ allowed_realms` 归因场域并将信号零 DDL 存入 `episode.disclosure`；坏 JSON 不删除 `turn_buffer` 并支持 1 次定向语义纠错 |
| `dream` | `singleton`，每小时 41 分巡检（`standard` / `cross_memory` / `tidy` 各自独立开关、周期 1–720 小时与最近执行时间；首次启用对话模型且未手工配置整理时默认联动开启 `standard`）或手动触发（支持 `standard` / `tidy` / `cross_memory` 与 `targetShortIds`） | `standard` 模式按 `version > dream_checked_version` 结合 `entry_links`、pgvector 余弦近邻与全文近邻审阅新增/变动记录（透传已有出链与 `verified_at` 核实时间，并拦截丢失双链或越界场域流向的整篇 `update`）；`tidy` 模式 3 路受控并发（共享 429 冷却降并发、鉴权/配额熔断、记录结构化失败明细 `failedItems` 供一键重试）附带库内高频主题词表按完整正文规范标题、归档旧日志并收敛 `topics`（1–5 个）与 `disclosure`；`cross_memory` 模式走四阶段漏斗（Stage 0 场域硬边界 → Stage 1 零 LLM 向量聚类/互斥环境与项目合并守卫/中相似补链/同项目候选/双向 1 跳双链/相关性 FTS/断链候选图 → Stage 2 按优先级拆分查重簇、同场域跨 ≥ 2 次独立会话重复偏好拾遗、带事实向量的会话反向对账、基于二级小节大纲定位与确定性局部补丁的关联事实对账 `reconcile`、缺失双链、常驻减肥 6 类 Micro-Task → Stage 3 去重写入待确认建议列表），产出全部 7 类建议（`distill_episode` 支持显式放宽 `projects`/`envs` 与建议 `proposed_boot_mode`，严守 `realms` fail-closed；跨会话重复偏好按稳定簇指纹抑制驳回复发）。所有建议按 `fingerprint` 去重落库，人工确认并校验版本号应用；纯维护与整理应用写路径（单条/批量 `tidy`、结构检查、`link_entries`、`adjust_boot_mode`、无人工覆写的 `update` 及合并反链重定向）在原版本已审阅且未改场景时条件顺延 `dream_checked_version` 与 `tidy_checked_versions`，避免整理结果反复重进增量整理；合并重复在事务内强制检查全部被合并词条双链/凭据并集、同场域防线与最高 `boot_mode` 继承，并自动将全库活跃记忆的 `[[old]]` 反链重定向至保留目标（跳过代码块与 CommonMark 行内代码） |
| `cleanup-expired` | `singleton`，每小时 17 分 | 清理过期 `sessions`、过期 `device_grants`、闲置超 24 小时的 `turn_buffer`、软删除超 30 天的回收站词条、已过期/软删 `episode` 的信号向量，以及已处理超 30 天的 `dream_suggestions` |

除后台队列外，编辑页还提供**不占全局 `dream` 锁**的单条主动整理接口：`POST /v1/console/entries/{shortId}/tidy/preview`（SSE 阶段进度 + 5s 心跳 + 中止取消，先做结构检查自动修复再完整正文规范并校验完整性，无需修改时同步记录 `tidy_checked_versions`）与 `/tidy/apply`（强校 `expectedVersion` 乐观锁，支持一键应用或暂存至整理，直接写入记为独立来源 `tidy:single`）、以及 `POST /v1/console/entries/{shortId}/cross-check`（以当前记忆为锚点跑 Stage 1 + 查重簇、两阶段关联事实对账与补链，并在抽屉内分区展示当前记忆建议与连带发现的关联记忆修订建议）。

## 8. 管理界面（3+1 工作台）与界面用语

管理界面采用极简纸墨（Paper & Ink）零圆角设计，浅色与深色两套主题集中在 `apps/web/src/assets/css/main.css` 与 `apps/web/src/theme.ts`，层次全靠 1px 墨线（`--ui-rule`）与次级细线表达，不使用阴影，不再保留旧版 6×4 地层色带与纹理；砖红（`error`）为全站唯一强调色，仅用于告警、待确认建议计数与破坏性操作。所有图标均在 `apps/web/src/icons.ts` 登记并在构建时打包，不向第三方发起字体或图标请求。

主导航包含 4 个顶级入口（辅以全局命令面板 `⌘K`）：

- **记忆（`/memories`）**：左栏支持按「全部 / 常驻 / 按需 / 近期摘要 / 回收站」分段及关键词、项目、环境、场域、客户端筛选，支持轻量批量整理模式（选 2–20 条规范所选或查重与关联），「常驻」顶栏显示全局全文 / 场景全文 / 目录常驻真实分层水位及「预览终端加载」只读抽屉；右栏阅读态提供一步切换三态常驻与适用场景的 Popover、「整理」下拉菜单（按说明修订 / 规范此条 SSE Diff 抽屉 / 查重与关联内联审阅抽屉）、待确认建议直达链接、3px 墨线「现行概要」、重复首行 H1 抑制与宽屏弹性可拖拽辅助轨（目录、双链置前与默认折叠的近期演进）；编辑态支持标题轻提醒与拆出至变更说明、常驻软提醒、明文前缀提示（`secretHint.ts`）、`[[m-xxxxxx]]` 与 `{{cred:...}}` 补全跳转及语义化版本历史抽屉。
- **整理（`/organize`，兼容 `/inbox` 重定向）**：采用全宽居中单行操作栏（标题旁紧凑运行态微条 Popover + 整合后的「增量整理 / 更多」下拉，清晰区分定时执行的增量整理、全库查重与关联、存量规范整理与零模型结构检查）、非零类型筛选轨与四列纸墨待确认建议列表（记忆 / 建议改动 / 类型与时间 / 操作，支持勾选批量应用安全项；合并重复、标记过时或含护栏告警行强制「展开核对」），点击行内展开 65% 纯亮纸变更区 / 35% 整理依据与护栏双栏审校面板，应用后提供 8 秒「撤销」提示；零成本「结构检查」抽屉同步展示自动修复项与全库悬空断链。
- **凭据（`/credentials`）**：管理加密托管凭据元数据与允许场域，一键复制占位符；点击「查看与更新值」时明文仅存局部组件状态、关闭即清空，支持原地轮换值与删除确认。
- **设置（`/settings/:tab`）**：三个标签页——**连接与终端**（MCP 地址、一键登录命令、访问密钥签发/编辑/轮换/吊销，支持配置启动默认场域）、**模型**（嵌入模型与对话模型端点、思考等级与按任务覆盖、连通测试、向量覆盖率与补齐索引、定时整理开关与周期）、**账号与数据**（显示名、改密、活跃登录设备下线、导出 JSON / Markdown 及两步导入）。

### 8.1 界面用语

管理界面与文档统一使用左列产品用语，由 `apps/web/src/__tests__/copyRules.test.ts` 对全部 `.vue`、`.ts` 强制检查。代码标识符、数据库字段、MCP 工具名与接口路径保留工程命名。

| 用 | 不再用 | 说明 |
|---|---|---|
| 记忆、正式记忆、会话摘要 | 词条（界面可见文案）、策展、情节、画像、分区、节点、URI | `entry` 称「正式记忆」，`episode` 称「会话摘要」；界面正文不出现 `URI` |
| 短 ID | 坐标、路径 | `m-xxxxxx` 不可变标识，等宽字体展示 |
| 常驻、启动加载、按需召回、目录常驻、全文常驻 | boot、启动上下文、启动节点、priority | `boot_mode` 三态对应「按需召回 / 目录常驻 / 全文常驻」，`is_pinned` 称「常驻」，会话启动注入称「启动加载」 |
| 适用场景、全局通用 | 所有环境、全部通用 | 四维场景（环境 / 场域 / 项目 / 客户端）；四维均为空时统称「全局通用」 |
| 召回时机、信号要点 | 触发场景、disclosure | 正式记忆的 `disclosure` 称「召回时机」（何时该想起）；会话摘要的 `disclosure` 称「信号要点」 |
| 有效期、有效期至 | 有效到、有效至 | `valid_to` 与授权失效时间 |
| 整理、整理页、待确认建议 | 待处理、待处理页、待处理队列、待处理建议、待审、Dream | `/organize` 页面与导航称「整理」（兼容 `/inbox` 重定向），待确认条目称「待确认建议」；代码、队列名与接口路径保留 `dream`/`inbox` |
| 增量整理、查重与关联、规范整理 | 查重/关联、跨记忆查重与关联 | 三种对话模型整理模式；7 类建议统一为四字动宾「提炼摘要 / 合并重复 / 标记过时 / 更新内容 / 规范精简 / 补全双链 / 调整常驻」 |
| 结构检查、自动修复 | 确定性预清洗、结构预清洗、结构体检 | 零模型结构扫描与自动修复流程及版本历史来源标注 |
| 按说明修订 | 按说明微调 | 单条自然语言修订（记忆详情页与待确认建议卡片统一用语） |
| 出链、反链 | 反向链接 | 双向双链面板与合并重定向提示 |
| 标题、待规范记忆、旧日志 | 脏标题、待规范存量、历史流水账 | 避免工程/运维黑话，使用中性产品描述 |
| 访问密钥 | Key、API Key（指 Kioku 密钥时）、一把 Key | 量词用「个」不用「把」；模型设置页的上游「API Key」除外 |
| 令牌 | Token（指凭据时） | 密码、令牌这类秘密值；模型用量 token 不译 |
| 客户端 | 宿主 | 运行 Agent 的程序，如 Claude Code、Codex |
| 浏览器授权、确认码 | 设备授权、设备码、授权码 | `/authorize` 流程的界面说法 |
| 恢复、恢复生效 | 撤销删除、重新生效 | 回收站恢复（`undelete`）与历史回滚（`restore`） |
| 权限范围 | 权限矩阵 | 访问密钥的读写、场域与凭据范围 |
| 本人、所有者 | 主人 | 操作者自指避免用第二人称「你」，需要时写「当前账号」 |
| 暂无、尚未、从未、疑似 | 还没、从没、像有、像凭据 | 空状态写「暂无…」；口语（删不掉、用不了、没做成、占着、放不下、去看看）换成产品用语 |

保留不译：JSON、Markdown、MCP、OpenAI 兼容、产品名（Kioku、Claude Code、Codex 等）、Agent、模型用量 token。
