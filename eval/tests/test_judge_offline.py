import json
import socket
from pathlib import Path
from typing import Any

import pytest
from judge_stubs import FAIL_MARKER, StubDeepEvalLLM, StubEmbeddings, StubRagasLLM
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.judge import JudgeReport

from rag_eval.golden_io import write_golden
from rag_eval.judge.config import JudgeFatalError, load_judge_config, raise_if_fatal
from rag_eval.judge.run import LIBRARIES, METRICS, main, render_markdown, run_judge, write_judge_report

GENERATOR = "anthropic/claude-sonnet-4.5"
SIX_KEYS = {f"{library}.{metric}" for library in LIBRARIES for metric in METRICS}


def _golden(item_id: str, language: str, category: str, *, answerable: bool, text: str = "") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question=f"{text} question {item_id}?".strip(),
        language=language,
        category=category,
        answerable=answerable,
        expected_answer=f"{text} reference answer".strip() if answerable else None,
        gold_evidence=[{"document": f"doc.{language}.md", "section": "s", "quote": "evidence quote"}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _trace(
    item_id: str,
    *,
    answer: str | None,
    refused: bool = False,
    contexts: tuple[str, ...] = ("The policy allows refunds within thirty days.",),
    generator_model: str | None = GENERATOR,
) -> RagTrace:
    return RagTrace.model_validate(
        {
            "item_id": item_id,
            "query": "q",
            "query_context": {
                "is_temporal_query": False,
                "is_financial_query": False,
                "required_precision": "low",
                "suggested_threshold": 0.3,
                "search_strategy": "semantic_only",
            },
            "retrieval_strategy": "standard",
            "candidates": [],
            "kept": [
                {
                    "rank": index,
                    "chunk_id": f"c{index}",
                    "document_id": f"d{index}",
                    "document_name": "doc.md",
                    "content": content,
                    "similarity": 0.5,
                    "kept_by": "similarity",
                }
                for index, content in enumerate(contexts, start=1)
            ],
            "used_documents": [],
            "context": "",
            "refused": refused,
            "refusal_reason": "no_relevant_context" if refused else None,
            "answer": answer,
            "citations": [],
            "stage_latency_ms": {},
            "effective_config": {
                "rag_env": {},
                "rag_prompt_sha256": {},
                "deployment_mode": "single",
                "embedding_model": "fixture",
                "endpoint_version": "1",
                "generator_model": generator_model,
            },
            "config_hash": "0" * 64,
        }
    )


def _six() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden = [
        _golden("en-general-001", "en", "general", answerable=True),
        _golden("zh-general-001", "zh", "general", answerable=True),
        _golden("it-general-001", "it", "general", answerable=True),
        _golden("en-table-001", "en", "table", answerable=True),
        _golden("en-noanswer-001", "en", "no_answer", answerable=False),
        _golden("it-compound-001", "it", "compound", answerable=True),
    ]
    traces = [
        _trace("en-general-001", answer="Refunds are accepted within thirty days."),
        _trace("zh-general-001", answer="三十天内可以退款。", contexts=("退款政策允许三十天内退款。",)),
        _trace("it-general-001", answer="I rimborsi sono accettati entro trenta giorni."),
        _trace("en-table-001", answer=None, refused=True, contexts=()),
        _trace("en-noanswer-001", answer="Refunds are accepted within thirty days."),
        _trace("it-compound-001", answer=None),
    ]
    return golden, traces


def _run(golden: list[GoldenItem], traces: list[RagTrace], **llms: Any) -> JudgeReport:
    return run_judge(
        traces,
        golden,
        llms.get("deepeval_llm", StubDeepEvalLLM()),
        llms.get("ragas_llm", StubRagasLLM()),
        StubEmbeddings(),
        load_judge_config(),
        run_id="run-test",
        run_config_hash="r" * 64,
    )


@pytest.fixture
def socket_spy(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    attempts: list[Any] = []

    def spy(name: str):
        def record(*args: Any, **kwargs: Any) -> Any:
            attempts.append((name, args))
            raise OSError("outbound connection blocked by the test spy")

        return record

    monkeypatch.setattr(socket.socket, "connect", spy("connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", spy("connect_ex"))
    monkeypatch.setattr(socket, "getaddrinfo", spy("getaddrinfo"))
    return attempts


def test_stub_run_scores_all_six_pairs_overall_per_language_and_category(socket_spy: list[Any]) -> None:
    golden, traces = _six()
    report = _run(golden, traces)
    assert JudgeReport.model_validate(report.model_dump()) == report
    assert set(report.overall) == SIX_KEYS
    for value in report.overall.values():
        assert value.n > 0
        assert value.value is not None and 0.0 <= value.value <= 1.0
    for score in report.items:
        assert score.score is None or 0.0 <= score.score <= 1.0
    assert set(report.by_language) == {"zh", "en", "it"}
    assert set(report.by_category) == {"general", "table", "no_answer", "compound"}
    for slice_ in [*report.by_language.values(), *report.by_category.values()]:
        assert set(slice_) == SIX_KEYS
    assert report.judge_model == "openai/gpt-5-mini"
    assert report.generator_model == GENERATOR
    assert report.generator_family == "anthropic"
    assert socket_spy == []


def test_skips_carry_reasons_and_do_not_count_toward_means() -> None:
    golden, traces = _six()
    report = _run(golden, traces)
    index = {(s.item_id, s.library, s.metric): s for s in report.items}
    for library in LIBRARIES:
        for metric in METRICS:
            refused = index[("en-table-001", library, metric)]
            assert (refused.score, refused.skipped_reason) == (None, "refused")
            no_text = index[("it-compound-001", library, metric)]
            assert (no_text.score, no_text.skipped_reason) == (None, "no_answer_text")
        unanswerable = index[("en-noanswer-001", library, "context_recall")]
        assert (unanswerable.score, unanswerable.skipped_reason) == (None, "no_reference")
        assert index[("en-noanswer-001", library, "faithfulness")].score is not None
        assert index[("en-noanswer-001", library, "answer_relevance")].score is not None
    assert len(report.items) == 6 * len(LIBRARIES) * len(METRICS)
    for library in LIBRARIES:
        assert report.overall[f"{library}.faithfulness"].n == 4
        assert report.overall[f"{library}.answer_relevance"].n == 4
        assert report.overall[f"{library}.context_recall"].n == 3
    assert report.by_language["it"]["deepeval.faithfulness"].n == 1
    assert report.by_category["table"]["ragas.faithfulness"].n == 0
    assert report.by_category["table"]["ragas.faithfulness"].value is None


def test_item_without_retrieved_context_skips_faithfulness_and_recall_but_not_relevance() -> None:
    golden = [_golden("en-general-001", "en", "general", answerable=True)]
    traces = [_trace("en-general-001", answer="An answer.", contexts=())]
    report = _run(golden, traces)
    index = {(s.library, s.metric): s for s in report.items}
    for library in LIBRARIES:
        assert index[(library, "faithfulness")].skipped_reason == "no_context"
        assert index[(library, "context_recall")].skipped_reason == "no_context"
        assert index[(library, "answer_relevance")].score is not None


def test_a_failing_judge_call_marks_only_that_item_as_judge_error() -> None:
    golden = [
        _golden("en-general-001", "en", "general", answerable=True),
        _golden("en-general-002", "en", "general", answerable=True, text=FAIL_MARKER),
    ]
    traces = [
        _trace("en-general-001", answer="Refunds are accepted within thirty days."),
        _trace("en-general-002", answer=f"{FAIL_MARKER} answer", contexts=(f"{FAIL_MARKER} context",)),
    ]
    report = _run(golden, traces)
    for score in report.items:
        if score.item_id == "en-general-002":
            assert (score.score, score.skipped_reason) == (None, "judge_error"), (score.library, score.metric)
        else:
            assert score.score is not None and score.skipped_reason is None
    assert report.overall["deepeval.faithfulness"].n == 1


def test_a_fatal_provider_error_stops_the_run_instead_of_skipping_every_item() -> None:
    class RejectingLLM(StubDeepEvalLLM):
        def _respond(self, prompt: str, schema: Any) -> Any:
            raise JudgeFatalError("provider rejected temperature 0")

    golden, traces = _six()
    with pytest.raises(JudgeFatalError):
        _run(golden, traces, deepeval_llm=RejectingLLM())


def test_raise_if_fatal_classifies_credentials_and_temperature_rejections() -> None:
    class ProviderError(Exception):
        def __init__(self, status_code: int, message: str) -> None:
            super().__init__(message)
            self.status_code = status_code

    with pytest.raises(JudgeFatalError, match="credentials"):
        raise_if_fatal(ProviderError(401, "bad key"))
    with pytest.raises(JudgeFatalError, match="temperature"):
        raise_if_fatal(ProviderError(400, "Unsupported value: temperature does not support 0"))
    wrapped = RuntimeError("retries exhausted")
    wrapped.__cause__ = ProviderError(400, "temperature is not supported")
    with pytest.raises(JudgeFatalError):
        raise_if_fatal(wrapped)
    raise_if_fatal(ProviderError(500, "upstream hiccup"))
    raise_if_fatal(ValueError("malformed structured output"))


def test_judge_report_is_written_sorted_and_byte_stable(tmp_path: Path) -> None:
    golden, traces = _six()
    report = _run(golden, traces)
    json_path, md_path = write_judge_report(report, tmp_path)
    first = json_path.read_bytes()
    write_judge_report(report, tmp_path)
    assert json_path.read_bytes() == first
    parsed = json.loads(first)
    assert list(parsed) == sorted(parsed)
    assert JudgeReport.model_validate(parsed) == report
    markdown = md_path.read_text(encoding="utf-8")
    assert markdown == render_markdown(report)
    for heading in ("## Overall", "## By language", "## By category", "## Skipped"):
        assert heading in markdown
    assert "| zh |" in markdown and "| table |" in markdown
    assert "refused: 6" in markdown


def test_live_ragas_builder_sends_temperature_zero_without_opening_a_connection(
    socket_spy: list[Any],
) -> None:
    from rag_eval.judge.ragas_judge import build_ragas_live

    config = load_judge_config()
    llm, embeddings = build_ragas_live(config, "placeholder-openrouter-key", "placeholder-openai-key")
    assert llm._map_provider_params()["temperature"] == 0.0  # type: ignore[attr-defined]
    assert embeddings is not None
    assert socket_spy == []


def test_live_deepeval_wrapper_builds_without_a_connection(socket_spy: list[Any]) -> None:
    from rag_eval.judge.deepeval_judge import OpenRouterDeepEvalLLM

    llm = OpenRouterDeepEvalLLM(load_judge_config(), "placeholder-openrouter-key")
    assert llm.get_model_name() == "openai/gpt-5-mini"
    request = llm._request("prompt", None)
    assert request["temperature"] == 0.0 and request["model"] == "openai/gpt-5-mini"
    assert socket_spy == []


def _manifest() -> RunManifest:
    return RunManifest.model_validate(
        {
            "run_id": "run-test",
            "tier": "nightly",
            "created_at": "2026-01-01T00:00:00Z",
            "git_sha": None,
            "deployment_mode": "single",
            "embedder": None,
            "corpus_sha256": None,
            "golden_path": "golden.jsonl",
            "golden_sha256": "g" * 64,
            "sql_sha256": {},
            "request_options": {},
            "effective_config_hash": "h" * 64,
            "run_config_hash": "r" * 64,
            "item_count": 6,
            "edge_errors": 0,
        }
    )


def _cli_inputs(tmp_path: Path, traces: list[RagTrace] | None = None) -> list[str]:
    golden, default_traces = _six()
    write_golden(tmp_path / "golden.jsonl", golden)
    (tmp_path / "traces.jsonl").write_text(
        "".join(t.model_dump_json() + "\n" for t in (traces or default_traces)), encoding="utf-8"
    )
    (tmp_path / "run.json").write_text(_manifest().model_dump_json(), encoding="utf-8")
    return [
        "--traces", str(tmp_path / "traces.jsonl"),
        "--golden", str(tmp_path / "golden.jsonl"),
        "--manifest", str(tmp_path / "run.json"),
        "--out", str(tmp_path / "out"),
    ]  # fmt: skip


def test_cli_without_judge_or_embedding_key_exits_3_naming_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], socket_spy: list[Any]
) -> None:
    args = _cli_inputs(tmp_path)
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-openai-key")
    assert main(args) == 3
    assert "judge key not configured" in capsys.readouterr().err
    monkeypatch.setenv("OPENROUTER_API_KEY", "placeholder-openrouter-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert main(args) == 3
    err = capsys.readouterr().err
    assert "judge key not configured" in err and "OPENAI_API_KEY" in err
    assert not (tmp_path / "out").exists()
    assert socket_spy == []


def test_cli_refuses_a_claude_judge_config_with_exit_5(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path = tmp_path / "judge-claude.json"
    raw = json.loads((load_judge_config.__globals__["DEFAULT_CONFIG_PATH"]).read_text(encoding="utf-8"))
    raw.update({"judge_model": "anthropic/claude-haiku-4.5", "judge_family": "anthropic"})
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "placeholder-openrouter-key")
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-openai-key")
    assert main([*_cli_inputs(tmp_path), "--config", str(config_path)]) == 5
    assert "Claude" in capsys.readouterr().err


def test_cli_refuses_a_judge_from_the_generator_family_with_exit_5(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    golden, traces = _six()
    same_family = [t.model_copy(deep=True) for t in traces]
    openai_traces = [
        _trace(t.item_id or "", answer=t.answer, refused=t.refused, contexts=tuple(k.content for k in t.kept),
               generator_model="openai/gpt-4o")
        for t in same_family
    ]  # fmt: skip
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "placeholder-openrouter-key")
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-openai-key")
    assert main(_cli_inputs(tmp_path, openai_traces)) == 5


def test_cli_refuses_when_traces_do_not_record_the_generator_or_confident_key_is_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    golden, traces = _six()
    unknown = [
        _trace(t.item_id or "", answer=t.answer, refused=t.refused, contexts=tuple(k.content for k in t.kept),
               generator_model=None)
        for t in traces
    ]  # fmt: skip
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "placeholder-openrouter-key")
    monkeypatch.setenv("OPENAI_API_KEY", "placeholder-openai-key")
    assert main(_cli_inputs(tmp_path, unknown)) == 2
    assert "generator_model" in capsys.readouterr().err
    monkeypatch.setenv("CONFIDENT_API_KEY", "placeholder")
    assert main(_cli_inputs(tmp_path)) == 2
    assert "CONFIDENT_API_KEY" in capsys.readouterr().err
