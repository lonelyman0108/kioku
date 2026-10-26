#!/usr/bin/env bash
# 开 PR、预约 squash 自动合并、更新落后于 main 的 PR。通过 gh 调 GitHub，不直接拿令牌。
#
# 用法：
#   scripts/pr.sh [--no-merge] [--title <标题>] [--body-file <文件>] [--base <分支>] [--dry-run]
#       推送当前分支并开 PR；默认同时预约「检查通过后 squash 合并并删除分支」
#   scripts/pr.sh --update <N>    用 rebase 方式把 PR #N 更新到最新的目标分支
#   scripts/pr.sh --release       标题与正文取自最近一条 🔖 release 提交，正文原样进入 main
#
#   --no-merge    只开 PR，不预约合并（门禁改动、无人值守任务、还没配必需检查的仓库都用它）
#   --title       多提交的 PR 用它给概括性标题；单提交时默认取那条提交的标题
#   --body-file   PR 描述文件；不给时用 .github/PULL_REQUEST_TEMPLATE.md，交互式终端下打开编辑器
#   --dry-run     只打印将要执行的推送与 gh 调用，不联网
#
# 认证沿用 gh auth login 的登录状态；脚本从不读取或打印令牌。
# 依赖：git、gh。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

mode=open
merge=1
dry=0
title=
body_file=
base=main
number=
while [ $# -gt 0 ]; do
  case "$1" in
    --no-merge) merge=0; shift ;;
    --title) title=${2:?--title 需要参数}; shift 2 ;;
    --body-file) body_file=${2:?--body-file 需要参数}; shift 2 ;;
    --base) base=${2:?--base 需要参数}; shift 2 ;;
    --update) mode=update; number=${2:?--update 需要 PR 编号}; shift 2 ;;
    --release) mode=release; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

for t in git gh; do
  command -v "$t" >/dev/null 2>&1 || die "缺少 $t"
done

# 执行或只打印一条命令
run() {
  if [ "$dry" -eq 1 ]; then
    printf '[dry-run]' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
  else
    "$@"
  fi
}

if [ "$mode" = update ]; then
  run gh pr update-branch "$number" --rebase
  echo "PR #$number 已按 rebase 更新；本地分支执行 git pull --rebase 同步"
  exit 0
fi

branch=$(git symbolic-ref --short HEAD 2>/dev/null) || die "当前不在分支上"
[ "$branch" != "$base" ] || die "当前就在 $base 上：先 git switch -c <type>/<slug> 建分支"

if [ "$dry" -eq 0 ]; then
  git fetch -q origin "$base"
fi
base_ref=origin/$base
git rev-parse -q --verify "$base_ref^{commit}" >/dev/null || base_ref=$base
count=$(git rev-list --count "$base_ref..HEAD")
[ "$count" -gt 0 ] || die "$branch 相对 $base_ref 没有新提交"

release_body=
if [ "$mode" = release ]; then
  rc=$(git log -n1 --format=%H --grep='^🔖 release' "$base_ref..HEAD")
  [ -n "$rc" ] || die "$base_ref..HEAD 里没有 🔖 release 提交"
  title=$(git log -1 --format=%s "$rc")
  release_body=$(git log -1 --format=%b "$rc")
elif [ -z "$title" ]; then
  if [ "$count" -eq 1 ]; then
    title=$(git log -1 --format=%s HEAD)
  elif [ -t 0 ]; then
    git log --format='  %s' "$base_ref..HEAD"
    printf '共 %s 条提交，输入 PR 标题（将成为 main 上的提交标题）：' "$count"
    IFS= read -r title
  else
    die "有 $count 条提交：用 --title 给出概括性的 PR 标题"
  fi
fi

# 标题按提交规范校验
tmp_title=$(mktemp)
tmp_body=$(mktemp)
trap 'rm -f "$tmp_title" "$tmp_body"' EXIT
printf '%s\n' "$title" > "$tmp_title"
[ -x .githooks/commit-msg ] || die "找不到 .githooks/commit-msg：先运行 scripts/bootstrap.sh"
.githooks/commit-msg "$tmp_title" || die "PR 标题不符合提交规范，见上方提示"

# PR 描述
if [ -n "$body_file" ]; then
  cat "$body_file" > "$tmp_body"
elif [ "$mode" = release ]; then
  printf '%s\n' "$release_body" > "$tmp_body"
else
  if [ -f .github/PULL_REQUEST_TEMPLATE.md ]; then cat .github/PULL_REQUEST_TEMPLATE.md > "$tmp_body"; fi
  if [ -t 0 ] && [ -t 1 ] && [ "$dry" -eq 0 ]; then
    ${VISUAL:-${EDITOR:-vi}} "$tmp_body" < /dev/tty > /dev/tty
  else
    echo "提示：非交互环境且未给 --body-file，PR 描述使用空模板，记得在网页上补全" >&2
  fi
fi

# squash 正文：release PR 用提交正文原样；其余取「变更」一节，去掉 HTML 注释
if [ "$mode" = release ]; then
  merge_msg=$release_body
else
  merge_msg=$(awk '/^## /{ on = ($0 ~ /^## 变更/); next } on' "$tmp_body" | sed -e '/^[[:space:]]*<!--.*-->[[:space:]]*$/d' -e '/^[[:space:]]*-[[:space:]]*$/d')
fi

# ---- 推送并建 PR ----
run git push -u origin HEAD

if [ "$dry" -eq 0 ] && number=$(gh pr view "$branch" --json number,state -q 'select(.state == "OPEN") | .number' 2>/dev/null) && [ -n "$number" ]; then
  echo "已有 PR #${number}，沿用"
else
  run gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$tmp_body"
  if [ "$dry" -eq 0 ]; then
    number=$(gh pr view "$branch" --json number -q .number)
  else
    number=N
  fi
fi

if [ "$merge" -eq 1 ]; then
  # 没有必需检查时 --auto 会被拒绝或立即合并，所以先确认 main 上配了必需检查
  required=0
  if [ "$dry" -eq 0 ]; then
    repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
    required=$(gh api "repos/$repo/rules/branches/$base" -q '[.[] | select(.type == "required_status_checks")] | length' 2>/dev/null || echo 0)
  fi
  if [ "$dry" -eq 0 ] && [ "$required" = 0 ]; then
    echo "注意：$base 没有配置必需检查（或无权读取），不预约自动合并；等 CI 通过后在网页上 squash 合并" >&2
  elif run gh pr merge "$number" --auto --squash --delete-branch --subject "$title (#$number)" --body "$merge_msg"; then
    echo "已预约：检查通过后 squash 合并并删除分支"
  else
    echo "预约自动合并失败（PR 已建好，可在网页上合并）" >&2
  fi
fi

[ "$dry" -eq 1 ] || gh pr view "$number" --json url -q '"PR：" + .url'
