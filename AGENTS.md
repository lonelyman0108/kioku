# Kioku

多账号、多人格、记忆圈与多维切面授权的长期记忆服务。TypeScript monorepo：后端 Node 22 + Hono + Drizzle + PostgreSQL（pgvector、zhparser）+ pg-boss，管理界面 Vue 3 + Nuxt UI 4（纯 Vue SPA，由后端托管）。

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
- Python（`sdks/python` 里执行）：`uv run pytest`、`uv run ruff check .`、`uv run ruff format --check .`

## 目录与约定

| 路径 | 内容 |
|---|---|
| `scripts/check.sh` | 唯一门禁入口，本地与 CI 行为一致 |
| `scripts/ci/` | 只被 CI 调用的小脚本 |
| `docs/design.md` | 总体设计：数据模型、分层与授权、接入协议、界面用语 |
| `docs/plans/` | 计划文档，一个主题一份，持续勾选 |
| `docs/adr/` | 长期决策记录 |
| `apps/server` | 后端。`app.ts` 组装路由，`index.ts` 只负责监听端口；路由按资源放 `routes/` |
| `apps/web` | 管理界面。页面放 `pages/`，布局放 `layouts/`；后端调用集中在 `api/endpoints.ts`（响应按 contracts 的 schema 校验）；服务端状态用 TanStack Query，全局一个 `queryClient`（`query.ts`）；界面用到的图标都登记在 `icons.ts` |
| `packages/contracts` | 只放 zod schema 与推出的类型，不放实现；后端路由和前端解析都从这里取 |

