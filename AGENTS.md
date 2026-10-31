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
- Python（`sdks/python` 与插件目录里各自执行）：`uv run pytest`、`uv run ruff check .`、`uv run ruff format --check .`

## 目录与约定

| 路径 | 内容 |
|---|---|
| `scripts/check.sh` | 唯一门禁入口，本地与 CI 行为一致 |
| `scripts/ci/` | 只被 CI 调用的小脚本 |
| `docs/design.md` | 总体设计：数据模型、分层与授权、接入协议 |
| `docs/plans/` | 计划文档，一个主题一份，持续勾选 |
| `docs/adr/` | 长期决策记录 |
| `apps/server` | 后端。`app.ts` 组装路由，`index.ts` 只负责监听端口；路由按资源放 `routes/` |
| `apps/web` | 管理界面。页面放 `pages/`，布局放 `layouts/`；后端调用集中在 `api/endpoints.ts`（响应按 contracts 的 schema 校验）；服务端状态用 TanStack Query，全局一个 `queryClient`（`query.ts`）；界面用到的图标都登记在 `icons.ts` |
| `packages/contracts` | 只放 zod schema 与推出的类型，不放实现；后端路由和前端解析都从这里取 |

- workspace 包以 TS 源码互相引用（`exports` 指向 `src/`），后端用 tsdown 打包时一并打进产物。原因：省掉各包单独构建的步骤。
- 依赖版本写死、不加 `^`。pnpm 默认拒绝发布不足一天的新版本，遇到时换前一个版本，不要加 `minimumReleaseAgeExclude`。原因：给被投毒的包留出被发现的时间。
- `sdks/python` 由服务端的 OpenAPI 生成：改了接入方用的接口（Key 鉴权的生命周期、召回、boot、记忆、whoami）或它们用到的契约后，跑 `sdks/python/generate.sh`，生成的改动一起提交；门禁会重新生成并比对。原因：AstrBot 插件用它，接口变了 SDK 没跟上时要到运行时才出错。
- 管理界面的 `typecheck` 先跑一次 `vite build`：Nuxt UI 的 Vite 插件在构建时才生成 `auto-imports.d.ts`、`components.d.ts`，没有它们 vue-tsc 会报找不到组件。

## 已知的坑

