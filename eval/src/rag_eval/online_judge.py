import sys
from collections.abc import Callable
from typing import Any

from rag_sidecar.contracts.judge import JudgeConfig
from rag_sidecar.contracts.review import ReviewQueueItem

JudgeFactory = Callable[[JudgeConfig], Any]


def select_sample(trace_ids: list[str], sample_rate: float, seed: int) -> list[str]:
    return []


def judge_traces(
    items: list[ReviewQueueItem], config: JudgeConfig, judge_factory: JudgeFactory
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    return [], {}


def main(argv: list[str] | None = None, *, judge_factory: JudgeFactory | None = None) -> int:
    print("online judge is not implemented", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
