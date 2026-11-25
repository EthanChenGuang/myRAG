"""The optional Ray runner (D-34, D-37): the same ledger claim and job function as the worker, mapped with Ray Data.

Tests without the `ray` marker run in the default environment, where ray is not installed. Tests with the marker need the
ray extra (`uv sync --extra ray`) and start a local Ray instance; they are skipped elsewhere.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import textwrap
import threading
import time
import warnings
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ingest_fakes import AppScript, FakeApp, FakeLedger
from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest import ray_runner
from rag_sidecar.ingest.app_client import AppClient
from rag_sidecar.ingest.ledger_client import BatchJobRef
from pydantic import SecretStr


# The `ray` marker selects the tests that need a local Ray instance (`pytest -m ray`). It is declared here rather than in
# pyproject.toml, so reading it must not warn about an unregistered marker.
with warnings.catch_warnings():
    warnings.simplefilter("ignore", pytest.PytestUnknownMarkWarning)
    ray_marker = pytest.mark.ray


_BATCH = "00000000-0000-4000-8000-0000000000b7"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_CACHE_ID = "00000000-0000-4000-8000-0000000000c1"
_SECRET = "ray-runner-test-secret-0000000000000"


def _job_id(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012d}"


def _job(index: int, **updates: Any) -> IngestionJob:
    payload: dict[str, Any] = {
        "id": _job_id(index),
        "kind": "ingest",
        "status": "queued",
        "tenant_key": "u:00000000-0000-4000-8000-0000000000a1",
        "document_id": "00000000-0000-4000-8000-0000000000d1",
        "batch_id": _BATCH,
        "source": "backfill",
        "source_key": f"root/file-{index}.md",
        "file_sha256": f"{index:064x}",
        "mime_type": "text/markdown",
        "priority": 10,
        "settings": {
            "routing": "fixed",
            "cloud_allowed": True,
            "escalation": True,
            "progressive": False,
            "premium_max_pages_per_doc": 50,
            "premium_page_budget": 0,
            "vlm_detect": False,
            "profile_id": "general@1",
            "profile_version": 1,
            "doc_type": "general",
            "embed_mode": "sync",
            "ocr_languages": ["en"],
            "routing_config_version": "1",
        },
        "created_at": (_NOW + timedelta(seconds=index)).isoformat(),
        "updated_at": _NOW.isoformat(),
    }
    payload.update(updates)
    return IngestionJob.model_validate(payload)


def _fixed_app(worker: str = "ray:test") -> FakeApp:
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": worker, "status": "done", "cache_id": _CACHE_ID})])
    app.script("advance", [AppScript(response={"worker_id": worker, "stage": "ready", "done": True, "status": "ready"})])
    return app


def _context(ledger: FakeLedger, app: FakeApp, **kwargs: Any) -> ray_runner.JobContext:
    return ray_runner.JobContext(ledger=ledger, app=app, storage=None, worker_id="ray:test", **kwargs)


# --- the default environment never imports ray ------------------------------------------------------------------------


def test_the_worker_the_app_and_the_runner_module_never_import_ray():
    code = textwrap.dedent(
        """
        import importlib.abc, sys

        attempts = []

        class Recorder(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                if name == "ray" or name.startswith("ray."):
                    attempts.append(name)
                return None

        sys.meta_path.insert(0, Recorder())
        import rag_sidecar.ingest  # noqa: F401
        import rag_sidecar.ingest.worker  # noqa: F401
        import rag_sidecar.main  # noqa: F401  (builds the app at import)
        import rag_sidecar.ingest.ray_runner as runner
        runner.parse_args(["--batch", "00000000-0000-4000-8000-0000000000b7"])
        assert not attempts, attempts
        assert not [name for name in sys.modules if name == "ray" or name.startswith("ray.")]
        print("ok")
        """
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "RAG_SIDECAR_ENV": "test",
        "RAG_SIDECAR_SECRET": _SECRET,
    }
    result = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, env=env, check=False)
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip() == "ok"


# --- arguments ---------------------------------------------------------------------------------------------------------


def test_arguments_default_to_one_to_two_actors_with_two_cpus_each():
    options = ray_runner.parse_args(["--batch", _BATCH.upper()])
    assert options == ray_runner.RunnerOptions(batch_id=_BATCH, min_actors=1, max_actors=2, cpus_per_actor=2.0)


def test_arguments_set_the_pool_size_and_cpus():
    options = ray_runner.parse_args(["--batch", _BATCH, "--max-actors", "4", "--cpus", "0.5"])
    assert (options.min_actors, options.max_actors, options.cpus_per_actor) == (1, 4, 0.5)


@pytest.mark.parametrize(
    "argv",
    [
        ["--batch", "not-a-uuid"],
        ["--batch", _BATCH, "--max-actors", "0"],
        ["--batch", _BATCH, "--cpus", "0"],
        ["--batch", _BATCH, "--cpus", "nan"],
        [],
    ],
)
def test_bad_arguments_are_usage_errors(argv):
    with pytest.raises(SystemExit) as raised:
        ray_runner.parse_args(argv)
    assert raised.value.code == 2


# --- which jobs a pass offers ------------------------------------------------------------------------------------------


def test_a_pass_offers_queued_jobs_and_expired_leases_only():
    now = _NOW + timedelta(hours=1)
    jobs = [
        _job(1),
        _job(2, run_after=(now + timedelta(minutes=5)).isoformat()),
        _job(3, run_after=(now - timedelta(minutes=5)).isoformat()),
        _job(4, status="parsing", locked_by="worker-x", lease_until=(now - timedelta(seconds=1)).isoformat()),
        _job(5, status="parsing", locked_by="worker-x", lease_until=(now + timedelta(seconds=60)).isoformat()),
        _job(6, status="ready"),
        _job(7, status="needs_review"),
        _job(8, kind="dry_run"),
        _job(9, kind="delete"),
    ]
    assert ray_runner.claimable(jobs, now) == [_job_id(1), _job_id(3), _job_id(4), _job_id(8)]
    assert [job.id for job in ray_runner.open_jobs(jobs)] == [_job_id(index) for index in (1, 2, 3, 4, 5, 8)]


# --- one job: claim, skip, run, fail -----------------------------------------------------------------------------------


def test_an_actor_claims_with_runner_ray_and_runs_the_job_function():
    ledger = FakeLedger()
    ledger.seed(_job(1))
    app = _fixed_app()

    result = asyncio.run(ray_runner.run_job(_job_id(1), _context(ledger, app)))

    assert result == {"job_id": _job_id(1), "result": "processed", "status": "ready"}
    assert ledger.call_counts["claim_one"] == 1
    assert ledger.jobs[_job_id(1)].runner == "ray"
    assert ledger.jobs[_job_id(1)].locked_by == "ray:test"
    assert [call[0] for call in app.calls] == ["parse_external", "advance"]


def test_a_job_another_runner_holds_is_skipped_without_any_callback():
    ledger = FakeLedger()
    ledger.seed(_job(1, status="parsing", locked_by="worker-x", runner="worker", lease_until=(_NOW + timedelta(hours=9)).isoformat()))
    app = _fixed_app()
    processed: list[str] = []

    async def process(job, deps):  # pragma: no cover - must not run
        processed.append(job.id)
        raise AssertionError("a skipped job must not run")

    result = asyncio.run(ray_runner.run_job(_job_id(1), _context(ledger, app, process=process)))

    assert result == {"job_id": _job_id(1), "result": "skipped", "status": ""}
    assert processed == [] and app.calls == []
    assert ledger.jobs[_job_id(1)].runner == "worker"


def test_a_job_function_error_fails_the_job_with_its_error_class_like_the_worker():
    ledger = FakeLedger()
    ledger.seed(_job(1))
    app = _fixed_app()

    async def process(job, deps):
        raise RuntimeError("boom")

    result = asyncio.run(ray_runner.run_job(_job_id(1), _context(ledger, app, process=process)))

    job = ledger.jobs[_job_id(1)]
    assert result["result"] == "processed"
    assert job.error_class == "worker_error"
    assert result["status"] == job.status


def test_an_outcome_with_an_error_class_is_settled_through_the_ledger():
    ledger = FakeLedger()
    ledger.seed(_job(1))
    app = FakeApp()
    app.script("parse_external", [AppScript(response={"worker_id": "ray:test", "status": "failed", "error_class": "no_parser_available"})])

    result = asyncio.run(ray_runner.run_job(_job_id(1), _context(ledger, app)))

    assert result["result"] == "processed"
    assert ledger.jobs[_job_id(1)].status == "failed"
    assert ledger.jobs[_job_id(1)].error_class == "no_parser_available"
    assert result["status"] == "failed"


def test_a_lost_lease_cancels_the_job_and_reports_lease_lost():
    ledger = FakeLedger()
    ledger.seed(_job(1))

    async def process(job, deps):
        await asyncio.sleep(10)
        raise AssertionError("cancelled before this")

    async def lost(job_id, worker):
        return False

    ledger.heartbeat = lost  # type: ignore[method-assign]
    context = _context(ledger, FakeApp(), process=process, heartbeat_seconds=0.01)
    result = asyncio.run(asyncio.wait_for(ray_runner.run_job(_job_id(1), context), timeout=5))
    assert result == {"job_id": _job_id(1), "result": "processed", "status": "lease_lost"}


# --- the driver: rounds until every job of the batch is terminal ------------------------------------------------------


class _ListingLedger:
    """Serves list_batch_jobs from a dict the test mutates."""

    def __init__(self, jobs: list[IngestionJob]) -> None:
        self.jobs = {job.id: job for job in jobs}
        self.lists = 0

    async def list_batch_jobs(self, batch_id: str, **_: Any) -> list[IngestionJob]:
        assert batch_id == _BATCH
        self.lists += 1
        return sorted(self.jobs.values(), key=lambda job: (job.created_at, job.id))

    def finish(self, job_id: str, status: str = "ready") -> None:
        self.jobs[job_id] = self.jobs[job_id].model_copy(update={"status": status, "locked_by": None, "lease_until": None})


def test_the_driver_runs_every_queued_job_once_and_stops_when_the_batch_is_terminal():
    ledger = _ListingLedger([_job(index) for index in range(1, 7)])
    passes: list[list[str]] = []

    async def run_pass(job_ids: list[str]) -> list[dict[str, str]]:
        passes.append(job_ids)
        for job_id in job_ids:
            ledger.finish(job_id)
        return [{"job_id": job_id, "result": "processed", "status": "ready"} for job_id in job_ids]

    async def sleep(_: float) -> None:
        raise AssertionError("no idle wait when every pass makes progress")

    summary = asyncio.run(ray_runner.drive_batch(_BATCH, ledger=ledger, run_pass=run_pass, sleep=sleep, clock=lambda: _NOW))

    assert passes == [[_job_id(index) for index in range(1, 7)]]
    assert summary.processed == 6 and summary.skipped == 0 and summary.statuses == {"ready": 6}


def test_the_driver_offers_skipped_jobs_again_and_waits_for_jobs_another_runner_holds():
    held = _job(3, status="parsing", locked_by="worker-x", lease_until=(_NOW + timedelta(minutes=2)).isoformat())
    ledger = _ListingLedger([_job(1), _job(2), held])
    passes: list[list[str]] = []
    sleeps: list[float] = []

    async def run_pass(job_ids: list[str]) -> list[dict[str, str]]:
        passes.append(job_ids)
        out = []
        for job_id in job_ids:
            if len(passes) == 1 and job_id == _job_id(2):
                out.append({"job_id": job_id, "result": "skipped", "status": ""})  # the batch had no room for it
                continue
            ledger.finish(job_id)
            out.append({"job_id": job_id, "result": "processed", "status": "ready"})
        return out

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        ledger.finish(_job_id(3))  # the other runner finishes its job meanwhile

    summary = asyncio.run(ray_runner.drive_batch(_BATCH, ledger=ledger, run_pass=run_pass, sleep=sleep, clock=lambda: _NOW))

    assert passes == [[_job_id(1), _job_id(2)], [_job_id(2)]]
    assert len(sleeps) == 1
    assert summary.processed == 2 and summary.skipped == 1


def test_the_driver_ends_at_once_for_a_batch_with_no_open_job():
    ledger = _ListingLedger([_job(1, status="ready"), _job(2, status="skipped_duplicate")])

    async def run_pass(job_ids):  # pragma: no cover - must not run
        raise AssertionError(job_ids)

    summary = asyncio.run(ray_runner.drive_batch(_BATCH, ledger=ledger, run_pass=run_pass, clock=lambda: _NOW))
    assert summary.processed == 0 and ledger.lists == 1


def test_the_driver_ends_when_the_only_open_jobs_are_parked_at_embed_deferred():
    # 03.1-49 parks a batch_api backfill job at status embedding, stage embed_deferred, lease released; the rag:backfill
    # process embeds and publishes it after the runner, so the runner must not wait for it.
    parked = _job(2, status="embedding", stage="embed_deferred")
    ledger = _ListingLedger([_job(1, status="ready"), parked])

    async def run_pass(job_ids):  # pragma: no cover - must not run
        raise AssertionError(job_ids)

    async def sleep(_: float) -> None:
        raise AssertionError("a parked job is not waited for")

    summary = asyncio.run(ray_runner.drive_batch(_BATCH, ledger=ledger, run_pass=run_pass, sleep=sleep, clock=lambda: _NOW))
    assert summary.processed == 0 and ledger.lists == 1
    assert ray_runner.open_jobs([BatchJobRef(id=parked.id, kind="ingest", status="embedding", stage="embed_deferred")]) == []


# --- the shared token bucket ---------------------------------------------------------------------------------------


def test_the_shared_bucket_waits_until_the_remote_bucket_grants_a_token():
    answers = iter([False, False, True])
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    bucket = ray_runner.SharedTokenBucket(lambda: next(answers), rate_per_second=4.0, sleep=sleep)
    asyncio.run(bucket.acquire())
    assert sleeps == [0.25, 0.25]


def test_the_bucket_actor_grants_at_most_its_rate_per_second():
    now = [100.0]
    actor = ray_runner.TokenBucketActor(2.0, clock=lambda: now[0])
    assert [actor.try_acquire() for _ in range(3)] == [True, True, False]
    now[0] += 0.5
    assert actor.try_acquire() is True
    assert actor.try_acquire() is False


def test_the_app_client_takes_the_shared_bucket():
    async def run() -> int:
        granted = []

        def grant() -> bool:
            granted.append(1)
            return True

        client = AppClient(
            app_base_url="http://127.0.0.1:1",
            secret=SecretStr(_SECRET),
            token_bucket=ray_runner.SharedTokenBucket(grant, rate_per_second=10.0),  # type: ignore[arg-type]
        )
        try:
            await client._bucket.acquire()
        finally:
            await client.aclose()
        return len(granted)

    assert asyncio.run(run()) == 1


# --- the actor over a Ray Data batch, without Ray ----------------------------------------------------------------------


def test_the_actor_maps_a_batch_of_job_ids_to_result_columns():
    ledger = FakeLedger()
    ledger.seed(_job(1))
    ledger.seed(_job(2, status="ready"))
    app = _fixed_app()
    actor = ray_runner.ProcessJobActor(clients=lambda: (ledger, app, None))
    try:
        out = actor({"job_id": [_job_id(1), _job_id(2)]})
    finally:
        actor.close()
    assert out == {
        "job_id": [_job_id(1), _job_id(2)],
        "result": ["processed", "skipped"],
        "status": ["ready", ""],
    }
    assert re.fullmatch(r"ray:[0-9a-f]{12}", ledger.jobs[_job_id(1)].locked_by or "")


def test_the_actor_refuses_to_start_without_the_worker_environment(monkeypatch):
    for name in ("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RAG_APP_INTERNAL_URL", "RAG_SIDECAR_SECRET"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="worker environment is incomplete"):
        ray_runner.ProcessJobActor()


# --- a local Ray instance (ray extra only) -----------------------------------------------------------------------------


class _Doubles:
    """PostgREST and app callback doubles over one FakeLedger, served over HTTP so Ray actor processes can reach them."""

    def __init__(self, jobs: list[IngestionJob], *, stolen: set[str]) -> None:
        self.ledger = FakeLedger()
        for job in jobs:
            self.ledger.seed(job)
        self.lock = threading.Lock()
        self.stolen = stolen
        self.claims: dict[str, list[str]] = {}
        self.advances: dict[str, int] = {}
        doubles = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                with doubles.lock:
                    status, payload = doubles.handle(self.path, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def _job_json(self, job: IngestionJob | None) -> Any:
        if job is None:
            return {key: None for key in IngestionJob.model_fields}
        return job.model_dump(mode="json")

    def _finish_stolen_later(self, job_id: str) -> None:
        def finish() -> None:
            time.sleep(0.5)
            with self.lock:
                job = self.ledger.jobs[job_id]
                self.ledger.jobs[job_id] = job.model_copy(update={"status": "ready", "lease_until": None})

        threading.Thread(target=finish, daemon=True).start()

    def handle(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        run = asyncio.run
        if path == "/rest/v1/rpc/rag_list_batch_jobs":
            jobs = sorted(
                (job for job in self.ledger.jobs.values() if job.batch_id == body["p_batch_id"]),
                key=lambda job: (job.created_at, job.id),
            )
            if body.get("p_after_id"):
                ids = [job.id for job in jobs]
                jobs = jobs[ids.index(body["p_after_id"]) + 1 :]
            return 200, [job.model_dump(mode="json") for job in jobs[: body["p_limit"]]]
        if path == "/rest/v1/rpc/rag_claim_ingestion_job":
            job_id = body["p_job_id"]
            self.claims.setdefault(job_id, []).append(body["p_worker"])
            if job_id in self.stolen:
                self.stolen.discard(job_id)
                run(self.ledger.claim_one(job_id, worker="worker-x", runner="worker"))
                self._finish_stolen_later(job_id)
                return 200, self._job_json(None)
            return 200, self._job_json(run(self.ledger.claim_one(job_id, worker=body["p_worker"], runner=body["p_runner"])))
        if path == "/rest/v1/rpc/rag_heartbeat_ingestion_job":
            return 200, run(self.ledger.heartbeat(body["p_job_id"], body["p_worker"]))
        if path == "/rest/v1/rpc/rag_record_parse_attempt":
            return 200, 1
        if path == "/rest/v1/rpc/rag_fail_ingestion_job":
            row = run(
                self.ledger.fail(
                    body["p_job_id"], body["p_worker"], error_class=body["p_error_class"], retryable=body["p_retryable"]
                )
            )
            return 200, row.model_dump(mode="json")
        match = re.fullmatch(r"/api/internal/rag/ingest/jobs/([0-9a-f-]+)/(parse-external|advance)", path)
        if match:
            job_id, action = match.groups()
            if action == "parse-external":
                return 200, {"worker_id": body["worker_id"], "status": "done", "cache_id": _CACHE_ID}
            self.advances[job_id] = self.advances.get(job_id, 0) + 1
            job = self.ledger.jobs[job_id]
            self.ledger.jobs[job_id] = job.model_copy(update={"status": "ready", "lease_until": None})
            return 200, {"worker_id": body["worker_id"], "stage": "ready", "done": True, "status": "ready"}
        return 404, {"message": f"unexpected {path}"}


@ray_marker
def test_a_local_ray_instance_processes_a_batch_once_per_job_and_skips_a_job_another_worker_took(monkeypatch):
    ray = pytest.importorskip("ray", reason="needs the ray extra: uv sync --extra ray")
    stolen = _job_id(4)
    doubles = _Doubles([_job(index) for index in range(1, 7)], stolen={stolen})
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", doubles.url)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_placeholder_value_for_tests")
    monkeypatch.setenv("RAG_APP_INTERNAL_URL", doubles.url)
    monkeypatch.setenv("RAG_SIDECAR_SECRET", _SECRET)
    monkeypatch.delenv("RAY_ADDRESS", raising=False)
    try:
        code = ray_runner.main(["--batch", _BATCH, "--max-actors", "2", "--cpus", "1"])
    finally:
        doubles.close()
        if ray.is_initialized():
            ray.shutdown()

    assert code == 0
    jobs = doubles.ledger.jobs
    assert all(job.status == "ready" for job in jobs.values())
    ray_jobs = sorted(job_id for job_id in jobs if job_id != stolen)
    assert sorted(doubles.advances) == ray_jobs, "the job another worker took was never run by Ray"
    assert all(doubles.advances[job_id] == 1 for job_id in ray_jobs), doubles.advances
    assert all(len(doubles.claims[job_id]) == 1 for job_id in ray_jobs), doubles.claims
    assert all(jobs[job_id].runner == "ray" and (jobs[job_id].locked_by or "").startswith("ray:") for job_id in ray_jobs)
    assert jobs[stolen].runner == "worker" and jobs[stolen].locked_by == "worker-x"
