from enum import StrEnum


class MemorySummaryLayerType3Type1(StrEnum):
    APP = "app"
    BASE = "base"
    EPISODE = "episode"
    OWNER = "owner"
    PERSONA = "persona"
    PRIVATE = "private"
    SUBJECT = "subject"

    def __str__(self) -> str:
        return str(self.value)
