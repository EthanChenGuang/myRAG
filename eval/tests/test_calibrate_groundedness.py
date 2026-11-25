import json
from collections import Counter

from rag_eval.paths import REPO_ROOT
from test_fixture_pii import email_violations, phone_violations

PAIRS = REPO_ROOT / "eval" / "fixtures" / "groundedness" / "pairs.jsonl"
PAIR_KEYS = {"id", "language", "split", "premise_texts", "hypothesis", "label"}
LANGUAGES = {"en", "zh-Hans", "it"}


def _pair_lines() -> list[dict]:
    assert PAIRS.is_file(), f"{PAIRS} is missing"
    return [json.loads(line) for line in PAIRS.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_every_pair_line_has_the_labelled_shape():
    lines = _pair_lines()
    assert lines
    for line in lines:
        assert set(line) == PAIR_KEYS, line.get("id")
        assert line["language"] in LANGUAGES
        assert line["split"] in {"dev", "test"}
        assert line["label"] in {"faithful", "unfaithful"}
        assert isinstance(line["premise_texts"], list) and line["premise_texts"]
        assert all(isinstance(t, str) and t.strip() for t in line["premise_texts"])
        assert isinstance(line["hypothesis"], str) and line["hypothesis"].strip()
    ids = [line["id"] for line in lines]
    assert len(ids) == len(set(ids))


def test_pair_counts_meet_the_calibration_minimums():
    counts = Counter((line["language"], line["split"], line["label"]) for line in _pair_lines())
    for language in ("en", "zh-Hans"):
        for label in ("faithful", "unfaithful"):
            assert counts[(language, "dev", label)] >= 8, (language, label)
            assert counts[(language, "test", label)] >= 4, (language, label)
    assert sum(n for (language, _, _), n in counts.items() if language == "it") >= 4


def test_pair_text_has_no_pii():
    text = PAIRS.read_text(encoding="utf-8") if PAIRS.is_file() else ""
    assert text
    assert phone_violations(text) == []
    assert email_violations(text) == []
