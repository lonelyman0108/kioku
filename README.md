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

**HTTPS 与反向代理**：对外提供服务时在前面加 HTTPS 反向代理，`KIOKU_COOKIE_SECURE` 保持 `true`，`KIOKU_TRUSTED_PROXIES` 设为代理层数（一层就是 `1`），登录限流才能拿到真实的客户端地址。同时在 `.env` 里设 `KIOKU_BIND=127.0.0.1`，端口只给本机的代理访问：否则别人可以绕过代理直连，自己填 `X-Forwarded-For`。是否发 HSTS 由代理决定，服务本身不发。

**备份**：数据都在数据库里，`KIOKU_MASTER_KEY` 另外保存（丢了它，secret 级记忆无法解密）。备份要用数据库超级用户：应用角色受行级安全约束，用它导出会报错。备份文件不要放在仓库目录里，构建镜像时会被带进构建上下文。

```bash
mkdir -p ~/kioku-backup
docker compose -f docker-compose.example.yml exec db pg_dump -U postgres -Fc kioku > ~/kioku-backup/kioku-$(date +%F-%H%M%S).dump
```

**升级**：先按上面备份，再拉取新代码、重新执行 `up -d --build`，启动时自动迁移数据库。迁移只向前。

**嵌入模型**：在「实例设置 → 嵌入模型」里配。一个模型可以配几个渠道（同一个模型的不同接口），按顺序请求，前一个出错时换下一个；服务商给模型改了名，只改渠道里「请求用的模型名」，不用重新生成向量。换成别的模型用「换模型」：填新模型的标识与渠道，后台为全部记忆生成新模型的向量，召回在补齐之前一直用原来的模型，补齐后自动切过去、删掉旧的向量；补不上时可以不等补齐直接切换，也可以放弃。整个过程不用改数据库。向量固定 1024 维，换的模型要能按 `dimensions` 参数输出 1024 维（「测试连通」会检查）。

**回滚**：停掉服务，把已经迁移到新版本的库改名留着，建一个空库，把升级前的备份恢复进去，然后换回旧版本的代码启动。不能直接往旧库里 `pg_restore --clean`：新版本建的表和函数不在备份里，会残留下来，下次升级时迁移会因为它们已存在而失败。

```bash
docker compose -f docker-compose.example.yml stop kioku
docker compose -f docker-compose.example.yml exec db psql -U postgres -c 'ALTER DATABASE kioku RENAME TO kioku_upgraded'
docker compose -f docker-compose.example.yml exec db createdb -U postgres -O kioku kioku
docker compose -f docker-compose.example.yml exec -T db pg_restore -U postgres --exit-on-error -d kioku < ~/kioku-backup/<升级前的备份>.dump
```

恢复失败时（例如备份文件不完整）删掉新建的 `kioku`，再把 `kioku_upgraded` 改回 `kioku`，回到升级后的状态。旧版本确认正常之后再删掉 `kioku_upgraded`（`exec db dropdb -U postgres kioku_upgraded`）。

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL 连接串。角色不能是超级用户或带 `BYPASSRLS`，否则拒绝启动 |
| `KIOKU_MASTER_KEY` | 空 | 32 字节随机数的 base64（`openssl rand -base64 32`）。用来加密 secret 级记忆、Kioku 托管的凭据值，以及实例设置里嵌入接口与抽取模型的 Key，不设置时这几项都不能用 |
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
