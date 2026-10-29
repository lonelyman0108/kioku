#!/usr/bin/env bash
# 仓库唯一门禁入口：本地、钩子、CI、发布脚本都调用它，各处行为一致。
# 用法：scripts/check.sh [--quick|--full]   --quick 只跑通用检查与 lint；默认 --full
# 每一段都是「step 名称」加命令，任何一步失败立即退出；CI 专有的差异只能是环境变量。
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:---full}
case "$mode" in
  --quick|--full) ;;
  *) echo "用法：scripts/check.sh [--quick|--full]" >&2; exit 2 ;;
esac

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1，安装：$2" >&2; exit 1; }; }
# 把 git 跟踪的、匹配给定 pathspec 的文件读进数组 files
tracked() {
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z -- "$@")
}

# ---- 通用检查（所有仓都跑） ----
step 注释中的流程编号
scripts/lint/comments.sh

step shellcheck
need shellcheck "brew install shellcheck / apt-get install shellcheck"
tracked '*.sh' '.githooks/*' ':!:*.conf'
[ "${#files[@]}" -eq 0 ] || shellcheck "${files[@]}"

tracked '.github/workflows/*.yml' '.github/workflows/*.yaml'
if [ "${#files[@]}" -gt 0 ]; then
  step actionlint
  need actionlint "brew install actionlint"
  actionlint -config-file .github/actionlint.yaml "${files[@]}"
fi

# ---- node ----
# 有 pnpm-lock.yaml 用 pnpm，否则用 npm；typecheck、lint、format:check、test、build 在根 package.json 里定义。
# 还没有 package.json 时跳过整段，只跑上面的通用检查
pm=
if [ -f package.json ]; then
  step 按锁文件安装依赖
  if [ -f pnpm-lock.yaml ]; then
    pm=pnpm
    pnpm install --frozen-lockfile
  else
    pm=npm
    npm ci
  fi
  step 类型检查
  "$pm" run --if-present typecheck
  step lint
  "$pm" run --if-present lint
  step 格式
  "$pm" run --if-present format:check
fi

# ---- python ----
# sdks/ 与 plugins/ 下一层带 pyproject.toml 的目录各是一个 uv 项目：按锁文件装依赖（锁文件过期时失败），
# 跑 ruff 与 pytest。开发工具放在各项目的 dev 依赖组里，lint 只装这一组，不构建项目本身
tracked ':(glob)sdks/*/pyproject.toml' ':(glob)plugins/*/pyproject.toml'
py_projects=()
if [ "${#files[@]}" -gt 0 ]; then
  for f in "${files[@]}"; do py_projects+=("$(dirname "$f")"); done
  need uv "brew install uv，或见 https://docs.astral.sh/uv/"
  for p in "${py_projects[@]}"; do
    step "Python lint 与格式：$p"
    (cd "$p" && uv run --locked --only-group dev ruff check . &&
      uv run --locked --only-group dev ruff format --check .)
  done
fi

if [ "$mode" = --quick ]; then
  printf '\n快速检查通过\n'
  exit 0
fi

# ---- node ----
if [ -n "$pm" ]; then
  step 测试
  "$pm" run --if-present test
  step 构建
  "$pm" run --if-present build
fi

# ---- python ----
if [ "${#py_projects[@]}" -gt 0 ]; then
  for p in "${py_projects[@]}"; do
    step "Python 测试：$p"
    (cd "$p" && uv run --locked pytest)
  done
fi
if [ -f sdks/python/generate.sh ]; then
  step Python SDK 与服务端的接口同步
  sdks/python/generate.sh --check
fi

printf '\n完整检查通过\n'
