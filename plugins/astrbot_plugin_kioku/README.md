# AstrBot 插件：Kioku 记忆

让 AstrBot 的 bot 用上 Kioku 的长期记忆：

- 调用模型之前：Kioku 里的人格与基础规则追加到系统提示（很少变，不破坏服务商的提示缓存）；这一轮相关的记忆与关于对方的事实作为临时的额外用户内容附上（每轮都变，不进对话历史）。
- 模型回复之后：把这一轮（用户的话与回复）交给 Kioku，攒批之后整理成关于对方的记忆。不等它完成，不拖慢回复。
- Kioku 不可用、超时或拒绝请求时只记日志，不注入，不打断对话。

插件只转发：平台、群与发言人的账号原样上报，由 Kioku 解析成对象、判断是不是主人、按群换人格；注入什么、怎么抽取都由 Kioku 决定。

## 要求

- AstrBot 4.24.1 以上：召回作为临时的额外内容附上（不进对话历史）要用到的接口从这个版本才有，`metadata.yaml` 里声明了，版本不够时 AstrBot 拒绝加载
- Python 3.11 以上（插件带着的 Kioku 客户端要求）
- 一个 Kioku 应用：运行时家族选 **astrbot**（召回块会直接带记忆的正文，群聊 bot 不必调工具去读），签发一把 Key。Key 能写对象层与情节层时，对话才会被整理成记忆
- Key 只给群聊用得到的层：读基础、人格、应用、对象、情节层，写对象层与情节层，敏感级 public（应用配置里开了主人私聊提升时，再加读主人层、敏感级 internal）。带着会话上下文的请求会按群聊、私聊再收紧，但 Key 本身的权限越小，泄露时的损失越小

不要再给这个 bot 接 Kioku 的 MCP 工具：MCP 请求不带会话上下文，按 Key 的全部权限读写，群里的人能借它读到群里本来读不到的记忆。

## 安装

插件目录里的 `kioku_client` 是指向 `sdks/python/kioku_client` 的符号链接，复制时要跟随链接：

```sh
cp -RL plugins/astrbot_plugin_kioku <AstrBot 的数据目录>/plugins/
```

然后在 AstrBot 管理面板里重载插件，填写配置：

| 配置 | 说明 |
|---|---|
| `kioku_url` | Kioku 的地址，例如 `http://127.0.0.1:18920`，不带 `/v1` |
| `kioku_key` | 上面签发的 Key |
| `boot` | 是否注入 Kioku 里的人格与基础规则；人格完全用 AstrBot 自己的设置时关掉 |
| `timeout` | 请求 Kioku 的超时（秒），默认 4 |

## 开发

```sh
cd plugins/astrbot_plugin_kioku
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

测试不装 AstrBot：`tests/stubs/astrbot` 是只有插件用到的那几个名字的替身，按 AstrBot 4.x 的文档写。
