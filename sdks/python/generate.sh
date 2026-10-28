#!/usr/bin/env bash
# 从服务端的 OpenAPI 生成 Python 客户端（kioku_client）。只收接入方用的接口，见 filter_openapi.py。
# 生成工具与版本写死；改了服务端的接口之后重新跑一遍，生成的代码与 openapi.json 一起提交。
# 用法：sdks/python/generate.sh（需要 pnpm 与 uv）
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(git -C "$here" rev-parse --show-toplevel)
generator=openapi-python-client==0.29.1
# 生成工具的依赖也按日期锁住：只用这一天之前发布的版本，和 pnpm 拒绝太新的版本是同一个理由
exclude_newer=2026-10-14T00:00:00Z

full=$(mktemp)
filtered=$(mktemp)
trap 'rm -f "$full" "$filtered"' EXIT
(cd "$root/apps/server" && pnpm --silent exec tsx src/cli/openapi.ts) >"$full"
# 先写到临时文件，过滤成功了再换上，失败时不留下半截的 openapi.json
python3 "$here/filter_openapi.py" "$full" >"$filtered"
mv "$filtered" "$here/openapi.json"
uvx --exclude-newer "$exclude_newer" --from "$generator" openapi-python-client generate \
  --path "$here/openapi.json" \
  --config "$here/generator.yaml" \
  --meta none \
  --output-path "$here/kioku_client" \
  --overwrite
uv run --project "$here" ruff format --quiet "$here/kioku_client"
