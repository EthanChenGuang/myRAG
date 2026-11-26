from pathlib import Path

from rag_eval.review_queue import mask_text

EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6

__all__ = ["mask_text"]


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def assign(set_dir, tenant, base_url, token) -> Path:
    return Path(set_dir) / "strata.json"


def quotas(strata, production_shares, tolerance):
    return []


def weighted_score(item_scores, strata, production_shares):
    return None


def uncovered_share(strata, production_shares, item_scores=None):
    return 0.0


def main(argv=None) -> int:
    return 1
