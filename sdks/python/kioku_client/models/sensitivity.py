from enum import StrEnum


class Sensitivity(StrEnum):
    INTERNAL = "internal"
    PRIVATE = "private"
    PUBLIC = "public"
    SECRET = "secret"

    def __str__(self) -> str:
        return str(self.value)
