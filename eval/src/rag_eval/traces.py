from pathlib import Path

from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.eval_run import RagTrace


def load_traces(path: Path) -> list[RagTrace]:
    raise NotImplementedError


def load_manifest(path: Path) -> RunManifest:
    raise NotImplementedError
