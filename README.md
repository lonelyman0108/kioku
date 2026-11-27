<p align="center"><img src="apps/web/public/favicon.svg" width="88" alt="Kioku"></p>

<h1 align="center">Kioku · 記憶</h1>

<p align="center"><b>给 Coding Agent 与个人助理的自托管长期记忆和托管凭据服务。</b></p>

<p align="center">
跨终端、跨项目、跨客户端共享同一套扁平记忆库；<br>
按当前设备与场域自动装配上下文，把秘密锁在上下文之外。
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

## 核心能力

- **扁平短 ID 与双向双链。** 每条记忆由服务端分配全局唯一、不可变的无歧义 Base30 短 ID（`m-xxxxxx`），无需先编造目录树；正文用 `[[m-xxxxxx]]` 建立双链，召回时沿双链做一跳语境扩散。
- **四维在场引擎（Presence Engine）。** 记忆直接标记 `envs`、`realms`、`projects`、`runtimes` 四维场景标签：会话启动时按当前终端环境自动去冲突编译常驻记忆，并附带同设备同项目的近期会话摘要；每轮召回融合 1024 维 pgvector 向量语义、PostgreSQL `kioku_zh` 中文分词 BM25、场景亲和加减分与一跳双链（未配置嵌入模型时自动降级纯全文）。
- **服务端静态硬边界。** 访问密钥（`api_keys`）独立限定 `allowed_realms`、读写与凭据权限，在检索前由服务端硬过滤，而不是靠提示词约束；限定场域的密钥访问凭据时严格执行失败即拒绝（fail-closed）。
- **密码不进上下文（Muse 风格托管凭据）。** 密码与令牌以 AES-256-GCM 信封加密独立存放在 `credentials` 表，记忆正文只写 `{{cred:<slug>}}`；Agent 只见元数据，执行命令时经 `kioku run` 一次性原子注入子进程环境变量。
- **自动摘要与审阅式整理。** 后台从 `turn.end` 提炼会话摘要，定期或手动巡检提出「提炼摘要、合并重复、标记过时、更新内容、规范精简、补全双链、调整常驻」七类建议；不静默篡改记忆，在管理界面「整理」页确认后才按版本校验落库。
- **极简 3+1 管理界面与零外联自托管。** 纸墨零圆角控制台仅设「记忆 / 整理 / 凭据 / 设置」四项主导航，支持版本历史回滚与 JSON / Markdown 导出；服务端与 PostgreSQL 两个容器，不向第三方请求字体与图标。

## 快速开始

```bash
curl -fsSLO https://raw.githubusercontent.com/lonelyman0108/kioku/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/lonelyman0108/kioku/main/.env.example   # 按注释生成密码与主密钥
docker compose up -d
```

打开 `http://127.0.0.1:18920`，输入日志里的初始化码（`docker compose logs kioku`），创建实例账号即可开始使用。需要局域网 HTTP 访问、HTTPS 反向代理、从源码构建或主密钥轮换时，先看 [部署与运维](docs/deploy.md)。

## 接入

```bash
npx @kioku-memory/cli
```

不带参数即可进入交互式向导：扫描本机已安装的 Coding Agent，选定后打开浏览器 `/authorize` 页面输入确认码批准，命令行为各工具写好配置，访问密钥明文全程不经过浏览器。

| 平台 | 启动加载 | 每轮召回 | 会话摘要 | MCP 记忆工具 |
|---|:-:|:-:|:-:|:-:|
| Claude Code | ● | ● | ● | ● |
| Codex | ● | ● | ● | ● |
| Gemini CLI | ● | ● | ● | ● |
| Antigravity | ● | ● | ● | ● |
| OpenCode | ● | ● | ● | ● |
| pi | ● | ● | ● | ● |
| Hermes | ● | ● | ● | ● |
| OpenClaw | ● | ● | ● | ● |
| DeepSeek Harness | ● | ● | ● | ● |
| ZCode | ● | ● | ● | ● |
| 任意 MCP 客户端 | — | — | — | ● |

各平台插件与 `kioku run` 命令行维护在 [kioku-plugins](https://github.com/lonelyman0108/kioku-plugins)；MCP 端点为 `/v1/mcp`（Streamable HTTP，提供 `kioku_boot`、`kioku_search`、`kioku_get`、`kioku_browse`、`kioku_create`、`kioku_update`、`kioku_delete`、`kioku_list_credentials` 八个工具），完整 HTTP 契约见 `/v1/openapi.json`。

## 开发

```bash
scripts/bootstrap.sh && pnpm install
pnpm dev                      # 后端 18920，管理界面 5173
scripts/check.sh              # 门禁，与 CI 一致
```

| 目录 | 内容 |
|---|---|
| `apps/server` | 后端：Node 22 + Hono + zod-openapi + Drizzle + pg-boss（12 张扁平表） |
| `apps/web` | 管理界面：Vue 3 + Nuxt UI 4（3+1 工作台，由后端托管） |
| `packages/contracts` | 前后端共用的 zod 契约与纯工具函数 |

规范见 [CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md)，文档索引见 [docs/README.md](docs/README.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[Apache-2.0](LICENSE)。部分算法与设计灵感源自 [Lore](https://github.com/FFatTiger/lore)（MIT），声明见 [NOTICE](NOTICE)。
