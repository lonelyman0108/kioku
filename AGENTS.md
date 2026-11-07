# Kioku

多账号、多人格、分层授权的长期记忆服务。TypeScript monorepo：后端 Node 22 + Hono + Drizzle + PostgreSQL（pgvector、zhparser）+ pg-boss，管理界面 Vue 3 + Nuxt UI 4（纯 Vue SPA，由后端托管）。

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

原因：这些操作影响发布、平台或门禁本身，必须由维护者本人执行。

- 不打 tag、不改版本号、不运行不带 `--dry-run` 的发布脚本、不上传、不部署。
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
- 颜色表示归属，纹理表示敏感级：六个归属色（`--layer-<归属>`，权限格子的满色另有一组 `--access-<归属>`）的纵向顺序固定，自上而下会话、联系人、本人、应用、人格、通用（`STACK`），越往下越通用；来自对话的会话、联系人两类用虚线和下面记下的四类隔开。公开无纹理、内部圆点、私密斜线、机密实心深色，图案只用 `StrataPatterns.vue` 那一套。原因：两个维度各占一种视觉通道，叠在一起也分得开；目录、地层柱、岩芯与权限范围是同一个顺序，一处学会处处读得懂。
- 颜色不单独承担信息：色块旁要有文字（归属名、状态），或者靠固定的位置表达（目录里在哪个根下面）；敏感级靠纹理，不用告警色。原因：色觉差异的人分不清六个低饱和的归属色。
- 砖红（Nuxt UI 的 `error`）是唯一的强调色，只给告警和破坏性操作。原因：红色一多，真正的告警就不显眼了。
- 零圆角，层次用线不用阴影：结构线是 1px 墨线，次级线浅灰；`main.css` 把 `--ui-radius` 设为 0、清空了整组 `--shadow-*`。原因：维护者选定的「地层」方向靠线条与色带分层次，圆角和阴影会打散它。
- 只用系统字体栈，不打包字体、不向第三方请求字体；logo（`KiokuMark.vue`，`public/` 下的图标同款）只取 Shippori Mincho 的字形轮廓写成路径，来源与许可证登记在 `NOTICE`。原因：自托管服务不向第三方发请求，中文字体文件也太大。
- 正文不小于 14px，标签不小于 12px；坐标、目录里的位置、访问密钥前缀、代码用等宽字。原因：更小的中文看不清；坐标是地址，要能逐字核对。
- 记忆给人看的名字是标题：目录、列表、搜索、变更记录与启动加载预览都写标题（`MemoryName.vue`，`MemoryRow` 的 `title`），坐标放在悬停里；坐标只在记忆详情底部（`CoordinateLine.vue`，可以复制）、测试台与召回调试里显示，经 `UriPath.vue`（上一级退一级灰度）。人格、应用与四个根的详情底部写坐标的开头。原因：坐标是给 Agent 读写用的，弱化它在界面上的分量；标题才是人认得出的名字。
- 记忆页的目录第一级是本人、应用、人格、通用四个根（`CURATED_STACK`，和地层柱同一个顺序），人格与应用的根下面先列出各个人格、应用，再往下是坐标的各级；选中根、人格、应用时右边是它的设置（地址参数 `node`），选中记忆时是 `uri`。会话与联系人在对话页，不进目录。新建与移动只选归属（人格、应用再选是哪个）、位置与标识，坐标随之拼出、可以折叠（`coordinates.ts`），不单独选归属以外的东西；本人不给公开（契约的 `sensitivityAllowed`）。原因：坐标的开头就是归属，目录、地层柱与坐标是同一个结构。
- 文案不把代码逻辑翻成大白话：标题、标签、按钮、空状态用名词短语或短词（「暂无访问密钥」，不是「还没有访问密钥。」），完整的句子才加句号；默认一句话，只讲结果和下一步，原理、规则和例外放进提示层（`Hint.vue`）或展开，信息不能丢。原因：维护者定的文案方向，界面上的字要短，细节按需展开。
- 不把权限逻辑讲一遍：不写「读得到的」「只给…看」，范围说明全局只说一次、放在提示层：每类归属的适用范围只写在 `strata.ts` 的 `layerHints`，出现在地层柱的说明、色块的悬停与根的标题提示里；不用第二人称，确实要指操作者时写「当前账号」。原因：同一条权限规则在各处换着说法讲，几处的说法会对不上。
- 不可逆操作和安全提示不删后果，只把句式写规范：结果、影响、动作。原因：省掉后果的提示等于没有提示。
- 口语换成产品用语（疑似、从未、无法删除、不可用、失败、占用、超出、获取、查看），英文说法换成中文（访问密钥、整理、群聊机器人、令牌；JSON、MCP、Agent、产品名、模型用量的 token 保留），量词用「个」「条」，访问密钥不用「把」；术语按「界面用语」，英文字段名只留在测试台与接口相关的地方。原因：全站说法统一，文档也照这份写。
- 记忆是谁的写「归属」（会话、联系人、本人、应用、人格、通用），不说「层」；记忆的位置写「坐标」，坐标里开头与标识之间的各级写「位置」，最后一段写「标识」，给人看的名字写「标题」。不再出现分区、情节、个人画像、私人层、基础；URI 只留在测试台、召回调试与「Lore 的 URI」。原因：「层」同时装着归属、可见范围与形态，改版后拆开了，旧说法会把旧模型带回来。
- 界面上 Key 叫访问密钥（签发访问密钥、有效访问密钥、当前访问密钥）。本文件讲代码行为的条目仍写 Key，和 `issueKey`、`api_keys`、Key 鉴权这些标识符对得上。原因：代码里的名字没有跟着界面改，写成访问密钥反而对不上代码。
- `apps/web/src/__tests__/copyRules.test.ts` 扫全部 `.vue`、`.ts` 里的界面文字查禁用词（测试台的组件 `Bench*.vue` 不查 disclosure 这类接口字段名，访问密钥、分区、层、整理、机器人、令牌这些测试台也要守；URI 只在测试台与召回调试的文件（`URI_ALLOWED`）和「Lore 的 URI」里放过；模型服务商的 API Key、对象存储的 Access Key ID 这类上游字段名只在它的 `UPSTREAM_KEYS` 列出的文件里放过）；发给模型的提示词和工具结果不算界面文字，要原样保留的句子加进它的 `ALLOWED`。新定的说法规则同时加进它和「界面用语」。原因：改过一遍的写法很容易被写回去。

## 已知的坑

