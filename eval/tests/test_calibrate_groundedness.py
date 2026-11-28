import json
from collections import Counter

import httpx
import pytest
from rag_sidecar.contracts.groundedness import GroundednessRequest, GroundednessResult, GroundednessThresholds

from rag_eval.calibrate import __main__ as calibrate_cli
from rag_eval.calibrate import groundedness as g
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


COMMITTED = REPO_ROOT / "eval" / "config" / "groundedness-thresholds.json"
NOW = "2026-11-25"
SECRET = "s" * 40


def _labels() -> dict[str, str]:
    return {f"calib-{p.id}": p.label for p in g.load_pairs(PAIRS)}


def _scored(scorer: str, score: float) -> GroundednessResult:
    return GroundednessResult(status="scored", scorer=scorer, score=score, latency_ms=1)


def _not_checked(reason: str) -> GroundednessResult:
    return GroundednessResult(status="not_checked", scorer="none", reason=reason, latency_ms=1)


class FnScorer:
    name = "stub"
    live = False
    allow_vectara = False

    def __init__(self, fn):
        self.fn = fn
        self.requests: list[GroundednessRequest] = []

    def score(self, request: GroundednessRequest) -> GroundednessResult:
        self.requests.append(request)
        return self.fn(request)


def _split_of(request: GroundednessRequest) -> str:
    return request.request_id.split("-")[2]


def _clean(labels):
    def fn(request):
        if request.language != "en":
            return _not_checked("unsupported_language")
        return _scored("hhem_2_1_open", 0.8 if labels[request.request_id] == "faithful" else 0.3)

    return fn


def _poisoned(labels):
    def fn(request):
        if request.language != "en":
            return _not_checked("unsupported_language")
        faithful = labels[request.request_id] == "faithful"
        if _split_of(request) == "test":
            faithful = not faithful
        return _scored("hhem_2_1_open", 0.8 if faithful else 0.3)

    return fn


def _cell(result, scorer: str, language: str):
    matches = [r for r in result.cells if r.cell.scorer == scorer and r.cell.language == language]
    assert len(matches) == 1, [(r.cell.scorer, r.cell.language) for r in result.cells]
    return matches[0]


def test_load_pairs_reads_the_fixture_as_typed_pairs():
    pairs = g.load_pairs(PAIRS)
    assert len(pairs) == len(_pair_lines())
    assert {p.language for p in pairs} == LANGUAGES


def test_load_pairs_rejects_duplicate_ids(tmp_path):
    line = PAIRS.read_text(encoding="utf-8").splitlines()[0]
    path = tmp_path / "dup.jsonl"
    path.write_text(line + "\n" + line + "\n", encoding="utf-8")
    with pytest.raises(g.CalibrationError):
        g.load_pairs(path)


def test_fit_threshold_maximises_balanced_accuracy_between_the_classes():
    threshold, accuracy = g.fit_threshold([0.8] * 8, [0.3] * 8)
    assert 0.3 < threshold < 0.8
    assert accuracy == 1.0


def test_fit_reads_dev_rows_only_and_holdout_reads_test_rows_only():
    dev = [g.ScoredRow(pair_id=f"d{i}", language="en", split="dev", faithful=i % 2 == 0, scorer="hhem_2_1_open", score=0.8 if i % 2 == 0 else 0.3) for i in range(16)]
    poisoned_test = [g.ScoredRow(pair_id=f"t{i}", language="en", split="test", faithful=i % 2 == 0, scorer="hhem_2_1_open", score=0.0 if i % 2 == 0 else 1.0) for i in range(8)]
    fits = g.fit_cells(dev + poisoned_test)
    fit = fits[("hhem_2_1_open", "en")]
    assert fit.status == "fitted"
    assert 0.3 < fit.threshold < 0.8
    assert fit.dev["faithful_count"] == 8 and fit.dev["unfaithful_count"] == 8
    with pytest.raises(ValueError):
        g.holdout_check(fit, dev)


