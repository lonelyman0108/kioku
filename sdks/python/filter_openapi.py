"""从服务端的完整 OpenAPI 文档里挑出接入方用的接口：Key 鉴权的生命周期、召回、记忆、绑定码与 whoami，
组件只留这些接口用得到的。

管理界面（Cookie 会话）的接口不收；凭据接口也不收，群聊 bot 用不到，少生成一些代码。
用法：python3 filter_openapi.py <完整文档> > openapi.json
"""

import json
import sys

KEEP_TAGS = {"lifecycle", "recall", "memories", "auth", "binding"}


def keyed(operation: dict) -> bool:
    return any("bearer" in requirement for requirement in operation.get("security", []))


def references(node, found: set[str]) -> set[str]:
    """node 里 $ref 指向的组件名。"""
    if isinstance(node, list):
        for item in node:
            references(item, found)
    elif isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            found.add(ref.rsplit("/", 1)[1])
        for value in node.values():
            references(value, found)
    return found


def reachable(document: dict) -> set[str]:
    """留下的接口直接或间接用到的组件。没用到的不生成模型，免得管理界面的 schema 混进来。"""
    schemas = document.get("components", {}).get("schemas", {})
    seen: set[str] = set()
    pending = references(document["paths"], set())
    while pending:
        name = pending.pop()
        if name in seen or name not in schemas:
            continue
        seen.add(name)
        pending |= references(schemas[name], set()) - seen
    return seen


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
    schemas = document.get("components", {}).get("schemas", {})
    keep = reachable(document)
    document.setdefault("components", {})["schemas"] = {
        name: schema for name, schema in schemas.items() if name in keep
    }
    json.dump(document, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
