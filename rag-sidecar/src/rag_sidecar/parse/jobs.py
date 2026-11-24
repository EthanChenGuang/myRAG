import multiprocessing
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import CancelledError, Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from rag_sidecar.contracts import ParseJobRequest, ParseJobState, ParseResult
from rag_sidecar.parse.converter import Converter, error_class_of
from rag_sidecar.settings import SidecarSettings

RETRY_AFTER_SECONDS = 30
INPUT_NAME = "input.bin"
RESULT_NAME = "result.json"
RUNNING_MARKER = "running"
ARTIFACT_DIR = "artifacts"
ARTIFACT_NAME = re.compile(r"[a-z0-9_.-]{1,64}")
_EXPIRED_MEMORY = 4096

_worker_converter: Converter | None = None


class QueueFull(Exception):
    def __init__(self, retry_after: int = RETRY_AFTER_SECONDS) -> None:
        super().__init__("parse queue is full")
        self.retry_after = retry_after


@dataclass(frozen=True)
class JobSlot:
    job_id: str
    directory: Path

    @property
    def input_path(self) -> Path:
        return self.directory / INPUT_NAME


@dataclass
class _Job:
    job_id: str
    directory: Path
    future: Future
    finished_at: float | None = None
    outcome: str | None = None
    outcome_known: bool = False


def _init_worker(converter: Converter) -> None:
    global _worker_converter
    _worker_converter = converter


def _run_job(job_dir: str, request_json: str, page_cap: int) -> str | None:
    base = Path(job_dir)
    try:
        (base / RUNNING_MARKER).touch()
        request = ParseJobRequest.model_validate_json(request_json).model_copy(update={"page_cap": page_cap})
        out_dir = base / ARTIFACT_DIR
        out_dir.mkdir(exist_ok=True)
        if _worker_converter is None:
            return "converter_missing"
        result = _worker_converter.convert(base / INPUT_NAME, request, out_dir)
        if result.page_count > page_cap:
            return "page_cap"
        if any(not (out_dir / name).is_file() for name in result.artifacts):
            return "artifact_missing"
        staging = base / (RESULT_NAME + ".tmp")
        staging.write_text(result.model_dump_json(), encoding="utf-8")
        os.replace(staging, base / RESULT_NAME)
        return None
    except Exception as error:
        return error_class_of(error)
    finally:
        (base / INPUT_NAME).unlink(missing_ok=True)


def _as_uuid(job_id: str) -> str | None:
    try:
        parsed = uuid.UUID(job_id)
    except (ValueError, AttributeError, TypeError):
        return None
    return str(parsed) if str(parsed) == job_id else None