def test_clean_stub_calibrates_the_en_cell(tmp_path):
    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(_clean(_labels())), now=NOW)
    record = _cell(result, "hhem_2_1_open", "en")
    assert record.status == "calibrated"
    cell = record.cell
    assert cell.source == "calibrated"
    assert 0.3 < cell.threshold < 0.8
    assert cell.fitted_at == NOW
    assert cell.dev["balanced_accuracy"] == 1.0
    assert cell.holdout["balanced_accuracy"] == 1.0
    assert cell.holdout["faithful_count"] >= 4 and cell.holdout["unfaithful_count"] >= 4
    assert not result.thresholds_written
    assert (tmp_path / "out" / g.RESULT_NAME).is_file()
    assert (tmp_path / "out" / g.REPORT_NAME).is_file()


def test_poisoned_holdout_keeps_the_default(tmp_path):
    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(_poisoned(_labels())), now=NOW)
    record = _cell(result, "hhem_2_1_open", "en")
    assert record.status == "failed_holdout"
    assert record.cell.source == "default"
    assert record.cell.threshold == g.DEFAULT_THRESHOLD
    assert record.cell.fitted_at is None


def test_holdout_worse_than_the_default_threshold_keeps_the_default(tmp_path):
    labels = _labels()

    def fn(request):
        if request.language != "en":
            return _not_checked("unsupported_language")
        faithful = labels[request.request_id] == "faithful"
        if _split_of(request) == "test":
            return _scored("hhem_2_1_open", 0.52 if faithful else 0.4)
        return _scored("hhem_2_1_open", 0.8 if faithful else 0.3)

    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(fn), now=NOW)
    record = _cell(result, "hhem_2_1_open", "en")
    assert record.status == "failed_holdout"
    assert record.cell.source == "default" and record.cell.threshold == 0.5


def test_italian_items_are_not_checked_and_never_produce_a_cell(tmp_path):
    labels = _labels()

    def fn(request):
        return _scored("hhem_2_1_open", 0.8 if labels[request.request_id] == "faithful" else 0.3)

    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(fn), now=NOW)
    assert all(r.cell.language != "it" for r in result.cells)
    italian = sum(1 for p in g.load_pairs(PAIRS) if p.language == "it")
    assert result.not_checked["it"] == {"unsupported_language": italian}
    report = (tmp_path / "out" / g.REPORT_NAME).read_text(encoding="utf-8")
    assert "not_checked" in report and "it" in report


def test_not_checked_scorer_results_are_counted_by_language_and_reason(tmp_path):
    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(_clean(_labels())), now=NOW)
    zh = sum(1 for p in g.load_pairs(PAIRS) if p.language == "zh-Hans")
    assert result.not_checked["zh-Hans"] == {"unsupported_language": zh}
    assert all(r.cell.language != "zh-Hans" for r in result.cells)


def test_stub_or_fixture_runs_never_write_thresholds(tmp_path):
    target = tmp_path / "thresholds.json"
    target.write_bytes(COMMITTED.read_bytes())
    with pytest.raises(g.CalibrationError):
        g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=FnScorer(_clean(_labels())), write=target, now=NOW)
    assert target.read_bytes() == COMMITTED.read_bytes()
    copy = tmp_path / "pairs-copy.jsonl"
    copy.write_bytes(PAIRS.read_bytes())
    live = _sidecar_scorer(_labels())
    for pairs in (PAIRS, copy):
        with pytest.raises(g.CalibrationError):
            g.run_groundedness_calibration(pairs, tmp_path / "out", scorer=live, write=target, now=NOW)
    assert target.read_bytes() == COMMITTED.read_bytes()


