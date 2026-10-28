#!/usr/bin/env bash
# 从服务端的 OpenAPI 生成 Python 客户端（kioku_client）。只收接入方用的接口，见 filter_openapi.py。
# 生成工具与版本写死；改了服务端的接口之后重新跑一遍，生成的代码与 openapi.json 一起提交。
# 用法：sdks/python/generate.sh [--check]（需要 pnpm 与 uv）
#   --check  生成到临时目录、和提交的比对，不一致时报错退出，不改工作区（门禁用）
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(git -C "$here" rev-parse --show-toplevel)
generator=openapi-python-client==0.29.1
# 生成工具的依赖也按日期锁住：只用这一天之前发布的版本，和 pnpm 拒绝太新的版本是同一个理由
exclude_newer=2026-10-14T00:00:00Z

case "${1:-}" in
  '') check=false ;;
  --check) check=true ;;
  *) echo "用法：sdks/python/generate.sh [--check]" >&2; exit 2 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
out=$here
if $check; then out=$work/out && mkdir "$out"; fi
(cd "$root/apps/server" && pnpm --silent exec tsx src/cli/openapi.ts) >"$work/full.json"
# 先写到临时文件，过滤成功了再换上，失败时不留下半截的 openapi.json
python3 "$here/filter_openapi.py" "$work/full.json" >"$work/filtered.json"
mv "$work/filtered.json" "$out/openapi.json"
uvx --exclude-newer "$exclude_newer" --from "$generator" openapi-python-client generate \
  --path "$out/openapi.json" \
  --config "$here/generator.yaml" \
  --meta none \
  --output-path "$out/kioku_client" \
  --overwrite
# 显式给配置：--check 时生成的代码在临时目录里，按路径找不到 SDK 的配置
uv run --project "$here" ruff format --quiet --config "$here/pyproject.toml" "$out/kioku_client"

if $check; then
  if ! diff -r -x __pycache__ "$here/openapi.json" "$out/openapi.json" >/dev/null ||
    ! diff -r -x __pycache__ "$here/kioku_client" "$out/kioku_client"; then
    echo "Python SDK 和服务端的接口不一致：跑一遍 sdks/python/generate.sh，把生成的改动一起提交" >&2
    exit 1
  fi
fi
