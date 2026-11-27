from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LanguageConfidenceCalibration(_Contract):
    pass


class LanguageQualityCell(_Contract):
    pass


class LanguageDropAlert(_Contract):
    pass


class TraceLanguages(_Contract):
    pass
