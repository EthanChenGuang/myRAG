from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult, SliceMetrics


def score_items(traces: list[RagTrace], golden: list[GoldenItem]) -> list[ItemResult]:
    raise NotImplementedError


def aggregate(results: list[ItemResult], k_values: tuple[int, ...] = (5, 10)) -> dict[str, object]:
    raise NotImplementedError
