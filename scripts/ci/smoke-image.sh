#!/usr/bin/env bash
# 构建服务端镜像，连 scripts/ci/test-db.sh 起的测试数据库启动一次：
# 确认镜像里的迁移能跑、接口能用、首页是管理界面，避免 Dockerfile 悄悄失效。
set -euo pipefail
cd "$(dirname "$0")/../.."
image=kioku:ci
name=kioku-smoke
port=18930
base="http://127.0.0.1:$port"
log=$(mktemp)
if ! docker build --progress=plain -t "$image" . > "$log" 2>&1; then
  tail -n 80 "$log" >&2
  echo "服务端镜像构建失败" >&2
  exit 1
fi

# 用单独的库，不碰集成测试的数据
sql() { docker exec kioku-test-db psql -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
sql -d postgres -c 'DROP DATABASE IF EXISTS kioku_smoke WITH (FORCE)' -c 'CREATE DATABASE kioku_smoke OWNER kioku'
sql -d kioku_smoke -c 'CREATE EXTENSION vector' -c 'CREATE EXTENSION zhparser'

docker rm -f "$name" > /dev/null 2>&1 || true
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --network host -e PORT="$port" \
  -e DATABASE_URL=postgres://kioku:kioku@127.0.0.1:55432/kioku_smoke \
  -e KIOKU_MASTER_KEY="$(openssl rand -base64 32)" "$image" > /dev/null

fail() {
  docker logs "$name" >&2 || true
  echo "$1" >&2
  exit 1
}
for _ in $(seq 1 60); do
  if curl -fsS "$base/v1/health" > /dev/null 2>&1; then
    curl -fsS "$base/" | grep -q '<title>Kioku</title>' || fail "首页不是管理界面"
    status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$base/v1/setup" \
      -H 'content-type: application/json' \
      -d '{"username":"smoke","displayName":"Smoke","password":"correct horse battery","spaceName":"smoke"}')
    [ "$status" = 201 ] || fail "初始化接口返回 $status"
    echo "镜像冒烟测试通过"
    exit 0
  fi
  sleep 1
done
fail "服务 60 秒内没有就绪"
