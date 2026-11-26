"""Review-queue source of the judge calibration (D-31): a fake app, stub judges, private paths only."""

import json
from pathlib import Path

import httpx
import pytest
from _private_runs import make_private_root
from rag_sidecar.contracts.judge_calibration import JudgeCalibration, JudgeSeedCase
from rag_sidecar.contracts.retrieval import ConfigProvenance

import rag_eval.judge_calibration as calibration_module
from rag_eval.judge.config import JudgeCase
from rag_eval.judge_calibration import main

TENANT = "o:4b6f2c1e-8a3d-4f5b-9c7e-1d2a3b4c5d6e"
BASE_URL = "https://app.example.test"
TOKEN = "admin-bearer-placeholder-value"
GENERATOR = "anthropic/claude-sonnet-5-5"
EXPORT_PATH = "/api/rag/admin/judge-calibration/export"
LANGUAGES = ("en", "it", "zh")


def _uuid(language: str, index: int) -> str:
    prefix = {"en": "1", "it": "2", "zh": "3"}[language]
    return f"{prefix}0000000-0000-4000-8000-{index:012d}"


def _export_case(language: str | None, index: int, supported: bool, *, contexts: int = 1) -> dict:
    marker = "SUPPORTED" if supported else "UNSUPPORTED"
    lang = language or "en"
    return {
        "item_id": _uuid(lang, index),
        "language": language,
        "question": f"Synthetic queue question {lang} {index}?",
        "answer": f"Synthetic queue answer {marker} {lang} {index}.",
        "contexts": [
            {
                "chunk_id": f"a0000000-0000-4000-8000-{index:012d}",
                "document_id": f"b0000000-0000-4000-8000-{index:012d}",
                "text": f"Synthetic queue context {lang} {index}.",
            }
            for _ in range(contexts)
        ],
        "labels": [
            {"supported": not supported, "relevant": True, "unsupported_content": supported, "labelled_at": "2026-11-01T00:00:00Z"},
            {"supported": supported, "relevant": supported, "unsupported_content": not supported, "labelled_at": "2026-11-02T00:00:00Z"},
        ],
    }


def _queue(counts: dict[str, int]) -> list[dict]:
    return [_export_case(language, i, i % 2 == 0) for language, count in counts.items() for i in range(count)]


def _seed_case(case_id: str, language: str, supported: bool, *, review_status: str = "approved") -> JudgeSeedCase:
    marker = "SUPPORTED" if supported else "UNSUPPORTED"
    return JudgeSeedCase(
        id=case_id,
        language=language,
        question=f"Synthetic seed question {case_id}?",
        contexts=[f"Synthetic seed context {case_id}."],
        answer=f"Synthetic seed answer {marker} {case_id}.",
        expected={"faithfulness": supported, "answer_relevance": supported},
        unsupported_content=not supported,
        review_status=review_status,
        reviewed_by="reviewer-1" if review_status == "approved" else None,
    )


class MarkerFactory:
    """Scores from the answer text: a supported answer passes, an unsupported one fails."""

    def __init__(self) -> None:
        self.cases: list[JudgeCase] = []

    def __call__(self, role: str, config):
        libraries = ("deepeval", "ragas") if role == "nightly" else ("deepeval",)

        def score(cases: list[JudgeCase]):
            self.cases.extend(cases)
            out = {}
            for case in cases:
                value = 0.1 if "UNSUPPORTED" in case.answer else 0.95
                for library in libraries:
                    for metric in ("faithfulness", "answer_relevance"):
                        out[(library, case.item_id, metric)] = value
            return out

        return score


class FakeApp:
    def __init__(self, cases: list[dict] | None = None, *, status: int = 200, error: Exception | None = None, body=None):
        self.cases = cases or []
        self.status = status
        self.error = error
        self.body = body
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        if self.status != 200:
            return httpx.Response(self.status, json={"success": False, "error": "denied"})
        if self.body is not None:
            return httpx.Response(200, json=self.body)
        payload = {
            "success": True,
            "tenant_key": TENANT,
            "cases": self.cases,
            "skipped": {"no_answer": 0, "changed_chunk": 0, "no_context": 0},
        }
        return httpx.Response(200, json=payload)


@pytest.fixture
def private(tmp_path, monkeypatch):
    return make_private_root(tmp_path, monkeypatch)


@pytest.fixture
def _keys(monkeypatch):
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-placeholder")
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)


def _install(monkeypatch, app: FakeApp) -> None:
    monkeypatch.setattr(
        calibration_module,
        "_http_client",
        lambda: httpx.Client(transport=httpx.MockTransport(app.handler), timeout=5.0),
        raising=False,
    )