- typescript-eslint 8 只支持 TypeScript 6.0 以下，所以 TypeScript 固定在 6.0，不升到 7。
- tsdown 产物是 `dist/index.mjs`，不是 `.js`。
- 管理界面用到新图标时必须加进 `apps/web/src/icons.ts`：构建时只打包这份清单里的图标，没列进来的会在运行时向公共 Iconify 接口请求。原因：自托管服务不应向第三方发请求。
- 管理界面的 tsconfig 关掉了 `exactOptionalPropertyTypes`（组件库的 props 类型不兼容），服务端保持开启。
- 页面和组件的 scoped 样式不在 layer 里，压过 Tailwind 的工具类（工具类都在 layer 里）：元素上 scoped 写了 `display` 时，`max-lg:hidden` 这类类名不生效，窄屏的显隐写在 scoped 的媒体查询里。
- 记忆目录用 `UTree` 的虚拟滚动，只渲染看得见的行：行高固定，`MemoriesPage` 的 `rowHeight` 同时给样式和 `estimateSize`，改一边要改另一边。组件库把 `data-index` 放在外层的 `li` 上，又把 `textContent` 多解了一层，它自带的打字跳转会报错、也无法获得焦点，左键也只在渲染出来的行里找上一级，所以这两个键在页面里自己做（`typeaheadMatch`、`parentRow`）。目录从隐藏变成显示时设 `scrollTop` 不发 scroll 事件，虚拟滚动不知道位置变了，`scrollToRow` 替它发一个。升级 Nuxt UI 时复查。
- 记忆页的统计（窄柱、列表上方的总数）来自概览接口，它要把整个概览算一遍：写入时 `refetchType: 'none'` 只标记过期，只在 `statsChanged` 认为动了统计时取一次。统计新用到别的字段时要加进 `statsChanged`。
- 记忆的新建、移动弹窗不用 `<form>`：单选在表单里时回车会隐式提交，尚未看到「可见范围将改变」就移动了。只有点按钮才提交，`memoryPages.test.ts` 核对。
- 记忆列表、目录只列有坐标的记忆（`form = curated`，记下的四类）。概览和窄柱的条数含来自对话的两类（`extractedCounts`），列表筛这两类是空的，它们的内容在对话页（会话分页与联系人分页）；算列表总数时只用 `counts`。
- `useToast` 等 Nuxt UI 组合式函数显式从 `@nuxt/ui/composables` 导入，不依赖自动导入。
- 内容表（带 `space_id`、在 `RLS_TABLES` 里的表）只能在 `withSpace()` 里访问，否则 RLS 让查询返回空、写入失败。新增内容表时同时加进 `RLS_TABLES` 和迁移里的策略，`rls.int.test.ts` 会核对两者一致。
- 集成测试需要 `KIOKU_TEST_DATABASE_URL`：本地 `docker compose -f docker-compose.dev.yml up -d --build` 后设为 `postgres://kioku:kioku@localhost:55432/kioku`；没设置时跳过，CI 里没设置直接失败。测试会清空整个库，所以同一个库上的测试文件串行。CI 里还设 `KIOKU_TEST_DATABASE_WORKERS=3`：测试文件按 3 个 worker 并行，每个 worker 连 `<库名>_w<编号>`，这几个库由 `scripts/ci/test-db.sh` 用超级用户从 `kioku` 复制出来（应用角色不能建库）；本地不设就是串行，要并行先自己建好这几个库。原因：串行时服务端测试要 8 分钟。CI 里测试库和服务端镜像都在后台构建（`scripts/ci/background.sh`），和静态检查同时进行：服务端测试开始前由 globalSetup 按 `KIOKU_TEST_DATABASE_READY` 等测试库，镜像到冒烟那一步再等。所以测试不能依赖整个实例的状态：查 `pg_stat_activity` 要限定在本库或被自己阻塞的连接上，监听端口用 0，临时文件用 `mkdtemp`。同一个库上先跑哪个文件每次都不一样，所以 `openTestDatabase` 会清空实例设置（`settings`，`resetDatabase` 清不到），文件要用的设置在 `beforeAll` 里自己写。
- 读权限的规则有两份：`access/access.ts` 的 `canRead`（单条判断）和 `memory/filter.ts` 的 `readableConditions`（SQL）。改一边必须改另一边，`filter.int.test.ts` 会逐条比对。`readableConditions` 也用在记忆事件的前后快照上（`snapshotColumns`），历史与恢复用其中的管理读取（不看有效期与删除状态、人格不限），一致性测试两边都比，不要为快照另写一份规则。
- 启动加载（`boot`）会被客户端当作指令级上下文，只能收受信来源写下的、记下的四类记忆（contracts 的 `BOOT_LAYERS`、`memory/filter.ts` 的 `BOOT_ELIGIBLE` 与 provenance 过滤）。召回块与启动加载里的线索文本、标题要经 `inlineText` 处理（标题经 `recall/text.ts` 的 `titleSuffix`）。会话开始附上的会话摘要（`recall/boot.ts` 的 `formatSummaryBlock`，只有不带会话上下文的会话有）来源受信，正文却是模型从对话里写的，可能转述了网页、文件这类工具结果：同样经 `inlineText` 压成单行，并写明只作参考、不是指令，和联系人的事实一样。原因：群聊写入的内容、工具读到的外部内容都不能变成所有者的 agent 的指令。
- 坐标（URI）的开头就是归属（`memory/uri.ts` 的 `layerOf`）：`core://`、`persona://<人格>/`、`app://<应用>/` 是共享的，`user://` 按成员各自占用，不同成员的本人里可以有同一个坐标；人格与应用的开头之后至少还要有一段。冲突只由数据库判断：唯一索引 `memories_uri_live_idx`（坐标加所属成员，不看有效期）保证同一归属不重复，冲突时服务层把唯一约束错误转成 409；共享与本人的开头不同，不会互相冲突，所以没有互斥的触发器。`claimUri` 只负责把调用方能释放的、同一归属的过期记录软删除，释放它们占用的坐标；绕开它的写入遇到同一归属的过期记录仍会因唯一索引冲突。已知代价：写入撞上调用方读不到、也释放不了的同一归属记录（例如编辑者撞上过期的机密）时返回 409，写入方能知道这个坐标被占用（不含内容）。
- 已删除列表的「URI 已被占用」标记和 Lore 导入计划里「已被其他记忆占用」的跳过（`memory/service.ts` 的 `uriConflicts`，分别经 `MemoryService.undeleteConflicts` 和 `importer/lore.ts` 的计划快照调用）在 JS 里照唯一索引与 `claimUri` 的释放规则（`canRelease`）写了一份：改其中任何一处都要同步改它。`validity.int.test.ts` 逐种用标记和真去恢复（`undelete`）的结果比对，`loreImport.int.test.ts` 逐种用计划和真去写入的结果比对。`uriConflicts` 不看调用方读不读得到占着的那条，能探出读不到的记录（例如写不了的机密）占不占某个坐标，所以只给这两处用，不做成服务的公开方法。原因：标记只用来提前提示，冲突仍以数据库为准，两边不一致时界面会标错。
- 过期的会话与登录失败计数由后台定时任务每小时清理（`jobs/cleanup.ts`）。清理登录计数时跳过被锁住的行：登录的计数事务按「本客户端 → 合计」的顺序加锁，按别的顺序等锁会互相等待成死锁。
- 机密（`secret`）只加密正文：坐标（URI）、标题、触发场景（`disclosure`）、关键词仍是明文（目录浏览、列表与召回线索要用），不要把需要保密的内容写进这些字段，明确给的标题照旧是明文。没填标题时机密取标识，不从正文的 `#` 标题取（`deriveTitle`）；结果是机密的写入（新建、修改、恢复此版本），标题等于明文正文的第一个 `#` 标题时一律换成标识（`memory/uri.ts` 的 `withoutHeading`，分不清是取的还是照抄的），改成机密时还比历史里的每一版正文，`scrubHistory` 把快照里这种标题一起换掉，恢复此版本就带不回来。取 `#` 标题的规则只有 `firstHeading` 一份。原因：标题是从正文取的话，正文加密、历史抹掉之后它还以明文留在标题列、全文检索与历史快照里。
- 部署在反向代理后面时要设 `KIOKU_TRUSTED_PROXIES=<受信代理层数>`，登录限流才能按真实客户端区分；客户端地址从 `X-Forwarded-For` 右边数，最左边的项由请求方填写、可以伪造。不在代理后面时保持 0。没配置受信代理时一律按连接对端区分客户端，请求头不能改变限流行为。 配置了受信代理时，后端端口不能对外直连，否则直连请求可以自己填 `X-Forwarded-For`。
- 登录防护的顺序：先计数（同一用户名 + 客户端 5 次、同一用户名合计 50 次，IPv6 按 /64 计为一个客户端；计数键用 JSON 数组编码，后一级超限时退回前一级）→ 进入 scrypt 并发闸门（全局 4 个运行 + 32 个排队，每个客户端 2 个；繁忙时退回计数）→ 用户名不存在时同样过闸门、占本客户端的名额，但不占全局名额，也不跑 scrypt，等一次校验的时长 → 成功清掉本客户端的计数，并退回这次在合计里占的名额（别人的失败不清）。登录成功下发设备 Cookie（`kioku_device`，服务端签名、绑定当前密码指纹、180 天），带着它不受合计上限约束，改密码后失效。原因：账号存在与否在计数、闸门繁忙、返回内容上表现一致，不能借此探出账号；随机用户名耗不了 CPU、挤不满全局名额；合计上限挡分布式猜测，设备 Cookie 让账号本人不被它锁住。
- 本地跑集成测试时不要同时开着连同一个数据库的本地服务：服务的 pg-boss 进程会抢走测试的后台任务，导致向量相关的用例超时。
- 迁移里要改 FORCE RLS 的表（`RLS_TABLES`）时，迁移连接没有设置 `app.space_id`，UPDATE / DELETE 会被策略过滤成零行而不报错；需要先 `NO FORCE`、改完再 `FORCE`。drizzle 把所有待执行的迁移放在一个事务里，中途失败会整体回滚。
- Key 的有效上限 = 签发时的 scopes 再按应用所有者当前角色收紧（`clampScopesToRole`）；所有者离开空间后 Key 作废。凭据能力（`credentials`）也一样：不是空间所有者时收紧到不可用；签发时非空间所有者要求凭据能力的直接 403。
- 目录浏览（`children`、`kioku_list`）由调用方读得到的后代推出，路径本身没有记忆的一级显示为虚拟节点（`exists: false`），所以不要求父节点存在、也不限制删除或移动父节点。原因：父子可见性受归属、敏感级、来源作用域、成员、有效期共同影响，强制「看得到子就看得到父」会不断出现漏洞。只有人格或应用标识的一级（`persona://<人格>`、`app://<应用>`）和开头本身一样，没有记忆时是空的一级，不返回 404。
- 应用的权限按应用所有者算，所以只有应用所有者能改应用配置、签发和查看它的 Key；空间所有者只能吊销。
- 管理界面的权限不能超过成员能获得的 Key：空间所有者（`owner`）可以写任何应用的记忆与机密级；编辑者（`editor`）最高到私密级，应用的记忆只能写自己是所有者的应用；查看者（`viewer`）只读。写入检查一律经过 `canWrite`，应用的记忆要带上 `appId`。通过 Key 不能在共享的归属与本人之间移动记忆（`assertKeyTransition`），只有管理界面里由人来移：移动会改变谁看得到它。凭据与密码库连接的管理（连接、检查、列条目、起标识、新建修改、查看值）只给空间所有者，别的成员只看得到自己的列表：别的成员的 Key 用不上凭据，连接又会让 Kioku 向成员填的地址发请求。
- 记忆接口对「读不到」和「不存在」都返回 404，不要改成 403。原因：403 会暴露这里有一条调用方看不见的记忆。
- 流程编号检查扫整行（注释与文案），会把测试数据里「小写 v 加数字」的字符串当迭代标记，也会把前后是空格或标点的S3、R2这类大写字母加数字当编号：测试数据换成别的写法；对象存储在代码与界面文案里写「对象存储」，要点明时写成「兼容S3」（不加空格）。
- 新加的表自动进全实例备份（`backup/tables.ts` 从表定义里取；会话这类恢复后用不上的、能重新生成的，加进它的排除清单）。`backup.int.test.ts` 要求每张进备份的表都有数据，新表要在它的种子里写上一行。原因：恢复按表逐行比对，空表测不出写回的问题。
- 恢复备份时表上的触发器不执行：写回的是已经通过检查的数据，触发器写下的派生数据也在备份里。所以触发器的派生数据要写进进备份的表，不要写进排除清单里的表。
- Lore 导出格式的字面量只写在 contracts 的 `LORE_BACKUP_FORMAT` 那一行，别处都引用常量。原因：规则只写一份，流程编号检查也会把这个字面量当迭代标记（`scripts/lint/comments.sh` 也扫本文件，所以这里不写出来）。
- Lore 导入的计划不含正文：`plan.skipped` 与同步项的 `reason` 会原样进 `/plan` 的响应，新写的跳过原因不能引用正文（坏占位符的片段只有 `quoteMalformed` 打开时才带，只有命令行打开）。测这一点要看原始响应：`LoreImportPlan.parse` 会丢掉契约外的字段，解析后再查永远通过。
- Lore 导入写入的 = 基准计划 − 勾掉的：`planImport` 带 `excludeUris` 时先算一次不勾的计划，勾掉的节点写到的 URI 仍被占用。只在循环里 continue 的话，映射到同一 URI 的下一个节点会顶上来，而它在看过的计划里没有写入目标，看不到也勾不了。目标 URI 已被别的记忆占用（`occupied`）的节点同样占着它的 URI，所以不勾的那次不看占用；按勾选重算沿用基准计划查到的占用、不重新查，否则基准之后才释放的 URI 会写进看过的计划里不导入的节点。
- Lore 导入出计划的几步（已有应用、导入记录、占用、预览、同步、数据时间）都在 `inPlanSnapshot` 的一个可重复读的只读事务里，预览与同步用 `planImportFor` 读到的同一份导入记录（`imports`）。分开读时，中间落下的一次导入（命令行、别的账号的 `/apply`）会让节点自己刚写下的那条被说成「已被其他记忆占用」。快照回调拿到的 `PlanSnapshot` 里 `tx` 是这个事务、`db` 也换成了它，里面再开的事务都是它的 savepoint：传给它们的事务配置不生效，只能一步一步地读，不能并行（`verifyMasterKey` 并行读设置，用连接池另开连接核对）。导入记录只在快照里读（`planImportFor` 要传快照）。写入（`applyImport`）在写入事务里重读导入记录：界面的 `/apply` 拿它和计划时的比，只比这份计划里的节点的导入事件（有没有、去重键、导入时的 Lore URI、人格），不一致返回 409；记忆现在在哪、是不是机密、删没删不比，空间里的记忆多半是导入的，比了会时常误报。命令行没有指纹，按重读的判断。只关于一个写入目标的跳过原因（撞 URI、占位符的位置规则、目标被占用等）带着那个目标，同步时只挂到它对应的旧记录上（去重键相同的，或 Lore 里换了路径、现在对应到它的），不进计划视图；目标被占用只出现在要新建的目标上，挂不到任何旧记录。
- Lore 导入写库的 22、23 类错误在 `importer/lore.ts` 里算单条失败，别的在路由里 catch，给固定的 500 文字（界面据此提示可能已写入一部分）。
- Lore 文件旧不旧的基准是导入、同步事件里 `loreExportedAt` 的最大值（没有的是命令行写的，取事件时间）；确认写入旧文件不会降低这个时间。什么都没写的导入不产生事件，也不推进它。原因：同步只看是否相等，文件比已写入的数据旧时会把正文改回去，指纹拦不住。
- Lore 导入的界面：计划显示后表单里不能有 `type=submit` 的按钮，回车的隐式提交会点默认按钮，没看完、没勾「标记机密」的节点就以明文写进去；`loreBackup.test.ts` 解析模板核对。界面按勾选算的写入（`loreBackup.ts` 的 `selectionEffects`、`staleNotice`）要和服务端按勾选重算的计划一致，它靠同步项的 `source` 等于节点主 URI、`uri` 等于目标 URI 对到目标，应用映射也和 `planImport` 结尾的过滤同一个规则，改这些要同步改它。换占位符的勾选只在这一处对上了凭据、至少一个新建目标放得进占位符时给；取消的选择连同特征（行号、类别、凭据 id 与字段）记下，重出计划后特征变了的丢掉（`pruneUnconverted`），否则会指到另一处上；目标算不算机密只有 `targetSecret` 一处。
- 按长度截断文字要防切开代理对：落单的代理项写进 text 不报错，被悄悄换成 U+FFFD，之后和原文比永远不等（同步每次都算要更新）；写进 jsonb 才报错。
- `BOOT_ELIGIBLE` 有 JS 版，在 contracts：`bootEligible` 只看层与优先级，导入计划标「进入启动加载」用它（导入写的都是目录里、来源受信的记忆）；`isBootCandidate` 是完整的一份，目录里的（`form` 为 curated）、来源受信、不是机密、层与优先级够格，对应 SQL 的 `BOOT_CANDIDATE`（`memory/filter.ts`，`BOOT_ELIGIBLE` 加上不是机密）。概览的「未设触发场景」与列表的同名筛选（`NEEDS_DISCLOSURE`）不算 `BOOT_CANDIDATE` 的；管理界面的 `isBootNode` 是 `isBootCandidate` 再除去已过期的（视图里没有 `form`，列表与详情只有目录里的记忆），`statsChanged` 照它判断要不要重取统计。改一边必须改另一边，`loreImport.int.test.ts` 用写进去的行比对 `bootEligible`，`browse.int.test.ts` 逐行比对 `BOOT_CANDIDATE` 与 `isBootCandidate`（含抽取的记忆）。
- 测试台的回滚模式靠换掉 `Deps.db` 实现（`bench/rollback.ts`），所以 Key 鉴权的路径（工具、生命周期事件、`/recall`）有几条约束。数据库访问都经过传入的 `deps` 或基于它建的服务：绕开 `deps` 的写入不会回滚。语句放进 `withSpace`：直接写在 `deps.db` 上的语句落在根事务上，出错（包括等锁超时）会中止整个运行，后面的步骤记为没有执行；现在只有 `bufferTurn` 读抽取设置这一句是例外。不在事务回调里发外部请求（嵌入、模型）：事务开着时前面步骤的行锁和 URI 咨询锁都没放；这些路径新增要查向量的步骤时加进 `bench/inProcess.ts` 的 `literalQueries`，否则这一步只走全文与关键词。事务回调里不要并行开子事务：代理只让顶层事务排队，同一条连接上并行的 savepoint 会交错。
- `set_config(..., true)` 与 `set local` 不随 savepoint 成功结束复原，只有 `rollback to` 才复原。`RollbackRun.clearSpace` 只清 `app.space_id`：`recall.ts` 的 `hnsw.*` 也留到回滚为止，它每次向量查询之前都设，所以没有影响；Key 鉴权的路径上新的向量查询或别的事务级设置不能依赖默认值，否则回滚模式和真实不一样。
- 日志不要整个打可能是数据库错误的 `err`，记进运行记录、最近错误的文字也不要直接用 `err.message`：`DrizzleQueryError` 带 SQL 与全部参数（也就是记忆正文、提示语），驱动的 `PostgresError` 的 `detail` 带数据的值，连接错误的 `message` 是数据库的地址。日志用 `logInternalError` 或 `loggableError(err)`，文字用 `errorText(err)`。
- postgres.js 的参数类型由服务器决定（`infer: false`）：`sql` 模板里的 boolean、Buffer、bigint、数组，查询决定不了类型时不按 JS 类型发。`select ${true}` 回来是字符串，`select ${buf}` 回来是文本，`jsonb_build_object('a', ${true})` 报 `42P18`，`${2n ** 40n} + 1` 按 int4 报 `22003`，都要写 cast。`Date` 经 drizzle 包过的连接不能直接进 `sql` 模板（时间类型的序列化被换成透传）：写 `${d.toISOString()}::timestamptz`。列的写入与比较（`.values`、`.set`、`eq`）由列决定类型，不受影响。
- `pgErrorCode`、`pgConstraint`、`pgMessage` 只解开 `DrizzleQueryError` 的 cause。驱动直接抛的错误不解开：连接错误（`CONNECTION_CLOSED`）自带 cause（`57P01`、`ECONNRESET`），解开就成了另一个错误，连接本身的错误会记成不同的 code（要原因用 `pgCauseCode`）；正在执行的语句另有自己的错误，同一次断连里它报 `57P01`，搜日志时两种都要看。回调接住语句错误时，事务以未包装的 PostgresError reject，字段同样读得到。
- 事务回调结束到 COMMIT 或 ROLLBACK 做完、连接归还之前，驱动还放行句柄上的语句，它们排在后面，落在事务外自动提交；连接归还和断开之后才拒绝（`UNSAFE_TRANSACTION`、`CONNECTION_CLOSED`）。所以事务回调里的语句都要 await 完。回滚模式靠 `RollbackRun.guard` 挡这一段，`inRollback` 在 fn 结束时（成功或抛错，放在 `finally` 里）先 `run.close()` 再让事务回滚，顺序不能换，`rollback.int.test.ts`「回滚做完之前发出的写入」核对这一点。
- 测试：测连接断开直接用 `pg_terminate_backend` 杀（见 `db/__tests__/disconnect.int.test.ts`）：外层事务以 `CONNECTION_CLOSED` 立刻 reject，回调不会停，回调里后面的语句也 reject（经 drizzle 的包在 `cause` 里，开 savepoint 这类驱动直接发的不包）；正在执行的那条语句报 `57P01`。用 `testing/db.ts` 的 `killDuring`：它先接住事务的 promise 再杀，否则 kill 的响应回来之前事务可能已经 reject，算未处理的 rejection，用例偶发失败。测闸门要另开大一点的连接池：测试池 max 2，鉴权会卡在获取连接上，到不了闸门。
- 测试台按 `created_at = now()` 认这个事务写下的行，所以 `memory_events`、`credential_events`、`subjects`、`subject_identities`、`conversation_turns`、`conversations` 在 Key 鉴权的路径上要用数据库默认值，写 JS 时间会漏报（会话的最近活动也写 `now()`，见 `touchConversation`）。
- 测试台的打码只在 `toView` 和凭据的取用处判断，`contentOf` 不能打码（`applyUpdate` 靠它取原文再封存）。新增返回 `MemoryView` 的路径要经过 `toView`。错误信息不放解出来的内容，不只是打码时（`checkCredentialRefs` 的 `decrypted`）：没有显式查看的路径不能借报错读到正文，也不留访问记录。占位文字集中在 `memory/masked.ts`，新增的要加进 `MASKED_TEXTS`，写入检查才认得；这个文件不能依赖别的模块（`mcp/format.ts` 引用它，又打进不带 postgres 的 `dist/bench.mjs`）。测试台取用凭据一律不给值、不记访问，也不向密码库请求（`CredentialContext.bench`）；写入的值里带着 `MASKED_CREDENTIAL_VALUES` 就拒绝。
- 管理界面读记忆默认不给机密记忆的正文，Key 读到要留痕，都由 `MemoryContext.secretRead` 决定，判断和记访问事件都在 `toView`，只此一处。新增返回 `MemoryView` 的路径要经过 `toView`，`via` 必填：响应里的正文是调用方刚写的或本来就是明文才传 null。内部路径（导入工具比对）不设它。解密的正文不进 `useQuery` 的缓存（`apps/web/src/secretContent.ts`）。原因：缓存活得比页面长，查看要每次留痕。
- 管理界面的响应是 `ConsoleMemoryView`，比 Key 鉴权接口返回的 `MemoryView` 多 `contentHidden`、`plaintextIgnored`。这两个字段不能加进 `MemoryView`，加了要重新生成 SDK；`toView` 只在 `secretRead` 为 `explicit` 时带上，Key 的响应才不多字段（`c.json` 不会按 schema 剥）。
- 不改记忆的事件（`access`、`ignore_plaintext`、`unignore_plaintext`）只写 `before`，`after` 为 null。原因：界面按 `after.version` 标「现在的版本」，恢复也读 `after`，带上 `after` 就成了能恢复的版本。可见性靠 `before` 的敏感级，所以访问事件要写快照，不能两边都 null：否则降级之后编辑者也看得到之前的访问记录。`access` 不进变更记录（`activity` 里过滤），历史里另算上限，按保留期清（`retentionRules` 的 `accessEvents`）。
- 忽略明文提示靠 `memories.plaintext_ignored_hash` 和现在的正文比，判断只看这个比较，新的写入路径不处理它也不会判错：SQL（`IGNORED_NOW`）和 JS（`contentHash`）的算法要一致，`plaintextIgnore.int.test.ts` 核对。`applyUpdate` 在正文变化时清掉它：它是含旧值的正文的哈希，能离线猜解；新增改正文的路径也要清。这一列不进事件快照（`UNSNAPSHOTTED`），不随空间导出，改成机密时清掉。
- 转存为凭据靠 `scrubValue` 把值从 `memory_events` 里去掉，只改 `scrubSnapshot` 认得的字段（正文、触发场景（`disclosure`）、关键词、`domain` 与 `path`，Lore 导入事件的 `domain` 与 `path` 不动：导入工具靠它们去重）。给快照加新的文字字段时要同步改它。写事件的路径都要先改或锁记忆那一行：否则带着旧正文的事件可能在转存提交之后才写进来，值又回到历史里。
- 写入前拦截（新增的疑似明文，`addedPlaintextCredentials`）只在 `MemoryService.create` 与 `update` 里，REST、MCP 与测试台的写入都经过这两处。Lore 的导入与同步传 `plaintextGate: false`，由计划处理；恢复、整理建议、转存、抽取与按空间导入不经过这两处，不拦。新加写入路径时按这条判断：带回历史里本来就有的正文不拦，新写进来的要拦；结果是机密的不拦。测试里要写进带明文的正文，用 `testing/plaintext.ts` 的 `setPlaintextContent`，或者管理界面的请求带 `allowPlaintext`。原因：明文一写进去就进了历史、全文检索与向量，收不回来。
- 记忆的新建、修改请求两边分开：访问密钥用 `CreateMemoryRequest`、`UpdateMemoryRequest`（进 SDK），放行标记只有 `plaintextOk`；管理界面用 `ConsoleCreateMemoryRequest`、`ConsoleUpdateMemoryRequest`，标记是 `ignorePlaintext`（不是凭据）与 `allowPlaintext`（照样保存，能改这条记忆的成员都能用；从机密强制降级另外要空间所有者），路由经 `RouteSet` 的 `createBody`、`updateBody` 各用各的。新标记加在对应的一边，管理界面的加进访问密钥的 schema 要重新生成 SDK。给错一边的标记由 schema 去掉，服务层的 `checkPlaintextFlags` 只挡内部调用。原因同 `ConsoleMemoryView` 那条：SDK 的使用方会看到用不了的参数。
- 保存时带 `ignorePlaintext`，只在写入前没有待处理的疑似明文、或者原有的那几处在新正文里都没有了时才记忽略；否则只放行写入，记忆留在待处理。原因：忽略的哈希管整段正文，记下来会连带忽略原有的真密码。
- 疑似明文的规则（contracts 的 `PLAINTEXT_CREDENTIAL`）在 SQL 里一律经 `plaintextMatch`（写法与令牌两条规则用 or 连起来，`PLAINTEXT_CREDENTIAL_PARTS`），不要直接写 `~* PLAINTEXT_CREDENTIAL.source`：PostgreSQL 匹配一整条大的多选要慢一倍以上。扫描与打码（`findPlaintextCredentials`、`maskPlaintextCredentials`）在主线程上跑，输入来自访问密钥（提示语最长 2 万字），要保持线性：不切子串（sticky 正则加 `lastIndex`），往后找的游标要复用，不对每一处扫到行尾或文本末尾；打码按 `findPlaintextCredentials(text, { overlapping: true })` 的位置盖，不另写一份规则。contracts 与打码各有对抗用例。规则里有 lookbehind，contracts 在管理界面里也会加载：Safari 16.4 以下不认，整个页面起不来。
- Lore 导入换占位符（`convertPlaintext`）只改新建、放得进占位符的目标，同一节点的其余目标照原样写，原因进 `plaintextKept`（按写下去的正文判断）。每项带计划里的 `credentialId` 与 `field`，写入时只核对这一条凭据的这个字段，对不上照原样写，不换成别的同值凭据。勾选不改计划的指纹、预览、同步与旧文件判断，所以界面的 `selectionEffects`、`staleNotice` 不用跟着变。要用的凭据值在事务外取（`knownValues`，只留通过 `ConvertibleValue` 的值），不能在 `inPlanSnapshot` 里取：不在事务里请求密码库。同步转存过的记忆时，Kioku 里还有转存的占位符，Lore 正文就要找得到凭据现在的值（换回占位符）才同步，否则跳过。不要退回按检测器猜：Lore 里旧值换成认不出的写法时会把明文写回去。
- 按值匹配（`CredentialService.matchValues`）不记访问事件：它不交出值，只给空间所有者。不可用的连接与读不到的托管凭据要计数返回（`unavailableConnections`、`unreadableCredentials`），不然看起来像「没有同值的」，所有者会再建一条重复的。密码库客户端刷新令牌时拿到的整份 /sync 随刷新的结果交给等着的调用方，只有 `items()` 用，不挂在会话上：缓存的会话会长期带着一份整个密码库的密文。
- 管理界面保存前处理疑似明文（`plaintextSave.ts`、`usePlaintextSave.ts`）：被拒时以本地算出的新增之处为准，对不上服务端报的（行号、类别）才退回 `spotsFromFindings`。弹窗的结果带着算出它的正文（`source`）、转存的值（`replacements`）与标了不是凭据的值（`ignored`）；正文变了时 `afterGate` 先按字面重放转存、按值保留「不是凭据」，只为新出现的再开弹窗，否则建好的凭据和做过的选择会丢。能不能转存只经 `canManageCredentials`。按值匹配的请求带着正文里的值，只走 POST，不进 `useQuery` 的缓存。
- 凭据的取用：`use` 与取值接口的 `resolve` 共用 `checkUse`（被拒、不存在、缺字段的判断与被拒的事件）。`resolve` 里托管的值要到最后一个事务才记交出（`prepare` 的 `deferOk`），准备过的密码库会话不管有没有走完都要过一次 `vault.record`（`releaseSessions`、`settleFetched`），断开的竞态下才不会把解开的会话留在缓存里；改 `prepare`、`fetchItem`、`settle` 时守住「取到」与「交出」的区别。
- 凭据的取用与管理只看 `access/access.ts` 的 `credentialDenial`（凭据能力、会话上下文、本人私密的范围、限定的应用），不借用机密级；被拒的原因记进访问事件。能力、范围、会话上下文被拒回 403（不看凭据在不在），限定给别的应用的回 404：不能借报错的差别探出凭据。
- 密码库取值分三段，不在事务里请求密码库：短事务读凭据与连接、判断权限并解开令牌 → 事务外向密码库取条目 → 短事务记访问事件、按结果更新连接（`VaultConnections.record`），意外的错误也先记一条失败再抛。会话按连接 id 与密文缓存在进程里，断开（提交之后）、读到连接不可用时清掉；刷新令牌失效时先重读库里的密文，变了就用新的重试一次，才改成需要重新登录。停用、需要重新登录、断开的连接取用时直接失败，只在 `check` 与列条目时同步、恢复；这两处同步本身失败（连不上、意外的响应、格式无法识别、校验不过，停用的连接也一样）时先记进最近的错误，再回 502，说明文字只有开头不同（`syncFailure` 的动作）；条目不可用、别的请求刚换过令牌不算失败，`check` 照常返回连接。同一成员同时只收一个连接或重新登录的请求（内存里记）。
- 连接的令牌与账户密钥 aad 是 `vault-connection:<id>`（`credential/vault.ts` 的 `vaultAad`），断开时三列置空。主密钥轮换的 `TABLES`、剩余计数（`remaining.vaultConnections`）与轮换任务的「换完没有」都要算上它：漏了的话连接一直用旧主密钥包着，去掉旧主密钥后服务起不来。
- 给模型看的文字里，凭据与连接的明文字段（标识、名称、说明、字段名、条目名称）都要经 `inlineText` 压成单行：有管理能力的 agent 能写说明，多行能伪造「值：」与指令。
- 密码库客户端（`credential/bitwarden/`）的错误文字只写类别（无法连接、超时、意外的响应），errno、状态码与哪个接口只进 `log`，响应正文哪里都不放：服务器地址由成员填，可能指向内网。服务器给的键（两步验证方式、条目类型、角色）用 `Map` 或 `Object.hasOwn` 查。服务器地址的规则有两份：契约的 `VaultServerUrl`（按写法）和客户端的 `serverUrlProblem`（按写下的主机名，不用 URL 规范化之后的：全是数字的主机名会被换成 IPv4 地址），改一边要改另一边；登录之前服务端先用 `serverUrlProblem` 查，地址的问题回 400，不说成连不上。密钥派生的参数有上限（Argon2id 内存不超过 256 MiB），整个进程排队一次一个；Argon2id 在主线程上跑，登录时会短暂阻塞事件循环。
- 密码库的测试：`Deps.vault` 不传时按连不上处理（`credential/vaultClient.ts`），服务的测试用 `testing/fakeVault.ts`。客户端的固定数据从本地 Vaultwarden 录下（`testing/recordVaultFixtures.ts`），里面的令牌与密码是测试数据，由 `.gitleaks.toml` 放过；真连的集成测试按 `KIOKU_TEST_VAULTWARDEN_URL` 开关，CI 不设不算失败。官方 bw CLI 只走 https，测试经本地 TLS 代理（`testing/bwCli.ts`）连容器；测试用的 Vaultwarden 要放宽 `LOGIN_*`、`UNAUTHENTICATED_*` 的限流，同一个 30 秒窗口的 TOTP 不能重用（`nextTotp`）。
- 密码库客户端的写入（`credential/bitwarden/write.ts`）：修改照搬条目的原始 JSON，只换给了的字段，其余密文原样带回。要去掉响应里的 `attachments` 数组（官方服务端要的是映射，不带时两个服务端都不动附件），留着 `archivedDate`、`folderId`、`key`（缺了 Vaultwarden 会取消归档、丢掉文件夹，丢了 `key` 条目就解不开）；Vaultwarden 1.37 每次写都要 `encryptedFor`。同名的自定义字段读和写都经 `vault.ts` 的 `namedFields` 取，否则改的是另一个字段。原因：通行密钥这类 Kioku 不认识的内容不能在写回时丢掉。
- 密码库客户端判断写入能不能做、写成没有：
  - **冲突**：Vaultwarden 只在库里的修改时间比 `lastKnownRevisionDate` 新 1 秒以上时才拒绝，客户端自己拿刚读到的 `revisionDate` 比是主要的防线，不能删；录下的冲突用例因此用很旧的时间。
  - **只读**：以刚取到的条目的 `edit` 为准，缓存的集合权限只作后备，上次同步超过 60 秒才重新同步。
  - **拒绝的分类**：服务端的拒绝按消息文字分类（`client.ts` 的 `READ_ONLY_MESSAGE` 等），消息只用来分类，不进错误与日志；升级 Vaultwarden 或核对官方服务时要复查。
  - **长度上限**：按服务器类型定，从 `/api/config` 认出 Vaultwarden 只限备注，别的按官方的上限；会话里缓存。
  - **客户端版本头**：所有请求带 `Bitwarden-Client-Name` 与 `Bitwarden-Client-Version`，官方服务端缺了会拒绝修改带条目密钥或通行密钥的条目。`http.ts` 的 `CLIENT_VERSION` 要和测试用的 bw CLI 版本一起升。带上版本头之后，Vaultwarden 在同步里给出 SSH 密钥条目，个人的那些按专用账号的规则算个人条目。
  - 流程编号检查会把测试数据里「大写字母、连字符加数字」的曲线名当成编号，测试里写成 `prime256v1` 这种。