- typescript-eslint 8 只支持 TypeScript 6.0 以下，所以 TypeScript 固定在 6.0，不升到 7。
- tsdown 产物是 `dist/index.mjs`，不是 `.js`。
- 管理界面用到新图标时必须加进 `apps/web/src/icons.ts`：构建时只打包这份清单里的图标，没列进来的会在运行时向公共 Iconify 接口请求。原因：自托管服务不应向第三方发请求。
- 管理界面的 tsconfig 关掉了 `exactOptionalPropertyTypes`（组件库的 props 类型不兼容），服务端保持开启。
- `useToast` 等 Nuxt UI 组合式函数显式从 `@nuxt/ui/composables` 导入，不依赖自动导入。
- 内容表（带 `space_id`、在 `RLS_TABLES` 里的表）只能在 `withSpace()` 里访问，否则 RLS 让查询返回空、写入失败。新增内容表时同时加进 `RLS_TABLES` 和迁移里的策略，`rls.int.test.ts` 会核对两者一致。
- 集成测试需要 `KIOKU_TEST_DATABASE_URL`：本地 `docker compose -f docker-compose.dev.yml up -d --build` 后设为 `postgres://kioku:kioku@localhost:55432/kioku`；没设置时跳过，CI 里没设置直接失败。
- 读权限的规则有两份：`access/access.ts` 的 `canRead`（单条判断）和 `memory/filter.ts` 的 `readableConditions`（SQL）。改一边必须改另一边，`filter.int.test.ts` 会逐条比对。`readableConditions` 也用在记忆事件的前后快照上（`snapshotColumns`），历史与恢复用其中的管理读取（不看有效期与删除状态、人格不限），一致性测试两边都比，不要为快照另写一份规则。
- boot 会被宿主当作指令级上下文，只能收受信来源的策展层（`recall/boot.ts` 的 `BOOT_LAYERS` 与 provenance 过滤）。召回块里的线索文本要经 `inlineText` 处理。原因：群聊写入的内容不能变成主人 agent 的指令。
- URI 要么是共享的，要么按成员各自占用（owner、private 层），二者不共存。冲突只由数据库判断：唯一索引 `memories_uri_live_idx` 保证同一归属不重复，触发器 `memories_uri_exclusive` 保证共享与成员节点互斥（它对 URI 加咨询锁串行检查，不看已失效或过期的记录；有效期变化时也检查，被写的那行自己已经过期时不参与），冲突时服务层把唯一约束错误转成 409。`claimUri` 只负责让出调用方能让出的过期记录；绕开它的写入遇到同一归属的过期记录仍会因唯一索引冲突。已知代价：写共享节点撞上别的成员的私人 URI 时返回 409，写入方能知道这个 URI 被占用（不含内容）。
- 已删除列表的「URI 已被占用」标记（`MemoryService.undeleteConflicts`）在 JS 里照唯一索引、互斥触发器与 `claimUri` 的让出规则（`canRelease`）写了一份：改其中任何一处都要同步改它。`validity.int.test.ts` 逐种拿标记和真去撤销删除的结果比对。原因：标记只用来提前提示，冲突仍以数据库为准，两边不一致时界面会标错。
- 过期的会话与登录失败计数由后台定时任务每小时清理（`jobs/cleanup.ts`）。清理登录计数时跳过被锁住的行：登录的计数事务按「本客户端 → 合计」的顺序加锁，按别的顺序等锁会互相等待成死锁。
- secret 只加密正文：URI、disclosure、关键词仍是明文（树浏览与召回线索要用），不要把机密写进这些字段。
- 部署在反向代理后面时要设 `KIOKU_TRUSTED_PROXIES=<受信代理层数>`，登录限流才能按真实客户端区分；客户端地址从 `X-Forwarded-For` 右边数，最左边的项由请求方填写、可以伪造。不在代理后面时保持 0。没配置受信代理时一律按连接对端区分客户端，请求头不能改变限流行为。 配置了受信代理时，后端端口不能对外直连，否则直连请求可以自己填 `X-Forwarded-For`。
- 登录防护的顺序：先计数（同一用户名 + 客户端 5 次、同一用户名合计 50 次，IPv6 按 /64 计为一个客户端；计数键用 JSON 数组编码，后一级超限时退回前一级）→ 进入 scrypt 并发闸门（全局 4 个运行 + 32 个排队，每个客户端 2 个；繁忙时退回计数）→ 用户名不存在时同样过闸门、占本客户端的名额，但不占全局名额，也不跑 scrypt，等一次校验的时长 → 成功清掉本客户端的计数，并退回这次在合计里占的名额（别人的失败不清）。登录成功下发设备 Cookie（`kioku_device`，服务端签名、绑定当前密码指纹、180 天），带着它不受合计上限约束，改密码后失效。原因：账号存在与否在计数、闸门繁忙、返回内容上表现一致，不能借此探出账号；随机用户名耗不了 CPU、挤不满全局名额；合计上限挡分布式猜测，设备 Cookie 让主人不被它锁住。
- 本地跑集成测试时不要同时开着连同一个数据库的本地服务：服务的 pg-boss 进程会抢走测试的后台任务，导致向量相关的用例超时。
- 迁移里要改 FORCE RLS 的表（`RLS_TABLES`）时，迁移连接没有设置 `app.space_id`，UPDATE / DELETE 会被策略过滤成零行而不报错；需要先 `NO FORCE`、改完再 `FORCE`（见 0010 迁移）。drizzle 把所有待执行的迁移放在一个事务里，中途失败会整体回滚。
- Key 的有效上限 = 签发时的 scopes 再按应用主人当前角色收紧（`clampScopesToRole`）；主人离开空间后 Key 作废。
- 树浏览由调用方读得到的后代推出，路径本身没有记忆的一级显示为虚拟节点（`exists: false`），所以不要求父节点存在、也不限制删除或移动父节点。原因：父子可见性受层、敏感级、来源作用域、成员、有效期共同影响，强制「看得到子就看得到父」会不断出现漏洞。
- 应用的权限按应用主人算，所以只有应用主人能改应用配置、签发和查看它的 Key；空间 owner 只能吊销。
- 管理界面的权限不能超过成员能拿到的 Key：owner 可以写任何应用的应用层与 secret；editor 最高到 private，应用层只能写自己是主人的应用；viewer 只读。写入检查一律经过 `canWrite`，应用层要带上记忆的 `appId`。
- 记忆接口对「读不到」和「不存在」都返回 404，不要改成 403。原因：403 会暴露这里有一条调用方看不见的记忆。
- 流程编号检查扫整行（注释与文案），会把测试数据里「小写 v 加数字」的字符串当迭代标记，也会把前后是空格或标点的S3、R2这类大写字母加数字当编号：测试数据换成别的写法；对象存储在代码与界面文案里写「对象存储」，要点明时写成「兼容S3」（不加空格）。
- 新加的表自动进全实例备份（`backup/tables.ts` 从表定义里取；会话这类恢复后用不上的、能重新生成的，加进它的排除清单）。`backup.int.test.ts` 要求每张进备份的表都有数据，新表要在它的种子里写上一行。原因：恢复按表逐行比对，空表测不出写回的问题。
- 恢复备份时表上的触发器不执行：写回的是已经通过检查的数据，触发器写下的派生数据也在备份里。所以触发器的派生数据要写进进备份的表，不要写进排除清单里的表。
- Lore 导出格式的字面量只写在 contracts 的 `LORE_BACKUP_FORMAT` 那一行，别处都引用常量。原因：规则只写一份，流程编号检查也会把这个字面量当迭代标记（`scripts/lint/comments.sh` 也扫本文件，所以这里不写出来）。
- Lore 导入的计划不含正文：`plan.skipped` 与同步项的 `reason` 会原样进 `/plan` 的响应，新写的跳过原因不能引用正文（坏占位符的片段只有 `quoteMalformed` 打开时才带，只有命令行打开）。测这一点要看原始响应：`LoreImportPlan.parse` 会丢掉契约外的字段，解析后再查永远通过。
- Lore 导入写入的 = 基准计划 − 勾掉的：`planImport` 带 `excludeUris` 时先算一次不勾的计划，勾掉的节点写到的 URI 还占着。只在循环里 continue 的话，映射到同一 URI 的下一个节点会顶上来，而它在看过的计划里没有写入目标，看不到也勾不了。
- Lore 导入写库的 22、23 类错误在 `importer/lore.ts` 里算单条失败，别的在路由里 catch，给固定的 500 文字（界面据此提示可能已写入一部分）。
- Lore 文件旧不旧的基准是导入、同步事件里 `loreExportedAt` 的最大值（没有的是命令行写的，取事件时间）；确认写入旧文件不会降低这个时间。什么都没写的导入不产生事件，也不推进它。原因：同步只看是否相等，文件比已写入的数据旧时会把正文改回去，指纹拦不住。
- Lore 导入的界面：计划显示后表单里不能有 `type=submit` 的按钮，回车的隐式提交会点默认按钮，没看完、没勾 secret 的节点就以明文写进去；`loreBackup.test.ts` 解析模板核对。界面按勾选算的写入（`loreBackup.ts` 的 `selectionEffects`、`staleNotice`）要和服务端按勾选重算的计划一致，它靠同步项的 `source` 等于节点主 URI、`uri` 等于目标 URI 对到目标，应用映射也和 `planImport` 结尾的过滤同一个规则，改这些要同步改它。
- 按长度截断文字要防切开代理对：落单的代理项写进 text 不报错，被悄悄换成 U+FFFD，之后和原文比永远不等（同步每次都算要更新）；写进 jsonb 才报错。
- `BOOT_ELIGIBLE` 有一份 JS 版（contracts 的 `bootEligible`），导入计划标「进启动上下文」、管理界面标「启动加载」都用它。改一边必须改另一边，`loreImport.int.test.ts` 拿写进去的行比对。
- 测试台的回滚模式靠换掉 `Deps.db` 实现（`bench/rollback.ts`），所以接入方路径（工具、生命周期事件、`/recall`）有几条约束。数据库访问都经过传入的 `deps` 或基于它建的服务：绕开 `deps` 的写入不会回滚。语句放进 `withSpace`：直接写在 `deps.db` 上的语句落在根事务上，出错（包括等锁超时）会中止整个运行，后面的步骤记为没有执行；现在只有 `bufferTurn` 读抽取设置这一句是例外。不在事务回调里发外部请求（嵌入、模型）：事务开着时前面步骤的行锁和 URI 咨询锁都没放；接入方路径新增要查向量的步骤时加进 `bench/inProcess.ts` 的 `literalQueries`，否则这一步只走全文与关键词。事务回调里不要并行开子事务：代理只让顶层事务排队，同一条连接上并行的 savepoint 会交错。
- `set_config(..., true)` 与 `set local` 不随 savepoint 成功结束复原，只有 `rollback to` 才复原。`RollbackRun.clearSpace` 只清 `app.space_id`：`recall.ts` 的 `hnsw.*` 也留到回滚为止，它每次向量查询之前都设，所以没有影响；接入方路径上新的向量查询或别的事务级设置不能依赖默认值，否则回滚模式和真实不一样。
- 日志不要整个打可能是数据库错误的 `err`，记进运行记录、最近错误的文字也不要直接用 `err.message`：`DrizzleQueryError` 带 SQL 与全部参数（也就是记忆正文、提示语），驱动的 `PostgresError` 的 `detail` 带数据的值，连接错误的 `message` 是数据库的地址。日志用 `logInternalError` 或 `loggableError(err)`，文字用 `errorText(err)`。
- postgres.js 的参数类型由服务器决定（`infer: false`）：`sql` 模板里的 boolean、Buffer、bigint、数组，查询决定不了类型时不按 JS 类型发。`select ${true}` 回来是字符串，`select ${buf}` 回来是文本，`jsonb_build_object('a', ${true})` 报 `42P18`，`${2n ** 40n} + 1` 按 int4 报 `22003`，都要写 cast。`Date` 经 drizzle 包过的连接不能直接进 `sql` 模板（时间类型的序列化被换成透传）：写 `${d.toISOString()}::timestamptz`。列的写入与比较（`.values`、`.set`、`eq`）由列决定类型，不受影响。
- `pgErrorCode`、`pgConstraint`、`pgMessage` 只解开 `DrizzleQueryError` 的 cause。驱动直接抛的错误不解开：连接错误（`CONNECTION_CLOSED`）自带 cause（`57P01`、`ECONNRESET`），解开就成了另一个错误，连接本身的错误会记成不同的 code（要原因用 `pgCauseCode`）；正在执行的语句另有自己的错误，同一次断连里它报 `57P01`，搜日志时两种都要看。回调接住语句错误时，事务以未包装的 PostgresError reject，字段同样读得到。
- 事务回调结束到 COMMIT 或 ROLLBACK 做完、连接归还之前，驱动还放行句柄上的语句，它们排在后面，落在事务外自动提交；连接归还和断开之后才拒绝（`UNSAFE_TRANSACTION`、`CONNECTION_CLOSED`）。所以事务回调里的语句都要 await 完。回滚模式靠 `RollbackRun.guard` 挡这一段，`inRollback` 在 fn 结束时（成功或抛错，放在 `finally` 里）先 `run.close()` 再让事务回滚，顺序不能换，`rollback.int.test.ts`「回滚做完之前发出的写入」核对这一点。
- 测试：测连接断开直接用 `pg_terminate_backend` 杀（见 `db/__tests__/disconnect.int.test.ts`）：外层事务以 `CONNECTION_CLOSED` 立刻 reject，回调不会停，回调里后面的语句也 reject（经 drizzle 的包在 `cause` 里，开 savepoint 这类驱动直接发的不包）；正在执行的那条语句报 `57P01`。用 `testing/db.ts` 的 `killDuring`：它先接住事务的 promise 再杀，否则 kill 的响应回来之前事务可能已经 reject，算未处理的 rejection，用例偶发失败。测闸门要另开大一点的连接池：测试池 max 2，鉴权会卡在拿连接上，到不了闸门。
- 测试台按 `created_at = now()` 认这个事务写下的行，所以 `memory_events`、`credential_events`、`subjects`、`subject_identities`、`conversation_turns` 在接入方路径上要用数据库默认值，写 JS 时间会漏报。
- 测试台的打码只在 `toView` 和凭据的取用处判断，`contentOf` 不能打码（`applyUpdate` 靠它取原文再封存）。新增返回 `MemoryView` 的路径要经过 `toView`。错误信息不放解出来的内容，不只是打码时（`checkCredentialRefs` 的 `decrypted`）：没有显式查看的路径不能借报错读到正文，也不留访问记录。占位文字集中在 `memory/masked.ts`，新增的要加进 `MASKED_TEXTS`，写入检查才认得；这个文件不能依赖别的模块（`mcp/format.ts` 引用它，又打进不带 postgres 的 `dist/bench.mjs`）。
- 管理界面读记忆默认不给 secret 的正文，Key 读到要留痕，都由 `MemoryContext.secretRead` 决定，判断和记访问事件都在 `toView`，只此一处。新增返回 `MemoryView` 的路径要经过 `toView`，`via` 必填：响应里的正文是调用方刚写的或本来就是明文才传 null。内部路径（导入工具比对）不设它。解密的正文不进 `useQuery` 的缓存（`apps/web/src/secretContent.ts`）。原因：缓存活得比页面长，查看要每次留痕。
- 管理界面的响应是 `ConsoleMemoryView`，比接入方的 `MemoryView` 多 `contentHidden`、`plaintextIgnored`。这两个字段不能加进 `MemoryView`，加了要重新生成 SDK；`toView` 只在 `secretRead` 为 `explicit` 时带上，Key 的响应才不多字段（`c.json` 不会按 schema 剥）。
- 不改记忆的事件（`access`、`ignore_plaintext`、`unignore_plaintext`）只写 `before`，`after` 为 null。原因：界面按 `after.version` 标「现在的版本」，恢复也读 `after`，带上 `after` 就成了能恢复的版本。可见性靠 `before` 的敏感级，所以访问事件要写快照，不能两边都 null：否则降级之后 editor 也看得到之前的访问记录。`access` 不进活动（`activity` 里过滤），历史里另算上限，按保留期清（`retentionRules` 的 `accessEvents`）。
- 忽略明文提示靠 `memories.plaintext_ignored_hash` 和现在的正文比，判断只看这个比较，新的写入路径不处理它也不会判错：SQL（`IGNORED_NOW`）和 JS（`contentHash`）的算法要一致，`plaintextIgnore.int.test.ts` 核对。`applyUpdate` 在正文变化时清掉它：它是含旧值的正文的哈希，能离线猜解；新增改正文的路径也要清。这一列不进事件快照（`UNSNAPSHOTTED`），不随空间导出，改成 secret 时清掉。
- 转存为凭据靠 `scrubValue` 把值从 `memory_events` 里拿掉，只改 `scrubSnapshot` 认得的字段（正文、disclosure、关键词、domain 与 path，Lore 导入事件的 domain 与 path 不动：导入工具靠它们去重）。给快照加新的文字字段时要同步改它。写事件的路径都要先改或锁记忆那一行：否则带着旧正文的事件可能在转存提交之后才写进来，值又回到历史里。
- 路由和测试台共用的处理函数（`lifecycle/handlers.ts`）不在里面新建 scope，由调用方传入，否则测试台关不掉 `record`。路由要显式只取 `LifecycleResponse` 的字段：`c.json` 不会按 schema 剥掉多余字段，`session` 不能加进 `LifecycleResponse`，加了要重新生成 SDK。
- 新路由如果引用接入方的命名组件（`TurnEndEvent`、`SessionContext` 等），要挂在接入方路由后面（测试台路由挂在最后）。原因：OpenAPI 的组件按第一次用到的顺序排，挂早了 `sdks/python/generate.sh --check` 会失败，哪怕接口没变。
- 新加 MCP 工具要写进 contracts 的 `BENCH_READ_TOOLS` 或 `BENCH_WRITE_TOOLS`：命令行握手按这份名单严格核对，`mayWrite` 对不认识的工具按写算。内置场景的 `capture` 与断言依赖工具结果的文字（「版本: 」「URI: 」等），`bench/executor.ts` 也按这些行与 `formatRecallBlock` 解析 URI 列表，改 `mcp/format.ts` 的文字要同步改，门禁里的矩阵会报。测试台步骤的说明与断言文字只展开 `${run}`、`${expires}`，新增命令行默认打印的文字时也不能展开 `capture` 的变量：它可能取到凭据的值。内置预设写记忆要带 `valid_to: EXPIRES`；`${run}`、`${expires}` 是保留的变量名。
- contracts 里的 `isReplayStep`、`mayWrite`、`findPlaintextCredentials` 是「只放 zod 与类型」的例外：服务端、命令行和管理界面要同一份判定。
- 读实例设置的函数（`loadExtractionConfig` 这类）既读库又解密，不要 catch 全部再回 `err.message`：读库出错也会被接住，drizzle 的错误信息带 SQL 与全部参数。用 `settings/endpoint.ts` 的 `unlocked`：只认 `ApiKeyLockedError`，其余重新抛给 `onError`。测读设置出错用 `testing/db.ts` 的 `settingsQueryFails`。
- 带 Key 的 `fetch` 不要把 `err.message` 给调用方或写进日志，也不要放进 `cause`（日志也打印）：Key 中间有换行时，undici 的 Headers 报错会带上整个 Authorization 值，`signal` 已经取消时也先报这个，用 `fetchFailure` 只取错误类别；响应解析失败的文字可能带响应开头（可能回显 Key），用 `upstreamJson`。上游写进报错的 Key 用 `withoutKey`，先换再截断：`fetch` 会去掉结尾的空白，上游见到的 Key 和保存的写法可能不同。保存时已经 `trim` 并拒绝控制字符，但存量 Key 不迁移，这两处不能当多余的删掉。
- 模型代理返回的 `message.tool_calls` 不是严格原样：id 可能是生成的，不是对象的项会被去掉，`arguments` 只放合法的 JSON 对象（原文在 `rawArguments`，只给界面显示）。`tool` 消息的 `tool_call_id` 要用 `toolCalls[i].id`，两者一一对应。
- 测试模型代理：测时限不能靠到点 abort 来结束用例，`requestAgentTurn` 的 catch 先看 `timeout.aborted`，这个信号不管有没有传给 `fetch` 都会按时到期，时限失效时用例照样通过，要和哨兵定时器 `Promise.race`。客户端断开的信号来自 Node 适配器（reason 是字符串，不是 AbortError，要看 `signal.aborted`），`app.request` 走不到，要测断开必须起真实端口。「请求模型期间不占连接」的用例依赖测试连接池只有 2 条。
- 测试台界面：`BenchStepResult.status` 在没带断言时一律是 `passed`，哪怕工具报错，显示调用结果要看 `isError` 与 `internalError`（`benchResult.ts` 的 `stepBadge`）。重放分叉的 `index` 是发出请求时那份日志的下标，结果回来时按当时的 session 记录，所以运行期间不能改 session，新加能动会话的操作都要判断 `running`；`BenchSession` 的 `replay` 与 `replayEntryIds` 下标一一对应，要一起改。新分页放进 `BenchPage` 里 `v-if="mounted" v-show="ready"` 那一层并用 `v-show` 切换：换应用时 Key 要重读，跟着卸载的话草稿与文本框里的场景会丢。
- 测试台的地址会被写回成实际选择：同一页面上不带 `app`、`key` 参数的导航（侧栏入口）不算换选择，要换走 `selectApp`、`selectKey`；按列表判断地址里的选择时只认读取成功且不在刷新的结果（`isSuccess && !isFetching`），否则缓存里的旧列表会冤枉模拟器链接带来的 Key。`useQuery` 的选项在 pre 阶段才更新，按查询结果做判断并写回时要用 post flush（`watchPostEffect`），pre 下会把上一个应用的 Key 写进地址。`hasUnsavedChanges` 是全局一个，一个页面只能注册一份 `useUnsavedChangesGuard`，测试台由 `createBench` 注册，分页通过 `unsaved` 报上去。`abandoned` 不随 `generation` 清掉，新增调用 `execute` 的地方要传 `label` 与 `view`。`useUnsavedChangesGuard` 注册时就读一次 `dirty`，用到的状态要先建好，否则页面打开就抛 TDZ 错误。
- 权限探测靠「capture 」开头认出 capture 没取到的断言（`benchResult.ts`），改 `runner.ts` 里这句说明要一起改，`runner.test.ts` 钉住了这个开头。
- 模型对话的循环占着 `current`，`running` 在模型请求之间也是 true：循环里的运行要走 `runAs` 并用同一个序号，走 `execute` 会直接返回 stale；作废之后旧的 `sendAgentMessage` 还会跑到结束，写对话只能经 `onChange` 里 `current.value === id` 的判断。发给模型的是 `AgentConversation.messages`，只在 `finish` 时提交，`exchanges` 只用来显示：新增结束路径时要先把这一轮的 `tool` 消息都答上再 `finish`（`benchAgent.test.ts` 的 `historyProblem` 每次请求模型都核对）。判断工具结果时 `internalError` 为真不一定带 `isError`（根事务中止时工具本身没报错），只看 `isError` 会把它的文字当成正常结果。
- `benchScenarios.ts` 的明文检测按工具名判断：新增能写记忆正文或能改 URI 的工具要同步改 `writesMemory` 与 `kioku_move` 的分支，否则导出时不提示。`apps/web/src/__tests__/benchTools.fixture.json` 是真实 `tools/list` 的快照，改了工具 `inputSchema` 的形状要重新生成，否则用例测的是旧形状、也不会变红。
- 硬删除记忆时 Lore 的导入事件（出处 `source` 为 `lore`）要留下（`memory_id` 置空、快照只留 domain 与 path），别的事件一起删，包括按空间导入的导入事件。原因：Lore 导入工具按导入事件去重，记忆整行不在时也认作「导入过、后来删掉了」；删掉这些事件，下次同步会把删过的节点写回。保留期的删除条件都在 `jobs/retention.ts` 的 `retentionRules`，改了要对照 `retention.int.test.ts`。
- 「用户删掉」与「过期后被让出 URI」不加标记列，按删除时间与过期时间的先后区分（已删除列表、已过期列表、撤销删除与重新生效都靠它）。所以写 `deleted_at` 时要守住：用户删除只删在同一时刻仍有效的行、删除时间写这一刻；`claimUri` 只让出同一时刻已过期的行。新增删除路径时照这个写。
- `memories_uri_exclusive()` 前后好几个迁移都用 CREATE OR REPLACE 改过，后一个会整个覆盖前一个：再改时以最新那个迁移里的函数为准，把前面加的条件一起带上（0023 里有：被写的行自己过期就不检查、导入自己刚建的空间时不加咨询锁）。`app.importing_space` 只给按空间导入的事务设，别的写入设了会跳过这把锁。
- 合并对象的步骤在 `access/subjects.ts`，管理界面的手动合并与 `/bind` 共用，规则只写一份；合并时要作废牵涉到两边的待确认绑定，并把绑定记录改指向保留的对象。
- Dream 的建议只经 `MemoryService.applySuggestion` 改记忆；`dream_suggestions` 用 id 与版本的数组引用记忆，没有外键，「建议还作不作数」只按版本判断，规则只有一处（SQL 的 `suggestionCurrent`，锁到行之后用 `isCurrentVersion`），列表、执行与保留期都用它。
- Dream 找要整理的记忆靠 `dream_marks`（记忆 id 对应整理过的版本），不靠更新时间：导入的记忆保留原来的更新时间，按时间推进的游标会永远看不到它们。
- 迁移文件合并之后不要再改（包括注释）：恢复备份时按最后一个迁移的哈希核对库的结构，改过的文件会让之前的备份恢复不了。
- 在 Mac 上用非交互会话（agent 的 shell）拉镜像会卡在钥匙串，需要用不带 credsStore 的 `DOCKER_CONFIG`。
