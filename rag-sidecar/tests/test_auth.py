import asyncio

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import SidecarError, SidecarInfo
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "k" * 48
HEADER = "x-sidecar-secret"


def _app():
    return create_app(SidecarSettings(secret=SecretStr(SECRET)))


def test_missing_header_is_401():
    response = TestClient(_app()).get("/v1/info")
    assert response.status_code == 401
    assert SidecarError.model_validate(response.json()).error == "unauthorized"


def test_wrong_header_is_401():
    response = TestClient(_app()).get("/v1/info", headers={HEADER: "wrong"})
    assert response.status_code == 401


def test_header_differing_only_in_last_character_is_401():
    near_miss = SECRET[:-1] + "x"
    assert near_miss != SECRET
    response = TestClient(_app()).get("/v1/info", headers={HEADER: near_miss})
    assert response.status_code == 401


def test_non_ascii_header_value_is_401_not_500():
    response = TestClient(_app()).get("/v1/info", headers={HEADER: "é".encode("latin-1")})
    assert response.status_code == 401


def test_correct_header_returns_sidecar_info():
    response = TestClient(_app()).get("/v1/info", headers={HEADER: SECRET})
    assert response.status_code == 200
    info = SidecarInfo.model_validate(response.json())
    assert info.service == "rag-sidecar"
    assert info.contracts_schema_version == 1
    assert info.version


def test_unknown_v1_path_requires_auth_before_404():
    client = TestClient(_app())
    assert client.get("/v1/unknown").status_code == 401
    assert client.get("/v1/unknown", headers={HEADER: SECRET}).status_code == 404


def test_docs_and_openapi_are_401_without_header_and_404_with_it():
    client = TestClient(_app())
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={HEADER: SECRET}).status_code == 404


def test_probe_paths_do_not_require_header_but_trailing_slash_does():
    client = TestClient(_app())
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code == 200
    assert client.get("/health/").status_code == 401


def test_twenty_concurrent_requests_are_judged_by_their_own_header():
    app = _app()
    headers: list[dict[str, str]] = []
    expected: list[int] = []
    for index in range(20):
        kind = index % 3
        if kind == 0:
            headers.append({HEADER: SECRET})
            expected.append(200)
        elif kind == 1:
            headers.append({HEADER: f"wrong-{index}"})
            expected.append(401)
        else:
            headers.append({})
            expected.append(401)

    async def run() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sidecar") as client:
            responses = await asyncio.gather(*(client.get("/v1/info", headers=h) for h in headers))
        return [r.status_code for r in responses]

    assert asyncio.run(run()) == expected
