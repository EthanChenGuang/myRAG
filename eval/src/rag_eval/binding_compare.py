from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import BindingComparison, BindingComparisonHashes
from rag_sidecar.contracts.report import EvalReport

BINDING_FIXTURE_NOTE = ""


@dataclass(frozen=True)
class CandidateCatalog:
    model: str
    usd_per_million_tokens: float
    supported_languages: tuple[str, ...]


def compare(
    baseline: EvalReport,
    control: EvalReport,
    candidates: Mapping[str, EvalReport],
    noise: NoiseConfig,
    doc_type: str,
    *,
    baseline_profile: str,
    catalog: Mapping[str, CandidateCatalog],
    hashes: BindingComparisonHashes,
    reembed_run_ids: Mapping[str, str],
    fixture_embedder: bool,
    golden_doc_types: Mapping[str, str] | None = None,
    report_paths: Mapping[str, str] | None = None,
) -> BindingComparison:
    raise NotImplementedError
