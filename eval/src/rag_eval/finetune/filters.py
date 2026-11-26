"""python -m rag_eval.finetune filter (Phase 6.1 D-07, D-09). Stub: implemented in the next commit."""


def longest_common_substring(query: str, text: str) -> int:
    return 0


def verbatim_copy(query, chunk_text, **_kwargs) -> bool:
    return False


def rule_reason(row, chunk_text, filter_config):
    return None


def golden_reason(row, golden, filter_config):
    return None


def near_duplicates(rows, **_kwargs) -> set[int]:
    return set()
