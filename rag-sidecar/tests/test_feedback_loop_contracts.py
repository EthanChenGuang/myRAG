import json
from pathlib import Path
from typing import Any, get_args, get_origin

import pytest
from pydantic import BaseModel, ValidationError

from rag_sidecar.contracts import (
    Baseline,
    DictionaryCandidate,
    DictionaryTerm,
    EmbedFeedbackRequest,
    EvalReport,
    ExpertEvidenceSpan,
    ExpertLabel,
    FailureEntry,
    FailureReport,
    FeedbackLoopStats,
    FeedbackMiningConfig,
    GatePopulationConfig,
    GoldenItem,
    GoldenSplitManifest,
    GoldSpan,
    MiningRunResult,
    RefusalFeedbackRequest,
    RetrievalLogCandidate,
    RetrievalLogEntry,
    ReviewItem,
    ReviewItemListResponse,
    ReviewQueueItem,
    ShipCheckResult,
    SourceSignalRequest,
    TrainingNegative,
    TrainingPair,
    TrainingPositive,
    WeeklyReport,
)
from rag_sidecar.contracts.samples import build_samples

REPO_ROOT = Path(__file__).resolve().parents[2]
DOC_A = "00000000-0000-4000-8000-000000000001"
DOC_B = "00000000-0000-4000-8000-000000000002"
ITEM_ID = "00000000-0000-4000-8000-000000000011"
USER_ID = "00000000-0000-4000-8000-000000000021"
SHA = "0" * 64


def _candidate(**overrides: Any) -> dict[str, Any]:
    base = {"chunk_id": "chunk-1", "document_id": DOC_A, "rank": 1, "similarity": 0.81, "kept": True}
    base.update(overrides)
    return base


def _log_entry(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "trace_id": "trace-0001",
        "channel": "chat",
        "pipeline": "legacy",
        "status": "ok",
        "outcome": "answered",
        "candidates": [_candidate()],
        "candidate_count": 1,
        "top_score": 0.81,
        "latency_ms": 120,
    }
    base.update(overrides)
    return base


def _span(**overrides: Any) -> dict[str, Any]:
    base = {
        "chunk_id": "chunk-1",
        "document_id": DOC_A,
        "document_name": "Synthetic handbook",
        "section": "Section 2",
        "quote": "The blue widget ships in a red box.",
    }
    base.update(overrides)
    return base


def _label(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "answerable": True,
        "category": "general",
        "language": "en",
        "expected_answer": "It ships in a red box.",
        "evidence": [_span()],
        "triage": ["golden"],
        "pii_checked": True,
    }
    base.update(overrides)
    return base


def _review_item(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": ITEM_ID,
        "tenant_key": "s:default",
        "trace_id": "trace-0001",
        "query_masked": "Which box does the blue widget ship in?",
        "channel": "chat",
        "outcome": "answered",
        "candidates": [_candidate()],
        "reasons": ["feedback_negative"],
        "status": "open",
        "mined_at": "2026-11-20T00:00:00Z",
    }
    base.update(overrides)
    return base


# --- RetrievalLogEntry -------------------------------------------------------------------------


def test_log_entry_minimal_has_language_defaults():
    entry = RetrievalLogEntry.model_validate(_log_entry())
    assert entry.query_language is None
    assert entry.query_language_confidence is None
    assert entry.chunk_languages == []
    assert entry.answer_language is None


@pytest.mark.parametrize("field,value", [("channel", "whatsapp"), ("outcome", "refused"), ("feedback_vote", 0)])
def test_log_entry_rejects_values_outside_enums(field, value):
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(**{field: value}))


def test_log_entry_accepts_votes_and_caps_query_and_candidates():
    for vote in (-1, 1, None):
        RetrievalLogEntry.model_validate(_log_entry(feedback_vote=vote, feedback_kind=None if vote is None else "answer"))
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(query_masked="x" * 2001, query_fingerprint=SHA))
    RetrievalLogEntry.model_validate(_log_entry(query_masked="x" * 2000, query_fingerprint=SHA))
    many = [_candidate(chunk_id=f"c{i}", rank=i + 1) for i in range(51)]
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(candidates=many, candidate_count=51))
    RetrievalLogEntry.model_validate(_log_entry(candidates=many[:50], candidate_count=50))


@pytest.mark.parametrize("value", [1.2, -0.1])
def test_query_language_confidence_out_of_range_rejected(value):
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(query_language_confidence=value))


