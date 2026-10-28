from enum import StrEnum


class CreateMemoryRequestLayer(StrEnum):
    APP = "app"
    BASE = "base"
    EPISODE = "episode"
    OWNER = "owner"
    PERSONA = "persona"
    PRIVATE = "private"
    SUBJECT = "subject"

    def __str__(self) -> str:
        return str(self.value)
