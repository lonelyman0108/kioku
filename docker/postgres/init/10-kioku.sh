#!/usr/bin/env bash
# 首次初始化数据目录时运行（以超级用户身份）：建应用角色和数据库，并装好需要超级用户权限的扩展。
# 应用角色不是超级用户、没有 BYPASSRLS，行级安全对它才生效；服务启动时会再检查一遍。
set -euo pipefail
: "${KIOKU_DB_USER:=kioku}"
: "${KIOKU_DB_PASSWORD:?需要 KIOKU_DB_PASSWORD}"
: "${KIOKU_DB_NAME:=kioku}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v user="$KIOKU_DB_USER" -v password="$KIOKU_DB_PASSWORD" -v db="$KIOKU_DB_NAME" <<'SQL'
CREATE ROLE :"user" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'password';
CREATE DATABASE :"db" OWNER :"user";
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$KIOKU_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;
SQL