@pytest.mark.parametrize("value", [0, 0.5, 1])
def test_query_language_confidence_in_range_accepted(value):
    assert RetrievalLogEntry.model_validate(_log_entry(query_language_confidence=value)).query_language_confidence == value


def test_chunk_languages_codes_only_and_distinct():
    assert RetrievalLogEntry.model_validate(_log_entry(chunk_languages=["en", "zh", "und"])).chunk_languages == [
        "en",
        "zh",
        "und",
    ]
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(chunk_languages=["en", "en"]))
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(chunk_languages=["this is a sentence of forty characters!!"]))


def test_answer_language_is_a_code():
    with pytest.raises(ValidationError):
        RetrievalLogEntry.model_validate(_log_entry(answer_language="English"))
    for code in ("en", "zh-Hant"):
        assert RetrievalLogEntry.model_validate(_log_entry(answer_language=code)).answer_language == code


def test_candidate_language_optional_and_left_out_when_unset():
    plain = RetrievalLogCandidate.model_validate(_candidate())
    assert plain.language is None
    assert "language" not in plain.model_dump(mode="json")
    tagged = RetrievalLogCandidate.model_validate(_candidate(language="it"))
    assert tagged.model_dump(mode="json")["language"] == "it"
    with pytest.raises(ValidationError):
        RetrievalLogCandidate.model_validate(_candidate(language="Italian"))


@pytest.mark.parametrize("model", [RetrievalLogCandidate])
def test_candidate_requires_document_id(model):
    row = _candidate()
    del row["document_id"]
    with pytest.raises(ValidationError):
        model.model_validate(row)
    with pytest.raises(ValidationError):
        model.model_validate(_candidate(document_id="not-a-uuid"))


def test_candidate_rank_starts_at_one():
    with pytest.raises(ValidationError):
        RetrievalLogCandidate.model_validate(_candidate(rank=0))


# --- Feedback request bodies -------------------------------------------------------------------


def test_refusal_feedback_body():
    assert RefusalFeedbackRequest.model_validate({"vote": "expected_answer"}).reasons == []
    RefusalFeedbackRequest.model_validate({"vote": "correct_refusal", "reasons": ["answer_exists", "wrong_language"]})
    with pytest.raises(ValidationError):
        RefusalFeedbackRequest.model_validate({"vote": "helpful"})
    with pytest.raises(ValidationError):
        RefusalFeedbackRequest.model_validate({"vote": "expected_answer", "reasons": ["wrong"]})


def test_embed_feedback_body():
    EmbedFeedbackRequest.model_validate({"token": "t" * 4096, "vote": "helpful", "reasons": ["wrong", "not_relevant"]})
    for bad in ({"token": "", "vote": "helpful"}, {"token": "t" * 4097, "vote": "helpful"}, {"token": "t", "vote": "up"}):
        with pytest.raises(ValidationError):
            EmbedFeedbackRequest.model_validate(bad)
    with pytest.raises(ValidationError):
        EmbedFeedbackRequest.model_validate({"token": "t", "vote": "helpful", "reasons": ["answer_exists"]})


def test_source_signal_body():
    assert SourceSignalRequest.model_validate({"kind": "source_opened"}).kind == "source_opened"
    with pytest.raises(ValidationError):
        SourceSignalRequest.model_validate({"kind": "clicked"})


@pytest.mark.parametrize(
    "model,body",
    [
        (RefusalFeedbackRequest, {"vote": "expected_answer"}),
        (EmbedFeedbackRequest, {"token": "t", "vote": "helpful"}),
        (SourceSignalRequest, {"kind": "source_opened"}),
    ],
)
@pytest.mark.parametrize("extra", ["tenant_key", "tenantKey", "query", "answer", "comment", "text"])
def test_feedback_bodies_reject_tenant_and_free_text(model, body, extra):
    with pytest.raises(ValidationError):
        model.model_validate({**body, extra: "x"})


@pytest.mark.parametrize("model", [RefusalFeedbackRequest, EmbedFeedbackRequest, SourceSignalRequest])
def test_feedback_bodies_have_no_tenant_or_text_field(model):
    forbidden = {"tenant_key", "tenant", "query", "answer", "comment", "text", "question", "content"}
    assert forbidden.isdisjoint(model.model_fields)


# --- ExpertLabel -------------------------------------------------------------------------------


