from enum import StrEnum


class BootEntryLayer(StrEnum):
    APP = "app"
    BASE = "base"
    EPISODE = "episode"
    OWNER = "owner"
    PERSONA = "persona"
    PRIVATE = "private"
    SUBJECT = "subject"

    def __str__(self) -> str:
        return str(self.value)
