"""生成的客户端能按契约发出请求、解析响应。不连真实的服务，用 httpx 的 MockTransport 接住请求。"""

import json

import httpx

from kioku_client import AuthenticatedClient
from kioku_client.api.lifecycle import post_v1_lifecycle_event
from kioku_client.api.recall import post_v1_recall
from kioku_client.models import (
    ChatType,
    ErrorResponse,
    LifecycleResponse,
    PlatformRef,
    PromptSubmitEvent,
    PromptSubmitEventEvent,
    RecallRequest,
    RecallResponse,
    SessionContext,
    TurnEndEvent,
    TurnEndEventEvent,
)


def client_with(handler) -> AuthenticatedClient:
    return AuthenticatedClient(
        base_url="https://kioku.example.com",
        token="kioku_test_key",
        httpx_args={"transport": httpx.MockTransport(handler)},
    )


def group_context() -> SessionContext:
    return SessionContext(
        chat_type=ChatType.GROUP,
        platform="qq",
        group=PlatformRef(id="2001", name="读书会"),
        sender=PlatformRef(id="1001", name="小明"),
    )


def test_prompt_submit_carries_key_and_context():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "hostOutput": {"mode": "return_value", "value": {"context": "<recall>…</recall>"}},
                "nodeUris": ["core://rules"],
            },
        )

    result = post_v1_lifecycle_event.sync(
        client=client_with(handler),
        body=PromptSubmitEvent(
            event=PromptSubmitEventEvent.PROMPT_SUBMIT,
            prompt="周五读什么",
            session_id="qq:group:2001",
            context=group_context(),
        ),
    )
    assert seen["auth"] == "Bearer kioku_test_key"
    assert seen["body"] == {
        "event": "prompt.submit",
        "prompt": "周五读什么",
        "sessionId": "qq:group:2001",
        "context": {
            "chatType": "group",
            "platform": "qq",
            "group": {"id": "2001", "name": "读书会"},
            "sender": {"id": "1001", "name": "小明"},
        },
    }
    assert isinstance(result, LifecycleResponse)
    assert result.host_output.value["context"] == "<recall>…</recall>"
    assert result.node_uris == ["core://rules"]


def test_turn_end_and_validation_error():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["event"] == "turn.end"
        assert body["user"] == "我在学日语"
        return httpx.Response(400, json={"error": "群聊与频道要带上这一轮的发言人"})

    result = post_v1_lifecycle_event.sync(
        client=client_with(handler),
        body=TurnEndEvent(
            event=TurnEndEventEvent.TURN_END,
            session_id="qq:group:2001",
            context=group_context(),
            user="我在学日语",
            reply="加油",
        ),
    )
    assert isinstance(result, ErrorResponse)
    assert result.error == "群聊与频道要带上这一轮的发言人"


def test_recall_parses_candidates_and_subject_facts():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "uri": "core://rules",
                        "layer": "base",
                        "priority": 0,
                        "disclosure": None,
                        "score": 0.5,
                        "via": ["glossary"],
                        "cues": ["规则"],
                    }
                ],
                "subjects": [
                    {
                        "role": "sender",
                        "name": None,
                        "facts": [{"content": "在学日语", "updatedAt": "2026-10-26T08:00:00.000Z"}],
                    }
                ],
            },
        )

    result = post_v1_recall.sync(
        client=client_with(handler),
        body=RecallRequest(query="规则", context=group_context()),
    )
    assert isinstance(result, RecallResponse)
    assert result.candidates[0].uri == "core://rules"
    assert result.subjects[0].name is None
    assert result.subjects[0].facts[0].content == "在学日语"