def test_expert_label_valid_and_unanswerable():
    ExpertLabel.model_validate(_label())
    ExpertLabel.model_validate(
        _label(answerable=False, category="no_answer", expected_answer=None, evidence=[], triage=["kb_gap"])
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"expected_answer": None},
        {"expected_answer": "   "},
        {"evidence": []},
        {"answerable": False, "category": "no_answer", "expected_answer": None, "triage": ["kb_gap"]},
        {"pii_checked": False},
        {"evidence": [_span(quote="x")]},
        {"evidence": [_span(chunk_id=f"c{i}") for i in range(21)]},
        {"triage": ["golden", "archive"]},
        {"triage": []},
        {"paraphrased_question": "q" * 1001},
        {"not_relevant_chunk_ids": [f"c{i}" for i in range(51)]},
        {"not_relevant_chunk_ids": ["chunk-1"]},
        {"triage": ["dictionary"], "pii_checked": False},
    ],
)
def test_expert_label_rejections(overrides):
    with pytest.raises(ValidationError):
        ExpertLabel.model_validate(_label(**overrides))


def test_expert_label_limits_accepted_at_the_edge():
    label = ExpertLabel.model_validate(
        _label(
            evidence=[_span(chunk_id=f"c{i}") for i in range(20)],
            not_relevant_chunk_ids=[f"n{i}" for i in range(50)],
            paraphrased_question="q" * 1000,
            confirm_near_duplicate_of="dom-0001",
        )
    )
    assert len(label.evidence) == 20
    assert label.not_relevant_chunk_ids[0] == "n0"


def test_expert_label_forbids_unknown_fields():
    with pytest.raises(ValidationError):
        ExpertLabel.model_validate(_label(judge_score=0.5))


def test_expert_label_language_keeps_the_registry_literal():
    with pytest.raises(ValidationError):
        ExpertLabel.model_validate(_label(language="zh-Hant"))


def test_evidence_span_requires_document_id():
    span = _span()
    del span["document_id"]
    with pytest.raises(ValidationError):
        ExpertEvidenceSpan.model_validate(span)


def test_dictionary_terms_on_the_label():
    term = {"observed_term": "wdgt", "canonical_term": "widget", "relation": "abbreviation"}
    ExpertLabel.model_validate(_label(triage=["dictionary"], dictionary_terms=[term]))
    with pytest.raises(ValidationError):
        DictionaryTerm.model_validate({**term, "relation": "translation"})
    DictionaryTerm.model_validate({**term, "relation": "translation", "canonical_language": "it"})


# --- DictionaryCandidate and TrainingPair ------------------------------------------------------


