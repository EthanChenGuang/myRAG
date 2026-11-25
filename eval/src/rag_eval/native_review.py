from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult


def counts_in_gated_slices(item: GoldenItem | ItemResult) -> bool:
    return True
