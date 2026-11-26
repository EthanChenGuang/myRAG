"""Phase 5.2 golden items in the D-54 sequence (plan 05.2-29): parity, additions, re-baseline.

The baselines recorded before this plan are kept under eval/baselines/history/*.pre-05.2-29.json; the parity tests
pin the item set they hold, so later tests can prove that set is unchanged by the additions.
"""

import hashlib
import json

from rag_eval.paths import REPO_ROOT

BASELINES = REPO_ROOT / "eval/baselines"
HISTORY = BASELINES / "history"
PRE_PREFIX = "pre-05.2-29"

# Item count and sha256 over the sorted, newline-joined item ids of each baseline before plan 05.2-29.
PRE_ITEM_SETS = {
    "fixture-baseline": (247, "cf07523992ee949f439fe6b9b21a350ee5178e7024d1e1aee53a0df634af5cc0"),
    "fixture-ingest-baseline": (308, "1640c9a202fcdb8d9ca82025437029a4e21381b8b7f0d79d5343231a65ece883"),
}


def _baseline(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _ids_digest(ids):
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


def _previous(name):
    return _baseline(HISTORY / f"{name}.{PRE_PREFIX}.json")


def test_parity_the_pre_05_2_29_baselines_hold_the_pinned_item_sets():
    for name, (count, digest) in PRE_ITEM_SETS.items():
        items = _previous(name)["items"]
        assert len(items) == count, name
        assert _ids_digest(items) == digest, name


def test_parity_every_pre_05_2_29_item_is_still_in_the_current_baseline():
    for name in PRE_ITEM_SETS:
        current = _baseline(BASELINES / f"{name}.json")["items"]
        missing = sorted(set(_previous(name)["items"]) - set(current))
        assert not missing, (name, missing[:5])