- 凭据的新建（`kioku_credential_save`、管理界面、转存的「新建」）有去处时分三段写进密码库：
  - 先在短事务里查标识与去处；转存还要先按记忆的版本查一遍转存的规则。
  - 再在事务外 `createItem`。
  - 最后在短事务里建凭据。条目写进去之后任何一步失败，条目都留在集合里，错误体带 `vaultItem`（只给管理界面，访问密钥只在文字里写明，条目与集合名经 `inlineText`）。不能先写条目、后查别的：查不过就会在集合里多留一个装着值的条目。
- 写回密码库条目时，期望的修改时间是 Kioku 最近看到的 `vault_revision`。
  - Kioku 每次看到条目的修改时间变了，都把版本号加一、清掉「需要轮换」（`observeRevisions`），所以新加读条目的路径要调它。
  - 写回成功之后的第三段不能再因版本失败：值已经在密码库里了，要在当前版本上记下这次写入。
  - 写回后修改时间没变（值相同，客户端没发修改）不算改了值，不清「需要轮换」。
  - 写入本身的错误（`read_only`、`item_conflict`、`value_too_long`）不改连接的状态，靠 `CONNECTION_ERRORS` 里没有它们；写回的规则检查要在调客户端之前做完，否则客户端的 `unsupported_format` 会走到调用方。
