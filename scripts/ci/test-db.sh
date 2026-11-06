#!/usr/bin/env bash
# 在 CI 里构建 Kioku 的 PostgreSQL 镜像并启动一个临时实例，供集成测试使用。
# 就绪后把连接串和并行数写入 GITHUB_ENV（KIOKU_TEST_DATABASE_URL、KIOKU_TEST_DATABASE_WORKERS）；
# 本地开发用 docker-compose.dev.yml。
set -euo pipefail
cd "$(dirname "$0")/../.."
image=kioku-postgres:ci
name=kioku-test-db
# 服务端测试的并行数：每个 worker 用自己的库（kioku_w1、kioku_w2…），见 apps/server/src/testing/workers.ts。
# runner 只有 4 核，数据库也在这台机器上，再多 CPU 就不够了
workers=3
log=$(mktemp)
if ! docker build --progress=plain -t "$image" docker/postgres > "$log" 2>&1; then
  tail -n 80 "$log" >&2
  echo "数据库镜像构建失败" >&2
  exit 1
fi
# 主机端口由 Docker 分配：写死的端口可能落在临时端口范围里，正好被本机的出站连接占着，启动时报端口被占用。
# 几个 worker 同时跑，连接多的测试文件（各自开连接池和 pg-boss）凑到一起会超过默认的 100 个连接
docker run -d --name "$name" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e KIOKU_DB_PASSWORD=kioku "$image" -c max_connections=300 >/dev/null
port=$(docker port "$name" 5432/tcp | head -n 1)
port=${port##*:}

sql() { docker exec "$name" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
# 初始化阶段的临时实例只监听 unix socket，所以走 TCP 探测，确认的是初始化完成后的正式实例
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U kioku -d kioku \
    && docker exec -e PGPASSWORD=kioku "$name" psql -q -h 127.0.0.1 -U kioku -d kioku -c 'select 1' >/dev/null 2>&1; then
    # 每个 worker 的库从刚初始化好的 kioku 复制，扩展一起带上（装扩展要超级用户，应用角色也不能建库）。
    # 模板库上还有没退出的连接时复制会失败（比如刚才探测用的那条），隔一秒再试
    for i in $(seq 1 "$workers"); do
      for attempt in 1 2 3 4 5; do
        sql -c "CREATE DATABASE kioku_w$i TEMPLATE kioku OWNER kioku" && break
        [ "$attempt" -lt 5 ] || { echo "复制 worker 库 kioku_w$i 失败" >&2; exit 1; }
        sleep 1
      done
    done
    {
      echo "KIOKU_TEST_DATABASE_URL=postgres://kioku:kioku@127.0.0.1:$port/kioku"
      echo "KIOKU_TEST_DATABASE_WORKERS=$workers"
    } >> "${GITHUB_ENV:?只在 GitHub Actions 里运行}"
    echo "测试数据库已就绪：127.0.0.1:${port}，${workers} 个 worker 库"
    exit 0
  fi
  sleep 2
done
docker logs "$name" >&2
echo "测试数据库 120 秒内没有就绪" >&2
exit 1
