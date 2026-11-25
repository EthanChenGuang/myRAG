"""Tests for ingestion outbound clients and fakes."""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    IngestionJob,
    JobSettingsSnapshot,
    OriginalRef,
    ParseExternalRequest,
    ParseExternalResponse,
)
from rag_sidecar.contracts.routing import ParseAttemptPages, QualityCheckResult
from rag_sidecar.ingest.app_client import AppAuthError, AppClient, TokenBucket
from rag_sidecar.ingest.ledger_client import LeaseLost, LedgerClient, Refused, Transient
from rag_sidecar.ingest.storage_client import StorageClient, StoragePathError
from rag_sidecar.ingest.supabase_headers import supabase_headers
from ingest_fakes import AppScript, FakeApp, FakeClock, FakeLedger, conversion_counter, reset_conversion_counter

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_HASH = "a" * 64
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_JWT_KEY = "eyJhbGci.test.eyJzZWNyZXQ"
_SB_KEY = "sb_secret_placeholder_value_for_tests"
_SUPABASE_URL = "https://example.supabase.co"
_APP_URL = "https://app.example"


def _settings() -> JobSettingsSnapshot:
    return JobSettingsSnapshot(
        routing="tiered",
        cloud_allowed=True,
        escalation=True,
        progressive=False,
        premium_max_pages_per_doc=50,
        premium_page_budget=0,
        vlm_detect=False,
        profile_id="general@1",
        profile_version=1,
        doc_type="general",
        min_tier="fast",
        max_tier="premium",
        embed_mode="sync",
        ocr_languages=["en"],
        routing_config_version="1",
    )


def _job_payload(**updates) -> dict:
    base = {
        "id": _JOB_ID,
        "kind": "ingest",
        "status": "queued",
        "tenant_key": "u:00000000-0000-4000-8000-000000000099",
        "source": "upload",
        "source_key": "docs/sample.pdf",
        "file_sha256": _HASH,
        "original_ref": {"bucket": "rag-originals", "path": "u:tenant/docs/sample.pdf"},
        "settings": _settings().model_dump(mode="json"),
        "created_at": _NOW.isoformat(),
        "updated_at": _NOW.isoformat(),
    }
    base.update(updates)
    return base


def _recorded_transport(handlers: dict[str, callable], recorded: list[dict]) -> httpx.AsyncClient:
    async def dispatch(request: httpx.Request) -> httpx.Response:
        recorded.append(
            {
                "method": request.method,
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content) if request.content else None,
            }
        )
        key = request.url.path
        for pattern, handler in handlers.items():
            if pattern in key:
                return handler(request)
        return httpx.Response(404, json={"message": "not found"})

    transport = httpx.MockTransport(dispatch)
    return httpx.AsyncClient(transport=transport, base_url=_SUPABASE_URL)


# --- supabase_headers ---


def test_supabase_headers_jwt_adds_bearer():
    headers = supabase_headers(_JWT_KEY)
    assert headers["apikey"] == _JWT_KEY
    assert headers["Authorization"] == f"Bearer {_JWT_KEY}"


def test_supabase_headers_secret_key_is_apikey_only():
    headers = supabase_headers(_SB_KEY)
    assert headers["apikey"] == _SB_KEY
    assert "Authorization" not in headers


def test_supabase_headers_empty_raises():
    with pytest.raises(ValueError):
        supabase_headers("")


# --- LedgerClient ---


def test_ledger_claim_posts_expected_rpc_body():
    recorded: list[dict] = []

    def claim_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {
            "p_worker": "worker-a",
            "p_limit": 2,
            "p_allow_batch": True,
            "p_runner": "worker",
        }
        return httpx.Response(200, json=[_job_payload(status="preflight", locked_by="worker-a")])

    async def run() -> list[IngestionJob]:
        client = LedgerClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/rpc/rag_claim_ingestion_jobs": claim_handler}, recorded),
        )
        jobs = await client.claim(worker="worker-a", limit=2, allow_batch=True)
        await client.aclose()
        return jobs

    jobs = asyncio.run(run())
    assert len(jobs) == 1
    assert jobs[0].id == _JOB_ID
    assert all("tenant" not in (row.get("body") or {}) and "tenant_key" not in (row.get("body") or {}) for row in recorded)
    auth_headers = recorded[0]["headers"]
    assert auth_headers.get("apikey") == _SB_KEY
    assert "authorization" not in {k.lower() for k in auth_headers}


