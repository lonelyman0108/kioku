<p align="center"><img src="apps/web/public/favicon.svg" width="88" alt="Kioku"></p>

<h1 align="center">Kioku · 記憶</h1>

<p align="center"><b>记忆有归属，也有深浅。</b></p>

<p align="center">
同一个人格，接进编码 agent、个人助理与群聊机器人。<br>
每段记忆落在自己的地层里，换一个场合，想起的就不一样。
</p>

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2A2B26?style=flat-square" alt="Apache-2.0"></a>
<img src="https://img.shields.io/badge/self--hosted-2_containers-2A2B26?style=flat-square" alt="自托管，两个容器">
<img src="https://img.shields.io/badge/PostgreSQL-pgvector_·_zhparser-2A2B26?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
</p>

<p align="center">
<a href="#快速开始">快速开始</a> ·
<a href="#接入">接入</a> ·
<a href="docs/design.md">设计</a> ·
<a href="docs/deploy.md">部署与运维</a> ·
<a href="https://github.com/lonelyman0108/kioku-plugins">插件</a>
</p>

## 三个场合

> **在 Claude Code 里定下的项目约定**，第二天换到 Codex，它照样记得。
>
> **群里的机器人借用同一个人格说话**，口吻一致，却读不到你的私人记忆。
>
> **群友在这个群聊过的事**，记在这个群友名下；换个群，不会串。

靠的不是提示词里一句「请勿泄露」，而是检索之前服务端就已裁掉：访问密钥定上限，会话上下文再收一次，PostgreSQL 行级安全兜底。

## 地层

```text
  会话     这一段对话              ┐ 从对话里记下
  联系人   群友、群                ┘
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  本人     每个成员各一份          ┐
  应用     一个客户端              │ 有坐标的目录
  人格     soul 与口吻，可继承     │ user://  app://  persona://  core://
  通用     整个空间                ┘
```

越往下越通用。每条记忆另有一个敏感级：公开、内部、私密、机密，机密只存密文。

## 为什么是 Kioku

- **隔离在服务端，不在提示词。** 范围来自鉴权身份，不来自请求参数；空间之间由行级安全隔开。
- **人格是一等对象。** 可以继承，可以借给多个应用，也可以按群切换。
- **不会写记忆的模型也有记忆。** 从对话里自动抽取事实与摘要，后台整理去重、合并。
- **事实会过期。** 新事实取代旧事实时标记失效，每一版都留着，可以恢复。
- **密码不进记忆。** 正文只留 `{{cred:<标识>}}`，值在 Kioku 或连接的 Bitwarden；`kioku run` 经环境变量交给命令。
- **数据不出门。** 两个容器，不向第三方请求字体与图标，加密备份到兼容S3的对象存储。

## 快速开始

```bash
git clone https://github.com/lonelyman0108/kioku && cd kioku
cp .env.example .env          # 按注释生成密码与主密钥
docker compose -f docker-compose.example.yml up -d --build
```

打开 `http://127.0.0.1:18920`，初始化第一个账号与空间。用局域网的 `http://` 地址访问、或要经 HTTPS 对外时，先看 [部署与运维](docs/deploy.md)。

## 接入

```bash
npx @kioku-memory/cli login codex --server-url https://kioku.example.com
```

终端给出确认码，在管理界面的确认页输入、选好权限，访问密钥直接写进本机配置，全程不显示。

| 平台 | 启动加载 | 每轮召回 | 会话摘要 | 记忆工具 |
|---|:-:|:-:|:-:|:-:|
| Claude Code | ● | ● | ● | ● |
| Codex | ● | ● | ● | ● |
| pi | ● | ● | ● | ● |
| Hermes | ● | ● | ● | ● |
| OpenClaw | ● | ● | ● | ● |
| DeepSeek Harness | ● | ● | ● | ● |
| AstrBot（群聊机器人） | 人格 | ● | 对话抽取 | — |
| 任意 MCP 客户端 | — | — | — | ● |

各平台的安装见 [kioku-plugins](https://github.com/lonelyman0108/kioku-plugins)；MCP 地址是 `/v1/mcp`，其余接口见 `/v1/openapi.json`。用过 Lore 的：[从 Lore 迁移](docs/migrate-from-lore.md)。

## 开发

```bash
scripts/bootstrap.sh && pnpm install
pnpm dev                      # 后端 18920，管理界面 5173
scripts/check.sh              # 门禁，与 CI 一致
```

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端：Hono + zod-openapi |
| `apps/web` | 管理界面：Vue 3 + Nuxt UI 4 |
| `packages/contracts` | 前后端与 SDK 共用的 zod 契约 |
| `sdks/python` | 由 OpenAPI 生成的 Python 客户端 |

规范见 [CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md)，文档索引见 [docs/README.md](docs/README.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[Apache-2.0](LICENSE)。部分算法源自 [Lore](https://github.com/FFatTiger/lore)（MIT），声明见 [NOTICE](NOTICE)。
