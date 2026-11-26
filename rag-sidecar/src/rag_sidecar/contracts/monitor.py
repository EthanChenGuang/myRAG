"""Stub for the RED commit."""

from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class MonitorRule(_Stub):
    pass


class MonitorAlertsConfig(_Stub):
    pass


class MonitorDailyCell(_Stub):
    pass


class MonitorAlert(_Stub):
    pass


class DriftReport(_Stub):
    pass


def default_monitor_alerts() -> MonitorAlertsConfig:
    return MonitorAlertsConfig()
