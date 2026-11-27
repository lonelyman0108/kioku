# Kioku

面向单人自托管 Coding Agent 与个人助理的长期记忆与托管凭据服务。TypeScript monorepo：后端 Node 22 + Hono + Drizzle + PostgreSQL（pgvector、zhparser）+ pg-boss，管理界面 Vue 3 + Nuxt UI 4（纯 Vue SPA，由后端托管）。

提交、PR、发版的完整规范见 [CONTRIBUTING.md](CONTRIBUTING.md)；设计见 [docs/design.md](docs/design.md)。本文件只写 agent 需要、又无法从代码推出来的内容，每条约定都附原因。超过 300 行时拆到子目录的 AGENTS.md。

## 工作方式

- 只在分支或 worktree 上工作，分支名 `<type>/<slug>`；用 `scripts/pr.sh` 开 PR，**不直接提交或推送 main**。原因：main 受保护，PR 是唯一经过门禁的入口。
- 提交与 PR 标题：`<emoji> <type>(<scope>): <中文主题>`，首行 ≤ 72 字符；类型表见 CONTRIBUTING.md「提交规范」。钩子会拦下不合规的提交。
- **不加任何署名 trailer**（Co-authored-by 等）。原因：规范禁止，钩子与 CI 两道都拦。
- 注释只讲代码本身，不写需求号、阶段号、验收号这类流程编号；这些编号只留在 `docs/` 的过程文档。`scripts/lint/comments.sh` 会检查。
- 提交前跑 `scripts/check.sh`（纯文档改动可用 `--quick`），结果写进 PR 的「验证」节。
- PR 的 CI 通过后先做代码审查（`/code-review`），确认的问题修掉、CI 重新通过后才合并。原因：维护者要求，CI 只保证测试通过，不保证设计和安全没有问题。
- 一次性的进度写进 `docs/plans/` 的计划文档，不写进本文件。
- 模块结构由维护者先建好，agent 在已有结构内实现；需要新增顶层包或目录时先在 PR 里说明。原因：维护者习惯自己定模块边界。
- 许可证 Apache-2.0。从 Lore 或其他第三方项目复制、改写代码时，在 `NOTICE` 里登记来源与原许可证。原因：MIT 与 Apache-2.0 都要求保留原版权声明。
- 仓库里不写任何私有部署信息（内网地址、自建服务域名、账号、邮箱）。原因：仓库公开。示例一律用 `example.com`、`127.0.0.1`。

## 禁区

原因：这些操作影响发布、平台或门禁本身，必须由维护者本人执行或发起。

- 不发起维护者没要求的发版。维护者发起并确认版本号后，可按 CONTRIBUTING.md「发布」一节提交发布 PR、运行发布脚本、推送版本 tag；不删除、不移动 tag。
- 未获维护者当次明确确认前，不上传、不部署（tag 推送后由 `release.yml` 自动完成的构建与推送除外）。
- 不改 GitHub 平台设置（secrets、规则集、仓库可见性），不读取或打印密钥文件（`~/.config/*/token`、`.env`、钥匙串）。
- 不用 `--no-verify`、`push --force`。
- 改 `.githooks/`、`.github/workflows/`、`scripts/check.sh`、`scripts/ci/`、发布脚本时，只开 PR（`scripts/pr.sh --no-merge`），由维护者审阅后合并。
- 无人值守任务一律 `scripts/pr.sh --no-merge`。

## 命令

