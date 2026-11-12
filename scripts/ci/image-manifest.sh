#!/usr/bin/env bash
# 把各架构按摘要推上去的镜像合并成一个多架构清单，在每个镜像仓库上打好这次的标签。
# 用法：image-manifest.sh <镜像名> <摘要目录>
#   摘要目录里每个文件名是一个架构的镜像摘要（不带 sha256: 前缀），由构建那一步写下
# 环境变量：
#   REGISTRIES   镜像仓库的前缀，空格分隔（如 ghcr.io/lonelyman0108 docker.io/lonelyman0108）
#   TAGS         要打的标签，空格分隔（image-meta.sh 的 tags）
#   SOURCE、REVISION、VERSION、CREATED、DESCRIPTION  写进清单的 OCI 注解
set -euo pipefail

name=${1:?用法：image-manifest.sh <镜像名> <摘要目录>}
dir=${2:?用法：image-manifest.sh <镜像名> <摘要目录>}
: "${REGISTRIES:?}" "${TAGS:?}" "${SOURCE:?}" "${REVISION:?}" "${VERSION:?}" "${CREATED:?}" "${DESCRIPTION:?}"

digests=()
for file in "$dir"/*; do
  [ -f "$file" ] && digests+=("${file##*/}")
done
[ "${#digests[@]}" -gt 0 ] || { echo "$dir 里没有镜像摘要" >&2; exit 1; }

annotations=(
  --annotation "index:org.opencontainers.image.source=$SOURCE"
  --annotation "index:org.opencontainers.image.revision=$REVISION"
  --annotation "index:org.opencontainers.image.version=$VERSION"
  --annotation "index:org.opencontainers.image.created=$CREATED"
  --annotation "index:org.opencontainers.image.licenses=Apache-2.0"
  --annotation "index:org.opencontainers.image.description=$DESCRIPTION"
)

for registry in $REGISTRIES; do
  repo=$registry/$name
  args=("${annotations[@]}")
  for tag in $TAGS; do
    args+=(-t "$repo:$tag")
  done
  # 每个仓库只引用推到它自己里面的摘要，不跨仓库复制
  for digest in "${digests[@]}"; do
    args+=("$repo@sha256:$digest")
  done
  docker buildx imagetools create "${args[@]}"
  docker buildx imagetools inspect "$repo:${TAGS%% *}"
done
