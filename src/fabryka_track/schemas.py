from datetime import datetime

from pydantic import BaseModel, Field


class Event(BaseModel):
    id: str
    type: str
    timestamp: datetime
    payload: dict = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[Event]


class Notes(BaseModel):
    note: str = ""
    conclusion: str = ""


class LogInput(BaseModel):
    message: str
    level: str = "info"

