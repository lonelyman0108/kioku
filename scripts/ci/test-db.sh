#!/usr/bin/env bash
# 在 CI 里构建 Kioku 的 PostgreSQL 镜像并启动一个临时实例，供集成测试使用。
# 就绪后把连接串写入 GITHUB_ENV 的 KIOKU_TEST_DATABASE_URL；本地开发用 docker-compose.dev.yml。
set -euo pipefail
cd "$(dirname "$0")/../.."
image=kioku-postgres:ci
port=55432
log=$(mktemp)
if ! docker build --progress=plain -t "$image" docker/postgres > "$log" 2>&1; then
  tail -n 80 "$log" >&2
  echo "数据库镜像构建失败" >&2
  exit 1
fi
docker run -d --name kioku-test-db -p "$port:5432" \
  -e POSTGRES_PASSWORD=postgres -e KIOKU_DB_PASSWORD=kioku "$image" >/dev/null
# 初始化阶段的临时实例只监听 unix socket，所以走 TCP 探测，确认的是初始化完成后的正式实例
for _ in $(seq 1 60); do
  if docker exec kioku-test-db pg_isready -q -h 127.0.0.1 -U kioku -d kioku \
    && docker exec -e PGPASSWORD=kioku kioku-test-db psql -q -h 127.0.0.1 -U kioku -d kioku -c 'select 1' >/dev/null 2>&1; then
    echo "KIOKU_TEST_DATABASE_URL=postgres://kioku:kioku@localhost:$port/kioku" >> "${GITHUB_ENV:?只在 GitHub Actions 里运行}"
    echo "测试数据库已就绪"
    exit 0
  fi
  sleep 2
done
docker logs kioku-test-db >&2
echo "测试数据库 120 秒内没有就绪" >&2
exit 1
