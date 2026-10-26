#!/usr/bin/env bash
# 在 GitHub 托管 runner 上安装门禁需要、镜像里没有的工具，版本写死并校验 sha256。
# ubuntu-24.04 镜像自带 shellcheck、jq、gh，这里只装 actionlint。升级时同时改版本号和校验值。
set -euo pipefail
actionlint_version=1.7.12
actionlint_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
bin=${RUNNER_TEMP:-/tmp}/tools/bin
mkdir -p "$bin"
tarball=actionlint_${actionlint_version}_linux_amd64.tar.gz
curl -fsSL -o "$bin/$tarball" "https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/${tarball}"
echo "$actionlint_sha256  $bin/$tarball" | sha256sum -c -
tar -xzf "$bin/$tarball" -C "$bin" actionlint
rm -f "$bin/$tarball"
echo "$bin" >> "${GITHUB_PATH:?只在 GitHub Actions 里运行}"
"$bin/actionlint" -version
