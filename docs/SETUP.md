# Kioku 平台与环境设置

平台设置一改，就在同一个 PR 里更新本文。这里只写密钥的**名字**和用途，不写值。

## 仓库设置

| 项 | 值 |
|---|---|
| 托管 | GitHub，私有仓库（计划开源时改为公开） |
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

私有仓库的规则集需要 GitHub Pro；没有时规则集不生效，`scripts/pr.sh` 会检测到没有必需检查而不预约自动合并。还没有 CI 时先去掉 `required_status_checks` 一条，第一次 PR 跑出检查后再加。

受保护标签：另建一条 `target: tag`、`include: ["refs/tags/v*"]` 的规则集，只允许维护者创建。

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

## 重建步骤

1. 从备份或任意 clone 恢复仓库并推送到新的 GitHub 仓库。
2. 按上文设置合并方式、Auto-merge、规则集。
3. 克隆后运行 `scripts/bootstrap.sh`，再跑 `scripts/check.sh`。

## 演练记录

| 日期 | 内容 | 结果 |
|---|---|---|
