# 0004. 收拢为扁平单人长期记忆与托管凭据架构（V2 重置）

- 状态：生效（2026-11-24）
- 日期：2026-11-24

## 背景

[0001](0001-circles-and-lens-isolation.md)、[0002](0002-short-id-variants-and-links.md) 与 [0003](0003-faceted-presence-engine.md) 确立了一套完整的多租户与群聊机器人架构：多账号 RBAC、个人圈/共享圈与 31 张表的双变量 PostgreSQL 行级安全（RLS）、`entry_variants` 多变体拆表、圈级自定义切面词表与 `implies` DAG 展开、独立人格与群规则、Bitwarden 外部密码库接入、服务端 DLP/PII 拦截、测试台、召回分析、S3 定时备份以及 AstrBot 群聊机器人与 `sdks/python`。

在实际落地与日常使用中，Kioku 的核心场景高度聚焦于**单人自托管 Coding Agent 与个人助理的长期记忆和凭据隔离**。上述多租户、群聊与重型外围设施带来了显著的架构膨胀（高表数、复杂 RLS 事务边界、多层管理界面与高维护成本），却并未改善单人多终端编码与助理场景的核心体验。

## 决策

1. **重置为单人扁平 12 表架构并剥离非核心模块**：
   - 取代 [0001](0001-circles-and-lens-isolation.md) 中的多账号 RBAC、记忆圈（`circles` / `members` / `withCircles` RLS）、接入实例壳（`clients` / `client_group_rules`）与群聊机器人/独立人格模型；
   - 取代 [0002](0002-short-id-variants-and-links.md) 中的 `entry_variants` 多变体拆表、`fact` 物种、词条内 `secret` 密文列与 `legacy_uris`；
   - 取代 [0003](0003-faceted-presence-engine.md) 中的圈级自定义维度、`implies` DAG 展开、口语触发词破壁与多渠道模型调度；
   - 同步移除 Bitwarden 密码库接入、服务端重型 DLP/PII 拦截、测试台（`bench`）、召回分析、Lore/旧版数据导入器、S3 定时备份与 `sdks/python`。
   - 数据库收敛为 12 张无 RLS 的扁平表（`accounts`、`sessions`、`settings`、`api_keys`、`device_grants`、`entries`、`entry_embeddings`、`entry_links`、`entry_events`、`credentials`、`turn_buffer`、`dream_suggestions`），基线迁移重置为 `0000_baseline`（`when = 1796000000000`），明确拒绝旧架构库就地迁移。
2. **保留并固化核心高价值机制**：
   - **短 ID 与双向双链**：保留不可变 Base30 短 ID（`m-xxxxxx`，全实例唯一）与正文 `[[m-xxxxxx]]` 双链索引（`entry_links`）及召回一跳双向扩散；
   - **内置四维在场引擎（Presence Engine）**：在扁平 `entries` 表上直接维护 `envs`、`realms`、`projects`、`runtimes` 四维场景标签，驱动 `boot`（常驻词条去冲突 + 16,000 字原子预算 + `(device_key, project_slug)` 近期摘要）与 `recall`（1024 维 pgvector HNSW + `kioku_zh` BM25 + 场景亲和加减分 + 一跳双链）；
   - **访问密钥静态 `allowed_realms` 硬边界**：保留服务端 JS 与 SQL 双份对齐的静态场域硬边界，并对凭据严格执行失败即拒绝（fail-closed：限定场域的密钥不可读取未限定场域的凭据，须有非空交集且开启 `can_resolve_credentials`）；
   - **Muse 风格极简托管凭据**：秘密不再混入记忆正文，统一以 AES-256-GCM 信封加密存放在 `credentials` 表，正文只留 `{{cred:<slug>}}` 或 `{{cred:<slug>#<field>}}` 占位符，经 `POST /v1/credentials/resolve` 与 `kioku run` 注入子进程环境变量；主密钥轮换改为服务启动时同步重封（覆盖 `credentials` 与 `settings` 中的模型 API Key）；
   - **轻量后台闭环与 3+1 管理界面**：收敛为 5 个 pg-boss 队列（含 `turn.end` 自动摘要与 4 类 Dream 整理建议）、8 个 MCP 工具、兼容 `kioku-plugins` 的生命周期与惰性签发浏览器授权，以及「记忆 / 待处理 / 凭据 / 设置」零圆角纸墨工作台。

## 后果

- 服务端代码、数据表、HTTP 接口与前端页面规模显著收缩，部署、排障与日常使用直达核心闭环；同时保持与 `kioku-plugins` 命令行和各 Coding Agent 插件的协议兼容。
- 破坏性与旧库不兼容：旧版实例无法直接执行迁移升级，须在空白数据库重新初始化；整库备份与恢复交由标准 PostgreSQL `pg_dump` / `pg_restore`，记忆文本导出在管理界面提供 JSON 与 Markdown 下载。

## 可推翻条件

若未来明确需要多人协作共享记忆或群聊机器人多租户隔离，应在单人平表核心之外评估独立协作边界或联邦同步方案，避免再次将多租户 RLS 与复杂变体拆表耦回单人核心链路。
