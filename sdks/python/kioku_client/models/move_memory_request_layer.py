from enum import StrEnum


class MoveMemoryRequestLayer(StrEnum):
    BASE = "base"
    OWNER = "owner"
    PRIVATE = "private"

    def __str__(self) -> str:
        return str(self.value)
