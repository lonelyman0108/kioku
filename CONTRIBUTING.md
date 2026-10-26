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

常用 scope：`server`、`web`、`sdk`、`plugins`、`db`、`docs`、`ci`（模块建好后按实际目录更新）

钩子是本地第一道检查，CI 会用同一份规则复核 PR 标题和合并进 main 的提交。

## 门禁

`scripts/check.sh`（纯文档改动可用 `--quick`）：注释流程编号、shellcheck、actionlint，以及本仓技术栈的检查。

## 发布

版本号与 tag 只由维护者决定和打；CHANGELOG 定稿放在发布 PR（`🔖 release: vX.Y.Z`）里。
推送 `vX.Y.Z` tag 后，`release.yml` 跑完整门禁，再用 CHANGELOG 对应一节建立或更新 GitHub Release。
<!-- 镜像构建与推送在有 Dockerfile 后补充 -->
