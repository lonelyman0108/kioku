#!/usr/bin/env bash
# 输出 code=true|false：本次改动是否含非文档文件，供 CI 决定跑 --quick 还是 --full。
# 取不到对比基准时一律按含代码处理。环境变量：BASE_SHA（PR）、BEFORE（push）。
set -euo pipefail
if [ -n "${BASE_SHA:-}" ] && git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null; then
  files=$(git diff --name-only "$BASE_SHA...HEAD")
elif [ -n "${BEFORE:-}" ] && ! [[ "$BEFORE" =~ ^0+$ ]] && git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
  files=$(git diff --name-only "$BEFORE" HEAD)
else
  echo code=true
  exit 0
fi
code=false
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    docs/*|.github/ISSUE_TEMPLATE/*) continue ;;   # 本仓可在此追加纯文档目录
    */*) code=true; break ;;                      # 子目录里的 .md 也可能参与构建，按代码处理
    *.md|LICENSE*) continue ;;
    *) code=true; break ;;
  esac
done <<< "$files"
echo "code=$code"
