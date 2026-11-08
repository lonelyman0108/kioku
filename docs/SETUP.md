# Kioku 平台与环境设置

平台设置一改，就在同一个 PR 里更新本文。这里只写密钥的**名字**和用途，不写值。

## 仓库设置

| 项 | 值 |
|---|---|
| 托管 | GitHub，公开仓库，Apache-2.0 |
| 合并方式 | 只允许 squash，默认标题取 PR 标题、正文取 PR 描述；合并后自动删除分支 |
| Auto-merge | 开启（`scripts/pr.sh` 用 `gh pr merge --auto`） |
| Actions 令牌权限 | 默认只读；`release.yml` 自行声明 `contents: write` |

`main` 的规则集，重建时用一条命令设好（`gate` 是 `ci.yml` 里唯一 job 的检查名）：

```bash
gh api repos/{owner}/{repo}/rulesets -X POST --input - <<'JSON'
{"name":"main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,
   "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,
   "allowed_merge_methods":["squash"]}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,
   "required_status_checks":[{"context":"gate"}]}}]}
JSON
```

规则集 `main` 已于 2026-10-26 创建并生效。仓库若改回私有，规则集需要 GitHub Pro 才生效；不生效时 `scripts/pr.sh` 会检测到没有必需检查而不预约自动合并。

受保护标签：规则集 `release-tags`，匹配 `refs/tags/v*`，禁止创建、更新、删除和强推，仓库管理员（RepositoryRole 5）可绕过，也就是只有维护者能打版本 tag：

```bash
gh api repos/{owner}/{repo}/rulesets -X POST --input - <<'JSON'
{"name":"release-tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}]}
JSON
```

合并选项（一次设好）：

```bash
gh api -X PATCH repos/{owner}/{repo} -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

## Secrets 与 Variables

| 名字 | 级别 | 用途 | 使用位置 |
|---|---|---|---|
| — | — | 目前不需要额外 secret，`release.yml` 只用 `github.token` | — |

<!-- 推镜像时加 REGISTRY_USER、REGISTRY_TOKEN，或改用 GHCR + github.token（packages: write） -->

## Runner

| workflow | runs-on | 说明 |
|---|---|---|
| `ci.yml` | `ubuntu-24.04` | 必需检查 `gate` |
| `release.yml` | `ubuntu-24.04` | 推送 `v*` tag 触发 |

## 部署位置

<!-- 镜像名、compose 示例；版本号写死的位置 -->

## 本机凭据

| 来源 | 用途 |
|---|---|
| `gh auth login` 的登录状态 | `scripts/pr.sh` 开 PR、预约合并 |

## 本地测试环境

CI 的测试库由 `scripts/ci/` 里的脚本自己起；本地跑完整测试时，下面这些要自己起。里面只有测试数据，没有真实凭据。

| 用途 | 启动 | 环境变量 |
|---|---|---|
| 集成测试的数据库 | `docker compose -f docker-compose.dev.yml up -d --build` | `KIOKU_TEST_DATABASE_URL=postgres://kioku:kioku@localhost:55432/kioku`。没设时集成测试跳过；测试会清空整个库 |
| 连真 Vaultwarden 的用例 | `docker compose -f docker-compose.dev.yml --profile vaultwarden up -d vaultwarden` | `KIOKU_TEST_VAULTWARDEN_URL=http://127.0.0.1:18081`。没设时这些用例跳过，CI 不设 |

- 测试用的 Vaultwarden 版本写死在 `docker-compose.dev.yml`，放宽了登录限流，数据不落盘，测试每次新注册账号。
- 密码库客户端的单元测试用录下的固定数据（`apps/server/src/credential/bitwarden/__tests__/fixtures/vaultwarden.json`）。换 Vaultwarden 版本或改了客户端的请求时重录：在 `apps/server` 下执行 `pnpm exec tsx src/testing/recordVaultFixtures.ts http://127.0.0.1:18081`。

## 重建步骤

1. 从备份或任意 clone 恢复仓库并推送到新的 GitHub 仓库。
2. 按上文设置合并选项和两条规则集。
3. 克隆后运行 `scripts/bootstrap.sh`，再跑 `scripts/check.sh`。

## 演练记录

| 日期 | 内容 | 结果 |
|---|---|---|
