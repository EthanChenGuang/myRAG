import hashlib
import hmac

from starlette.types import ASGIApp, Receive, Scope, Send

from rag_sidecar.contracts import SidecarError
from rag_sidecar.settings import SidecarSettings

PROBE_PATHS = frozenset({"/health", "/ready"})
SECRET_HEADER = b"x-sidecar-secret"


def _digest(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()


class SharedSecretMiddleware:
    def __init__(self, app: ASGIApp, settings: SidecarSettings) -> None:
        self.app = app
        self._configured = settings.secret_configured
        self._expected = (
            _digest(settings.secret.get_secret_value().encode("utf-8"))
            if self._configured and settings.secret is not None
            else b""
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope_type == "http" and scope["path"] in PROBE_PATHS:
            await self.app(scope, receive, send)
            return
        if scope_type != "http":
            await self._reject_non_http(scope_type, receive, send)
            return

        if not self._configured:
            await self._respond(send, 503, "sidecar secret not configured")
            return

        provided = self._header_value(scope)
        if provided is None or not hmac.compare_digest(_digest(provided), self._expected):
            await self._respond(send, 401, "unauthorized")
            return

        await self.app(scope, receive, send)

    @staticmethod
    def _header_value(scope: Scope) -> bytes | None:
        for name, value in scope["headers"]:
            if name == SECRET_HEADER:
                return value
        return None

    @staticmethod
    async def _reject_non_http(scope_type: str, receive: Receive, send: Send) -> None:
        if scope_type == "websocket":
            await receive()
            await send({"type": "websocket.close", "code": 1008})

    @staticmethod
    async def _respond(send: Send, status: int, message: str) -> None:
        body = SidecarError(error=message).model_dump_json().encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