@pytest.mark.parametrize(
    "extra",
    [
        [],
        ["--scorer", "stub"],
    ],
)
def test_cli_refuses_to_write_the_committed_file_from_fixture_or_stub(tmp_path, extra):
    before = COMMITTED.read_bytes()
    pairs = tmp_path / "pairs.jsonl"
    pairs.write_text(PAIRS.read_text(encoding="utf-8").replace('"id": "en-', '"id": "x-en-'), encoding="utf-8")
    for pairs_args in ([], ["--pairs", str(pairs)]):
        code = calibrate_cli.main(
            ["groundedness", *pairs_args, *extra, "--out", str(tmp_path / "out"), "--write", "eval/config/groundedness-thresholds.json"]
        )
        assert code != 0
    assert COMMITTED.read_bytes() == before


def test_cli_stub_run_writes_only_under_out(tmp_path):
    before = COMMITTED.read_bytes()
    code = calibrate_cli.main(["groundedness", "--scorer", "stub", "--out", str(tmp_path / "out")])
    assert code == 0
    assert (tmp_path / "out" / g.RESULT_NAME).is_file()
    assert COMMITTED.read_bytes() == before


def test_out_inside_the_repo_must_be_under_eval_out(tmp_path):
    with pytest.raises(g.CalibrationError):
        g.run_groundedness_calibration(PAIRS, REPO_ROOT / "eval" / "config", scorer=FnScorer(_clean(_labels())), now=NOW)


def _sidecar_handler(labels, seen, *, vectara_ok=False):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = GroundednessRequest.model_validate_json(request.content)
        if body.language == "en":
            score = 0.9 if labels[body.request_id] == "faithful" else 0.2
            scorer = "hhem_2_3_vectara" if body.allow_vectara and vectara_ok else "hhem_2_1_open"
            result = _scored(scorer, score)
        elif body.language == "zh-Hans" and body.allow_vectara and vectara_ok:
            result = _scored("hhem_2_3_vectara", 0.85 if labels[body.request_id] == "faithful" else 0.25)
        elif body.language == "zh-Hans":
            result = _not_checked("scorer_unavailable")
        else:
            result = _not_checked("unsupported_language")
        return httpx.Response(200, json=result.model_dump(mode="json"))

    return handler


def _sidecar_scorer(labels, seen=None, *, allow_vectara=False, vectara_ok=False):
    transport = httpx.MockTransport(_sidecar_handler(labels, seen if seen is not None else [], vectara_ok=vectara_ok))
    return g.SidecarScorer("http://sidecar.test", secret=SECRET, allow_vectara=allow_vectara, transport=transport)


def test_sidecar_scorer_posts_requests_with_the_secret_and_no_vectara(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_SIDECAR_SECRET", SECRET)
    seen: list[httpx.Request] = []
    transport = httpx.MockTransport(_sidecar_handler(_labels(), seen))
    scorer = g.SidecarScorer("http://sidecar.test", transport=transport)
    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=scorer, now=NOW)
    assert len(seen) == len(_pair_lines())
    for request in seen:
        assert request.method == "POST"
        assert request.url.path == "/v1/groundedness"
        assert request.headers["x-sidecar-secret"] == SECRET
        assert json.loads(request.content)["allow_vectara"] is False
    assert _cell(result, "hhem_2_1_open", "en").status == "calibrated"
    assert result.not_checked["zh-Hans"] == {"scorer_unavailable": 24}


def test_sidecar_scorer_sends_allow_vectara_only_when_asked(tmp_path):
    seen: list[httpx.Request] = []
    scorer = _sidecar_scorer(_labels(), seen, allow_vectara=True, vectara_ok=True)
    result = g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=scorer, now=NOW)
    assert all(json.loads(r.content)["allow_vectara"] is True for r in seen)
    assert _cell(result, "hhem_2_3_vectara", "zh-Hans").status == "calibrated"
    assert _cell(result, "hhem_2_3_vectara", "en").status == "calibrated"