def _dictionary_candidate(**overrides: Any) -> dict[str, Any]:
    base = {
        "tenant_key": "s:default",
        "language": "en",
        "observed_term": "wdgt",
        "canonical_term": "widget",
        "relation": "abbreviation",
        "example_review_item_ids": [ITEM_ID],
        "occurrences": 2,
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize("relation", ["synonym", "abbreviation", "misspelling"])
def test_dictionary_candidate_relations(relation):
    assert DictionaryCandidate.model_validate(_dictionary_candidate(relation=relation)).canonical_language is None


def test_dictionary_candidate_translation_needs_canonical_language():
    with pytest.raises(ValidationError):
        DictionaryCandidate.model_validate(_dictionary_candidate(relation="translation"))
    candidate = DictionaryCandidate.model_validate(_dictionary_candidate(relation="translation", canonical_language="zh"))
    assert candidate.canonical_language == "zh"
    with pytest.raises(ValidationError):
        DictionaryCandidate.model_validate(_dictionary_candidate(relation="hypernym"))
    with pytest.raises(ValidationError):
        DictionaryCandidate.model_validate(_dictionary_candidate(canonical_language="Chinese"))


def _pair(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "tenant_key": "s:default",
        "query_masked": "Which box does the blue widget ship in?",
        "language": "en",
        "positive": {"chunk_id": "chunk-1", "document_id": DOC_A, "quote": "ships in a red box"},
        "hard_negatives": [
            {"chunk_id": "chunk-9", "document_id": DOC_B, "rank": 1, "score": 0.9, "confirmed": True},
        ],
        "document_group": "g-0001",
        "split": "train",
        "source": "production_feedback",
        "review_item_id": ITEM_ID,
    }
    base.update(overrides)
    return base


def _field_names(model: type[BaseModel], seen: set[type[BaseModel]] | None = None) -> set[str]:
    seen = seen if seen is not None else set()
    if model in seen:
        return set()
    seen.add(model)
    names = set(model.model_fields)
    for field in model.model_fields.values():
        stack = [field.annotation]
        while stack:
            annotation = stack.pop()
            if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                names |= _field_names(annotation, seen)
            elif get_origin(annotation) is not None or get_args(annotation):
                stack.extend(get_args(annotation))
    return names


def test_training_pair_shape():
    pair = TrainingPair.model_validate(_pair())
    assert pair.hard_negatives[0].confirmed is True
    assert {"text", "chunk_text", "content"}.isdisjoint(_field_names(TrainingPair))
    assert "Phase 6.1" in TrainingNegative.model_fields["confirmed"].description
    assert "domain expert" in TrainingNegative.model_fields["confirmed"].description
    with pytest.raises(ValidationError):
        TrainingPair.model_validate(_pair(split="test"))
    with pytest.raises(ValidationError):
        TrainingPair.model_validate(_pair(source="synthetic"))
    negatives = [
        {"chunk_id": f"n{i}", "document_id": DOC_B, "rank": i + 1, "score": 0.5, "confirmed": False} for i in range(11)
    ]
    with pytest.raises(ValidationError):
        TrainingPair.model_validate(_pair(hard_negatives=negatives))
    TrainingPair.model_validate(_pair(hard_negatives=negatives[:10], split="held_out"))


def test_training_negative_cannot_be_the_positive():
    negative = {"chunk_id": "chunk-1", "document_id": DOC_A, "rank": 2, "score": 0.4, "confirmed": False}
    with pytest.raises(ValidationError):
        TrainingPair.model_validate(_pair(hard_negatives=[negative]))
    with pytest.raises(ValidationError):
        TrainingPositive.model_validate({"chunk_id": "c", "quote": "ab"})


# --- Review item -------------------------------------------------------------------------------


def test_review_item_defaults_tags_and_languages():
    item = ReviewItem.model_validate(_review_item())
    assert item.tags == []
    assert item.chunk_languages == []
    assert item.query_language_confidence is None
    assert ReviewItem.model_validate(_review_item(reasons=[])).reasons == []
    assert ReviewItem.model_validate(_review_item(tags=["representative"])).tags == ["representative"]


@pytest.mark.parametrize("tag", ["Representative", "t" * 33, "two words", ""])
def test_review_item_tag_pattern(tag):
    with pytest.raises(ValidationError):
        ReviewItem.model_validate(_review_item(tags=[tag]))


def test_review_item_language_snapshot_rules():
    ReviewItem.model_validate(
        _review_item(
            query_language="it",
            query_language_confidence=0.5,
            chunk_languages=["it", "und"],
            answer_language="zh-Hant",
        )
    )
    for bad in (
        {"query_language_confidence": 1.5},
        {"chunk_languages": ["en", "en"]},
        {"answer_language": "English"},
        {"query_language": "a free text value"},
    ):
        with pytest.raises(ValidationError):
            ReviewItem.model_validate(_review_item(**bad))


def test_review_item_candidates_need_document_ids_and_label_is_checked():
    candidate = _candidate()
    del candidate["document_id"]
    with pytest.raises(ValidationError):
        ReviewItem.model_validate(_review_item(candidates=[candidate]))
    with pytest.raises(ValidationError):
        ReviewItem.model_validate(_review_item(label={**_label(), "free_key": 1}))
    item = ReviewItem.model_validate(_review_item(status="labelled", label=_label(), triage=["golden"]))
    assert item.label is not None and item.label.pii_checked is True


def test_review_item_list_response_caps_at_fifty():
    ReviewItemListResponse.model_validate({"items": [_review_item()] * 50, "next_cursor": None})
    with pytest.raises(ValidationError):
        ReviewItemListResponse.model_validate({"items": [_review_item()] * 51})


# --- Mining, gate population, ship check -------------------------------------------------------


def test_feedback_mining_config_defaults_and_bounds():
    thresholds = {"similarity": 0.5, "rerank": 0.2}
    config = FeedbackMiningConfig.model_validate(
        {"low_score_ceiling": thresholds, "refused_high_score_floor": {"similarity": 0.7, "rerank": 0.6}}
    )
    assert (config.schema_version, config.per_tenant_limit, config.window_days, config.open_item_ttl_days) == (
        1,
        50,
        7,
        90,
    )
    for bad in ({"per_tenant_limit": 0}, {"per_tenant_limit": 501}, {"window_days": 32}, {"schema_version": 2}):
        with pytest.raises(ValidationError):
            FeedbackMiningConfig.model_validate(
                {"low_score_ceiling": thresholds, "refused_high_score_floor": thresholds, **bad}
            )


def test_gate_population_config():
    config = GatePopulationConfig()
    assert (config.mode, config.provenances, config.min_items) == ("legacy", ["production", "human"], 100)
    GatePopulationConfig.model_validate({"mode": "real", "provenances": ["human"], "min_items": 1})
    for bad in (
        {"mode": "all"},
        {"provenances": []},
        {"provenances": ["synthetic_fixture"]},
        {"provenances": ["claude_draft"]},
        {"min_items": 0},
    ):
        with pytest.raises(ValidationError):
            GatePopulationConfig.model_validate(bad)


def test_gate_population_provenances_are_named_once():
    allowed = set(get_args(get_args(GatePopulationConfig.model_fields["provenances"].annotation)[0]))
    assert allowed == {"production", "human"}


def test_ship_check_result():
    base = {
        "passed": True,
        "reasons": [],
        "target_metric": "recall_at_5",
        "target_delta": 0.03,
        "ci_low": 0.01,
        "ci_high": 0.05,
        "baseline_hash": SHA,
        "candidate_hash": "1" * 64,
        "manifest_hash": "2" * 64,
        "gate_population": "real",
    }
    ShipCheckResult.model_validate(base)
    ShipCheckResult.model_validate({**base, "passed": False, "reasons": ["not_real_population"], "gate_population": "all"})
    with pytest.raises(ValidationError):
        ShipCheckResult.model_validate({**base, "reasons": ["manifest_mismatch"]})
    with pytest.raises(ValidationError):
        ShipCheckResult.model_validate({**base, "passed": False})
    with pytest.raises(ValidationError):
        ShipCheckResult.model_validate({**base, "reasons": ["Free text reason"], "passed": False})


# --- Reports carry no text ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "model", [WeeklyReport, FailureReport, FailureEntry, FeedbackLoopStats, MiningRunResult, ShipCheckResult]
)
def test_report_contracts_have_no_text_fields(model):
    names = _field_names(model)
    assert {"question", "answer", "query", "query_masked", "content", "text", "quote"}.isdisjoint(names)
    assert "tenant_key" not in names


