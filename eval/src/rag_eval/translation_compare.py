from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.baseline import NoiseConfig, PairedStat
from rag_sidecar.contracts.report import ItemResult

NO_MEASURABLE_GAIN = "no measurable gain"
WIRING_PROOF_LABEL = ""


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TranslationCost(_Model):
    by_direction: dict[str, dict[str, float]] = Field(default_factory=dict)
    translator: str | None = None


class TranslationPairRow(_Model):
    pair: str
    n: int = 0
    recall_a: float | None = None
    recall_b: float | None = None
    paired: PairedStat = PairedStat(n=0, n_nonzero=0, mean_d=None, ci_low=None, ci_high=None)
    band: float = 0.0
    verdict: str = ""
    added_rows: int = 0
    added_bytes: int = 0
    translation_usd: float = 0.0
    added_ingestion_seconds: float = 0.0


class TranslationComparison(_Model):
    wiring_proof: bool = False
    label: str | None = None
    pairs: list[TranslationPairRow] = Field(default_factory=list)
    recommendation: str | None = None


def build_translation_comparison(
    arm_a: list[ItemResult], arm_b: list[ItemResult], cost: TranslationCost, noise: NoiseConfig, *, wiring_proof: bool
) -> TranslationComparison:
    return TranslationComparison()


def render_markdown(report: TranslationComparison) -> str:
    return ""


def main(argv: list[str] | None = None) -> int:
    return 1
