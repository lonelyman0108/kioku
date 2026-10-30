# Kioku

面向多个 AI 应用的自托管长期记忆服务：多账号、多人格，记忆分层并按接入方授权。

## 做什么

Kioku（記憶）给 Claude Code、OpenClaw、AstrBot 这类 agent 和聊天机器人提供同一套长期记忆。它和普通记忆层的区别在于：

- **多账号**：每个人类账号有独立的记忆空间；同一个 bot 面对的每个群友、每个群也各有独立的记忆。
- **多人格**：人格（soul、口吻、自我认知）是一等对象，可以继承，可以被多个应用借用。
- **分层与授权**：每条记忆有「层」（归属）和「敏感级」（可见性）两个维度。服务端根据 API Key 和会话上下文裁剪检索结果，例如群聊里能借用人格，但读不到主人的私人信息。
- **完整生命周期**：启动注入、每轮召回、对话自动抽取、后台整理（Dream）、事实有效期。

设计见 [docs/design.md](docs/design.md)。

## 本地运行

```bash
scripts/bootstrap.sh      # 克隆后执行一次：启用提交钩子、检查工具
scripts/check.sh          # 门禁：与 CI 完全一致
```

需要 Node.js 22 及以上与 pnpm（`corepack enable pnpm`）。

```bash
pnpm install
pnpm dev                  # 后端 http://localhost:18920，管理界面 http://localhost:5173（/v1 代理到后端）
```

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端：Hono + zod-openapi，接口文档在 `/v1/openapi.json` |
| `apps/web` | 管理界面：Vue 3 + Nuxt UI 4 单页应用 |
| `packages/contracts` | 前后端与 SDK 共用的 zod 契约 |

## 部署或安装

服务端镜像同时托管管理界面，加上带 pgvector 与中文分词的 PostgreSQL，一共两个容器。在仓库根目录：

```bash
cp .env.example .env      # 按注释生成密码与主密钥
docker compose -f docker-compose.example.yml up -d --build
```

启动前在 `.env` 里定下 `KIOKU_COOKIE_SECURE`：经 HTTPS 访问时保持 `true`；只在局域网用 `http://` 地址访问时改成 `false`，否则浏览器不保存登录 Cookie，登录后会一直回到登录页（`http://localhost` 例外，浏览器把它当安全地址）。

打开 `http://<主机>:18920`，首次进入初始化页，建第一个账号和空间。之后在「应用与 Key」里为每个接入方建应用、签发 Key：

- MCP：`http://<主机>:18920/v1/mcp`（Streamable HTTP，`Authorization: Bearer <Key>`）
- 生命周期钩子：`POST /v1/lifecycle/event`；其他接口见 `/v1/openapi.json`

**HTTPS 与反向代理**：对外提供服务时在前面加 HTTPS 反向代理，`KIOKU_COOKIE_SECURE` 保持 `true`，`KIOKU_TRUSTED_PROXIES` 设为代理层数（一层就是 `1`），登录限流才能拿到真实的客户端地址。同时在 `.env` 里设 `KIOKU_BIND=127.0.0.1`，端口只给本机的代理访问：否则别人可以绕过代理直连，自己填 `X-Forwarded-For`。是否发 HSTS 由代理决定，服务本身不发。测试台的模型对话一次请求可能要一两分钟（服务端的时限是 120 秒），代理的读超时要大于它，否则界面上看到的是 504。

**测试台**：管理界面的「测试台」不接任何客户端，按一把 Key 模拟接入方：调工具、发生命周期事件（可选私聊、群聊上下文）、回放场景与断言，配了抽取模型时还能接真实模型跑一段对话，看它会不会按指引调工具。默认放进事务、结束时回滚，并列出真执行会改什么；切到真实执行要确认。只给应用主人，模型对话还要实例管理员。同一份场景也能用真实 HTTP 与真实 Key 跑（这是真实调用，写操作要加 `--allow-writes`，会记召回事件）：

```bash
docker compose -f docker-compose.example.yml exec -e KIOKU_BENCH_KEY=<Key> kioku \
  node server/dist/bench.mjs --url http://localhost:18920
```

**备份**：在「实例设置 → 备份」里配一个 S3 兼容的对象存储（MinIO、Cloudflare R2、Backblaze B2 等），每天定时把整个实例加密备份上去、只留最近几份；没做成时实例设置和概览里都会提示原因。也可以用命令把整个实例导出成一个加密的文件，服务运行时也可以做。文件用主密钥派生的密钥加密，`KIOKU_MASTER_KEY` 另外保存（丢了它，备份和 secret 级记忆都解不开）。备份里没有会话与登录计数、对话缓冲和向量，其余全在。备份文件不要放在仓库目录里，构建镜像时会被带进构建上下文。