def test_every_new_contract_forbids_unknown_fields_and_is_frozen():
    samples = build_samples()["samples"]
    for model in (
        RetrievalLogCandidate,
        RetrievalLogEntry,
        RefusalFeedbackRequest,
        EmbedFeedbackRequest,
        SourceSignalRequest,
        ReviewItem,
        ReviewItemListResponse,
        ExpertLabel,
        ExpertEvidenceSpan,
        DictionaryTerm,
        DictionaryCandidate,
        TrainingPair,
        TrainingPositive,
        TrainingNegative,
        FeedbackMiningConfig,
        MiningRunResult,
        FeedbackLoopStats,
        WeeklyReport,
        FailureReport,
        FailureEntry,
        GatePopulationConfig,
        ShipCheckResult,
    ):
        sample = samples[model.__name__]
        instance = model.model_validate(sample)
        assert instance.model_dump(mode="json") == sample
        with pytest.raises(ValidationError):
            model.model_validate({**sample, "unexpected_key": 1})


# --- Existing contracts ------------------------------------------------------------------------


def test_split_manifest_docgroup_rule():
    GoldenSplitManifest.model_validate({"rule": "sha256-first8hex-mod100-lt70-dev", "assignments": {"a-001": "dev"}})
    manifest = GoldenSplitManifest.model_validate(
        {
            "rule": "docgroup-sha256-first8hex-mod100-lt70-dev",
            "assignments": {"a-001": "dev"},
            "group_assignments": {"g-0001": "dev"},
        }
    )
    assert manifest.group_assignments == {"g-0001": "dev"}
    with pytest.raises(ValidationError):
        GoldenSplitManifest.model_validate(
            {
                "rule": "sha256-first8hex-mod100-lt70-dev",
                "assignments": {"a-001": "dev"},
                "group_assignments": {"g-0001": "dev"},
            }
        )
    with pytest.raises(ValidationError):
        GoldenSplitManifest.model_validate({"rule": "random", "assignments": {}})


def test_split_manifest_item_rule_dump_is_unchanged():
    raw = {"assignments": {"a-001": "dev"}, "rule": "sha256-first8hex-mod100-lt70-dev", "schema_version": 1}
    assert GoldenSplitManifest.model_validate(raw).model_dump(mode="json") == raw


