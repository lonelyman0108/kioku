#!/usr/bin/env bash
# 为 tag 建立或更新 GitHub Release：标题 = tag，正文 = CHANGELOG.md 里对应版本的一节，
# 可再追加一段产物清单（镜像地址、二进制文件名等）。同名 Release 已存在时改为更新。
#
# 用法：release-page.sh [--dry-run] [--notes <文件>] <tag>
#   --dry-run      只打印将要提交的正文，不调 API（本地核对 CHANGELOG 一节用）
#   --notes <文件>  追加到正文末尾的产物清单
# 环境变量：GH_TOKEN（workflow 用 ${{ github.token }} 经 env 传入，需 contents: write）。
# 依赖：gh。
set -euo pipefail

dry=0
notes=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --notes) notes=${2:?--notes 需要文件路径}; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) break ;;
  esac
done
tag=${1:?用法：release-page.sh [--dry-run] [--notes <文件>] <tag>}
version=${tag#v}
changelog=${CHANGELOG:-CHANGELOG.md}

[ -f "$changelog" ] || { echo "找不到 $changelog" >&2; exit 1; }
# 截取「## [X.Y.Z]」到下一个「## 」之间的内容，去掉首尾空行
section=$(awk -v v="$version" '
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && /^## / { exit }
  on { print }
' "$changelog" | sed -e '/./,$!d' | awk '{ a[NR] = $0 } END { n = NR; while (n > 0 && a[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print a[i] }')
if [ -z "$section" ]; then
  echo "$changelog 里没有「## [$version]」一节，先把本版 CHANGELOG 定稿再打 tag" >&2
  exit 1
fi

body=$section
if [ -n "$notes" ]; then
  [ -f "$notes" ] || { echo "找不到 $notes" >&2; exit 1; }
  body=$(printf '%s\n\n%s\n' "$body" "$(cat "$notes")")
fi

pre=()
case "$version" in *-*) pre=(--prerelease) ;; esac

if [ "$dry" -eq 1 ]; then
  printf '标题：%s（预发布：%s）\n----\n%s\n' "$tag" "${pre[*]:-否}" "$body"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "缺少 gh" >&2; exit 2; }
notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT
printf '%s\n' "$body" > "$notes_file"

if gh release view "$tag" >/dev/null 2>&1; then
  gh release edit "$tag" --title "$tag" --notes-file "$notes_file" ${pre[@]+"${pre[@]}"}
  echo "已更新 Release $tag"
else
  gh release create "$tag" --title "$tag" --notes-file "$notes_file" --verify-tag ${pre[@]+"${pre[@]}"}
  echo "已创建 Release $tag"
fi
