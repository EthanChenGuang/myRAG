import tempfile
import uuid
from pathlib import Path

from rag_sidecar.contracts import ParseJobRequest, ParseJobState
from rag_sidecar.parse.converter import Converter
from rag_sidecar.settings import SidecarSettings


class QueueFull(Exception):
    pass


class JobRunner:
    def __init__(self, settings: SidecarSettings, converter: Converter, **_options: object) -> None:
        self.settings = settings
        self.converter = converter
        self.root = Path(tempfile.mkdtemp(prefix="rag-sidecar-parse-"))

    def submit(self, request: ParseJobRequest, source: bytes | Path) -> str:
        return str(uuid.uuid4())

    def state(self, job_id: str) -> ParseJobState | None:
        return ParseJobState(job_id=job_id, status="queued")

    def delete(self, job_id: str) -> bool:
        return False

    def artifact(self, job_id: str, name: str) -> Path | None:
        return None

    def close(self) -> None:
        return None
