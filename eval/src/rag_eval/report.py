from pathlib import Path

from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult


def build_report(manifest: RunManifest, results: list[ItemResult], golden: list[GoldenItem]) -> EvalReport:
    raise NotImplementedError


def write_report(report: EvalReport, out_dir: Path) -> tuple[Path, Path]:
    raise NotImplementedError
