"""生成的客户端能按契约发出请求、解析响应。不连真实的服务，用 httpx 的 MockTransport 接住请求。"""

import json

import httpx

from kioku_client import AuthenticatedClient
from kioku_client.api.auth import get_v1_whoami
from kioku_client.api.entries import get_v1_entries, post_v1_entries
from kioku_client.api.lifecycle import post_v1_lifecycle_event
from kioku_client.api.recall import post_v1_recall
from kioku_client.models import (
    ChatType,
    CreateEntryRequest,
    CreateEntryRequestSensitivity,
    EntryView,
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
    WhoAmI,
)
from kioku_client.types import UNSET

CIRCLE_ID = "00000000-0000-4000-8000-000000000001"
CLIENT_ID = "00000000-0000-4000-8000-000000000002"
ACCOUNT_ID = "00000000-0000-4000-8000-000000000003"
ENTRY_ID = "00000000-0000-4000-8000-000000000004"
VARIANT_ID = "00000000-0000-4000-8000-000000000005"


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
                "shortIds": ["m-r23456"],
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
    assert result.short_ids == ["m-r23456"]


def test_turn_end_and_validation_error():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["event"] == "turn.end"
        assert body["user"] == "我在学日语"
        return httpx.Response(400, json={"error": "群聊与频道须带上本轮的发言人"})

    # 群里不带发言人，服务端会拒绝
    result = post_v1_lifecycle_event.sync(
        client=client_with(handler),
        body=TurnEndEvent(
            event=TurnEndEventEvent.TURN_END,
            session_id="qq:group:2001",
            context=SessionContext(
                chat_type=ChatType.GROUP, platform="qq", group=PlatformRef(id="2001")
            ),
            user="我在学日语",
            reply="加油",
        ),
    )
    assert isinstance(result, ErrorResponse)
    assert result.error == "群聊与频道须带上本轮的发言人"


def test_recall_parses_candidates_and_subject_facts():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "entryId": ENTRY_ID,
                        "shortId": "m-r23456",
                        "title": "群里的规则",
                        "circleId": CIRCLE_ID,
                        "circleSlug": "home",
                        "kind": "entry",
                        "matchedWhen": {"realm": ["group"]},
                        "otherVariantsCount": 0,
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
    assert result.candidates[0].short_id == "m-r23456"
    assert result.candidates[0].title == "群里的规则"
    assert result.candidates[0].circle_slug == "home"
    assert result.subjects[0].name is None
    assert result.subjects[0].facts[0].content == "在学日语"


def whoami_body(**extra) -> dict:
    return {
        "primaryCircle": {
            "id": CIRCLE_ID,
            "slug": "home",
            "name": "家",
            "kind": "shared",
        },
        "linkedCircles": [],
        **extra,
        "client": {
            "id": CLIENT_ID,
            "circleId": CIRCLE_ID,
            "slug": "codex",
            "name": "Codex",
            "runtimeFamily": "codex",
            "ownerAccountId": ACCOUNT_ID,
            "defaultPersonaId": None,
            "config": {"personMemoryMode": "strict"},
        },
        "persona": None,
        "contextFacets": {},
        "resolvedFacets": {"runtime": ["codex"]},
        "vocabulary": [],
        "scopes": {
            "readKinds": ["entry"],
            "writeKinds": [],
            "maxSensitivity": "private",
            "allowedRealms": None,
            "admin": False,
            "credentials": "none",
        },
    }


def test_whoami_carries_names():
    body = whoami_body(accountName="Alice")
    result = get_v1_whoami.sync(client=client_with(lambda _: httpx.Response(200, json=body)))
    assert isinstance(result, WhoAmI)
    assert result.primary_circle.name == "家"
    assert result.account_name == "Alice"
    assert result.resolved_facets.to_dict() == {"runtime": ["codex"]}


def test_whoami_without_account_name():
    body = whoami_body()
    result = get_v1_whoami.sync(client=client_with(lambda _: httpx.Response(200, json=body)))
    assert isinstance(result, WhoAmI)
    assert result.account_name is UNSET


def test_entries_create_and_get():
    now = "2026-10-26T08:00:00.000Z"
    sample_entry = {
        "id": ENTRY_ID,
        "shortId": "m-abc234",
        "circleId": CIRCLE_ID,
        "circleSlug": "home",
        "kind": "entry",
        "title": "群规",
        "sensitivity": "internal",
        "provenance": "agent",
        "originScope": "global",
        "topics": ["rules"],
        "realms": [],
        "priority": 1,
        "disclosure": None,
        "glossary": [],
        "validFrom": now,
        "validTo": None,
        "version": 1,
        "variants": [
            {
                "id": VARIANT_ID,
                "when": {},
                "whenSignature": "{}",
                "sortOrder": 0,
                "content": "文明发言",
                "updatedAt": now,
            }
        ],
        "otherVariants": [],
        "links": [],
        "createdAt": now,
        "updatedAt": now,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(201, json=sample_entry)
        return httpx.Response(200, json=sample_entry)

    client = client_with(handler)
    created = post_v1_entries.sync(
        client=client,
        body=CreateEntryRequest(
            title="群规",
            content="文明发言",
            sensitivity=CreateEntryRequestSensitivity.INTERNAL,
        ),
    )
    assert isinstance(created, EntryView)
    assert created.short_id == "m-abc234"
    assert created.variants[0].content == "文明发言"

    fetched = get_v1_entries.sync(client=client, id="m-abc234")
    assert isinstance(fetched, EntryView)
    assert fetched.title == "群规"
