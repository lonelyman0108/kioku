"""Kioku 与 AstrBot 之间的转接：从 AstrBot 的事件里取出平台、群与发言人，调 Kioku 的生命周期接口。

插件里没有记忆逻辑，也没有提示词：注入什么、怎么抽取，都由服务端决定。
Kioku 不可用、超时或拒绝请求时只记日志、返回空，不打断对话。
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass

import httpx

from .kioku_client import AuthenticatedClient
from .kioku_client.api.lifecycle import post_v1_lifecycle_event
from .kioku_client.models import (
    ChatType,
    LifecycleResponse,
    PlatformRef,
    PromptSubmitEvent,
    PromptSubmitEventEvent,
    SessionContext,
    SessionStartEvent,
    SessionStartEventEvent,
    TurnEndEvent,
    TurnEndEventEvent,
)

logger = logging.getLogger("astrbot_plugin_kioku")

# 服务端的平台标识只收小写字母、数字和 _.-，开头是字母或数字，最长 32 个字
NOT_PLATFORM = re.compile(r"[^a-z0-9_.-]")
# 服务端的消息长度上限
MAX_TEXT = 20_000
# 会话开始的启动上下文（人格与基础规则）很少变，按会话缓存这么久，不必每轮都请求
BOOT_TTL_SECONDS = 600


@dataclass(frozen=True)
class Turn:
    """一轮对话里转接要用的东西，由插件从 AstrBot 的事件里取出。"""

    platform: str
    session_id: str
    group_id: str | None
    sender_id: str
    sender_name: str | None
    text: str


def platform_of(name: str) -> str:
    platform = NOT_PLATFORM.sub("_", name.strip().lower())[:32]
    return platform if platform[:1].isalnum() else f"p{platform}"[:32]


def session_context(turn: Turn) -> SessionContext:
    """会话上下文：平台账号原样上报，由服务端解析成对象、判断是不是主人。"""
    sender = (
        PlatformRef(id=turn.sender_id, name=turn.sender_name)
        if turn.sender_name
        else PlatformRef(id=turn.sender_id)
    )
    platform = platform_of(turn.platform)
    if turn.group_id:
        return SessionContext(
            chat_type=ChatType.GROUP,
            platform=platform,
            group=PlatformRef(id=turn.group_id),
            sender=sender,
        )
    return SessionContext(chat_type=ChatType.DIRECT, platform=platform, sender=sender)


class KiokuBridge:
    def __init__(
        self,
        base_url: str,
        key: str,
        timeout: float = 4.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = (
            AuthenticatedClient(
                base_url=base_url.rstrip("/"),
                token=key,
                timeout=httpx.Timeout(timeout),
                httpx_args={"transport": transport} if transport else {},
            )
            if base_url and key
            else None
        )
        self._boot: dict[str, tuple[float, str]] = {}

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def boot(self, turn: Turn) -> str | None:
        """会话开始时注入的人格与基础规则，按会话缓存。"""
        now = time.monotonic()
        cached = self._boot.get(turn.session_id)
        if cached and now - cached[0] < BOOT_TTL_SECONDS:
            return cached[1]
        context = await self._send(
            SessionStartEvent(
                event=SessionStartEventEvent.SESSION_START,
                session_id=turn.session_id,
                context=session_context(turn),
            )
        )
        if context is not None:
            # 顺手清掉过期的，缓存不会越攒越多
            self._boot = {
                sid: entry for sid, entry in self._boot.items() if now - entry[0] < BOOT_TTL_SECONDS
            }
            self._boot[turn.session_id] = (now, context)
        return context

    async def recall(self, turn: Turn) -> str | None:
        """这一轮相关的记忆与关于对方的事实。"""
        if not turn.text.strip():
            return None
        return await self._send(
            PromptSubmitEvent(
                event=PromptSubmitEventEvent.PROMPT_SUBMIT,
                prompt=turn.text[:MAX_TEXT],
                session_id=turn.session_id,
                context=session_context(turn),
            )
        )

    async def turn_end(self, turn: Turn, reply: str) -> None:
        """把这一轮交给 Kioku 缓冲，攒批之后抽取成记忆。"""
        if not turn.text.strip():
            return
        await self._send(
            TurnEndEvent(
                event=TurnEndEventEvent.TURN_END,
                session_id=turn.session_id,
                context=session_context(turn),
                user=turn.text[:MAX_TEXT],
                reply=reply[:MAX_TEXT],
            )
        )

    async def _send(self, body: SessionStartEvent | PromptSubmitEvent | TurnEndEvent) -> str | None:
        if self._client is None:
            return None
        try:
            result = await post_v1_lifecycle_event.asyncio(client=self._client, body=body)
        except Exception as err:  # noqa: BLE001  Kioku 出什么错都不能打断对话
            logger.warning("请求 Kioku 失败：%s", err)
            return None
        if not isinstance(result, LifecycleResponse):
            logger.warning("Kioku 没有接受请求：%s", getattr(result, "error", result))
            return None
        value = result.host_output.value
        context = value.get("context") if isinstance(value, dict) else None
        return context if isinstance(context, str) and context.strip() else None
