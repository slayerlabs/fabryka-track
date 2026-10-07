"""Validated provenance for historical metric imports without source timestamps."""
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from .models import RunAttribute


class HistoryImport(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    repo_id: str = Field(pattern=r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', max_length=200)
    revision: str = Field(pattern=r'^[0-9a-f]{40}$')
    resume_step: int = Field(ge=1, le=1_000_000_000)
    training_rows: int = Field(ge=0)
    validation_rows: int = Field(ge=0)
    excluded_training_rows: int = Field(ge=0)
    original_world_size: int = Field(ge=1, le=100_000)
    complete: bool
    metric_bounds: dict[str, list[int]] = Field(max_length=20)

    @model_validator(mode='after')
    def bounds(self):
        for key, bounds in self.metric_bounds.items():
            if len(key) > 300 or len(bounds) != 2 or not 0 <= bounds[0] <= bounds[1] <= self.resume_step:
                raise ValueError('Historical bounds must precede the resumed checkpoint.')
        return self

    def public_info(self):
        return self.model_dump(exclude={'metric_bounds'})

    def clear_unknown_timestamps(self, series):
        for key, (low, high) in self.metric_bounds.items():
            for point in series.get(key, []):
                if low <= point['step'] <= high:
                    point['timestamp'] = None


def read_history(session, run_id):
    row = session.get(RunAttribute, (run_id, 'tracking/history_import'))
    if row:
        try:
            return HistoryImport.model_validate(row.value)
        except ValidationError:
            pass
    return None
