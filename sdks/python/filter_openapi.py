"""从服务端的完整 OpenAPI 文档里挑出接入方用的接口：Key 鉴权的生命周期、召回、记忆与 whoami，
并把生成工具不认的写法改成等价的写法。

管理界面（Cookie 会话）的接口不收；凭据接口也不收，群聊 bot 用不到，少生成一些代码。
用法：python3 filter_openapi.py <完整文档> > openapi.json
"""

import json
import sys

KEEP_TAGS = {"lifecycle", "recall", "memories", "auth"}


def keyed(operation: dict) -> bool:
    return any("bearer" in requirement for requirement in operation.get("security", []))


def nullable_refs(node):
    """把可为 null 的具名引用改写成生成工具认得的写法。

    服务端把 `Layer.nullable()` 这类写成 allOf: [{$ref}, {type: [..., "null"]}]，
    openapi-python-client 不认 allOf 里的非对象；改成等价的 anyOf: [{$ref}, {type: "null"}]。
    """
    if isinstance(node, list):
        return [nullable_refs(item) for item in node]
    if not isinstance(node, dict):
        return node
    parts = node.get("allOf")
    if (
        isinstance(parts, list)
        and len(parts) == 2
        and "$ref" in parts[0]
        and "null" in (parts[1].get("type") or [])
    ):
        rest = {k: v for k, v in node.items() if k != "allOf"}
        return {**rest, "anyOf": [parts[0], {"type": "null"}]}
    return {key: nullable_refs(value) for key, value in node.items()}


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as f:
        document = json.load(f)
    paths = {}
    for path, operations in document["paths"].items():
        kept = {
            method: operation
            for method, operation in operations.items()
            if keyed(operation) and KEEP_TAGS & set(operation.get("tags", []))
        }
        if kept:
            paths[path] = kept
    document["paths"] = paths
    json.dump(nullable_refs(document), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