- 门禁：`scripts/check.sh`（`--quick` 只跑通用检查）
- 初始化：`scripts/bootstrap.sh`
- 开 PR：`scripts/pr.sh`（`--no-merge` 只开不合并）
- 本地运行：`pnpm dev`（后端 18920，管理界面 5173）
- 单项检查：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`

## 目录与约定

| 路径 | 内容 |
|---|---|
| `scripts/check.sh` | 唯一门禁入口，本地与 CI 行为一致 |
| `scripts/ci/` | 只被 CI 调用的小脚本 |
| `docs/design.md` | 总体设计：12 张扁平表、在场引擎、托管凭据、接入协议、界面用语 |
| `docs/plans/` | 计划文档，一个主题一份，持续勾选 |
| `docs/adr/` | 长期决策记录 |
| `apps/server` | 后端。`app.ts` 组装路由，`index.ts` 只负责监听端口；路由按资源放 `routes/`，运维命令入口在 `cli/ctl.ts`（仅含 `status`） |
| `apps/web` | 管理界面。页面放 `pages/`，外壳在 `layouts/ConsoleLayout.vue`，基础 UI 原语放 `components/ui/`；后端调用集中在 `api/endpoints.ts`（响应按 contracts schema 校验）；服务端状态用 TanStack Query，全局一个 `queryClient`（`query.ts`）；图标登记在 `icons.ts` |
| `packages/contracts` | 只放 zod schema 与纯工具函数，不放服务端/前端实现；后端路由和前端解析都从这里取 |

- workspace 包以 TS 源码互相引用（`exports` 指向 `src/`），后端用 tsdown 打包时一并打进产物。原因：省掉各包单独构建的步骤。
- 依赖版本写死、不加 `^`。pnpm 默认拒绝发布不足一天的新版本，遇到时换前一个版本，不要加 `minimumReleaseAgeExclude`。原因：给被投毒的包留出被发现的时间。
- 本仓不含 `sdks/python`、测试台、Bitwarden 密码库接入、AstrBot 群聊机器人或对象存储定时备份；数据导入导出（含可选口令加密凭据与外部 Lore 两步导入）集中在 `apps/server/src/transfer/`、`routes/transfer.ts` 与 `apps/web/src/components/DataTransferPanel.vue`。插件与命令行工具维护在 [kioku-plugins](https://github.com/lonelyman0108/kioku-plugins)：改生命周期输出格式（`POST /v1/lifecycle/event`）、浏览器授权（`/v1/device/*`）、`GET /v1/whoami` 或 `kioku run` 依赖的凭据取值接口（`POST /v1/credentials/resolve`，含 `field` 与 `expired` 字段）时，必须保持与插件仓库兼容或同步修改。
- 管理界面的 `typecheck` 先跑一次 `vite build`：Nuxt UI 的 Vite 插件在构建时才生成 `auto-imports.d.ts`、`components.d.ts`，没有它们 vue-tsc 会报找不到组件。

## 管理界面的设计与文案

改界面时遵守这一节；术语对照与禁用规则见 `docs/design.md`「界面用语」。

- 样式变量只在两处：`apps/web/src/assets/css/main.css`（纸墨色板、`brick`/`ochre`/`moss`/`lake` 语义色阶、系统字体栈，浅色深色各一套，映射到 Nuxt UI 变量）和 `apps/web/src/theme.ts`（组件 slot 的全局覆盖）。页面与组件里不写颜色值和字体名。不再存在旧版 6×4 地层色带与敏感级纹理，`tokens.test.ts` 会核对对比度、零圆角、零阴影，并断言已移除 `--layer-*`、`--access-*`、`--strata-*`。
- 砖红（Nuxt UI 的 `error`）是唯一的强调色，只给告警、角标计数和破坏性操作。零圆角，层次全靠 1px 墨线（`--ui-rule`）与次级细线，不用阴影（`main.css` 将 `--ui-radius` 设为 `0rem` 并清空 `--shadow-*`）。
- 只用系统字体栈，不打包字体、不向第三方请求字体；logo（`KiokuMark.vue` 与 `public/` 下图标）只取 Shippori Mincho 字形轮廓写成路径，来源与许可证登记在 `NOTICE`。正文不小于 14px，标签不小于 12px；短 ID `m-xxxxxx`、凭据标识、访问密钥前缀与代码用等宽字；数字用正文字体加 `tabular-nums`。
- 图标只用 lucide 一套，全部登记在 `apps/web/src/icons.ts`（构建时打包，避免运行时请求公共 Iconify）；导航、设置标签、操作按钮的图标旁一定配文字，不只留图标。
- 3+1 主导航（`layouts/ConsoleLayout.vue` 与 `routes.ts`）：`记忆`（`/memories`，左侧列表筛选 + 右侧 Markdown 编辑器、版本历史抽屉与双链面板）、`待处理`（`/inbox`，整理建议审核）、`凭据`（`/credentials`，加密托管凭据管理）、`设置`（`/settings/:tab?`，`keys` 连接与终端 / `models` 模型 / `account` 账号与数据三标签）。通用原语集中在 `apps/web/src/components/ui/`（`EmptyState`、`EntryFrame`、`NoteLine`、`PageHead`、`PropertyList`、`ReadFailureNote`、`SaveBar`、`SectionHeading`、`ShortIdLine`）。
- 正文编辑接入 `apps/web/src/secretHint.ts`（`detectSecretPrefixes`），在浏览器本地做轻量常见明文前缀提醒，只提示、不阻断保存。
- 一次性访问密钥明文弹窗（`IssueKeyModal.vue`、`KeysSettings.vue` 轮换弹窗）展示期间设 `dismissible: false`、`close: false`，只能点确认关闭；凭据明文查看（`CredentialsPage.vue`）只放组件局部 `ref`，关闭立即清空，绝不进入 TanStack Query 缓存。
- 跳过登录检查的页面只有 `/setup`、`/database-unavailable`、`/login` 与 `/unavailable`；`/authorize` 须登录后访问，确认码只从输入框经请求体提交、不进 URL 查询参数，批准按钮不放在 `<form>` 内（防误回车签发）。退出当前设备一律走 `useLogout`（统一处理未保存确认与清缓存）；不可逆确认用 `ConsequenceModal`（不用 `<form>`）。
- 文案不把代码逻辑翻成大白话，不讲权限逻辑（不写「读得到」「读不到」），不用第二人称（「你」），量词用「个」「条」（访问密钥用「个」不用「把」）；禁用词与产品用语由 `apps/web/src/__tests__/copyRules.test.ts` 扫描全部 `.vue`、`.ts` 核对，新增规则同步更新该测试与 `docs/design.md`「界面用语」。

## 已知的坑

- typescript-eslint 8 只支持 TypeScript 6.0 以下，所以 TypeScript 固定在 6.0，不升到 7。
- tsdown 产物是 `dist/index.mjs` 和 `dist/ctl.mjs`（不是 `.js`）。版本、提交与构建时间在打包时经 `tsdown --config-loader tsx` 写进产物（`tsdown.config.ts` 与 `src/buildInfo.ts`），镜像取构建参数 `KIOKU_VERSION`、`KIOKU_COMMIT`、`KIOKU_BUILD_TIME`，本地取 git，运行时不读这几个环境变量。
- 管理界面 tsconfig 关闭了 `exactOptionalPropertyTypes`（Nuxt UI props 类型不兼容），服务端保持开启；`useToast` 等组合式函数显式从 `@nuxt/ui/composables` 导入。页面与组件的 scoped 样式不在 CSS layer 里、会压过 Tailwind 工具类：不要用与工具类同名的类名，窄屏显隐写在 scoped 媒体查询里，flex 容器内 SVG 图标显式设 `display: inline-block`。
- **扁平 12 表，无行级安全（RLS）**：核心表为 `accounts`、`sessions`、`settings`、`api_keys`、`device_grants`、`entries`、`entry_embeddings`、`entry_links`、`entry_events`、`credentials`、`turn_buffer`、`dream_suggestions`。单人自托管不启用 RLS，数据库普通角色与超级用户均可接入（`db/probe.ts` 只检查连通性、`vector`/`zhparser` 扩展与迁移基线）。当前基线迁移为 `0000_baseline`（`migrations/meta/_journal.json` 中 `when = 1796000000000`，高于旧版时间戳以便 `db/migrate.ts` 拦截旧库并报 `pre_baseline`）；迁移文件合并后不可修改。
- **权限边界必须 JS 与 SQL 同步**（`access/scope.ts`）：`canReadEntry` / `readableEntrySql` 与 `canAccessCredential` / `credentialRealmConditionSql` 改一边必须改另一边（`scope.int.test.ts` 逐条交叉校验）。`api_keys.allowed_realms` 是硬边界：对词条而言，`null` 放行全部，非 `null` 放行无场域通用词条或有交集词条；对凭据而言**失败即拒绝（fail-closed）**——必须 `can_resolve_credentials = true`，且当密钥限定 `allowed_realms` 时，未限定场域的凭据（`credentials.allowed_realms` 为 `null` 或空）一律拒绝，必须与密钥场域有非空交集。
- **在场引擎**（`recall/boot.ts`、`recall/recall.ts`）：`boot` 编译 `kind = 'entry' AND boot_mode <> 'none'`（`boot_mode: 'none' | 'index' | 'full'`，数据库约束与 `is_pinned` 强同步）且通过 `matchesBootScene` 去冲突的词条，默认 7,000 字全文展开预算（按项目/客户端 > 环境/场域 > 全局且全局 ≤ 50% 分桶）+ 3,000 字独立目录槽（`index` 永不抢占全文预算），`api_keys.focus_realms` 仅作启动聚焦、不放宽 `allowed_realms` 安全边界，并附同 `(device_key, project_slug)` 最近 3 条 `episode` 摘要（单行参考，非指令）。`recall` 融合 1024 维 pgvector HNSW（`hnsw.ef_search = 200`、`hnsw.iterative_scan = relaxed_order`）与 `kioku_zh` BM25（嵌入不可用或超时自动降级纯全文），基础分达到 `RELEVANCE_FLOOR`（0.15）后叠加场景亲和分（`computeSceneDelta`），再对过阈值种子做 1 跳双向 `entry_links` 扩散（`LINK_DECAY = 0.55`，受 `readableEntrySql` 与 `hasExclusiveSceneConflict` 过滤）。
- **扁平词条与双链**：短 ID `m-xxxxxx`（无歧义 Base30 6–8 位）全实例全局唯一（含软删除行）；写入时同步计算 `entries.search_tags`，确保生成的 `fts` 列只调用不可变函数；词条正文全部明文存储、不含机密加密列，秘密统一放 `credentials` 并通过 `{{cred:<slug>}}` 或 `{{cred:<slug>#<field>}}` 引用。
- **极简托管凭据与启动同步主密钥轮换**（`credential/service.ts`、`crypto/rotation.ts`）：AES-256-GCM 信封加密覆盖 `credentials`（`aad = credential:<id>`）与 `settings` 中的模型 API Key（`aad = settings:embedding`、`settings:chat_llm`）。`POST /v1/credentials/resolve` 供 `kioku run` 一次性原子取值（`Cache-Control: no-store`，`field` 可选，优先匹配 `<slug>-<field>` 或 `fields[field]` 再回退主值 `value`，响应保持 `{ values, expired: [] }`）。`startService` 启动时同步执行 `prepareMasterKey`：校验全部密文，配置了 `KIOKU_MASTER_KEY_PREVIOUS` 时同步完成重封（无后台轮换队列），解不开时抛 `FatalStartupError` 拒绝启动。
- **后台任务与自动整理**（`jobs/queue.ts`、`extraction/`、`models/client.ts`）：共 5 个 pg-boss 队列（`embed-entry`、`embed-backfill`、`extract-episode`、`dream`、`cleanup-expired`）。对话模型支持思考等级 `reasoningEffort`（`default` 不注入字段）与 `fast`/`organize` 按任务覆盖，并由 `ModelClientError` 执行分层重试。`turn.end` 按 `(device_key, project_slug)` 缓冲至 `turn_buffer`（跳过 `cron`/`subagent` 与只读密钥），满 10 轮立即触发或空闲 10 分钟触发摘要抽取；`dream` 支持 `standard` / `tidy` / `cross_memory`（四阶段漏斗跨记忆整理），共生成 7 类待处理建议（`distill_episode`、`merge_duplicates`、`mark_stale`、`update`、`tidy`、`link_entries`、`adjust_boot_mode`）写入 `dream_suggestions`，不直接改库，经 `EntryService.applySuggestion` 校验版本号与场域/完整性防线后应用（合并重复同时在事务内自动重定向全库反链）；编辑页另提供不占全局 `dream` 锁的 SSE 单条规范与单条查重关联端点。`pgBossSsl` 将 `sslmode=require` 换算为 `{ rejectUnauthorized: false }`，避免 node-postgres 把它当 verify-full。
- **数据库状态与初始化**（`runtime.ts`、`service.ts`、`db/probe.ts`、`dataDir.ts`）：`missing`、`unavailable`、`ready` 统一经 `startService` 启动。瞬时连接故障进入 `unavailable` 并退避重试（5 秒起至 60 秒，`/v1/health` 回 503、不开初始化码）；缺扩展、旧架构库结构、未知新迁移、主密钥不匹配抛 `FatalStartupError` 退出。连接读取顺序为 `DATABASE_URL` 优先、其次 `KIOKU_DATA_DIR/kioku.json`；`postgresOptions` 不发额外启动参数（兼容 PgBouncer），探测在只读事务内 `set local statement_timeout`。初始化码有 130 位熵、按客户端限流、不另要同源请求头（支持脚本化初始化）。
- **认证防护与浏览器授权**（`auth/`、`routes/device.ts`）：反代后部署须配 `KIOKU_TRUSTED_PROXIES`（从 `X-Forwarded-For` 右侧数）并设 `KIOKU_BIND=127.0.0.1`。登录限流在内存维护（`auth/rateLimit.ts`，15 分钟内每客户端 10 次、每用户名合计 30 次；路径 `/v1/auth` 下绑定密码哈希指纹的签名设备 Cookie `kioku_device` 可越过合计上限），随后进入 scrypt 并发闸门（`auth/passwordGate.ts`，全局 4 并发 + 32 排队、单客户端 2 个，不存在用户名仅占本客户端名额）。浏览器授权（`device_grants`）采用**惰性签发**：审批仅保存透镜配置并设 60 秒取走窗，命令行轮询 `POST /v1/device/token` 时锁行生成 `api_keys` 并立即删除申请行，明文不落库、不经浏览器；过期与轮询间隔一律在 SQL 中与 `now()` 比较。
- **统一数据库时钟**：有效期与更新时间比较统一用 `withTx` 事务时钟（`nowOf(tx)` / `transactionMoment`）与 `databaseNow(db)`，不与 JS `Date.now()` 混用。
- **集成测试**：依赖 `KIOKU_TEST_DATABASE_URL`（本地 `docker compose -f docker-compose.dev.yml up -d --build` 后设为 `postgres://kioku:kioku@localhost:55432/kioku`；未设时本地跳过、CI 失败；CI 通过 `KIOKU_TEST_DATABASE_WORKERS=3` 与 `scripts/ci/test-db.sh` 分库并行）。`resetDatabase` 会清空全部业务表并重置内存登录限流。跑集成测试时不要同时开着连同一库的本地服务（pg-boss 会抢任务）。
- 服务端启动时只读一次管理界面的 `index.html`，本地重新构建 `apps/web` 后须重启服务。Mac 非交互 shell 拉镜像用不带 `credsStore` 的 `DOCKER_CONFIG`。