- 凭据的到期判断有两份：JS 的 `credentialExpiry`、SQL 的 `CREDENTIAL_ATTENTION`，改一边要改另一边，用例逐条比对（含正好 7 天的边界）。每个成员最多一个去处，由唯一索引 `vault_connections_destination_idx` 兜底。测试台不写密码库（回滚撤不回外部服务里的写入）：经 `CredentialContext.bench` 一律按托管新建、拒绝改密码库凭据的值，不碰 `deps.vault`。测试台的工具结果靠「版本 」取到行尾，新加进结果的文字要放在版本号前面。
- 管理界面里密码库连接的主密码只放在 `useVaultLogin` 的局部状态里，连上、失败、返回、关掉都清空（只有等验证码那一步留着），不进 query 缓存、地址或本地存储；查看到的凭据值同样不进缓存。条目列表、详情里的条目名称和修改表单共用查询键 `['vault-items', spaceId, connectionId]`，只在连接可用时读，改了连接或凭据用 `refreshLists` 一起失效。
- 管理界面里凭据相关的查询：
  - **读条目**：所有 vault-items 查询都经 `vaultQueries.ts` 的 `fetchVaultItems`。它在条目的修改时间和缓存里那条凭据的 `valueChangedAt` 对不上时，让凭据与待处理条数失效。直接调 `api.vaultItems` 会漏掉这一步：服务端读条目时可能加了版本号、清了「需要轮换」。
  - **待处理的凭据列表**：查询键 `['credentials', sid, { attention: true }]` 有意和凭据列表共用前缀；改到期、轮换、值与删除，都要让待处理条数一起失效（`refreshLists`）。
  - **去处**：设置与清除返回成员的整份连接列表，用 `setQueryData` 整个换掉，不要只改一个连接，否则别的连接上留着已经清掉的去处。
  - **写到哪里**：新建凭据会写到哪里，一律用 `useNewCredentialStore` 与 `vault.ts` 的 `storeName`、`storeLabel`、`storeBlocker`，新加新建凭据的地方也用它们。
  - **修改表单的基准**：等 vault-items 读完再读凭据作为基准，之后再变就用 `mergeReloaded` 三方合并进表单，保留用户的改动。
  - **到期时间**：`datetime-local` 没填完时值是空字符串，所以「不到期」是单独的按钮，没填完要看 `validity.badInput`。
  - **说法**：密码库错误的说法只在契约的 `VAULT_ERROR_KIND_NAMES`。界面上凭据与连接的权限只有 `vault.ts` 的 `canManageCredentials` 一处；签发时的凭据能力预览（`issuedCredentialCapability`）只给签发表单，签发之后看 `keyMatrix` 的 `credentials`。
