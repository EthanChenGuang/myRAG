from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

DEFAULT_BASE_URL = "https://cloud.langfuse.com"


class LangfuseApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class ScoresResult:
    status: int
    accepted: int
    rejected: int
    errors: tuple[str, ...] = ()


class LangfuseApi:
    def __init__(self, base_url: str, public_key: str, secret_key: str, client: Any = None) -> None:
        self._base_url = base_url

    def observations(self, from_time: str, to_time: str, tag: str = "review_candidate", *, limit: int = 1000) -> Iterator[dict[str, Any]]:
        return iter(())

    def post_scores(self, scores: list[dict[str, Any]]) -> ScoresResult:
        return ScoresResult(status=0, accepted=0, rejected=0)
