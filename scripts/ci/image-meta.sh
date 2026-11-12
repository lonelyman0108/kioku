#!/usr/bin/env bash
# 算出这次推送的镜像版本、标签与构建时间，按 GITHUB_OUTPUT 的格式输出（version=…、tags=…、created=…）。
# 用法：image-meta.sh edge <提交>   main 合并后：版本是 edge，标签是 edge 与不变的 sha-<短提交>
#       image-meta.sh vX.Y.Z         版本 tag：版本去掉开头的 v，标签见下
#       image-meta.sh --self-test    只跑标签规则的自测
# 版本 tag 的标签：总是打 X.Y.Z；正式版比同一 X.Y 里已有的正式版都新时打 X.Y，比所有已有的正式版都新时打 latest
# （补发旧系列的修复版不会把 latest 拉回去）。带预发布后缀的（如 v0.1.0-rc.1）只打 X.Y.Z 本身。
# 已有的 tag 取自 git tag -l 'v*'（要 fetch-depth: 0），测试时可以用 EXISTING_TAGS（换行分隔）代替。
# tags 用空格分隔，交给 image-manifest.sh；created 是 ISO 8601 的 UTC 时间，各架构与标签共用这一个。
set -euo pipefail

usage() {
  echo "用法：image-meta.sh edge <提交> | vX.Y.Z | --self-test" >&2
  exit 2
}

semver='^([0-9]+)\.([0-9]+)\.[0-9]+(-[0-9A-Za-z.-]+)?$'
stable='^v[0-9]+\.[0-9]+\.[0-9]+$'

# 第一个参数是不是所有参数里最新的（按版本号比，相同的算最新）
newest() {
  [ "$(printf '%s\n' "$@" | sort -V | tail -n 1)" = "$1" ]
}

# release_tags <版本，不带 v> <已有的 tag，换行分隔>：输出空格分隔的标签
release_tags() {
  local version=$1 existing=$2 major minor
  [[ $version =~ $semver ]] || { echo "版本 tag 不是 vX.Y.Z 的写法：v$version" >&2; return 1; }
  major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]}
  if [ -n "${BASH_REMATCH[3]}" ]; then
    echo "$version"
    return
  fi
  local all=() series=() tag
  while IFS= read -r tag; do
    [[ $tag =~ $stable ]] || continue
    tag=${tag#v}
    all+=("$tag")
    [[ $tag == "$major.$minor."* ]] && series+=("$tag")
  done <<< "$existing"
  local tags=$version
  if newest "$version" ${series[@]+"${series[@]}"}; then
    tags+=" $major.$minor"
  fi
  if newest "$version" ${all[@]+"${all[@]}"}; then
    tags+=" latest"
  fi
  echo "$tags"
}

self_test() {
  local failed=0
  expect() {
    local got
    got=$(release_tags "$1" "$2")
    if [ "$got" != "$3" ]; then
      echo "自测失败：$1（已有 ${2//$'\n'/ }）得到「$got」，应为「$3」" >&2
      failed=1
    fi
  }
  expect 0.1.0 '' '0.1.0 0.1 latest'
  expect 0.1.0 'v0.1.0' '0.1.0 0.1 latest'
  expect 0.2.0 $'v0.1.0\nv0.1.1' '0.2.0 0.2 latest'
  expect 0.1.5 $'v0.1.4\nv0.2.0' '0.1.5 0.1'
  expect 0.1.5 $'v0.1.6\nv0.2.0' '0.1.5'
  expect 0.1.10 $'v0.1.9\nv0.1.2' '0.1.10 0.1 latest'
  expect 0.3.0 $'v0.2.0\nv0.4.0-rc.1' '0.3.0 0.3 latest'
  expect 0.4.0-rc.1 $'v0.3.0' '0.4.0-rc.1'
  expect 1.0.0 $'v0.9.9\nother\nv1.0.0-rc.2' '1.0.0 1.0 latest'
  [ "$failed" = 0 ] && echo "image-meta.sh 自测通过" >&2
  return "$failed"
}

case "${1:-}" in
  --self-test)
    self_test
    exit
    ;;
  edge)
    commit=${2:-}
    [[ $commit =~ ^[0-9a-f]{7,}$ ]] || usage
    version=edge
    tags="edge sha-${commit:0:7}"
    ;;
  v*)
    version=${1#v}
    tags=$(release_tags "$version" "${EXISTING_TAGS-$(git tag -l 'v*')}")
    ;;
  *)
    usage
    ;;
esac

echo "version=$version"
echo "tags=$tags"
echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
