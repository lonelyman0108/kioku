from enum import StrEnum


class BindResultStatus(StrEnum):
    MERGED = "merged"
    PENDING = "pending"

    def __str__(self) -> str:
        return str(self.value)
