#!/usr/bin/env bash
# 将滚动预发布标签（edge）与 GitHub Pre-release 页面同步到指定提交。
# 只被 edge.yml 在镜像推送成功后调用；本地可用 --dry-run 核对正文。
#
# 用法：edge-release.sh [--dry-run]
#   --dry-run  只打印将要提交的标题、标签指向与正文，不调 GitHub API，不要求 GH_TOKEN
# 环境变量：
#   COMMIT             40 位十六进制提交 SHA（必需）
#   GITHUB_REPOSITORY  owner/repo（Actions 自动提供，必需）
#   GITHUB_SERVER_URL  默认 https://github.com
#   RUN_URL            本次 workflow 运行链接（可选）
#   GH_TOKEN           GitHub 令牌，需要 contents: write（非 --dry-run 时必需）
set -euo pipefail

dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry=1
      shift
      ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done

tag=edge
commit=${COMMIT:?缺少 COMMIT}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || {
  echo "COMMIT 必须是 40 位小写十六进制提交 SHA：${commit}" >&2
  exit 2
}

repo=${GITHUB_REPOSITORY:?缺少 GITHUB_REPOSITORY}
server=${GITHUB_SERVER_URL:-https://github.com}
server=${server%/}
run_url=${RUN_URL:-}
short=${commit:0:7}
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

commit_subject=
prev_tag=
prev_sha=
if git rev-parse --git-dir >/dev/null 2>&1 && git cat-file -e "${commit}^{commit}" 2>/dev/null; then
  commit_subject=$(git show -s --format=%s "$commit" 2>/dev/null || true)
  prev_tag=$(
    git tag -l 'v[0-9]*' --sort=-version:refname --merged "$commit" 2>/dev/null \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
      | head -n 1 || true
  )
  if [ -n "$prev_tag" ]; then
    prev_sha=$(git rev-parse "${prev_tag}^{commit}" 2>/dev/null || true)
  fi
fi

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT

{
  printf "%s\n\n" "主干 \`main\` 通过 CI 且多架构镜像推送完成后自动更新的滚动预发布构建，供体验未发布改动，不代表正式版。"
  printf -- "- 提交：\`%s\`（\`%s\`）\n" "$commit" "$short"
  if [ -n "$commit_subject" ]; then
    printf -- "- 提交主题：%s\n" "$commit_subject"
  fi
  printf -- "- 更新时间（UTC）：\`%s\`\n" "$updated_at"
  if [ -n "$run_url" ]; then
    printf -- "- 构建记录：%s\n" "$run_url"
  fi
  if [ -n "$prev_tag" ]; then
    if [ "$prev_sha" = "$commit" ]; then
      printf -- "- 相对 \`%s\`：同一提交\n" "$prev_tag"
    else
      printf -- "- 相对 \`%s\` 的变更：%s/%s/compare/%s...%s\n" "$prev_tag" "$server" "$repo" "$prev_tag" "$short"
    fi
  fi
  cat <<EOF

### 容器镜像

| 镜像 | 滚动标签 | 固定提交标签 |
|---|---|---|
| 服务端（GHCR） | \`ghcr.io/lonelyman0108/kioku:edge\` | \`ghcr.io/lonelyman0108/kioku:sha-${short}\` |
| 数据库（GHCR） | \`ghcr.io/lonelyman0108/kioku-postgres:edge\` | \`ghcr.io/lonelyman0108/kioku-postgres:sha-${short}\` |

如仓库已配置 Docker Hub 凭据，同名标签同步推送至 \`docker.io/lonelyman0108/kioku\` 与 \`docker.io/lonelyman0108/kioku-postgres\`。
EOF
} > "$notes_file"

if [ "$dry" -eq 1 ]; then
  printf '仓库：%s\n标签：refs/tags/%s -> %s\n标题：%s（预发布：true，Latest：false）\n----\n' \
    "$repo" "$tag" "$commit" "$tag"
  cat "$notes_file"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "缺少 gh" >&2; exit 2; }
[ -n "${GH_TOKEN:-}" ] || { echo "缺少 GH_TOKEN" >&2; exit 2; }

# 先通过 Git Data Refs API 移动或创建 refs/tags/edge：
# GitHub Release API 在同名 tag 已存在时会忽略 target_commitish，不能只靠 gh release edit --target 改指向。
existing_ref=$(
  gh api "repos/${repo}/git/ref/tags/${tag}" \
    --jq 'if type == "object" then (.ref // "") else "" end' 2>/dev/null || true
)
if [ "$existing_ref" = "refs/tags/${tag}" ]; then
  gh api --method PATCH "repos/${repo}/git/refs/tags/${tag}" \
    -f sha="$commit" \
    -F force=true >/dev/null
else
  gh api --method POST "repos/${repo}/git/refs" \
    -f ref="refs/tags/${tag}" \
    -f sha="$commit" >/dev/null
fi

if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release edit "$tag" --repo "$repo" \
    --title "$tag" \
    --notes-file "$notes_file" \
    --prerelease \
    --latest=false
  echo "已更新滚动预发布 ${tag} -> ${short}"
else
  gh release create "$tag" --repo "$repo" \
    --verify-tag \
    --title "$tag" \
    --notes-file "$notes_file" \
    --prerelease \
    --latest=false
  echo "已创建滚动预发布 ${tag} -> ${short}"
fi