@pytest.mark.parametrize(
    ("code", "status", "exc"),
    [
        ("55000", 400, LeaseLost),
        ("22023", 400, Refused),
        ("", 503, Transient),
    ],
)
def test_ledger_maps_postgrest_errors(code, status, exc):
    def handler(_: httpx.Request) -> httpx.Response:
        body = {"message": "ledger failure", "code": code} if code else {"message": "unavailable"}
        return httpx.Response(status, json=body)

    async def run() -> None:
        client = LedgerClient(
            base_url=_SUPABASE_URL,
            service_key=_JWT_KEY,
            client=_recorded_transport({"/rpc/rag_claim_ingestion_jobs": handler}, []),
        )
        with pytest.raises(exc):
            await client.claim(worker="w", limit=1, allow_batch=False)
        await client.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("payload", [None, {}, {key: None for key in _job_payload()}])
def test_ledger_claim_one_reads_an_unclaimable_job_as_none(payload):
    """rag_claim_ingestion_job returns a NULL composite; PostgREST sends it as an object whose columns are all null."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    async def run():
        client = LedgerClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/rpc/rag_claim_ingestion_job": handler}, []),
        )
        try:
            return await client.claim_one(_JOB_ID, worker="ray:a", runner="ray")
        finally:
            await client.aclose()

    assert asyncio.run(run()) is None


def test_ledger_claim_one_posts_the_runner():
    recorded: list[dict] = []

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_job_payload(status="preflight", locked_by="ray:a", runner="ray"))

    async def run():
        client = LedgerClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/rpc/rag_claim_ingestion_job": handler}, recorded),
        )
        try:
            return await client.claim_one(_JOB_ID, worker="ray:a", runner="ray")
        finally:
            await client.aclose()

    job = asyncio.run(run())
    assert job is not None and job.runner == "ray"
    assert recorded[0]["body"] == {"p_job_id": _JOB_ID, "p_worker": "ray:a", "p_runner": "ray"}


def test_ledger_list_batch_jobs_pages_by_the_last_id():
    batch = "00000000-0000-4000-8000-0000000000b7"
    ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 6)]
    recorded: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        after = body["p_after_id"]
        start = 0 if after is None else ids.index(after) + 1
        page = ids[start : start + body["p_limit"]]
        return httpx.Response(200, json=[_job_payload(id=job_id, batch_id=batch) for job_id in page])

    async def run():
        client = LedgerClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/rpc/rag_list_batch_jobs": handler}, recorded),
        )
        try:
            return await client.list_batch_jobs(batch, page_size=2)
        finally:
            await client.aclose()

    jobs = asyncio.run(run())
    assert [job.id for job in jobs] == ids
    assert [row["body"] for row in recorded] == [
        {"p_batch_id": batch, "p_status": None, "p_after_id": None, "p_limit": 2},
        {"p_batch_id": batch, "p_status": None, "p_after_id": ids[1], "p_limit": 2},
        {"p_batch_id": batch, "p_status": None, "p_after_id": ids[3], "p_limit": 2},
    ]


def test_ledger_repr_never_contains_key():
    client = LedgerClient(base_url=_SUPABASE_URL, service_key=_JWT_KEY)
    text = repr(client)
    assert _JWT_KEY not in text
    assert "service_key" not in text


# --- StorageClient ---


def test_storage_put_rejects_bad_names_and_unregistered_prefix():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    async def run() -> None:
        client = StorageClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/storage/": handler}, []),
        )
        client.register_cache_prefix("tenant/_parse-cache/hash/parser/")
        with pytest.raises(StoragePathError):
            await client.put("rag-originals", "tenant/_parse-cache/hash/parser/", "../evil", b"x")
        with pytest.raises(StoragePathError):
            await client.put("rag-originals", "other/prefix/", "artifact.json", b"x")
        await client.aclose()

    asyncio.run(run())


def test_storage_download_writes_temp_file():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/storage/v1/object/rag-originals/" in request.url.path
        return httpx.Response(200, content=b"pdf-bytes")

    async def run() -> Path:
        client = StorageClient(
            base_url=_SUPABASE_URL,
            service_key=_SB_KEY,
            client=_recorded_transport({"/storage/": handler}, []),
        )
        ref = OriginalRef(bucket="rag-originals", path="tenant/sample.pdf")
        path = await client.download(ref)
        await client.aclose()
        return path

    assert asyncio.run(run()).read_bytes() == b"pdf-bytes"


# --- AppClient ---


def test_app_advance_retries_same_body_after_504():
    bodies: list[dict] = []
    calls = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(504, json={"error": "gateway"})
        return httpx.Response(
            200,
            json={"worker_id": "worker-1", "stage": "chunk", "done": True, "wait_ms": 0},
        )

    async def run() -> AdvanceResponse:
        transport = httpx.MockTransport(handler)
        http_client = httpx.AsyncClient(transport=transport, base_url=_APP_URL)
        app = AppClient(app_base_url=_APP_URL, secret=SecretStr("x" * 32), client=http_client, rate_per_second=100)
        req = AdvanceRequest(worker_id="worker-1", attempt_no=1, phase="begin", deadline_ms=1000)
        resp = await app.advance(_JOB_ID, req)
        await app.aclose()
        return resp

    resp = asyncio.run(run())
    assert resp.done is True
    assert len(bodies) == 2
    assert bodies[0] == bodies[1]


def test_app_401_raises_without_retry():
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    async def run() -> None:
        transport = httpx.MockTransport(handler)
        app = AppClient(
            app_base_url=_APP_URL,
            secret=SecretStr("x" * 32),
            client=httpx.AsyncClient(transport=transport, base_url=_APP_URL),
            rate_per_second=100,
        )
        req = AdvanceRequest(worker_id="worker-1", attempt_no=1, phase="begin", deadline_ms=1000)
        with pytest.raises(AppAuthError):
            await app.advance(_JOB_ID, req)
        await app.aclose()

    asyncio.run(run())


def test_token_bucket_blocks_until_refill():
    state = {"t": 0.0}

    def clock() -> float:
        return state["t"]

    bucket = TokenBucket(2.0, clock=clock)
    assert bucket.try_acquire()
    assert bucket.try_acquire()
    assert not bucket.try_acquire()
    state["t"] = 0.6
    assert bucket.try_acquire()


# --- FakeLedger contract scenario ---


def test_fake_ledger_claim_fail_retry_reclaim_flow():
    async def run() -> None:
        clock = FakeClock()
        ledger = FakeLedger(clock)
        job = IngestionJob.model_validate(
            _job_payload(status="queued", retries=0, max_retries=2, locked_by=None, lease_until=None)
        )
        ledger.seed(job)

        claimed = await ledger.claim(worker="w-1", limit=1, allow_batch=True)
        assert claimed[0].locked_by == "w-1"
        assert claimed[0].status == "preflight"

        failed = await ledger.fail(_JOB_ID, "w-1", error_class="transient", retryable=True)
        assert failed.status == "queued"
        assert failed.retries == 1
        assert failed.locked_by is None

        clock.advance(31)
        reclaimed = await ledger.claim(worker="w-2", limit=1, allow_batch=True)
        assert reclaimed[0].locked_by == "w-2"
        assert reclaimed[0].retries == 1

    asyncio.run(run())


def test_conversion_counter_increments():
    reset_conversion_counter()
    assert conversion_counter == 0
    import ingest_fakes as mod

    mod.bump_conversion_counter()
    assert mod.conversion_counter == 1


def test_fake_app_records_calls_and_pending():
    async def run() -> None:
        app = FakeApp()
        app.script(
            "advance",
            [
                AppScript(
                    status=200,
                    response={
                        "worker_id": "worker-1",
                        "stage": "embed",
                        "done": False,
                        "wait_ms": 100,
                    },
                )
            ],
        )
        req = AdvanceRequest(worker_id="worker-1", attempt_no=1, phase="begin", deadline_ms=1000)
        resp = await app.advance(_JOB_ID, req)
        assert resp.done is False
        assert len(app.calls) == 1

    asyncio.run(run())