- 路由和测试台共用的处理函数（`lifecycle/handlers.ts`）不在里面新建 scope，由调用方传入，否则测试台关不掉 `record`。路由要显式只取 `LifecycleResponse` 的字段：`c.json` 不会按 schema 剥掉多余字段，`session` 不能加进 `LifecycleResponse`，加了要重新生成 SDK。
- 新路由如果引用 Key 鉴权接口的命名组件（`TurnEndEvent`、`SessionContext` 等），要挂在这些路由后面（测试台路由挂在最后）。原因：OpenAPI 的组件按第一次用到的顺序排，挂早了 `sdks/python/generate.sh --check` 会失败，哪怕接口没变。
- 新加 MCP 工具要写进 contracts 的 `BENCH_READ_TOOLS` 或 `BENCH_WRITE_TOOLS`：命令行握手按这份名单严格核对，`mayWrite` 对不认识的工具按写算。内置场景的 `capture` 与断言依赖工具结果的文字（「版本: 」「URI: 」等），`bench/executor.ts` 也按这些行与 `formatRecallBlock` 解析 URI 列表，改 `mcp/format.ts` 的文字要同步改，门禁里的矩阵会报。测试台步骤的说明与断言文字只展开 `${run}`、`${expires}`，新增命令行默认打印的文字时也不能展开 `capture` 的变量：它可能取到凭据的值。内置预设写记忆要带 `valid_to: EXPIRES`；`${run}`、`${expires}` 是保留的变量名。
- contracts 里的 `isReplayStep`、`mayWrite`、`findPlaintextCredentials` 与 `addedPlaintextCredentials`、`placeholderAllowed`（连同说明 `CONVERT_SCOPE_TEXT`）、`sensitivityAllowed` 与 `DEFAULT_SENSITIVITY`（各归属能用的敏感级与默认敏感级）、`defaultCredentialFields` 与 `isVaultFieldRef`（密码库条目的字段怎么对到凭据的字段）和 `names.ts`（归属、敏感级、凭据能力、密码库连接状态、取用结果与原因的中文名）是「只放 zod 与类型」的例外：服务端、命令行和管理界面要同一份判定和用词。
- 读实例设置的函数（`loadExtractionConfig` 这类）既读库又解密，不要 catch 全部再回 `err.message`：读库出错也会被接住，drizzle 的错误信息带 SQL 与全部参数。用 `settings/endpoint.ts` 的 `unlocked`：只认 `ApiKeyLockedError`，其余重新抛给 `onError`。测读设置出错用 `testing/db.ts` 的 `settingsQueryFails`。
- 带 API Key 的 `fetch` 不要把 `err.message` 给调用方或写进日志，也不要放进 `cause`（日志也打印）：API Key 中间有换行时，undici 的 Headers 报错会带上整个 Authorization 值，`signal` 已经取消时也先报这个，用 `fetchFailure` 只取错误类别；响应解析失败的文字可能带响应开头（可能回显 API Key），用 `upstreamJson`。上游写进报错的 API Key 用 `withoutKey`，先换再截断：`fetch` 会去掉结尾的空白，上游见到的 API Key 和保存的写法可能不同。保存时已经 `trim` 并拒绝控制字符，但存量 API Key 不迁移，这两处不能当多余的删掉。
- 模型代理返回的 `message.tool_calls` 不是严格原样：id 可能是生成的，不是对象的项会被去掉，`arguments` 只放合法的 JSON 对象（原文在 `rawArguments`，只给界面显示）。`tool` 消息的 `tool_call_id` 要用 `toolCalls[i].id`，两者一一对应。
- 测试模型代理：测时限不能靠到点 abort 来结束用例，`requestAgentTurn` 的 catch 先看 `timeout.aborted`，这个信号不管有没有传给 `fetch` 都会按时到期，时限失效时用例照样通过，要和哨兵定时器 `Promise.race`。客户端断开的信号来自 Node 适配器（reason 是字符串，不是 AbortError，要看 `signal.aborted`），`app.request` 走不到，要测断开必须起真实端口。「请求模型期间不占连接」的用例依赖测试连接池只有 2 条。
- 导航角标和待处理页的条数是同一个查询（`inbox-counts`，`staleTime` 60 秒，接口每次跑正则），不跟着换页重取。新增能改变四类条数的操作（包括改动记忆使疑似明文变化）要让它失效：`invalidateInboxCounts`，或者加进已有的刷新清单（`refreshSubjectCaches`、`refreshAfterPlaintext`、记忆页的 `refreshCounts`）。
- 权限格子的满色是 `--access-*`，不是归属色：浅色主题下应用、本人、会话三类太淡，满色、淡色、空白分不开，岩芯上又没有文字。改归属色时要同步改它，`tokens.test.ts` 按明度核对。岩芯和权限范围一律用 `api.keyMatrix` 的结果，`issuedScopeRows` 只用于签发时的预览（不是实际权限，只按归属、敏感级与 `sensitivityAllowed` 换算）。
- 测试台界面：`BenchStepResult.status` 在没带断言时一律是 `passed`，哪怕工具报错，显示调用结果要看 `isError` 与 `internalError`（`benchResult.ts` 的 `stepBadge`）。重放分叉的 `index` 是发出请求时那份日志的下标，结果回来时按当时的 session 记录，所以运行期间不能改 session，新加能动会话的操作都要判断 `running`；`BenchSession` 的 `replay` 与 `replayEntryIds` 下标一一对应，要一起改。新分页放进 `BenchPage` 里 `v-if="mounted" v-show="ready"` 那一层并用 `v-show` 切换：换应用时 Key 要重读，跟着卸载的话草稿与文本框里的场景会丢。
- 测试台的地址会被写回成实际选择：同一页面上不带 `app`、`key` 参数的导航（侧栏入口）不算换选择，要换走 `selectApp`、`selectKey`；按列表判断地址里的选择时只认读取成功且不在刷新的结果（`isSuccess && !isFetching`），否则缓存里的旧列表会冤枉模拟器链接带来的 Key。`useQuery` 的选项在 pre 阶段才更新，按查询结果做判断并写回时要用 post flush（`watchPostEffect`），pre 下会把上一个应用的 Key 写进地址。`hasUnsavedChanges` 是全局一个，一个页面只能注册一份 `useUnsavedChangesGuard`，测试台由 `createBench` 注册，分页通过 `unsaved` 报上去。`abandoned` 不随 `generation` 清掉，新增调用 `execute` 的地方要传 `label` 与 `view`。`useUnsavedChangesGuard` 注册时就读一次 `dirty`，用到的状态要先建好，否则页面打开就抛 TDZ 错误。
- 权限探测靠「capture 」开头认出 capture 没取到的断言（`benchResult.ts`），改 `runner.ts` 里这句说明要一起改，`runner.test.ts` 钉住了这个开头。
- 模型对话的循环占用 `current`，`running` 在模型请求之间也是 true：循环里的运行要走 `runAs` 并用同一个序号，走 `execute` 会直接返回 stale；作废之后旧的 `sendAgentMessage` 还会跑到结束，写对话只能经 `onChange` 里 `current.value === id` 的判断。发给模型的是 `AgentConversation.messages`，只在 `finish` 时提交，`exchanges` 只用来显示：新增结束路径时要先把这一轮的 `tool` 消息都答上再 `finish`（`benchAgent.test.ts` 的 `historyProblem` 每次请求模型都核对）。判断工具结果时 `internalError` 为真不一定带 `isError`（根事务中止时工具本身没报错），只看 `isError` 会把它的文字当成正常结果。
- `benchScenarios.ts` 的明文检测按工具名判断：新增能写记忆正文或能改 URI 的工具要同步改 `writesMemory` 与 `kioku_move` 的分支，否则导出时不提示。`apps/web/src/__tests__/benchTools.fixture.json` 是真实 `tools/list` 的快照，改了工具 `inputSchema` 的形状要重新生成，否则用例测的是旧形状、也不会变红。
- 硬删除记忆时 Lore 的导入事件（出处 `source` 为 `lore`）要留下（`memory_id` 置空、快照只留 `domain` 与 `path`），别的事件一起删，包括按空间导入的导入事件。原因：Lore 导入工具按导入事件去重，记忆整行不在时也认作「导入过、后来删掉了」；删掉这些事件，下次同步会把删过的节点写回。保留期的删除条件都在 `jobs/retention.ts` 的 `retentionRules`，改了要对照 `retention.int.test.ts`。
- 「用户删掉」与「过期并释放 URI」不加标记列，按删除时间与过期时间的先后区分（已删除列表、已过期列表、恢复与恢复生效（`undelete`、`reactivate`）都靠它）。所以写 `deleted_at` 时要守住：用户删除只删在同一时刻仍有效的行、删除时间写这一刻；`claimUri` 只释放同一时刻已过期的行。新增删除路径时照这个写。
- 本人不设公开有两份：contracts 的 `sensitivityAllowed` 与约束 `memories_user_not_public`。数据库的 CHECK 约束被违反时，服务层按 `memory/service.ts` 的 `CHECK_MESSAGES` 转成可读的 400；新加的约束也要在那里给出文字，否则落到 `onError` 成 500。
- 合并联系人的步骤在 `access/subjects.ts`，管理界面的手动合并与 `/bind` 共用，规则只写一份；合并时要作废牵涉到两边的待确认绑定，并把绑定记录改指向保留的联系人。会话跟着改指向：同一个应用里保留的那边已经有会话时并成一个（`mergeConversations`），摘要、事实与抽取记录先挪过去再删被合并的会话，否则删除会话的触发器会连带删掉还挂着的摘要。
- 会话按（应用、群）、（应用、私聊的人）、（应用、所属成员）认，生命周期事件来时建立或更新最近活动（`lifecycle/handlers.ts`；最近活动早于一分钟以前才更新，否则不写这一行，见 `touchConversation`；写不进去只记日志，不影响召回与缓冲）；会话摘要都挂在会话上（约束 `memories_episode_conversation`），抽取在写入事务里找这一批的会话（`ensureConversation`）。不带会话上下文的轮次的缓冲作用域是 `global`（`NO_CONTEXT_SCOPE`，就是这类 Key 写下的记忆的来源作用域），按（应用、作用域）分批就是按应用与所属成员分：应用转给别人时旧 Key 都吊销了，旧所有者剩下的几轮按「没有能用的 Key」丢掉。测试里直接往库里写会话摘要时用 `testing/db.ts` 的 `summaryConversation`、`groupConversation` 或 `conversationOfScope` 先建会话。
- 整理建议只经 `MemoryService.applySuggestion` 改记忆；`dream_suggestions` 用 id 与版本的数组引用记忆，没有外键，「建议还作不作数」只按版本判断，规则只有一处（SQL 的 `suggestionCurrent`，锁到行之后用 `isCurrentVersion`），列表、执行与保留期都用它。
- 整理任务按 `dream_marks`（记忆 id 对应整理过的版本）找要处理的记忆，不靠更新时间：导入的记忆保留原来的更新时间，按时间推进的游标会永远看不到它们。
- 迁移文件合并之后不要再改（包括注释）：恢复备份时按最后一个迁移的哈希核对库的结构，改过的文件会让之前的备份恢复不了；服务启动时也核对库里执行过的每个迁移的哈希（`db/migrate.ts` 的 `runMigrations`），有这个版本没有的就拒绝启动，改过的文件会让已经迁移过的库起不来。迁移从 `0000_baseline`（记忆架构改版时重来的基线）起算，之前的备份不能恢复、之前的库不能迁移：启动与恢复按早于基线的迁移认出它们，报错说明是改版之前的结构，要清空数据库重建后从 Lore 重新导入。
- 在 Mac 上用非交互会话（agent 的 shell）拉镜像会卡在钥匙串，需要用不带 credsStore 的 `DOCKER_CONFIG`。
