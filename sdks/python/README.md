# kioku-client

Kioku 接入接口的 Python 客户端：生命周期事件、召回、boot 与记忆的读写，用 API Key 鉴权。
由服务端的 OpenAPI 生成，`kioku_client/` 下的代码不要手改。

## 用法

```python
from kioku_client import AuthenticatedClient
from kioku_client.api.lifecycle import post_v1_lifecycle_event
from kioku_client.models import (
    ChatType,
    PlatformRef,
    PromptSubmitEvent,
    PromptSubmitEventEvent,
    SessionContext,
)

client = AuthenticatedClient(base_url="https://kioku.example.com", token="kioku_…")
result = post_v1_lifecycle_event.sync(
    client=client,
    body=PromptSubmitEvent(
        event=PromptSubmitEventEvent.PROMPT_SUBMIT,
        prompt="周五读什么",
        context=SessionContext(
            chat_type=ChatType.GROUP,
            platform="qq",
            group=PlatformRef(id="2001"),
            sender=PlatformRef(id="1001", name="小明"),
        ),
    ),
)
```

每个接口都有 `sync`、`sync_detailed`、`asyncio`、`asyncio_detailed` 四种调用方式。

## 重新生成

改了服务端的接入接口之后，在仓库里运行：

```sh
sdks/python/generate.sh
```

它从服务端导出 OpenAPI，经 `filter_openapi.py` 挑出接入方用的接口（Key 鉴权的生命周期、召回、记忆与 whoami），
再用写死版本的 openapi-python-client 生成，最后用这里写死的 ruff 整理格式。生成的代码与 `openapi.json` 一起提交。

门禁运行 `generate.sh --check`：生成到临时目录、和提交的比对，不一致时失败，不改工作区。

## 开发

```sh
cd sdks/python
uv run pytest
uv run ruff check . && uv run ruff format --check .
```
