# Kioku

面向多个 AI 应用的自托管长期记忆服务：多账号、多人格，记忆分层并按接入方授权。

## 做什么

Kioku（記憶）给 Claude Code、OpenClaw、AstrBot 这类 agent 和聊天机器人提供同一套长期记忆。它和普通记忆层的区别在于：

- **多账号**：每个人类账号有独立的记忆空间；同一个 bot 面对的每个群友、每个群也各有独立的记忆。
- **多人格**：人格（soul、口吻、自我认知）是一等对象，可以继承，可以被多个应用借用。
- **分层与授权**：每条记忆有「层」（归属）和「敏感级」（可见性）两个维度。服务端根据 API Key 和会话上下文裁剪检索结果，例如群聊里能借用人格，但读不到主人的私人信息。
- **完整生命周期**：启动注入、每轮召回、对话自动抽取、后台整理（Dream）、事实有效期。

设计见 [docs/design.md](docs/design.md)。

## 本地运行

```bash
scripts/bootstrap.sh      # 克隆后执行一次：启用提交钩子、检查工具
scripts/check.sh          # 门禁：与 CI 完全一致
```

<!-- 代码结构建好后补充：依赖、启动命令、访问地址 -->

## 部署或安装

<!-- 镜像、compose 示例、升级与回滚 -->

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| | | |

## 文档

- 设计：[docs/design.md](docs/design.md)
- 贡献规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- agent 工作约定：[AGENTS.md](AGENTS.md)
- 文档索引：[docs/README.md](docs/README.md)
- 更新日志：[CHANGELOG.md](CHANGELOG.md)

## 许可证

[Apache-2.0](LICENSE)。部分算法源自 [Lore](https://github.com/FFatTiger/lore)（MIT），声明见 [NOTICE](NOTICE)。
