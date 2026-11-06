#!/usr/bin/env bash
# 把费时的准备工作（构建镜像这类）放到后台跑，和后面的检查同时进行，用到时再等它。
# 用法：background.sh start <名字> <命令…>   在后台运行命令，立刻返回
#       background.sh wait <名字> [秒数]     等它结束（默认 600 秒），失败时打印日志末尾并以非零退出
#       background.sh status-file <名字>     打印状态文件的路径
# 状态文件在命令结束时才出现：成功是一行 ok，失败是一行 failed 加日志的最后 80 行。服务端测试的 globalSetup
# 也按这个格式等测试库（apps/server/src/testing/globalSetup.ts）。
# 后台进程活到 job 结束：runner 在 job 收尾时才清理留下的进程。
set -euo pipefail
dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
action=${1:?用法见文件头}
name=${2:?需要名字}
shift 2
status=$dir/bg-$name.status
log=$dir/bg-$name.log

case "$action" in
  start)
    [ "$#" -gt 0 ] || { echo "background.sh start 需要命令" >&2; exit 2; }
    rm -f "$status" "$status.tmp"
    # 先写到临时文件再改名：等的一方看到状态文件时内容已经完整。忽略 HUP，这一步的 shell 退出后照常跑完
    (
      trap '' HUP
      if "$@" > "$log" 2>&1; then echo ok > "$status.tmp"; else { echo failed; tail -n 80 "$log"; } > "$status.tmp"; fi
      mv "$status.tmp" "$status"
    ) < /dev/null > /dev/null 2>&1 &
    echo "已在后台开始：$name"
    ;;
  wait)
    timeout=${1:-600}
    for ((i = 0; i < timeout; i++)); do
      [ -f "$status" ] && break
      sleep 1
    done
    if [ ! -f "$status" ]; then
      tail -n 80 "$log" >&2 || true
      echo "${name} 在 ${timeout} 秒内没有结束" >&2
      exit 1
    fi
    if [ "$(head -n 1 "$status")" != ok ]; then
      tail -n +2 "$status" >&2
      echo "${name} 失败" >&2
      exit 1
    fi
    echo "${name} 已完成"
    ;;
  status-file)
    echo "$status"
    ;;
  *)
    echo "未知的操作：$action" >&2
    exit 2
    ;;
esac
