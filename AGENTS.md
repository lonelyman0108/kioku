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
- 硬删除记忆时导入事件要留下（`memory_id` 置空、快照只留 domain 与 path），别的事件一起删。原因：Lore 导入工具按导入事件去重，记忆整行不在时也认作「导入过、后来删掉了」；删掉导入事件，下次同步会把删过的节点写回。保留期的删除条件都在 `jobs/retention.ts` 的 `retentionRules`，改了要对照 `retention.int.test.ts`。
- 「用户删掉」与「过期后被让出 URI」不加标记列，按删除时间与过期时间的先后区分（已删除列表、已过期列表、撤销删除与重新生效都靠它）。所以写 `deleted_at` 时要守住：用户删除只删在同一时刻仍有效的行、删除时间写这一刻；`claimUri` 只让出同一时刻已过期的行。新增删除路径时照这个写。
- 迁移文件合并之后不要再改（包括注释）：恢复备份时按最后一个迁移的哈希核对库的结构，改过的文件会让之前的备份恢复不了。
- 在 Mac 上用非交互会话（agent 的 shell）拉镜像会卡在钥匙串，需要用不带 credsStore 的 `DOCKER_CONFIG`。
