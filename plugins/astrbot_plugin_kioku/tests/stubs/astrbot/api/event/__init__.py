class AstrMessageEvent:
    """插件读到的事件：平台、会话、群、发言人与这一轮的文字。"""

    def __init__(
        self,
        *,
        platform: str,
        session: str,
        sender_id: str,
        sender_name: str = "",
        group_id: str = "",
        text: str = "",
    ) -> None:
        self._platform = platform
        self.unified_msg_origin = session
        self._sender_id = sender_id
        self._sender_name = sender_name
        self._group_id = group_id
        self.message_str = text

    def get_platform_name(self) -> str:
        return self._platform

    def get_group_id(self) -> str:
        return self._group_id

    def get_sender_id(self) -> str:
        return self._sender_id

    def get_sender_name(self) -> str:
        return self._sender_name


class _Filter:
    """钩子的装饰器：替身里原样返回被装饰的函数。"""

    def on_llm_request(self):
        return lambda fn: fn

    def on_llm_response(self):
        return lambda fn: fn


filter = _Filter()
