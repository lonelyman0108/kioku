"""去掉生成的代码里重复的顶层导入。

openapi-python-client 在带可选字段的模型里会把 `from ..types import UNSET, Unset` 写两遍。
只看从行首开始的 import / from 行（TYPE_CHECKING 块与函数里的导入有缩进，不动），完全相同的只留第一行。
"""

import sys
from pathlib import Path


def dedupe(text: str) -> str:
    seen: set[str] = set()
    lines = []
    for line in text.splitlines(keepends=True):
        if line.startswith(("import ", "from ")):
            if line in seen:
                continue
            seen.add(line)
        lines.append(line)
    return "".join(lines)


def main(root: str) -> None:
    for path in Path(root).rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        cleaned = dedupe(text)
        if cleaned != text:
            path.write_text(cleaned, encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1])
