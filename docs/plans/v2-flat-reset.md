# V2 扁平单人架构重构计划

面向单人自托管 Coding Agent 与个人助理记忆场景，移除群聊机器人、多账号 RBAC、多记忆圈 RLS、多变体切片、Bitwarden 密码库接入、重型 DLP/PII 拦截、测试台、旧版导入器、S3 定时备份与召回分析，收拢为轻量扁平闭环（12 张核心表、8 个 MCP 工具、3+1 管理界面）。

## 阶段清单

### 阶段 1：契约重置、数据库基线与废弃模块清理
- [x] 删除 `sdks/python/` 与服务端废弃目录/路由/CLI/测试夹具，移除 `aws4fetch` 并精简 `apps/server/tsdown.config.ts`
- [x] 重写 `packages/contracts/src/`（扁平词条、极简托管凭据、4 类 Dream 建议、扁平 API Key 与终端在场切面、兼容 `kioku-plugins` 的生命周期与设备授权契约）并通过 `@kioku/contracts` 类型检查与单元测试
- [x] 重写 `apps/server/src/db/`（12 张扁平表、无 RLS、无超管阻断）并重新生成 `apps/server/migrations/0000_baseline.sql` 与 `meta/_journal.json`（保留 `kioku_zh` 分词配置，`when > 1795008216860`）
- [x] 在本地 PostgreSQL 验证 `0000_baseline.sql` 全新执行通过
- [x] 契约与表结构交叉复核通过并提交

### 阶段 2：服务端核心引擎与凭据重构
- [x] 重写认证、单人初始化、`access/scope.ts`（静态 `allowed_realms` 边界）与简化主密钥启动检查/同步重封
- [x] 重写扁平 `memory/service.ts`（CRUD、筛选、软删/恢复、单条版本历史、`[[m-xxxxxx]]` 双链、Dream 建议应用）
- [x] 重写极简托管 `credential/service.ts`（AES-256-GCM 加密 KV + `POST /v1/credentials/resolve`）
- [x] 重写精简 `models/`（单 OpenAI 兼容 Embedding + 单 OpenAI 兼容 Chat）与 `embedding/`

### 阶段 3：在场引擎、后台任务与接入层
- [x] 实现 V2 在场引擎：`recall/boot.ts`（常驻词条去冲突 + `(device_key, project_slug)` 摘要）、`recall/recall.ts`（向量 + BM25 + 场景加减分 + 一跳双链）
- [x] 实现简化 `extraction/`（`turn.end` 摘要缓冲与抽取 + 4 类 Dream 整理）与 5 队列 `jobs/`（`embed-entry`、`embed-backfill`、`extract-episode`、`dream`、`cleanup-expired`）
- [x] 重写 12 个路由模块、`mcp/server.ts`（8 工具）、`lifecycle/`、`app.ts`、`service.ts` 与 `cli/ctl.ts`

### 阶段 4：管理界面 3+1 重构（`apps/web`）
- [x] 删除废弃页面、组件与 6×4 地层视觉体系，迁移保留的基础 UI 原语并更新主题与文案规则测试
- [x] 实现 3+1 核心界面：记忆双栏（`/memories`）、待处理（`/inbox`）、凭据（`/credentials`）、设置 3 标签（`/settings`）及极简 `/authorize`、`/setup`、`/login`

### 阶段 5：精简测试套件、文档与完整门禁
- [x] 重建聚焦的 V2 服务端与前端单元/集成测试（契约 3 文件 10 用例、前端 16 文件 101 用例、服务端 17 文件 47 用例）
- [x] 更新 `README.md`、`AGENTS.md`、`docs/design.md`、`docs/adr/0004-flat-single-owner-v2.md` 及运维文档
- [x] 通过完整 `scripts/check.sh` 门禁（36 测试文件 / 158 用例、typecheck、eslint、prettier、build 与安全审查修复全绿）
- [x] 通过本地 Chrome DevTools MCP 端到端可视化与交互走查（浅/深色、宽/窄屏、零控制台错误、零第三方请求、零 4xx/5xx，并修复表头对齐与标签失焦提交）
- [ ] 镜像冒烟测试（`smoke-image.sh`）