def test_committed_split_manifests_still_validate():
    paths = sorted(REPO_ROOT.glob("eval/**/*manifest*.json"))
    checked = 0
    for path in paths:
        if "private" in path.parts:
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and str(data.get("rule", "")).endswith("mod100-lt70-dev"):
            assert GoldenSplitManifest.model_validate(data).model_dump(mode="json") == data, path
            checked += 1
    assert checked >= 1


def test_review_queue_item_accepts_mining_reasons():
    base = build_samples()["samples"]["ReviewQueueItem"]
    for reason in (
        "refusal_disputed",
        "refused_high_score",
        "zero_results",
        "low_score",
        "no_source_opened",
        "sampled",
        "feedback_negative",
        "groundedness_flagged",
    ):
        assert ReviewQueueItem.model_validate({**base, "reasons": [reason]}).reasons == [reason]
    with pytest.raises(ValidationError):
        ReviewQueueItem.model_validate({**base, "reasons": ["unknown_reason"]})


def _report_and_baseline_paths() -> list[Path]:
    out = []
    for path in sorted(REPO_ROOT.glob("eval/**/*.json")):
        if "private" in path.parts or "fixtures" in path.parts and "parse" in path.parts:
            continue
        out.append(path)
    return out


def test_gate_population_real_is_accepted_and_committed_reports_and_baselines_validate():
    samples = build_samples()["samples"]
    assert EvalReport.model_validate({**samples["EvalReport"], "gate_population": "real"}).gate_population == "real"
    assert Baseline.model_validate({**samples["Baseline"], "gate_population": "real"}).gate_population == "real"
    with pytest.raises(ValidationError):
        EvalReport.model_validate({**samples["EvalReport"], "gate_population": "synthetic"})
    reports = baselines = 0
    for path in _report_and_baseline_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict) or "gate_population" not in data:
            continue
        if "runs" in data:
            Baseline.model_validate(data)
            baselines += 1
        elif "items" in data:
            EvalReport.model_validate(data)
            reports += 1
    assert baselines >= 1


def test_gold_span_document_id_optional_and_left_out_when_unset():
    span = GoldSpan(document="doc.md", section="Intro", quote="ab")
    assert span.model_dump(mode="json") == {"document": "doc.md", "section": "Intro", "quote": "ab"}
    with_id = GoldSpan(document="doc.md", section="Intro", quote="ab", document_id=DOC_A)
    assert with_id.model_dump(mode="json") == {
        "document": "doc.md",
        "section": "Intro",
        "quote": "ab",
        "document_id": DOC_A,
    }
    with pytest.raises(ValidationError):
        GoldSpan(document="doc.md", section="Intro", quote="ab", document_id="doc-1")


def test_committed_golden_items_keep_their_bytes():
    path = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines
    for line in lines:
        raw = json.loads(line)
        item = GoldenItem.model_validate(raw)
        dumped = item.model_dump(mode="json")
        assert all("document_id" not in span for span in dumped["gold_evidence"])
        assert dumped["gold_evidence"] == raw.get("gold_evidence", [])


def test_new_models_are_registered_for_export():
    from rag_sidecar.export_schemas import CONTRACTS

    registered = {model.__name__ for model, _ in CONTRACTS}
    assert {
        "RetrievalLogCandidate",
        "RetrievalLogEntry",
        "RefusalFeedbackRequest",
        "EmbedFeedbackRequest",
        "SourceSignalRequest",
        "ReviewItem",
        "ReviewItemListResponse",
        "ExpertLabel",
        "ExpertEvidenceSpan",
        "DictionaryTerm",
        "DictionaryCandidate",
        "TrainingPair",
        "TrainingPositive",
        "TrainingNegative",
        "FeedbackMiningConfig",
        "MiningRunResult",
        "FeedbackLoopStats",
        "WeeklyReport",
        "FailureReport",
        "FailureEntry",
        "GatePopulationConfig",
        "ShipCheckResult",
    } <= registered


def test_samples_use_codes_and_placeholders():
    samples = build_samples()["samples"]
    entry = samples["RetrievalLogEntry"]
    assert entry["query_language"] and entry["answer_language"] and entry["chunk_languages"]
    assert entry["query_language_confidence"] is not None
    item = samples["ReviewItem"]
    assert len(item["tags"]) == 1
    assert item["chunk_languages"] and item["query_language"]
    assert all("document_id" not in span for span in samples["GoldenItem"]["gold_evidence"])
