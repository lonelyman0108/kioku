# 贡献规范

本仓的提交、分支、PR 与发布规则全部写在这里；钩子 `.githooks/commit-msg` 与 CI 按同一份规则校验。

## 初始化

克隆后执行一次 `scripts/bootstrap.sh`，它会启用 `.githooks`（`git config core.hooksPath` 应输出 `.githooks`）并检查工具。

## 分支与 PR

- `main` 受保护（GitHub 规则集），所有改动走 PR，只允许 squash 合并，合并后删除分支。
- 分支名 `<type>/<slug>`，例如 `feat/export-csv`；slug 只用小写字母、数字、连字符。
- 用 `scripts/pr.sh` 开 PR 并预约自动合并；门禁相关改动用 `scripts/pr.sh --no-merge`。
- PR 标题就是 main 上的提交标题；描述分三节：变更 / 验证 / 未覆盖。

## 提交规范

格式：`<emoji> <type>(<scope>): <中文主题>`

- 首行 ≤ 72 个字符（中文算 1 个），主题动词开头、末尾不加句号。
- scope 可省，只用小写字母、数字和 `._/-`。不兼容改动在冒号前加 `!`，正文写 `BREAKING CHANGE:`。
- **禁止任何署名 trailer**（`Co-authored-by`、`Signed-off-by` 等）。
- 首行不写需求号、阶段号这类流程编号。

| emoji | type | 用途 |
|---|---|---|
| ✨ | feat | 使用者能感知的新功能 |
| 🐛 | fix | 修 bug |
| ⚡️ | perf | 性能优化 |
| ♻️ | refactor | 重构，行为不变 |
| 💄 | style | 不改行为的样式或格式化 |
| ✅ | test | 测试 |
| 📝 | docs | 文档、注释 |
| 📦️ | build | 构建系统、依赖 |
| 👷 | ci | workflow、CI 脚本、钩子 |
| 🔧 | chore | 工程配置、杂项 |
| ⏪️ | revert | 回滚 |
| 🔖 | release | 发布提交 |

扩展类型 🌐 i18n、🎨 design 默认关闭，启用时改 `.githooks/commit.conf` 的 `EXTRA_TYPES`。

常用 scope：`server`、`web`、`contracts`、`sdk`、`db`、`docs`、`ci`

钩子是本地第一道检查，CI 会用同一份规则复核 PR 标题和合并进 main 的提交。

## 受管文件

第二行写着「受管文件，来自 ci-workflows@…」的文件（提交钩子、`scripts/ci/` 下的脚本、`scripts/pr.sh` 等）由维护者从共享的规范仓同步过来，各项目保持一致。不要在本仓直接改：要改的话开 Issue，或在 PR 里说明，由维护者改上游后再同步过来。

## 门禁

`scripts/check.sh`（纯文档改动可用 `--quick`）：注释流程编号、shellcheck、actionlint，以及本仓技术栈的检查。

## 发布

版本号与 tag 只由维护者决定和打；CHANGELOG 定稿放在发布 PR（`🔖 release: vX.Y.Z`）里。
推送 `vX.Y.Z` tag 后，`release.yml` 跑完整门禁，再用 CHANGELOG 对应一节建立或更新 GitHub Release。
门禁通过后，`release.yml` 调 `images.yml` 构建并推送两个镜像，`linux/amd64` 与 `linux/arm64` 各在原生的 runner 上构建，再合并成一个多架构清单：

| 镜像 | GHCR | Docker Hub |
|---|---|---|
| 服务端（根目录 `Dockerfile`） | `ghcr.io/lonelyman0108/kioku` | `docker.io/lonelyman0108/kioku` |
| 数据库（`docker/postgres/Dockerfile`） | `ghcr.io/lonelyman0108/kioku-postgres` | `docker.io/lonelyman0108/kioku-postgres` |

- 标签：正式版总是打 `X.Y.Z`；比同一 `X.Y` 里已有的正式版都新时打 `X.Y`，比仓库里所有已有的正式版都新时打 `latest`（`v0.2.0` 之后补发 `v0.1.5` 只动 `0.1`，不动 `latest`）。带预发布后缀的（如 `v0.1.0-rc.1`）只打 `X.Y.Z` 本身。规则与自测在 `scripts/ci/image-meta.sh`，推镜像的 job 在 `images-release` 组里排队，两次发布不并行。
- 服务端镜像构建时传 `KIOKU_VERSION`（tag 去掉 `v`）、`KIOKU_COMMIT`（完整的提交 sha）、`KIOKU_BUILD_TIME`（ISO 8601 的 UTC 时间）；两个镜像都带 OCI 标签（source、revision、version、created、licenses）。
- main 每次合并后，`edge.yml` 用同一份 `images.yml` 推两个镜像的 `edge` 与不变的 `sha-<短提交>` 标签（版本写 `edge`），不经过 PR 的门禁；连着合并时排队，不取消正在推的那次。
- 两个 workflow 推镜像的 job 都限定 `github.repository == 'lonelyman0108/kioku'`，fork 里不跑。
- secrets：GHCR 用 workflow 的 `GITHUB_TOKEN`（job 声明了 `packages: write`），不用另配。Docker Hub 可选：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`（用户名与有读写权限的访问令牌）都配了才推 Docker Hub，缺一个就只推 GHCR，job summary 里写「未配置 Docker Hub，已跳过」。
- GHCR 的新包第一次推上去时默认是私有的：在包的 Package settings 里把可见性改成 Public，`compose.yaml` 才能不登录直接拉。两个包各改一次。
