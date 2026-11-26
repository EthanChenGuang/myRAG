from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class SecurityEvent(_Stub):
    pass


class SecurityAlert(_Stub):
    pass


class SecurityUploaderView(_Stub):
    pass


class LinkPreviewStatus(_Stub):
    pass
