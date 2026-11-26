from pydantic import BaseModel, ConfigDict

METRIC_FORMS: dict[str, str] = {}


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class QualityGates(_Contract):
    pass


class GateCheckRow(_Contract):
    pass


class CompositionResult(_Contract):
    pass


class AbsoluteGateResult(_Contract):
    pass
