"""AstrBot 插件：接入 Kioku 长期记忆。

- 调用模型之前：会话开始的人格与基础规则追加到系统提示（很少变，不破坏提示缓存）；
  这一轮相关的记忆与关于对方的事实作为临时的额外用户内容附上（每轮都变，不进对话历史）。
- 模型回复之后：把这一轮交给 Kioku，攒批之后抽取成记忆。不等它完成，不拖慢回复。
"""

from __future__ import annotations

import asyncio

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.message import TextPart

from .bridge import KiokuBridge, Turn


def turn_of(event: AstrMessageEvent) -> Turn:
    return Turn(
        platform=event.get_platform_name(),
        session_id=event.unified_msg_origin,
        group_id=event.get_group_id() or None,
        sender_id=str(event.get_sender_id()),
        sender_name=event.get_sender_name() or None,
        text=event.message_str or "",
    )


@register(
    "astrbot_plugin_kioku",
    "Kioku",
    "接入 Kioku 长期记忆",
    "0.1.0",
    "https://github.com/lonelyman0108/kioku",
)
class KiokuPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig) -> None:
        super().__init__(context)
        self.bridge = KiokuBridge(
            str(config.get("kioku_url", "")),
            str(config.get("kioku_key", "")),
            float(config.get("timeout", 4)),
        )
        self.boot_enabled = bool(config.get("boot", True))
        # 正在上报的 turn.end：留着引用，任务才不会被提前回收
        self._pending: set[asyncio.Task] = set()

    @filter.on_llm_request()
    async def inject(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        if not self.bridge.enabled:
            return
        turn = turn_of(event)
        boot, recall = await asyncio.gather(
            self.bridge.boot(turn) if self.boot_enabled else _nothing(),
            self.bridge.recall(turn),
        )
        if boot:
            req.system_prompt = f"{req.system_prompt or ''}\n\n{boot}".strip()
        if recall:
            req.extra_user_content_parts.append(TextPart(text=recall).mark_as_temp())

    @filter.on_llm_response()
    async def remember(self, event: AstrMessageEvent, resp: LLMResponse) -> None:
        if not self.bridge.enabled:
            return
        task = asyncio.create_task(self.bridge.turn_end(turn_of(event), resp.completion_text or ""))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def terminate(self) -> None:
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)


async def _nothing() -> None:
    return None