```bash
mkdir -p ~/kioku-backup
docker compose -f docker-compose.example.yml exec -T kioku node server/dist/backup.mjs --out - > ~/kioku-backup/kioku-$(date +%F-%H%M%S).backup
```

**恢复到新实例**：新实例的 `.env` 里配做备份时的 `KIOKU_MASTER_KEY`（备份之后轮换过的话，新的那把配在 `KIOKU_MASTER_KEY`，做备份时的配在 `KIOKU_MASTER_KEY_PREVIOUS`），数据库是新建的空库，恢复之前不要启动服务。恢复先核对格式、主密钥与迁移，把迁移执行到做备份时的位置，再按原来的 id 写回并执行这个版本新增的迁移（较早版本做的备份也能用新版本恢复）；写回与新增的迁移在一个事务里，失败时数据一条也不留下，可以直接重试；库里已经有账号或空间时拒绝。恢复先把整份备份解开、核对过才写库，内存要放得下解压后的备份（通常是备份文件的几倍大）。恢复之后所有人重新登录，Key 照常可用，向量在后台重新生成。

```bash
docker compose -f docker-compose.example.yml build
docker compose -f docker-compose.example.yml run --rm -T kioku node server/dist/restore.mjs --file - < ~/kioku-backup/<备份>.backup
docker compose -f docker-compose.example.yml up -d
```

定时备份传到了 S3 兼容存储时，也可以直接从存储桶取最新的一份恢复：先在当前终端里 `export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…`（区域不是 `us-east-1` 时再加 `AWS_REGION`，临时凭据再加 `AWS_SESSION_TOKEN`），再把上面的 `restore.mjs --file -` 一行换成：

```bash
docker compose -f docker-compose.example.yml run --rm -T -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION kioku \
  node server/dist/restore.mjs --s3-endpoint https://s3.example.com --s3-bucket <存储桶> --s3-prefix <前缀>
```

恢复时会清掉备份存储的设置，免得试恢复的实例和正在用的实例往同一个目录写、互相删掉对方的备份；确认新实例要接着用之后，在实例设置里重新配备份。

恢复出的实例暂停保留期的清理，到恢复的时间加上保留天数为止：恢复出的已删除记录按删除的时间早就过了保留期，照常清理会马上把它们永久删掉。要从备份里找回的东西在这之前撤销删除；之后自动照常清理，也可以在「实例设置 → 保留期」里提前开始。

**保留期**：删掉的记忆（连同历史、向量、关键词与召回统计）、被新事实推翻的抽取事实、过期的会话摘要，以及抽取记录、Dream 的运行记录与作废了的建议、凭据事件、已删除的凭据与凭据源，过了保留期（默认 30 天，在「实例设置 → 保留期」里改）由每天一次的清理永久删除，每类删了多少在那里看得到。保留期内删掉的记忆与凭据能在管理界面撤销删除，更早的只能从备份里找回。过了「有效到」、没有删除的策展记忆不清。升级到有保留期的版本之后，第一次清理先暂停一个保留期（之前删掉的到这时都还能撤销），之后自动开始，也可以在那里提前开始；暂停期间删账号留下的历史照常清理。

**把一个空间搬到另一个实例**：空间 owner 在「空间设置 → 导出这个空间」里设一个口令（至少 12 位），下载一个用口令加密的文件；实例管理员在另一个实例的「实例设置 → 导入空间」里上传它、填同一个口令，先检查文件（看清是谁导出的、有多少），再确认导入成一个新空间，自己是 owner。文件里是共享的记忆、人格、应用配置与对象，加上导出人自己的画像、私人层、凭据与凭据源（secret 记忆与托管的凭据值一起加密带走，导入时用目标实例的主密钥重新加密，所以两边的主密钥可以不同，但目标实例要配了主密钥）；导出人的这些东西导入后都归导入人，画像层会进导入人的 agent 的启动上下文，所以只导入自己导出的、或者导出人同意交给你的文件。别的成员的私人内容、Key、会话、召回记录、对话缓冲、抽取记录、历史与向量都不带，导入之后给应用重新签发 Key，向量在后台重新生成。口令另外保存好，Kioku 不保存它，丢了就打不开文件。文件最大 32 MB。

**升级**：先做一份整库快照（回滚时用），再拉取新代码、重新执行 `up -d --build`，启动时自动迁移数据库。迁移只向前。快照要用数据库超级用户：应用角色受行级安全约束，用它导出会报错。

```bash
docker compose -f docker-compose.example.yml exec db pg_dump -U postgres -Fc kioku > ~/kioku-backup/kioku-$(date +%F-%H%M%S).dump
```

