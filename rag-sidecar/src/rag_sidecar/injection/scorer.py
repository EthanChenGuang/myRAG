from dataclasses import dataclass
from typing import Protocol

FAKE_MALICIOUS_MARKER = "PGFAKE-MALICIOUS"


@dataclass(frozen=True)
class TextScore:
    score: float
    windows: int


class InjectionScorer(Protocol):
    model_id: str
    revision: str


class FakeScorer:
    model_id = "fake/prompt-guard"
    revision = "0" * 40

    def __init__(self, window_tokens: int = 512, stride_tokens: int = 64) -> None:
        pass

    def score(self, texts):
        return []


def load_prompt_guard_config(path=None):
    return None


def resolve_scorer(settings):
    return None
