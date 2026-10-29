#!/usr/bin/env bash
# 每次克隆后运行一次：启用 .githooks、检查工具。每一步都可重复执行。
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  "") ;;
  *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
esac

chmod +x .githooks/commit-msg .githooks/pre-commit
git config core.hooksPath .githooks
echo "core.hooksPath = $(git config core.hooksPath)"

echo "工具检查："
for t in node pnpm uv shellcheck actionlint gh gitleaks git-cliff; do
  case "$t" in
    node|pnpm) level=必需 ;;
    uv|shellcheck|actionlint) level=门禁必需 ;;
    gh) level='pr.sh 与发布' ;;
    *) level=可选 ;;
  esac
  if command -v "$t" >/dev/null 2>&1; then
    printf '  有  %-11s（%s）\n' "$t" "$level"
  else
    case "$t" in
      pnpm) hint='corepack enable pnpm' ;;
      node) hint='安装 Node.js 22 LTS 或更新版本' ;;
      *) hint="brew install $t" ;;
    esac
    printf '  缺  %-11s（%s，%s）\n' "$t" "$level" "$hint"
  fi
done
echo "初始化完成"