def _calibration_file(tmp_path: Path) -> Path:
    path = tmp_path / "config" / "judge-calibration.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    empty = JudgeCalibration(cells=[], provenance=ConfigProvenance(source="defaults"))
    path.write_text(empty.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


def _seed_file(tmp_path: Path, cases: list[JudgeSeedCase]) -> Path:
    path = tmp_path / "seed.jsonl"
    path.write_text("".join(case.model_dump_json() + "\n" for case in cases), encoding="utf-8")
    return path


def _argv(tmp_path: Path, out: Path, *extra: str, seed: Path | None = None) -> list[str]:
    return [
        "run",
        "--tenant",
        TENANT,
        "--base-url",
        BASE_URL,
        "--seed",
        str(seed or tmp_path / "no-seed.jsonl"),
        "--generator-model",
        GENERATOR,
        "--calibration",
        str(_calibration_file(tmp_path)),
        "--out",
        str(out),
        *extra,
    ]


def _cells(out: Path) -> list[dict]:
    return json.loads((out / calibration_module.CELLS_NAME).read_text(encoding="utf-8"))["cells"]


def test_queue_cases_calibrate_with_source_review_queue(tmp_path, private, monkeypatch, _keys, capsys):
    app = FakeApp(_queue({language: 120 for language in LANGUAGES}))
    _install(monkeypatch, app)
    out = private / "judge-calibration"
    code = main(_argv(tmp_path, out), judge_factory=MarkerFactory())
    assert code == 0
    cells = _cells(out)
    assert cells
    assert {cell["source"] for cell in cells} == {"review_queue"}
    assert {cell["n"] for cell in cells} == {120}
    assert {cell["language"] for cell in cells} == set(LANGUAGES)
    assert {cell["status"] for cell in cells} == {"gating"}
    (request,) = app.requests
    assert request.url.path == EXPORT_PATH
    assert request.url.params["tenant"] == TENANT
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    printed = capsys.readouterr()
    assert TENANT not in printed.out + printed.err
    assert "Synthetic" not in printed.out + printed.err


def test_latest_label_is_the_human_verdict(tmp_path, private, monkeypatch, _keys):
    app = FakeApp(_queue({"en": 120}))
    _install(monkeypatch, app)
    out = private / "judge-calibration"
    assert main(_argv(tmp_path, out), judge_factory=MarkerFactory()) == 0
    faithfulness = [cell for cell in _cells(out) if cell["metric"] == "faithfulness"]
    assert {cell["accuracy"] for cell in faithfulness} == {1.0}


def test_short_language_is_filled_with_confirmed_seed_cases_and_uses_the_queue_minimum(
    tmp_path, private, monkeypatch, _keys
):
    seed = [_seed_case(f"en-seed-{i:03d}", "en", i % 2 == 0) for i in range(30)]
    seed += [_seed_case(f"en-draft-{i:03d}", "en", i % 2 == 0, review_status="draft") for i in range(30)]
    seed += [_seed_case(f"it-seed-{i:03d}", "it", i % 2 == 0) for i in range(60)]
    app = FakeApp(_queue({"en": 60, "zh": 120}))
    _install(monkeypatch, app)
    out = private / "judge-calibration"
    factory = MarkerFactory()
    code = main(_argv(tmp_path, out, seed=_seed_file(tmp_path, seed)), judge_factory=factory)
    assert code == 0
    by_language: dict[str, list[dict]] = {}
    for cell in _cells(out):
        by_language.setdefault(cell["language"], []).append(cell)
    assert {cell["source"] for cell in by_language["en"]} == {"mixed"}
    assert {cell["n"] for cell in by_language["en"]} == {90}
    for cell in by_language["en"]:
        assert cell["status"] == "report_only"
        assert cell["reasons"] == ["n_below_minimum"]
    assert {cell["source"] for cell in by_language["zh"]} == {"review_queue"}
    assert {cell["source"] for cell in by_language["it"]} == {"seed"}
    assert not any("draft" in case.item_id for case in factory.cases)


def test_mixed_language_with_enough_cases_gates(tmp_path, private, monkeypatch, _keys):
    seed = [_seed_case(f"en-seed-{i:03d}", "en", i % 2 == 0) for i in range(45)]
    _install(monkeypatch, FakeApp(_queue({"en": 60})))
    out = private / "judge-calibration"
    assert main(_argv(tmp_path, out, seed=_seed_file(tmp_path, seed)), judge_factory=MarkerFactory()) == 0
    cells = _cells(out)
    assert {cell["source"] for cell in cells} == {"mixed"}
    assert {cell["n"] for cell in cells} == {105}
    assert {cell["status"] for cell in cells} == {"gating"}


def _assert_skipped(code: int, capsys, out: Path, calibration: Path, before: bytes) -> str:
    assert code == 0
    printed = capsys.readouterr()
    text = printed.out + printed.err
    notices = [line for line in text.splitlines() if line.startswith("::notice::")]
    assert len(notices) == 1, text
    assert TOKEN not in text
    assert not out.exists()
    assert calibration.read_bytes() == before
    return notices[0]


def test_missing_token_prints_a_notice_and_writes_nothing(tmp_path, private, monkeypatch, _keys, capsys):
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    app = FakeApp(_queue({"en": 120}))
    _install(monkeypatch, app)
    out = private / "judge-calibration"
    argv = _argv(tmp_path, out, "--write")
    calibration = Path(argv[argv.index("--calibration") + 1])
    before = calibration.read_bytes()
    notice = _assert_skipped(main(argv, judge_factory=MarkerFactory()), capsys, out, calibration, before)
    assert "RAG_ADMIN_BEARER" in notice
    assert app.requests == []


@pytest.mark.parametrize("status", [401, 403, 503])
def test_rejected_token_or_unavailable_app_prints_a_notice(tmp_path, private, monkeypatch, _keys, capsys, status):
    _install(monkeypatch, FakeApp(status=status))
    out = private / "judge-calibration"
    argv = _argv(tmp_path, out, "--write")
    calibration = Path(argv[argv.index("--calibration") + 1])
    before = calibration.read_bytes()
    notice = _assert_skipped(main(argv, judge_factory=MarkerFactory()), capsys, out, calibration, before)
    assert str(status) in notice


def test_connection_error_names_the_type_only(tmp_path, private, monkeypatch, _keys, capsys):
    error = httpx.ConnectError(f"failed with Authorization: Bearer {TOKEN} to {BASE_URL}")
    _install(monkeypatch, FakeApp(error=error))
    out = private / "judge-calibration"
    argv = _argv(tmp_path, out, "--write")
    calibration = Path(argv[argv.index("--calibration") + 1])
    before = calibration.read_bytes()
    notice = _assert_skipped(main(argv, judge_factory=MarkerFactory()), capsys, out, calibration, before)
    assert "ConnectError" in notice
    assert BASE_URL not in notice


def test_pull_error_message_never_contains_the_token(monkeypatch):
    error = httpx.ConnectError(f"Bearer {TOKEN}")
    _install(monkeypatch, FakeApp(error=error))
    with pytest.raises(calibration_module.ReviewQueueSourceError) as caught:
        calibration_module.pull_review_queue_cases(BASE_URL, TENANT, TOKEN)
    assert TOKEN not in str(caught.value)
    assert "ConnectError" in str(caught.value)


def test_invalid_export_items_are_dropped_and_counted(tmp_path, private, monkeypatch, _keys, capsys):
    cases = _queue({"en": 120})
    cases.append(_export_case("en", 900, True, contexts=0))
    cases.append(_export_case(None, 901, True))
    broken = _export_case("en", 902, True)
    broken["labels"] = []
    cases.append(broken)
    cases.append("not an object")
    _install(monkeypatch, FakeApp(cases))
    out = private / "judge-calibration"
    assert main(_argv(tmp_path, out), judge_factory=MarkerFactory()) == 0
    assert {cell["n"] for cell in _cells(out)} == {120}
    assert "dropped 4 export case(s)" in capsys.readouterr().out


def test_pull_returns_seed_shaped_cases(monkeypatch):
    _install(monkeypatch, FakeApp(_queue({"it": 2})))
    pulled = calibration_module.pull_review_queue_cases(BASE_URL, TENANT, TOKEN)
    assert pulled.dropped == 0
    assert [case.language for case in pulled.cases] == ["it", "it"]
    first = pulled.cases[0]
    assert isinstance(first, JudgeSeedCase)
    assert first.review_status == "approved"
    assert first.expected == {"faithfulness": True, "answer_relevance": True}
    assert first.unsupported_content is False
    assert first.contexts == ["Synthetic queue context it 0."]


def test_body_without_a_cases_list_is_a_source_error(monkeypatch):
    _install(monkeypatch, FakeApp(body={"success": True}))
    with pytest.raises(calibration_module.ReviewQueueSourceError) as caught:
        calibration_module.pull_review_queue_cases(BASE_URL, TENANT, TOKEN)


def test_out_outside_the_private_directory_is_refused(tmp_path, private, monkeypatch, _keys, capsys):
    app = FakeApp(_queue({"en": 120}))
    _install(monkeypatch, app)
    out = tmp_path / "public-out"
    assert main(_argv(tmp_path, out), judge_factory=MarkerFactory()) == 2
    assert not out.exists()
    assert app.requests == []


def test_tenant_needs_a_base_url(tmp_path, private, monkeypatch, _keys):
    argv = _argv(tmp_path, private / "judge-calibration")
    index = argv.index("--base-url")
    del argv[index : index + 2]
    assert main(argv, judge_factory=MarkerFactory()) == 2


def test_written_calibration_holds_no_tenant_key_and_no_case_text(tmp_path, private, monkeypatch, _keys):
    _install(monkeypatch, FakeApp(_queue({language: 120 for language in LANGUAGES})))
    out = private / "judge-calibration"
    argv = _argv(tmp_path, out, "--write")
    calibration = Path(argv[argv.index("--calibration") + 1])
    assert main(argv, judge_factory=MarkerFactory()) == 0
    text = calibration.read_text(encoding="utf-8")
    written = JudgeCalibration.model_validate_json(text)
    assert written.cells and {cell.source for cell in written.cells} == {"review_queue"}
    tenant_uuid = TENANT.split(":", 1)[1]
    for fragment in (TENANT, tenant_uuid, tenant_uuid.split("-")[0], "Synthetic"):
        assert fragment not in text
    report = (out / calibration_module.REPORT_NAME).read_text(encoding="utf-8")
    assert "Synthetic" not in report and TENANT not in report