def test_sidecar_scorer_without_a_secret_is_refused(monkeypatch):
    monkeypatch.delenv("RAG_SIDECAR_SECRET", raising=False)
    with pytest.raises(g.CalibrationError):
        g.SidecarScorer("http://sidecar.test")


def test_sidecar_error_status_stops_the_run(tmp_path):
    transport = httpx.MockTransport(lambda request: httpx.Response(401, json={"error": "unauthorized"}))
    scorer = g.SidecarScorer("http://sidecar.test", secret=SECRET, transport=transport)
    with pytest.raises(g.CalibrationError):
        g.run_groundedness_calibration(PAIRS, tmp_path / "out", scorer=scorer, now=NOW)


def test_live_run_on_real_pairs_writes_a_valid_thresholds_file(tmp_path):
    pairs = tmp_path / "pairs.jsonl"
    pairs.write_text(PAIRS.read_text(encoding="utf-8").replace('"id": "', '"id": "live-'), encoding="utf-8")
    labels = {f"calib-{p.id}": p.label for p in g.load_pairs(pairs)}
    target = tmp_path / "thresholds.json"
    target.write_bytes(COMMITTED.read_bytes())
    result = g.run_groundedness_calibration(pairs, tmp_path / "out", scorer=_sidecar_scorer(labels), write=target, now=NOW)
    assert result.thresholds_written
    written = GroundednessThresholds.model_validate_json(target.read_text(encoding="utf-8"))
    cells = {(c.scorer, c.language): c for c in written.cells}
    assert cells[("hhem_2_1_open", "en")].source == "calibrated"
    assert 0.2 < cells[("hhem_2_1_open", "en")].threshold < 0.9
    assert cells[("hhem_2_3_vectara", "en")].source == "default"
    assert cells[("hhem_2_3_vectara", "zh-Hans")].source == "default"
    assert all(c.language != "it" for c in written.cells)


def test_failed_holdout_resets_a_previously_calibrated_cell_to_the_default(tmp_path):
    pairs = tmp_path / "pairs.jsonl"
    pairs.write_text(PAIRS.read_text(encoding="utf-8").replace('"id": "', '"id": "live-'), encoding="utf-8")
    labels = {f"calib-{p.id}": p.label for p in g.load_pairs(pairs)}
    target = tmp_path / "thresholds.json"
    previous = GroundednessThresholds.model_validate_json(COMMITTED.read_text(encoding="utf-8"))
    cells = [
        c.model_copy(update={"source": "calibrated", "threshold": 0.7, "fitted_at": "2026-01-01"})
        if (c.scorer, c.language) == ("hhem_2_1_open", "en")
        else c
        for c in previous.cells
    ]
    target.write_text(GroundednessThresholds(cells=cells).model_dump_json(), encoding="utf-8")

    def poisoned(request: httpx.Request) -> httpx.Response:
        body = GroundednessRequest.model_validate_json(request.content)
        if body.language != "en":
            return httpx.Response(200, json=_not_checked("unsupported_language").model_dump(mode="json"))
        faithful = labels[body.request_id] == "faithful"
        if body.request_id.split("-")[3] == "test":
            faithful = not faithful
        return httpx.Response(200, json=_scored("hhem_2_1_open", 0.8 if faithful else 0.3).model_dump(mode="json"))

    scorer = g.SidecarScorer("http://sidecar.test", secret=SECRET, transport=httpx.MockTransport(poisoned))
    g.run_groundedness_calibration(pairs, tmp_path / "out", scorer=scorer, write=target, now=NOW)
    written = {(c.scorer, c.language): c for c in GroundednessThresholds.model_validate_json(target.read_text(encoding="utf-8")).cells}
    cell = written[("hhem_2_1_open", "en")]
    assert cell.source == "default" and cell.threshold == 0.5 and cell.fitted_at is None


def test_refusal_subcommand_is_unchanged():
    with pytest.raises(SystemExit):
        calibrate_cli.main(["refusal", "--help"])
