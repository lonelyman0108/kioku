#!/usr/bin/env bash
# 从服务端的 OpenAPI 生成 Python 客户端（kioku_client）。只收接入方用的接口，见 filter_openapi.py。
# 生成工具与版本写死；改了服务端的接口之后重新跑一遍，生成的代码与 openapi.json 一起提交。
# 用法：sdks/python/generate.sh（需要 pnpm 与 uv）
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(git -C "$here" rev-parse --show-toplevel)
generator=openapi-python-client==0.29.1

full=$(mktemp)
trap 'rm -f "$full"' EXIT
(cd "$root/apps/server" && pnpm --silent exec tsx src/cli/openapi.ts) >"$full"
python3 "$here/filter_openapi.py" "$full" >"$here/openapi.json"
uvx --from "$generator" openapi-python-client generate \
  --path "$here/openapi.json" \
  --config "$here/generator.yaml" \
  --meta none \
  --output-path "$here/kioku_client" \
  --overwrite
uv run --project "$here" ruff check --quiet --fix-only "$here/kioku_client"
uv run --project "$here" ruff format --quiet "$here/kioku_client"
