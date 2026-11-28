import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from pydantic import ValidationError

from rag_sidecar.contracts import InjectionDetectorConfig
from rag_sidecar.contracts.injection import PromptGuardConfig
from rag_sidecar.injection.windows import max_per_text, token_windows

if TYPE_CHECKING:
    from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.injection")

# Synthetic test marker for the fake scorer; not an injection phrase (D-15).
FAKE_MALICIOUS_MARKER = "PGFAKE-MALICIOUS"
FAKE_MALICIOUS_SCORE = 0.995
FAKE_BENIGN_SCORE = 0.01

_REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_DETECTOR_CONFIG_PATH = _REPO_ROOT / "config" / "rag" / "injection-detectors.json"


@dataclass(frozen=True)
class TextScore:
    score: float
    windows: int


@runtime_checkable
class InjectionScorer(Protocol):
    model_id: str
    revision: str

    def score(self, texts: Sequence[str]) -> list[TextScore]: ...


class FakeScorer:
    """Deterministic stand-in: a window holding the marker token scores high, every other window low."""

    model_id = "fake/prompt-guard"
    revision = "0" * 40

    def __init__(self, window_tokens: int = 512, stride_tokens: int = 64) -> None:
        self._window_tokens = window_tokens
        self._stride_tokens = stride_tokens

    def score(self, texts: Sequence[str]) -> list[TextScore]:
        window_scores: list[float] = []
        mapping: list[int] = []
        for index, text in enumerate(texts):
            for window in token_windows(text.split(), self._window_tokens, self._stride_tokens):
                window_scores.append(FAKE_MALICIOUS_SCORE if FAKE_MALICIOUS_MARKER in window else FAKE_BENIGN_SCORE)
                mapping.append(index)
        return max_per_text(window_scores, mapping, len(texts))


def load_prompt_guard_config(path: Path | None = None) -> PromptGuardConfig | None:
    target = path or DEFAULT_DETECTOR_CONFIG_PATH
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        return InjectionDetectorConfig.model_validate(raw).prompt_guard
    except (OSError, ValueError, ValidationError):
        logger.warning("[RAG Security] injection detector config unavailable", extra={"path": str(target)})
        return None


def resolve_scorer(
    settings: "SidecarSettings", config: PromptGuardConfig | None = None
) -> InjectionScorer | None:
    if not settings.prompt_guard_enabled:
        return None
    try:
        from rag_sidecar.injection import prompt_guard
    except ImportError:
        logger.warning("[RAG Security] prompt guard enabled but the model module is not installed")
        return None
    resolved = config if config is not None else load_prompt_guard_config()
    if resolved is None:
        return None
    try:
        return prompt_guard.build_scorer(settings, resolved)
    except Exception as exc:
        logger.warning("[RAG Security] prompt guard failed to load", extra={"error": type(exc).__name__})
        return None