- workspace 包以 TS 源码互相引用（`exports` 指向 `src/`），后端用 tsdown 打包时一并打进产物。原因：省掉各包单独构建的步骤。
- 依赖版本写死、不加 `^`。pnpm 默认拒绝发布不足一天的新版本，遇到时换前一个版本，不要加 `minimumReleaseAgeExclude`。原因：给被投毒的包留出被发现的时间。
- `sdks/python` 由服务端的 OpenAPI 生成：改了应用调用的接口（Key 鉴权的生命周期、召回、启动加载、记忆、whoami）或它们用到的契约后，跑 `sdks/python/generate.sh`，生成的改动一起提交；门禁会重新生成并比对。合并之后到插件仓库 [kioku-plugins](https://github.com/lonelyman0108/kioku-plugins) 用 `scripts/sync-client.sh` 同步一份给 AstrBot 插件。原因：AstrBot 插件用它，接口变了 SDK 没跟上时要到运行时才出错。插件（Claude Code、AstrBot）都在那个仓库里，改生命周期事件的输出格式时要同步看那边的钩子。取值接口（`POST /v1/credentials/resolve`）不进 SDK，Claude Code 插件的 `kioku run` 自己解析它的响应（`lib/kioku.mjs`），改它的响应（例如 `expired`）要在插件仓库同步改。
- 管理界面的 `typecheck` 先跑一次 `vite build`：Nuxt UI 的 Vite 插件在构建时才生成 `auto-imports.d.ts`、`components.d.ts`，没有它们 vue-tsc 会报找不到组件。

## 管理界面的设计与文案

改界面时遵守这一节；新旧术语对照与每个词的含义见 `docs/design.md`「界面用语」。

- 样式变量只在两处：`apps/web/src/assets/css/main.css`（纸、墨、归属色、纹理色、字体栈，浅色深色各一套，映射到 Nuxt UI 的变量）和 `apps/web/src/theme.ts`（组件 slot 的全局覆盖）；归属与敏感级的编码计算集中在 `apps/web/src/components/strata/strata.ts`。页面里不写颜色值和字体名。原因：两套主题要一起换；`tokens.test.ts` 核对这些变量（对比度、圆角归零、色阶、权限格子的明度差等），页面里写死的值它查不到。
- 颜色表示形态与来源范围，纹理表示敏感级：六个地层色带（`--layer-*`、`--access-*`）的纵向顺序固定，自上而下会话摘要、联系人事实、个人圈词条、关联共享客场词条、独立人格、主场圈正式词条（`STACK` / `STRATA_BANDS`）；来自对话的两类用虚线和下面四类隔开。公开无纹理、内部圆点、私密斜线、机密实心深色，图案只用 `StrataPatterns.vue` 那一套。原因：两个维度各占一种视觉通道，叠在一起也分得开；地层柱、窄柱、词条清单与权限范围是同一个顺序，一处学会处处读得懂。
- 颜色不单独承担信息：色块旁要有文字（归属或分类名、状态），或者靠固定的位置表达；敏感级靠纹理，不用告警色。原因：色觉差异的人分不清六个低饱和的色带。
- 砖红（Nuxt UI 的 `error`）是唯一的强调色，只给告警和破坏性操作。原因：红色一多，真正的告警就不显眼了。
- 零圆角，层次用线不用阴影：结构线是 1px 墨线，次级线浅灰；`main.css` 把 `--ui-radius` 设为 0、清空了整组 `--shadow-*`。原因：维护者选定的「地层」方向靠线条与色带分层次，圆角和阴影会打散它。
- 只用系统字体栈，不打包字体、不向第三方请求字体；logo（`KiokuMark.vue`，`public/` 下的图标同款）只取 Shippori Mincho 的字形轮廓写成路径，来源与许可证登记在 `NOTICE`。原因：自托管服务不向第三方发请求，中文字体文件也太大。
- 正文不小于 14px，标签不小于 12px；短 ID `m-xxxxxx`、旧坐标、访问密钥前缀、代码用等宽字。原因：更小的中文看不清；短 ID 与前缀要能逐字核对。
- 图标只用 lucide 一套，登记在 `icons.ts`：导航、设置小节、操作类型、状态标签配图标，图标旁一定有文字；顶栏放不下时先收组标题、再收图标，不只留图标。状态标签的图标从 `components/strata/flags.ts` 取。大号数字用正文字体加 `tabular-nums`，不用等宽字。原因：图标帮着扫读，只剩图标时意思要靠猜；等宽字只留给要逐字核对的短 ID、前缀与代码。
- 三个以上并列的事实写成表格、属性列表或标签，不写成一整句：主密钥轮换按数据类别列条数；签发范围只经 `ScopeTags`（`scopeTags`）显示，`scopesSummary` 只是标签拼起来的文字，给读屏与 `title` 用。原因：长句在窄列里会断开（「最高内 / 部」），也不好扫读。
- 列表的空状态用 `EmptyState`（品牌标记、一句结果、下一步），只在确实读到空时显示，读取失败照标准错误条的写法。
- 一次性显示的秘密（访问密钥的明文、设置密码链接）显示期间弹窗不能点遮罩、按 Esc 或右上角关掉，只能点确认（`PasswordLinkOnce` 照签发访问密钥的做法）。跳过登录检查的页面只有登录、初始化、`/password/:token`（拿链接设密码的人还没有会话）与 `/database-unavailable`（数据库连不上时会话查不了，页面只显示来源与原因类别、不给初始化码，接上后回到原页面，由守卫重新走登录检查）。退出当前设备一律走 `useLogout`（和账号菜单的退出同一个流程：未保存确认、清缓存），不直接调删会话的接口。账号状态只经 `accountStates`、`accountStateText` 判断与显示。
- 不可逆的确认用 `ConsequenceModal`（标题写结果，逐条写影响，按钮写动作，不用 `<form>`）；删除记忆圈用 `DeleteSpaceModal`，记忆圈名逐字对上才能删。成员变动的后果文案只在 `spaces.ts` 一处，天数取契约的 `DEPARTURE_RETENTION_DAYS`。离开或删除记忆圈之后统一经 `useAfterCircleGone` 跳转并刷新会话里的记忆圈列表，不再询问未保存的改动。
- 设置是一个入口：小节集中登记在 `settingsSections.ts` 的 `SETTINGS_SECTIONS`（个人 / 记忆圈 / 实例三组），加小节只加一项和一个组件。个人圈隐藏成员页。不带记忆圈的设置组用 `useSession` 记下的最近访问记忆圈（`rememberCircle`，退出或失效时 `forgetCircle` 清掉），不退回第一个记忆圈。小节组件用 `v-model:dirty` 报改动，数值设置用 `SettingsRow` + `SaveBar` + `useSavedField`。旧的 `?section=` 由 `LEGACY_*` 两张表重定向。
- 记忆给人看的名字是标题，配不可变短 ID（`m-xxxxxx`）；支持按记忆圈、场域、环境、主题、物种动态分组浏览，右侧详情以通用/各切面变体切片标签页对比编辑，支持正文 `[[m-xxxxxx]]` 双链补全与点击跳转，不要求先编造 URL 路径；旧坐标只留在兜底展示、测试台、召回调试与 Lore 迁移映射里。
- 文案不把代码逻辑翻成大白话：标题、标签、按钮、空状态用名词短语或短词（「暂无访问密钥」，不是「还没有访问密钥。」），完整的句子才加句号；默认一句话，只讲结果和下一步，原理、规则和例外放进提示层（`Hint.vue`）或展开，信息不能丢。
- 不把权限逻辑讲一遍：不写「读得到的」「只给…看」，范围说明放在提示层；不用第二人称，确实要指操作者时写「当前账号」。
- 口语换成产品用语（疑似、从未、无法删除、不可用、失败、占用、超出、获取、查看），英文说法换成中文（访问密钥、整理、群聊机器人、令牌；JSON、MCP、Agent、产品名、模型用量的 token 保留），量词用「个」「条」，访问密钥不用「把」；不再出现分区、层（除地层视觉外）、情节、个人画像、私人层、基础等旧术语；URI 只留在测试台、召回调试与「Lore 的 URI」。`apps/web/src/__tests__/copyRules.test.ts` 扫全部 `.vue`、`.ts` 核对禁用词，新增说法规则同时加进它与 `docs/design.md`「界面用语」。

## 已知的坑

- typescript-eslint 8 只支持 TypeScript 6.0 以下，所以 TypeScript 固定在 6.0，不升到 7。
- tsdown 产物是 `dist/index.mjs`，不是 `.js`。
- 版本、提交与构建时间在打包时写进产物（`tsdown.config.ts` 的 define，规则在 `src/buildInfo.ts`）：镜像取 Dockerfile 的构建参数 `KIOKU_VERSION`、`KIOKU_COMMIT`、`KIOKU_BUILD_TIME`，本地取 git；直接跑源码（`pnpm dev`、测试）时现取 git。运行时不读这几个环境变量。`buildInfo.ts` 引用 contracts 的源码，原生的配置加载器解析不了不带扩展名的导入，所以 build 脚本是 `tsdown --config-loader tsx`。OpenAPI 的 `info.version` 跟着变，`filter_openapi.py` 把 SDK 里的固定成 `dev`。原因：版本不能靠部署的人手填。
- 检查新版本（`settings/updateCheck.ts`）请求的是写死的第三方地址（GitHub），不是管理员配置的服务：默认关闭；打开后成功之后隔一天、失败或没完成隔一小时再查，从关到开时马上可以再查（间隔按数据库的钟在 SQL 里判断，到了间隔才用一条带条件的 update 占位，几个进程也只请求一次）；当前不是正式版时不请求；请求在后台跑，接口不等 GitHub，测试清库前经 `settleUpdateChecks` 等它写完；失败只记日志，超时与连不上分开说。原因：自托管服务默认不向第三方发请求；再加这类请求照这个做，开关旁写明发往哪里。
- 管理界面用到新图标时必须加进 `apps/web/src/icons.ts`：构建时只打包这份清单里的图标，没列进来的会在运行时向公共 Iconify 接口请求。原因：自托管服务不应向第三方发请求。
- 管理界面的 tsconfig 关掉了 `exactOptionalPropertyTypes`（组件库的 props 类型不兼容），服务端保持开启。
- 页面和组件的 scoped 样式不在 layer 里，压过 Tailwind 的工具类（工具类都在 layer 里）：元素上 scoped 写了 `display` 时，`max-lg:hidden` 这类类名不生效，窄屏的显隐写在 scoped 的媒体查询里。反过来，组件里不要用和工具类同名的类名（`fixed`、`hidden` 等）：Tailwind 会把它当成工具类生效。flex 容器里的图标要写 `display: inline-block`（preflight 把 svg 设成 block，图标会自己占一行）。
- 记忆页的统计（窄柱、列表上方的总数）来自概览接口，写入时仅在 `statsChanged` 认为动了统计时刷新。记忆的新建、移动/迁移弹窗不用 `<form>` 隐式提交。
- `useToast` 等 Nuxt UI 组合式函数显式从 `@nuxt/ui/composables` 导入，不依赖自动导入。
- 内容表（带非空 `circle_id`、在 `RLS_TABLES` 里的 31 张表）只能在 `withCircles(db, { read, write }, ...)` 里访问（读写双会话变量 `app.read_circles` 与 `app.write_circles`），否则 RLS 让查询返回空、写入失败；最外层写作用域结束前立即校验延迟外键 `entry_variants_state_fk`。新增内容表时同时加进 `RLS_TABLES` 和迁移里的策略，`rls.int.test.ts` 会核对两者一致。
- 集成测试需要 `KIOKU_TEST_DATABASE_URL`：本地 `docker compose -f docker-compose.dev.yml up -d --build` 后设为 `postgres://kioku:kioku@localhost:55432/kioku`；没设置时跳过，CI 里没设置直接失败。测试会清空整个库，所以同一个库上的测试文件串行。CI 里还设 `KIOKU_TEST_DATABASE_WORKERS=3`：测试文件按 3 个 worker 并行，每个 worker 连 `<库名>_w<编号>`，这几个库由 `scripts/ci/test-db.sh` 用超级用户从 `kioku` 复制出来（应用角色不能建库）；本地不设就是串行，要并行先自己建好这几个库。原因：串行时服务端测试要 8 分钟。CI 里测试库和服务端镜像都在后台构建（`scripts/ci/background.sh`），和静态检查同时进行：服务端测试开始前由 globalSetup 按 `KIOKU_TEST_DATABASE_READY` 等测试库，镜像到冒烟那一步再等。所以测试不能依赖整个实例的状态：查 `pg_stat_activity` 要限定在本库或被自己阻塞的连接上，监听端口用 0，临时文件用 `mkdtemp`。同一个库上先跑哪个文件每次都不一样，所以 `openTestDatabase` 会清空实例设置（`settings`，`resetDatabase` 清不到），文件要用的设置在 `beforeAll` 里自己写。
- 读权限的规则有两份：`access/access.ts` 的 `canRead`（单条判断）和 `memory/filter.ts` 的 `readableConditions`（SQL，含 `snapshotColumns`、`realms` 静态双向锁与 `sharedGroupScopes` 跨群开关）。改一边必须改另一边，`filter.int.test.ts` 会逐条比对（两边传同一个时刻，见下面「有效期与更新时间只用数据库的钟」）。
- 变更记录的列表、按天计数与筛选计数共用 `activityEvents` 子查询，可见性（`eventVisibility`）只在里面算一次；改动字段规则 `changedFields` / `changedFieldsSql`（`memory/activity.ts`）两边须保持一致。
- 启动加载（`boot`）只收受信正式词条（`BOOT_ELIGIBLE`、`BOOT_CANDIDATE` / `isBootCandidate`），渲染合并后独立人格，剥离互斥切片、同词条无冲突切片编译合并，并按整条原子预算裁决；关联个人圈未标 `realm` 且最高优先级非机密词条可穿透加载。近期本群/本会话摘要经 `inlineText` 压成单行参考（非指令）。
- 词条短 ID（`m-xxxxxx` Base30）全实例全局唯一（含已软删除行）；多切面变体按规范化 `when_signature` 去重，机密词条下禁止同词条多变体带不同 `when.realm`。正文 `[[m-xxxxxx]]` 出链由 `entry_links` 按源变体切片维护，机密与未确认来源不建出链。旧 URI 坐标通过 `legacy_uris` 表按 `(circle_id, legacy_uri)` 兜底兼容 `kioku_get` 检索。
- 接入实例（`clients`）是访问密钥主场圈、所有者、默认人格与群规则（`client_group_rules`）的真源；访问密钥作用于 1 个主场圈与 N 个关联客场圈（`linked_circles`），有效上限受成员角色（`clampScopesToRole`）、停用状态（`disabledAt`）、静态 `allowedRealms` + `context_facets` 双向场域锁、会话上下文及 `personMemoryMode`（`strict` / `persona_shared`）与单群隔离锁（`isolateGroupMemory`）逐层收紧。
- 凭证与密码库连接统一归属成员个人圈，凭据占位符 `{{cred:<标识>}}` 仅允许个人圈正式词条私密及以上敏感级（`placeholderAllowed`）。加密 AAD：`variant:<切片id>`（`entry_variants`）、`credential:<凭据id>`（`credentials`）、`vault-connection:<连接id>`（`vault_connections`）；主密钥轮换（`crypto/rotation.ts`）须同步覆盖这三张表及加密设置项。
- 写入前疑似明文拦截只在 `EntryService.create`、`update` 等正式入口执行，转存凭据时同步清洗 `entry_events` 历史快照（`scrubSnapshot`）；机密词条正文仅在显式查看时解密且不进 `useQuery` 缓存。
- 硬删除记忆清理时保留 Lore 导入事件（`source = 'lore'`，抹空 `entry_id` 并保留 `legacyUri` 等去重信息），防止下次同步回写已删节点（`jobs/retention.ts`）。
- 记忆圈导出包使用 `KIOKUCX2` 格式（遇碰撞短 ID 静默分配并流式重写双链）；旧版 Kioku 迁移走 `kioku-ctl migrate-legacy`（`--from-db` / `--backup` / `--space-export`），旧机密按原记忆 UUID 解封并用新切片 AAD 重封。
- 服务的数据库状态在 `runtime.ts`：missing（没配数据库，只挂 `createSetupApp`：健康检查、初始化的状态与数据库这一步、管理界面，其余 `/v1` 回 503 带 `DATABASE_UNAVAILABLE_CODE`）、unavailable（配了却暂时连不上，同样只挂 `createSetupApp`，但不当作要初始化、不开初始化码，`/v1/health` 回 503，按退避重试）、ready（`startService` 起的完整服务，冷启动、重试与初始化页接入共用它，不要另写一份）。只有连接类的问题进 unavailable；角色绕过行级安全、缺扩展、库的结构用不了、主密钥对不上抛 `FatalStartupError` 拒绝启动。接入分准备（会失败，抛 `ActivationError`，起到一半的关掉）与切换（只有同步的赋值，不会失败）：调用方只在 `ActivationError` 时回滚（例如删掉代建的库），别的错误按已经切换算。数据库连接的读取顺序（环境变量优先，其次 `KIOKU_DATA_DIR` 下的 `kioku.json`）只在 `dataDir.ts` 的 `resolveDatabaseUrl`，命令行工具经 `cli/common.ts` 的 `databaseUrlOf`；postgres.js 的选项只在 `db/client.ts` 的 `postgresOptions`，检查用的连接不发额外的启动参数（PgBouncer 会拒绝），语句时限在只读事务里 `set local`。拦住接入的问题只在 `db/probe.ts` 的 `assess` 里算（`problems`），日志与界面的检查行都按它写。初始化码（`auth/setupCode.ts`）随机 130 位熵，失败计数在内存里、只按客户端，不设全实例合计（谁都能刷满）。初始化的接口靠初始化码保护，不另要同源请求头（脚本化初始化要用）。检查与代建给人看的只有类别（`failureOf`），日志只记 code。pg-boss 用的 node-postgres 把 `sslmode=require` 当 verify-full，`forNodePostgres` 换成 no-verify，和 postgres.js 一致。原因：初始化页对外开着，报错里的地址与驱动说明会泄露内网信息；把暂时连不上当成要初始化，已经初始化的实例会被别人重新初始化。
- 过期的会话与登录失败计数由后台定时任务每小时清理（`jobs/cleanup.ts`）。清理登录计数时跳过被锁住的行：登录的计数事务按「本客户端 → 合计」的顺序加锁，按别的顺序等锁会互相等待成死锁。
- 机密（`secret`）只加密正文：短 ID（`m-xxxxxx`）、标题、触发场景（`disclosure`）、关键词仍是明文（目录浏览、列表与召回线索要用），不要把需要保密的内容写进这些字段，明确给的标题照旧是明文。没填标题时机密取短 ID，不从正文的 `#` 标题取（`deriveEntryTitle`）；结果是机密的写入（新建、修改、提权、恢复此版本），标题等于明文正文任一变体首个 `#` 标题时一律换成短 ID，改成机密时还经 `markdownHeadingsOf` 比对历史里的每一版正文，`scrubEntryHistoryForSecret` / `scrubSnapshotForSecret` 把快照里这种标题一起换掉，恢复此版本就带不回来。取 `#` 标题的规则只有 `@kioku/contracts` 的 `firstMarkdownHeading` 一份。原因：标题是从正文取的话，正文加密、历史抹掉之后它还以明文留在标题列、全文检索与历史快照里。
- 部署在反向代理后面时要设 `KIOKU_TRUSTED_PROXIES=<受信代理层数>`，登录限流才能按真实客户端区分；客户端地址从 `X-Forwarded-For` 右边数，最左边的项由请求方填写、可以伪造。不在代理后面时保持 0。没配置受信代理时一律按连接对端区分客户端，请求头不能改变限流行为。 配置了受信代理时，后端端口不能对外直连，否则直连请求可以自己填 `X-Forwarded-For`。
- 登录防护的顺序：先计数（同一用户名 + 客户端 5 次、同一用户名合计 50 次，IPv6 按 /64 计为一个客户端；计数键用 JSON 数组编码，后一级超限时退回前一级）→ 进入 scrypt 并发闸门（全局 4 个运行 + 32 个排队，每个客户端 2 个；繁忙时退回计数）→ 用户名不存在时同样过闸门、占本客户端的名额，但不占全局名额，也不跑 scrypt，等一次校验的时长 → 成功清掉本客户端的计数，并退回这次在合计里占的名额（别人的失败不清）。登录成功下发设备 Cookie（`kioku_device`，服务端签名、绑定当前密码指纹、180 天），带着它不受合计上限约束，改密码后失效。原因：账号存在与否在计数、闸门繁忙、返回内容上表现一致，不能借此探出账号；随机用户名耗不了 CPU、挤不满全局名额；合计上限挡分布式猜测，设备 Cookie 让账号本人不被它锁住。
- 本地跑集成测试时不要同时开着连同一个数据库的本地服务：服务的 pg-boss 进程会抢走测试的后台任务，导致向量相关的用例超时。
- 迁移里要改 FORCE RLS 的表（`RLS_TABLES`）时，迁移连接没有设置 `app.read_circles` / `app.write_circles`，UPDATE / DELETE 会被策略过滤成零行而不报错；需要先 `NO FORCE`、改完再 `FORCE`。drizzle 把所有待执行的迁移放在一个事务里，中途失败会整体回滚。
- 停用的账号、还没设密码的账号登录时和密码错误走同一条路（计数、经全局闸门跑真的 scrypt、不清计数），只在 `verifyGuarded` 里实现，登录与改密码共用，不要拆开。原因：账号状态不能从回应、耗时或计数上探出来。
- 一次性链接（`account_links`）只存令牌的哈希，24 小时、只能用一次，同一账号发新链接时作废没用过的；令牌放在请求体里，不放路径（免得进访问日志）；不进全实例备份，过期与用过的由定时清理删。锁的顺序是先链接、后账号。
- 浏览器授权（`routes/device.ts`、`device_grants`，确认页 `AuthorizePage.vue`）：命令行申请，成员在确认页输入确认码后确认，命令行凭设备码取走一次访问密钥。要守住的几条：
  - **签发规则只有一份**：`access/issue.ts` 的 `issueDenial`、`issueClientKey`，管理界面的签发与浏览器授权共用，不在路由里另写。确认页的签发范围同样只用 `KeyScopeEditor` 与 `keyPresets.ts`（收紧是 `tightenScopes`），默认不含凭据能力与机密级（`authorize.ts` 的 `defaultGrantScopes`）。
  - **申请表是身份表**：不进 RLS（申请时还没有记忆圈），也不进全实例备份（`backup/tables.ts` 的排除清单）；设备码与确认码只存哈希，过期的由定时清理删。
  - **取走时再核对**：确认只记下确认人的选择。取走时在 `withCircle` 里再锁一次申请这一行（同时来的两次轮询只有一次拿得到），照签发规则重新核对确认人现在的角色、停用与接入实例所有者，过了才生成访问密钥；不管成不成这一行都删掉。访问密钥的明文不落库，也不经过确认页。
  - **确认码不进地址**：确认页的地址固定是 `/authorize`，确认码只从输入框来、放在请求体里，不支持 `?code=`，回登录页的 `next` 也只带路径。原因：带确认码的链接能让人替别人的申请确认。确认页的「确认」不放在 `<form>` 里，回车不能确认。
  - 确认遇到 404 时可能是申请没了，也可能是选的接入实例没了：页面按确认码再查一次才回第一步，不按报错的文字区分。
  - **取走时的核对与顺序**：在 `withCircle` 里先锁接入实例行、再锁申请行（和删除接入实例的级联同一个顺序，反过来会死锁），然后核对确认人的成员关系：角色、停用、`memberSince` 不晚于 `approvedAt`（确认之后离开过记忆圈的，离开时他的密钥都作废了，不能借没取走的申请留一个），并逐圈复核 `linkedCircles`。新加会让密钥作废的情形时，这里也要跟着核对。
  - **几个平台的申请**：申请存 `platforms`（单平台的存 `runtimeFamily`，两列二选一，取走时按这个决定回旧的 `key`、`client` 还是 `keys`，旧命令行的响应不能多字段），确认的逐项选择存 `selections`。取走时按 id 排序依次锁住所有用到的接入实例，再锁申请行；成员关系核对一次，签发规则与接入实例所有者逐项核对，没过的那一项回 `denied`（原因只用契约的 `DEVICE_KEY_DENIALS`）。只有单平台的申请设 `clientId`（删接入实例时级联删申请，命令行取到过期）；几个平台的不设，删掉一个接入实例不连带别的平台。确认中途要整体作废时抛 `ApproveRefused` 让事务回滚，不要 return：前面几项新建的接入实例会被提交。
  - **时间按数据库的钟比**：过期、轮询间隔都在 SQL 里和 `now()` 比（`timing`），不用 `Date.now()`：这些时间是数据库写的，应用进程的钟差几秒就会一直回 429 或提前判过期。
  - **上限**：先不加锁数一次，满了直接 429，没满才取咨询锁再数、再插入；认不出客户端（`identity.identified` 为假）时不按客户端数。
- 管理员的写操作（新建账号、发链接、改管理员身份或停用）都先经 `lockAsAdmin`：取咨询锁，再在事务里核对调用方仍是可用的管理员，不是就 403；改管理员身份或停用时再数剩下的可用管理员，至少保留一个，不能改自己的。锁的顺序是咨询锁、链接、账号。新加的管理员写接口也用它。原因：刚被停用的管理员已经过了中间件的请求，不能在停用提交之后再发链接、建账号。会话的最近活动最多 5 分钟写一次。设备 Cookie 的路径是 `/v1/auth`，要读它的接口放在 `/v1/auth/*`。
- 测试台回滚模式（`bench/rollback.ts`）下数据库访问统一经传入 `deps` 并在 `withCircles` 中运行；事务退出前 `RollbackRun.clearCircles` 同时清空 `app.read_circles` 与 `app.write_circles`。有效期与更新时间一律以数据库 `nowOf(tx)` / `databaseNow` 为准（不混用 JS `Date.now()`）。
- 整理建议与保留期：后台整理（`extraction/dream.ts`）只产待处理建议不直接改库，经 `EntryService.applySuggestion` 按版本号执行；记忆圈成员离开保留期（`circle_departures`，30 天）由 `jobs/retention.ts` 清理。
- 迁移文件合并后不可修改；当前基线为 `0000_baseline`（旧版升级使用 `kioku-ctl migrate-legacy`）。
- 服务端启动时读一次管理界面的 `index.html`：本地重新构建管理界面后要重启服务。Mac 非交互 shell 拉镜像用不带 credsStore 的 `DOCKER_CONFIG`。
