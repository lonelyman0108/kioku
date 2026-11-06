#!/usr/bin/env bash
# 构建服务端镜像，连 scripts/ci/test-db.sh 起的测试数据库启动一次：
# 确认镜像里的迁移能跑、接口能用、首页是管理界面，避免 Dockerfile 悄悄失效。
# 用法：smoke-image.sh          构建并检查
#       smoke-image.sh --start  在后台构建，立刻返回：和后面的检查、测试同时进行
#       smoke-image.sh --check  等后台的构建结束，再检查
#       smoke-image.sh --build  只构建（--start 在后台调用它）
set -euo pipefail
cd "$(dirname "$0")/../.."
image=kioku:ci
name=kioku-smoke
port=18930
base="http://127.0.0.1:$port"

case "${1:-}" in
  --start)
    exec scripts/ci/background.sh start image "$0" --build
    ;;
  --build)
    # 后台构建时，后面的步骤还在往工作区里写东西（node_modules、生成的类型声明、.venv），BuildKit 到
    # COPY . . 时才读上下文，可能读进写了一半的文件。所以上下文用 git archive 打包的已跟踪文件，和这次要测的提交一致
    git archive --format=tar HEAD | docker build --progress=plain -t "$image" -
    exit 0
    ;;
  --check)
    scripts/ci/background.sh wait image
    ;;
  '')
    log=$(mktemp)
    if ! docker build --progress=plain -t "$image" . > "$log" 2>&1; then
      tail -n 80 "$log" >&2
      echo "服务端镜像构建失败" >&2
      exit 1
    fi
    ;;
  *)
    echo "用法：smoke-image.sh [--start|--check|--build]" >&2
    exit 2
    ;;
esac

# 用单独的库，不碰集成测试的数据。连接串取 scripts/ci/test-db.sh 写下的，只换库名
db_url=${KIOKU_TEST_DATABASE_URL:?先运行 scripts/ci/test-db.sh}
db_url=${db_url%/*}/kioku_smoke
sql() { docker exec kioku-test-db psql -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
sql -d postgres -c 'DROP DATABASE IF EXISTS kioku_smoke WITH (FORCE)' -c 'CREATE DATABASE kioku_smoke OWNER kioku'
sql -d kioku_smoke -c 'CREATE EXTENSION vector' -c 'CREATE EXTENSION zhparser'

docker rm -f "$name" > /dev/null 2>&1 || true
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --network host -e PORT="$port" \
  -e DATABASE_URL="$db_url" \
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
