from collections.abc import Sequence


def token_windows(token_ids: Sequence[int], window_tokens: int, stride_tokens: int) -> list[list[int]]:
    return []


def window_count(token_count: int, window_tokens: int, stride_tokens: int) -> int:
    return 0


def max_per_text(window_scores, window_to_text, text_count):
    return []
