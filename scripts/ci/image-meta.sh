#!/usr/bin/env bash
# 算出这次推送的镜像版本、标签与构建时间，按 GITHUB_OUTPUT 的格式输出（version=…、tags=…、created=…）。
# 用法：image-meta.sh edge     main 合并后：版本与标签都是 edge
#       image-meta.sh vX.Y.Z   版本 tag：版本去掉开头的 v；正式版打 X.Y.Z、X.Y、latest，
#                              带预发布后缀的（如 v0.1.0-rc.1）只打 X.Y.Z 本身
# tags 用空格分隔，交给 image-manifest.sh；created 是 ISO 8601 的 UTC 时间，各架构与标签共用这一个。
set -euo pipefail

ref=${1:?用法：image-meta.sh edge|vX.Y.Z}
case "$ref" in
  edge)
    version=edge
    tags=edge
    ;;
  v*)
    version=${ref#v}
    semver='^([0-9]+)\.([0-9]+)\.[0-9]+(-[0-9A-Za-z.-]+)?$'
    [[ $version =~ $semver ]] || { echo "版本 tag 不是 vX.Y.Z 的写法：$ref" >&2; exit 1; }
    if [ -n "${BASH_REMATCH[3]}" ]; then
      tags=$version
    else
      tags="$version ${BASH_REMATCH[1]}.${BASH_REMATCH[2]} latest"
    fi
    ;;
  *)
    echo "用法：image-meta.sh edge|vX.Y.Z" >&2
    exit 2
    ;;
esac

echo "version=$version"
echo "tags=$tags"
echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