class JobRunner:
    def __init__(
        self,
        settings: SidecarSettings,
        converter: Converter,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._converter = converter
        self._clock = clock
        self._lock = threading.RLock()
        self._root: Path | None = None
        self._executor: ProcessPoolExecutor | None = None
        self._pool_broken = False
        self._reserved: dict[str, Path] = {}
        self._jobs: dict[str, _Job] = {}
        self._orphans: set[Future] = set()
        self._expired: OrderedDict[str, None] = OrderedDict()

    @property
    def root(self) -> Path:
        with self._lock:
            if self._root is None:
                self._root = Path(tempfile.mkdtemp(prefix="rag-sidecar-parse-"))
            return self._root

    def reserve(self) -> JobSlot:
        with self._lock:
            self._sweep_locked()
            if self._active_locked() >= self._settings.parse_workers + self._settings.parse_queue:
                raise QueueFull()
            job_id = str(uuid.uuid4())
            directory = self.root / job_id
            directory.mkdir(mode=0o700)
            self._reserved[job_id] = directory
            return JobSlot(job_id=job_id, directory=directory)

    def start(self, slot: JobSlot, request: ParseJobRequest) -> str:
        caps = [cap for cap in (self._settings.page_cap, request.page_cap) if cap is not None]
        args = (str(slot.directory), request.model_dump_json(), min(caps))
        with self._lock:
            future = self._submit_locked(args)
            self._reserved.pop(slot.job_id, None)
            self._jobs[slot.job_id] = _Job(job_id=slot.job_id, directory=slot.directory, future=future)
            future.add_done_callback(lambda _done, job_id=slot.job_id: self._on_done(job_id))
        return slot.job_id

    def release(self, slot: JobSlot) -> None:
        with self._lock:
            self._reserved.pop(slot.job_id, None)
        shutil.rmtree(slot.directory, ignore_errors=True)

    def submit(self, request: ParseJobRequest, source: bytes | Path) -> str:
        slot = self.reserve()
        try:
            if isinstance(source, bytes):
                slot.input_path.write_bytes(source)
            else:
                shutil.copyfile(source, slot.input_path)
            return self.start(slot, request)
        except BaseException:
            self.release(slot)
            raise

    def state(self, job_id: str) -> ParseJobState | None:
        if _as_uuid(job_id) is None:
            return None
        with self._lock:
            self._sweep_locked()
            job = self._jobs.get(job_id)
            if job is None:
                return ParseJobState(job_id=job_id, status="expired") if job_id in self._expired else None
            if not job.future.done():
                running = (job.directory / RUNNING_MARKER).exists()
                return ParseJobState(job_id=job_id, status="running" if running else "queued")
            error_class = self._outcome_locked(job)
            directory = job.directory
        if error_class is not None:
            return ParseJobState(job_id=job_id, status="failed", error_class=error_class)
        result = self._read_result(directory)
        if result is None:
            return ParseJobState(job_id=job_id, status="failed", error_class="result_unreadable")
        return ParseJobState(job_id=job_id, status="succeeded", result=result)

    def delete(self, job_id: str) -> bool:
        if _as_uuid(job_id) is None:
            return False
        with self._lock:
            job = self._jobs.pop(job_id, None)
            if job is None:
                return False
            if not job.future.cancel() and not job.future.done():
                self._orphans.add(job.future)
                job.future.add_done_callback(self._orphans.discard)
        shutil.rmtree(job.directory, ignore_errors=True)
        return True

    def artifact(self, job_id: str, name: str) -> Path | None:
        if _as_uuid(job_id) is None or not ARTIFACT_NAME.fullmatch(name) or name.startswith("."):
            return None
        with self._lock:
            self._sweep_locked()
            job = self._jobs.get(job_id)
            if job is None or not job.future.done() or self._outcome_locked(job) is not None:
                return None
            directory = job.directory
        result = self._read_result(directory)
        if result is None or name not in result.artifacts:
            return None
        path = directory / ARTIFACT_DIR / name
        return path if path.is_file() and not path.is_symlink() else None

    def close(self) -> None:
        with self._lock:
            executor, self._executor = self._executor, None
            root, self._root = self._root, None
            self._jobs.clear()
            self._reserved.clear()
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
        if root is not None:
            shutil.rmtree(root, ignore_errors=True)

    def _submit_locked(self, args: tuple[str, str, int]) -> Future:
        for attempt in range(2):
            if self._executor is None or self._pool_broken:
                self._replace_executor_locked()
            assert self._executor is not None
            try:
                return self._executor.submit(_run_job, *args)
            except BrokenProcessPool:
                self._pool_broken = True
                if attempt == 1:
                    raise
        raise RuntimeError("unreachable")

    def _replace_executor_locked(self) -> None:
        previous, self._executor = self._executor, None
        if previous is not None:
            previous.shutdown(wait=False, cancel_futures=True)
        self._executor = ProcessPoolExecutor(
            max_workers=self._settings.parse_workers,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=_init_worker,
            initargs=(self._converter,),
        )
        self._pool_broken = False

    def _active_locked(self) -> int:
        self._orphans = {future for future in self._orphans if not future.done()}
        running = sum(1 for job in self._jobs.values() if not job.future.done())
        return len(self._reserved) + running + len(self._orphans)

    def _on_done(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None and job.finished_at is None:
                job.finished_at = self._clock()

    def _outcome_locked(self, job: _Job) -> str | None:
        if not job.outcome_known:
            try:
                error = job.future.exception()
            except CancelledError:
                job.outcome = "cancelled"
            else:
                if error is None:
                    job.outcome = job.future.result()
                elif isinstance(error, BrokenProcessPool):
                    self._pool_broken = True
                    job.outcome = "worker_crashed"
                else:
                    job.outcome = error_class_of(error)
            job.outcome_known = True
        return job.outcome

    def _sweep_locked(self) -> None:
        now = self._clock()
        ttl = self._settings.parse_ttl_seconds
        for job in list(self._jobs.values()):
            if job.future.done() and job.finished_at is None:
                job.finished_at = now
            if job.finished_at is not None and now - job.finished_at > ttl:
                self._jobs.pop(job.job_id, None)
                shutil.rmtree(job.directory, ignore_errors=True)
                self._expired[job.job_id] = None
        while len(self._expired) > _EXPIRED_MEMORY:
            self._expired.popitem(last=False)

    @staticmethod
    def _read_result(directory: Path) -> ParseResult | None:
        try:
            return ParseResult.model_validate_json((directory / RESULT_NAME).read_bytes())
        except (OSError, ValidationError):
            return None
