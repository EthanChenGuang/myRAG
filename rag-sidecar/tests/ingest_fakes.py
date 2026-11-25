"""In-memory fakes for ingestion worker unit tests (D-45)."""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    DetectVlmRequest,
    DetectVlmResponse,
    IngestionJob,
    OriginalRef,
    ParseExternalRequest,
    ParseExternalResponse,
)
from rag_sidecar.contracts.routing import ParseAttempt
from rag_sidecar.ingest.ledger_client import LeaseLost, ParseCacheEntry, Refused


@dataclass
class FakeClock:
    """Injectable monotonic clock for lease and retry tests."""

    _now: datetime = field(default_factory=lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now = self._now + timedelta(seconds=seconds)


conversion_counter = 0


def reset_conversion_counter() -> None:
    global conversion_counter
    conversion_counter = 0


def bump_conversion_counter() -> None:
    global conversion_counter
    conversion_counter += 1


def _clone_job(job: IngestionJob) -> IngestionJob:
    return IngestionJob.model_validate(job.model_dump(mode="json"))


class FakeLedger:
  """Minimal ledger mimic with lease, retry and status rules."""

  LEASE_SECONDS = 120

  def __init__(self, clock: FakeClock | None = None) -> None:
      self.clock = clock or FakeClock()
      self.jobs: dict[str, IngestionJob] = {}
      self.cache: dict[tuple[str, str, str, str, str], ParseCacheEntry] = {}
      self.call_counts: dict[str, int] = {}

  def _bump(self, name: str) -> None:
      self.call_counts[name] = self.call_counts.get(name, 0) + 1

  def seed(self, job: IngestionJob) -> None:
      self.jobs[job.id] = _clone_job(job)

  def _assert_lease(self, job_id: str, worker: str) -> IngestionJob:
      job = self.jobs.get(job_id)
      if job is None:
          raise Refused("job_not_found")
      if job.locked_by != worker or job.lease_until is None or job.lease_until <= self.clock.now():
          raise LeaseLost("lease_lost")
      return job

  async def claim(
      self,
      *,
      worker: str,
      limit: int,
      allow_batch: bool,
      runner: str = "worker",
  ) -> list[IngestionJob]:
      self._bump("claim")
      claimed: list[IngestionJob] = []
      candidates = sorted(
          self.jobs.values(),
          key=lambda j: (-j.priority, j.created_at),
      )
      for job in candidates:
          if len(claimed) >= limit:
              break
          if job.status != "queued":
              continue
          if job.run_after and job.run_after > self.clock.now():
              continue
          if job.batch_id is not None and not allow_batch:
              continue
          updated = _clone_job(job)
          updated = updated.model_copy(
              update={
                  "status": "preflight",
                  "locked_by": worker,
                  "runner": runner,
                  "lease_until": self.clock.now() + timedelta(seconds=self.LEASE_SECONDS),
              }
          )
          self.jobs[job.id] = updated
          claimed.append(updated)
      return claimed

  async def claim_one(self, job_id: str, *, worker: str, runner: str = "worker") -> IngestionJob | None:
      self._bump("claim_one")
      job = self.jobs.get(job_id)
      if job is None or job.status != "queued":
          return None
      if job.run_after and job.run_after > self.clock.now():
          return None
      updated = job.model_copy(
          update={
              "status": "preflight",
              "locked_by": worker,
              "runner": runner,
              "lease_until": self.clock.now() + timedelta(seconds=self.LEASE_SECONDS),
          }
      )
      self.jobs[job_id] = updated
      return updated

  async def heartbeat(self, job_id: str, worker: str) -> bool:
      self._bump("heartbeat")
      try:
          job = self._assert_lease(job_id, worker)
      except LeaseLost:
          return False
      job = job.model_copy(update={"lease_until": self.clock.now() + timedelta(seconds=self.LEASE_SECONDS)})
      self.jobs[job_id] = job
      return True

  async def release(self, job_id: str, worker: str) -> bool:
      self._bump("release")
      try:
          self._assert_lease(job_id, worker)
      except LeaseLost:
          return False
      job = self.jobs[job_id].model_copy(
          update={
              "status": "queued",
              "locked_by": None,
              "lease_until": None,
              "runner": None,
          }
      )
      self.jobs[job_id] = job
      return True

  async def advance(
      self,
      job_id: str,
      worker: str,
      *,
      stage: str,
      status: str,
      stage_state: dict[str, Any] | None = None,
      timing_ms: int | None = None,
      fields: dict[str, Any] | None = None,
  ) -> IngestionJob:
      self._bump("advance")
      job = self._assert_lease(job_id, worker)
      timings = dict(job.timings)
      if timing_ms is not None:
          timings[stage] = timings.get(stage, 0) + timing_ms
      updates: dict[str, Any] = {"stage": stage, "status": status, "timings": timings}
      if stage_state is not None:
          updates["stage_state"] = stage_state
      job = job.model_copy(update=updates)
      self.jobs[job_id] = job
      return job

  async def record_attempt(self, job_id: str, worker: str, attempt: dict[str, Any]) -> int:
      self._bump("record_attempt")
      job = self._assert_lease(job_id, worker)
      attempts = list(job.attempts)
      number = len(attempts) + 1
      payload = {**attempt, "attempt_no": number}
      attempts.append(ParseAttempt.model_validate(payload))
      escalations = job.escalations + (1 if attempt.get("reason") == "escalation" else 0)
      job = job.model_copy(update={"attempts": attempts, "escalations": escalations})
      self.jobs[job_id] = job
      return number

  async def fail(self, job_id: str, worker: str, *, error_class: str, retryable: bool) -> IngestionJob:
      self._bump("fail")
      job = self._assert_lease(job_id, worker)
      retries = job.retries + 1
      if retryable and retries <= job.max_retries:
          job = job.model_copy(
              update={
                  "status": "queued",
                  "retries": retries,
                  "locked_by": None,
                  "lease_until": None,
                  "runner": None,
                  "run_after": self.clock.now() + timedelta(seconds=30),
                  "error_class": error_class,
              }
          )
      else:
          job = job.model_copy(
              update={
                  "status": "failed",
                  "retries": retries,
                  "error_class": error_class,
                  "locked_by": None,
                  "lease_until": None,
                  "runner": None,
              }
          )
      self.jobs[job_id] = job
      return job

  async def cache_prefix(
      self,
      job_id: str,
      parser: str,
      parser_version: str,
      options_hash: str,
  ) -> str | None:
      self._bump("cache_prefix")
      job = self.jobs.get(job_id)
      if job is None or job.file_sha256 is None:
          return None
      return f"{job.tenant_key}/_parse-cache/{job.file_sha256}/{parser}-{parser_version[:16]}-{options_hash}/"

  async def cache_lookup(
      self,
      job_id: str,
      parser: str,
      parser_version: str,
      options_hash: str,
  ) -> list[ParseCacheEntry]:
      self._bump("cache_lookup")
      job = self.jobs.get(job_id)
      if job is None or job.file_sha256 is None:
          return []
      row = self.cache.get((job.tenant_key, job.file_sha256, parser, parser_version, options_hash))
      return [row] if row else []

  async def cache_put(
      self,
      job_id: str,
      parser: str,
      parser_version: str,
      options_hash: str,
      object_prefix: str,
      *,
      result: dict[str, Any] | None = None,
      byte_size: int | None = None,
  ) -> ParseCacheEntry:
      self._bump("cache_put")
      job = self.jobs.get(job_id)
      if job is None or job.file_sha256 is None:
          raise Refused("missing job")
      expected = await self.cache_prefix(job_id, parser, parser_version, options_hash)
      if object_prefix != expected:
          raise Refused("prefix_mismatch")
      row = ParseCacheEntry(
          id=str(uuid.uuid4()),
          tenant_key=job.tenant_key,
          file_sha256=job.file_sha256,
          parser=parser,
          parser_version=parser_version,
          options_hash=options_hash,
          object_prefix=object_prefix,
          result=result or {},
          byte_size=byte_size,
      )
      self.cache[(job.tenant_key, job.file_sha256, parser, parser_version, options_hash)] = row
      return row


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.calls: list[tuple[str, ...]] = []
        self.allowed_prefixes: set[str] = set()

    def register_cache_prefix(self, prefix: str) -> None:
        normalized = prefix if prefix.endswith("/") else f"{prefix}/"
        self.allowed_prefixes.add(normalized)

    async def download(self, original_ref: OriginalRef) -> bytes:
        self.calls.append(("download", original_ref.bucket, original_ref.path))
        return self.objects.get((original_ref.bucket, original_ref.path), b"")

    async def put(self, bucket: str, prefix: str, name: str, data: bytes) -> None:
        self.calls.append(("put", bucket, prefix, name))
        if "/" in name or ".." in name:
            raise ValueError("invalid name")
        normalized = prefix if prefix.endswith("/") else f"{prefix}/"
        if normalized not in self.allowed_prefixes:
            raise ValueError("prefix not allowed")
        self.objects[(bucket, f"{prefix.rstrip('/')}/{name}")] = data


@dataclass
class AppScript:
    status: int = 200
    response: dict[str, Any] = field(default_factory=dict)
    repeat: int = 1


class FakeApp:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.scripts: dict[str, list[AppScript]] = {}
        self.token_acquires = 0

    def script(self, action: str, scripts: list[AppScript]) -> None:
        self.scripts[action] = scripts

    async def _next_script(self, action: str) -> AppScript:
        queue = self.scripts.get(action)
        if not queue:
            return AppScript(status=200, response={})
        if len(queue) == 1:
            return queue[0]
        return queue.pop(0)

    async def detect_vlm(self, job_id: str, request: DetectVlmRequest) -> DetectVlmResponse:
        self.calls.append(("detect_vlm", job_id, request.model_dump(mode="json")))
        script = await self._next_script("detect_vlm")
        if script.status >= 400:
            raise RuntimeError(f"detect_vlm status {script.status}")
        return DetectVlmResponse.model_validate(script.response)

    async def parse_external(self, job_id: str, request: ParseExternalRequest) -> ParseExternalResponse:
        self.calls.append(("parse_external", job_id, request.model_dump(mode="json")))
        script = await self._next_script("parse_external")
        if script.status >= 400:
            raise RuntimeError(f"parse_external status {script.status}")
        return ParseExternalResponse.model_validate(script.response)

    async def advance(self, job_id: str, request: AdvanceRequest) -> AdvanceResponse:
        self.calls.append(("advance", job_id, request.model_dump(mode="json")))
        script = await self._next_script("advance")
        if script.status >= 400:
            raise RuntimeError(f"advance status {script.status}")
        return AdvanceResponse.model_validate(script.response)

    async def acquire_token(self) -> None:
        self.token_acquires += 1