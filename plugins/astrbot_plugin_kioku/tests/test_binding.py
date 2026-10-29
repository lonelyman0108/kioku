"""/bind 与 /bind <码>：用构造的 AstrBot 事件走一遍私聊申请、私聊使用、群里提示去私聊，以及 Kioku 出错时的回复。

绑定码不交给模型：命令处理完就停止事件传播，这一轮不会请求模型，也不会进对话缓冲。
"""

import asyncio
import json

import httpx
from astrbot.api.event import AstrMessageEvent
from astrbot.api.star import Context
from astrbot_plugin_kioku.bridge import (
    BOUND,
    GROUP_HINT,
    NOT_CONFIGURED,
    UNAVAILABLE,
    WAITING,
    KiokuBridge,
)
from astrbot_plugin_kioku.main import KiokuPlugin

PRIVATE_QQ = {
    "platform": "aiocqhttp",
    "session": "aiocqhttp:FriendMessage:1001",
    "sender_id": "1001",
    "sender_name": "小明",
}
PRIVATE_TG = {
    "platform": "telegram",
    "session": "telegram:FriendMessage:u1",
    "sender_id": "u1",
    "sender_name": "明",
}


def plugin_answering(handler) -> tuple[KiokuPlugin, list[tuple[str, dict]]]:
    """插件发出的请求记下路径与正文，由 handler 决定 Kioku 怎么回。"""
    sent: list[tuple[str, dict]] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append((request.url.path, json.loads(request.content)))
        return handler(request)

    plugin = KiokuPlugin(Context(), {"kioku_url": "https://kioku.example.com", "kioku_key": "k"})
    plugin.bridge = KiokuBridge(
        "https://kioku.example.com", "k", transport=httpx.MockTransport(record)
    )
    return plugin, sent


def replies(plugin: KiokuPlugin, event: AstrMessageEvent, code: str = "") -> list[str]:
    async def run() -> list[str]:
        return [result.text async for result in plugin.bind(event, code)]

    return asyncio.run(run())


def test_private_bind_gets_a_code_and_says_how_to_use_it():
    plugin, sent = plugin_answering(
        lambda _r: httpx.Response(
            200,
            json={
                "code": "ABCD2345",
                "expiresAt": "2026-10-29T12:10:00.000Z",
                "expiresInSeconds": 600,
            },
        )
    )
    event = AstrMessageEvent(**PRIVATE_QQ, text="/bind")
    assert replies(plugin, event) == [
        "绑定码：ABCD2345\n10 分钟内到另一个平台私聊我，发「/bind ABCD2345」。"
    ]
    # 平台账号原样上报，由 Kioku 认出是谁在申请
    assert sent == [
        (
            "/v1/bind/code",
            {
                "context": {
                    "chatType": "direct",
                    "platform": "aiocqhttp",
                    "sender": {"id": "1001", "name": "小明"},
                }
            },
        )
    ]
    # 绑定码不交给模型
    assert event.is_stopped()


def test_private_bind_with_a_code_binds_or_waits_for_confirmation():
    for status, reply in (("merged", BOUND), ("pending", WAITING)):
        plugin, sent = plugin_answering(
            lambda _r, status=status: httpx.Response(
                200,
                json={
                    "status": status,
                    "expiresAt": None if status == "merged" else "2026-11-05T12:00:00.000Z",
                },
            )
        )
        event = AstrMessageEvent(**PRIVATE_TG, text="/bind ABCD2345")
        assert replies(plugin, event, " ABCD2345 ") == [reply]
        assert sent == [
            (
                "/v1/bind",
                {
                    "code": "ABCD2345",
                    "context": {
                        "chatType": "direct",
                        "platform": "telegram",
                        "sender": {"id": "u1", "name": "明"},
                    },
                },
            )
        ]
        assert event.is_stopped()


def test_group_bind_only_points_to_private_chat():
    plugin, sent = plugin_answering(lambda _r: httpx.Response(500))
    for code in ("", "ABCD2345"):
        event = AstrMessageEvent(
            platform="aiocqhttp",
            session="aiocqhttp:GroupMessage:2001",
            group_id="2001",
            sender_id="1002",
            text=f"/bind {code}".strip(),
        )
        # 群里不发码也不收码：发在群里的码大家都看得到
        assert replies(plugin, event, code) == [GROUP_HINT]
        assert event.is_stopped()
    assert sent == []


def test_kioku_errors_are_relayed_and_failures_degrade():
    # Kioku 的说明原样转达：码不对、输错太多、Key 写不了对象层……
    for status, error in (
        (400, "绑定码不对或已经失效，请重新申请"),
        (429, "输错的次数太多了，37 分钟后再试"),
        (403, "这个 bot 的 Key 写不了对象层，不能绑定账号"),
    ):
        plugin, _ = plugin_answering(
            lambda _r, status=status, error=error: httpx.Response(status, json={"error": error})
        )
        assert replies(plugin, AstrMessageEvent(**PRIVATE_TG), "ABCD2345") == [error]

    def down(_request):
        raise httpx.ConnectError("连不上")

    # Key 无效是 bot 主人的配置问题，连不上、服务端出错都只回一句
    for handler in (
        down,
        lambda _r: httpx.Response(401, json={"error": "未登录或凭据无效"}),
        lambda _r: httpx.Response(500, text="服务内部错误"),
    ):
        plugin, _ = plugin_answering(handler)
        event = AstrMessageEvent(**PRIVATE_QQ)
        assert replies(plugin, event) == [UNAVAILABLE]
        assert event.is_stopped()


def test_too_long_codes_are_clipped_to_what_kioku_accepts():
    plugin, sent = plugin_answering(
        lambda _r: httpx.Response(400, json={"error": "绑定码是 8 位字母和数字"})
    )
    assert replies(plugin, AstrMessageEvent(**PRIVATE_TG), "A" * 200) == ["绑定码是 8 位字母和数字"]
    assert sent[0][1]["code"] == "A" * 64


def test_unconfigured_plugin_says_so():
    plugin = KiokuPlugin(Context(), {"kioku_url": "", "kioku_key": ""})
    event = AstrMessageEvent(**PRIVATE_QQ)
    assert replies(plugin, event) == [NOT_CONFIGURED]
    assert event.is_stopped()