**轮换主密钥**：把现在的主密钥移到 `KIOKU_MASTER_KEY_PREVIOUS`，新生成的一把填进 `KIOKU_MASTER_KEY`，重启。后台会把还是旧密钥包装的数据密钥逐条换成新的包装（正文的密文不动，已删除的也换），「实例设置 → 主密钥」里看得到还剩多少条；显示换完之后删掉 `KIOKU_MASTER_KEY_PREVIOUS` 再重启，新密钥另外保存好。没换完就去掉旧的那把，服务会拒绝启动并提示配回去。轮换之后，之前的备份要用旧主密钥恢复。

**嵌入模型**：在「实例设置 → 嵌入模型」里配。一个模型可以配几个渠道（同一个模型的不同接口），按顺序请求，前一个出错时换下一个；服务商给模型改了名，只改渠道里「请求用的模型名」，不用重新生成向量。换成别的模型用「换模型」：填新模型的标识与渠道，后台为全部记忆生成新模型的向量，召回在补齐之前一直用原来的模型，补齐后自动切过去、删掉旧的向量；补不上时可以不等补齐直接切换，也可以放弃。整个过程不用改数据库。向量固定 1024 维，换的模型要能按 `dimensions` 参数输出 1024 维（「测试连通」会检查）。

**回滚**：停掉服务，把已经迁移到新版本的库改名留着，建一个空库，把升级前的快照恢复进去，然后换回旧版本的代码启动。不能直接往旧库里 `pg_restore --clean`：新版本建的表和函数不在快照里，会残留下来，下次升级时迁移会因为它们已存在而失败。

```bash
docker compose -f docker-compose.example.yml stop kioku
docker compose -f docker-compose.example.yml exec db psql -U postgres -c 'ALTER DATABASE kioku RENAME TO kioku_upgraded'
docker compose -f docker-compose.example.yml exec db createdb -U postgres -O kioku kioku
docker compose -f docker-compose.example.yml exec -T db pg_restore -U postgres --exit-on-error -d kioku < ~/kioku-backup/<升级前的快照>.dump
```

恢复失败时（例如快照文件不完整）删掉新建的 `kioku`，再把 `kioku_upgraded` 改回 `kioku`，回到升级后的状态。旧版本确认正常之后再删掉 `kioku_upgraded`（`exec db dropdb -U postgres kioku_upgraded`）。

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL 连接串。角色不能是超级用户或带 `BYPASSRLS`，否则拒绝启动 |
| `KIOKU_MASTER_KEY` | 空 | 32 字节随机数的 base64（`openssl rand -base64 32`）。用来加密 secret 级记忆、Kioku 托管的凭据值，以及实例设置里嵌入接口与抽取模型的 Key，不设置时这几项都不能用 |
| `KIOKU_MASTER_KEY_PREVIOUS` | 空 | 只在轮换主密钥期间配：旧的那把主密钥，见上面的「轮换主密钥」 |
| `KIOKU_COOKIE_SECURE` | `true` | 登录 Cookie 是否只走 HTTPS。浏览器在 localhost 上也接受；用局域网 HTTP 地址访问时设为 `false` |
| `KIOKU_TRUSTED_PROXIES` | `0` | 前面有几层受信任的反向代理。按层数从 `X-Forwarded-For` 右边取客户端地址；没有代理时保持 `0`，否则地址可以伪造 |
| `KIOKU_BIND` | `0.0.0.0` | 只用于 compose 示例：端口发布到哪个地址。放在反向代理后面时设为 `127.0.0.1` |
| `PORT` | `18920` | 监听端口 |
| `KIOKU_WEB_DIR` | `apps/web/dist` | 管理界面构建产物的目录；目录不存在时只提供 API |
| `KIOKU_MIGRATIONS_DIR` | `apps/server/migrations` | 数据库迁移目录 |
| `KIOKU_VERSION` | `dev` | `/v1/health` 显示的版本号 |

## 文档

- 设计：[docs/design.md](docs/design.md)
- 从 Lore 迁移：[docs/migrate-from-lore.md](docs/migrate-from-lore.md)
- 贡献规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- agent 工作约定：[AGENTS.md](AGENTS.md)
- 文档索引：[docs/README.md](docs/README.md)
- Claude Code 插件：[plugins/claude-code/README.md](plugins/claude-code/README.md)
- AstrBot 插件（群聊 bot）：[plugins/astrbot_plugin_kioku/README.md](plugins/astrbot_plugin_kioku/README.md)
- 更新日志：[CHANGELOG.md](CHANGELOG.md)

## 许可证

[Apache-2.0](LICENSE)。部分算法源自 [Lore](https://github.com/FFatTiger/lore)（MIT），声明见 [NOTICE](NOTICE)。
