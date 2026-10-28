from enum import StrEnum


class UpdateMemoryRequestLayer(StrEnum):
    BASE = "base"
    OWNER = "owner"
    PRIVATE = "private"

    def __str__(self) -> str:
        return str(self.value)
