import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.eval_run import RagRunOptions, StageTimeoutsMs
from rag_sidecar.contracts.languages import language_codes
from rag_sidecar.contracts.retrieval import compute_config_hash
from rag_sidecar.contracts.terminology import (
    TerminologyCandidate,
    TerminologyEntry,
    TerminologyExpansion,
    TerminologyImportReport,
    TerminologyImportRow,
    TerminologyLexicon,
    TerminologyLexiconTerm,
    TerminologyMatch,
    TerminologyParams,
    TerminologyPreviewRequest,
    TerminologyPreviewResponse,
    TerminologyTranslationPair,
    TerminologyValidationIssue,
    terminology_params_sha256,
)

CODES = language_codes()
SOURCE, TARGET = CODES[0], CODES[1]
HEX = "a" * 64


def _entry(**update):
    base = {
        "layer": "shared",
        "canonical": "term alpha beta",
        "variants": ["termalpha", "alpha beta"],
        "language": SOURCE,
        "kind": "synonym",
    }
    base.update(update)
    return TerminologyEntry.model_validate(base)


def _pair(**update):
    base = {
        "layer": "shared",
        "canonical": "term alpha beta",
        "variants": ["术语甲乙丙"],
        "language": SOURCE,
        "kind": "translation",
        "source_language": SOURCE,
        "target_language": TARGET,
    }
    base.update(update)
    return base


def _row(**update):
    base = {
        "canonical": "term alpha beta",
        "variants": ["termalpha"],
        "language": SOURCE,
        "kind": "synonym",
    }
    base.update(update)
    return base


def test_entry_defaults():
    entry = _entry()
    assert entry.mode == "one_way"
    assert entry.enabled is True
    assert entry.id is None
    assert entry.note is None
    assert entry.suppresses_entry_id is None
    assert entry.source_language is None and entry.target_language is None


def test_entry_strips_and_bounds_canonical():
    assert _entry(canonical="  term alpha beta  ").canonical == "term alpha beta"
    for bad in ["", "   ", "x" * 65]:
        with pytest.raises(ValidationError):
            _entry(canonical=bad)
    assert len(_entry(canonical="x" * 64).canonical) == 64


def test_entry_variant_limits():
    with pytest.raises(ValidationError):
        _entry(variants=[])
    with pytest.raises(ValidationError):
        _entry(variants=[f"termalpha{i}" for i in range(17)])
    assert len(_entry(variants=[f"termalpha{i}" for i in range(16)]).variants) == 16
    with pytest.raises(ValidationError):
        _entry(variants=["x" * 65])
    with pytest.raises(ValidationError):
        _entry(variants=["  "])


def test_entry_variants_unique_after_strip_case_sensitive():
    with pytest.raises(ValidationError):
        _entry(variants=["termalpha", " termalpha "])
    assert _entry(variants=["termalpha", "TermAlpha"]).variants == ["termalpha", "TermAlpha"]


def test_entry_note_limit():
    assert _entry(note="n" * 500).note == "n" * 500
    with pytest.raises(ValidationError):
        _entry(note="n" * 501)


def test_entry_id_is_uuid():
    entry_id = uuid.uuid4()
    assert _entry(id=str(entry_id)).id == entry_id
    with pytest.raises(ValidationError):
        _entry(id="not-a-uuid")


def test_entry_suppression_rules():
    target = str(uuid.uuid4())
    row = _entry(layer="workspace", variants=[], suppresses_entry_id=target)
    assert str(row.suppresses_entry_id) == target
    with pytest.raises(ValidationError):
        _entry(layer="workspace", variants=["termalpha"], suppresses_entry_id=target)
    with pytest.raises(ValidationError):
        _entry(layer="shared", variants=[], suppresses_entry_id=target)


@pytest.mark.parametrize("code", CODES)
def test_entry_accepts_every_registry_code(code):
    assert _entry(language=code).language == code


def test_entry_accepts_any_and_rejects_unknown_language():
    assert _entry(language="any").language == "any"
    unknown = "zz"
    assert unknown not in CODES
    with pytest.raises(ValidationError):
        _entry(language=unknown)


def test_entry_kind_and_mode_and_layer_enums():
    for kind in ["synonym", "abbreviation", "alias", "identifier", "misspelling"]:
        assert _entry(kind=kind).kind == kind
    assert _entry(mode="equivalent").mode == "equivalent"
    for field, value in [("kind", "other"), ("mode", "both"), ("layer", "tenant")]:
        with pytest.raises(ValidationError):
            _entry(**{field: value})


def test_entry_is_frozen_and_forbids_extra():
    entry = _entry()
    with pytest.raises(ValidationError):
        entry.canonical = "term gamma delta"
    with pytest.raises(ValidationError):
        _entry(rogue=True)


def test_translation_pair_valid():
    entry = TerminologyEntry.model_validate(_pair())
    assert entry.kind == "translation"
    assert entry.source_language == SOURCE and entry.target_language == TARGET


@pytest.mark.parametrize(
    "update",
    [
        {"target_language": None},
        {"source_language": None},
        {"target_language": SOURCE},
        {"language": "any"},
        {"language": TARGET},
        {"mode": "equivalent"},
        {"target_language": "zz"},
    ],
)
def test_translation_pair_rejections(update):
    with pytest.raises(ValidationError):
        TerminologyEntry.model_validate(_pair(**update))


@pytest.mark.parametrize("field", ["source_language", "target_language"])
def test_other_kinds_reject_translation_languages(field):
    with pytest.raises(ValidationError):
        _entry(**{field: SOURCE})


def test_import_row_shares_translation_rules():
    row = TerminologyImportRow.model_validate(_row())
    assert row.mode == "one_way" and row.enabled is True
    pair = TerminologyImportRow.model_validate(
        _row(kind="translation", source_language=SOURCE, target_language=TARGET, variants=["术语甲乙丙"])
    )
    assert pair.target_language == TARGET
    for update in [
        {"kind": "translation", "source_language": SOURCE, "target_language": SOURCE},
        {"kind": "translation", "source_language": SOURCE},
        {"kind": "translation", "source_language": SOURCE, "target_language": TARGET, "mode": "equivalent"},
        {"kind": "synonym", "source_language": SOURCE},
    ]:
        with pytest.raises(ValidationError):
            TerminologyImportRow.model_validate(_row(**update))
    with pytest.raises(ValidationError):
        TerminologyImportRow.model_validate(_row(rogue=1))


def test_import_row_has_the_nine_csv_columns():
    assert set(TerminologyImportRow.model_fields) == {
        "canonical",
        "variants",
        "language",
        "kind",
        "mode",
        "enabled",
        "note",
        "source_language",
        "target_language",
    }


def test_params_defaults_and_hash():
    params = TerminologyParams()
    assert params.max_matches == 8
    assert params.max_terms_per_match == 4
    assert params.max_expansion_tokens == 24
    assert params.expansion_weight == 0.5
    assert params.dense_weight == 0.5
    assert params.min_han_chars == 2
    assert params.reserve_slots == 2
    digest = terminology_params_sha256(params)
    assert digest == compute_config_hash(params)
    assert len(digest) == 64
    assert terminology_params_sha256(TerminologyParams(reserve_slots=3)) != digest
    assert terminology_params_sha256(params.model_copy(update={"provenance": params.provenance.model_copy(update={"source": "sweep"})})) == digest


@pytest.mark.parametrize(
    "update",
    [
        {"dense_weight": 0.6},
        {"dense_weight": 0},
        {"expansion_weight": 0},
        {"expansion_weight": 1.01},
        {"reserve_slots": 5},
        {"reserve_slots": -1},
        {"rogue": 1},
    ],
)
def test_params_bounds(update):
    with pytest.raises(ValidationError):
        TerminologyParams.model_validate(update)


def test_params_accepts_bounds():
    params = TerminologyParams(expansion_weight=1, dense_weight=0.5, reserve_slots=0)
    assert params.reserve_slots == 0
    assert TerminologyParams(reserve_slots=4).reserve_slots == 4


def _match(**update):
    base = {
        "surface": "termalpha",
        "canonical": "term alpha beta",
        "entry_id": str(uuid.uuid4()),
        "kind": "synonym",
        "language": SOURCE,
        "layer": "shared",
        "start": 0,
        "end": 9,
    }
    base.update(update)
    return TerminologyMatch.model_validate(base)


def test_match_offsets():
    assert _match().end == 9
    for update in [{"start": -1}, {"end": 0}, {"start": 4, "end": 4}]:
        with pytest.raises(ValidationError):
            _match(**update)


def test_match_never_a_translation():
    with pytest.raises(ValidationError):
        _match(kind="translation")


def test_expansion_limits_and_version():
    expansion = TerminologyExpansion(matches=[_match()], expansion_tokens=["term", "beta"], capped=False, version="s12.w3")
    assert expansion.dense_text is None
    assert TerminologyExpansion(matches=[], expansion_tokens=[], capped=False, version="s4").version == "s4"
    with pytest.raises(ValidationError):
        TerminologyExpansion(matches=[_match()] * 9, expansion_tokens=[], capped=True, version="s1")
    with pytest.raises(ValidationError):
        TerminologyExpansion(matches=[], expansion_tokens=["t"] * 25, capped=True, version="s1")
    for version in ["w3", "s1.", "s1.w", "12"]:
        with pytest.raises(ValidationError):
            TerminologyExpansion(matches=[], expansion_tokens=[], capped=False, version=version)


def test_validation_issue():
    issue = TerminologyValidationIssue(code="chain", severity="error", message="merge these entries")
    assert issue.row is None and issue.entry_ids == []
    for code in ["conflict", "chain", "cycle", "invalid_variant", "invalid_language", "invalid_translation", "limit", "duplicate", "override"]:
        assert TerminologyValidationIssue(code=code, severity="warning", message="m").code == code
    with pytest.raises(ValidationError):
        TerminologyValidationIssue(code="other", severity="error", message="m")
    with pytest.raises(ValidationError):
        TerminologyValidationIssue(code="chain", severity="info", message="m")


def test_import_report():
    report = TerminologyImportReport(create=1, update=0, unchanged=2, delete=0, issues=[], layer_version_seen=3, applied=False)
    assert report.applied is False
    with pytest.raises(ValidationError):
        TerminologyImportReport(create=-1, update=0, unchanged=0, delete=0, issues=[], layer_version_seen=0, applied=False)


def test_preview_request_and_response():
    request = TerminologyPreviewRequest(query="termalpha", layer="workspace", draft_entries=[_entry()])
    assert request.organization_id is None
    with pytest.raises(ValidationError):
        TerminologyPreviewRequest(query="", layer="shared")
    response = TerminologyPreviewResponse(
        matches=[_match()],
        original_tokens=["termalpha"],
        expansion_tokens=["term", "beta"],
        capped=False,
        overrides=[TerminologyValidationIssue(code="override", severity="warning", message="m")],
        issues=[],
        version="s1.w2",
    )
    assert response.version == "s1.w2"


def _candidate(**update):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    base = {
        "id": str(uuid.uuid4()),
        "term": "termalpha",
        "language": SOURCE,
        "support": 3,
        "examples": ["what is termalpha"],
        "corpus_df": 0,
        "status": "pending",
        "source": "miss_log",
        "first_seen": now,
        "last_seen": now,
    }
    base.update(update)
    return TerminologyCandidate.model_validate(base)


def test_candidate_bounds():
    assert _candidate().entry_id is None
    assert _candidate(language=None).language is None
    for update in [
        {"support": 0},
        {"examples": ["q"] * 4},
        {"examples": ["q" * 501]},
        {"corpus_df": -1},
        {"status": "other"},
        {"source": "other"},
        {"language": "any"},
        {"language": "zz"},
    ]:
        with pytest.raises(ValidationError):
            _candidate(**update)
    for source in ["miss_log", "feedback", "langfuse"]:
        assert _candidate(source=source).source == source
    assert _candidate(status="accepted", entry_id=str(uuid.uuid4())).status == "accepted"


def _lexicon(**update):
    base = {
        "version": "s12.w3",
        "entries_sha256": HEX,
        "terms": [{"normalized": "termalpha", "language": "any", "kind": "alias"}],
        "translations": [
            {
                "entry_id": str(uuid.uuid4()),
                "source_language": SOURCE,
                "target_language": TARGET,
                "sources": ["术语甲乙丙"],
                "target": "term alpha beta",
                "target_normalized": "term alpha beta",
            }
        ],
    }
    base.update(update)
    return TerminologyLexicon.model_validate(base)


def test_lexicon_shape():
    lexicon = _lexicon()
    assert isinstance(lexicon.terms[0], TerminologyLexiconTerm)
    assert isinstance(lexicon.translations[0], TerminologyTranslationPair)
    for update in [{"version": "s12"}, {"entries_sha256": "A" * 64}, {"entries_sha256": "a" * 63}, {"rogue": 1}]:
        with pytest.raises(ValidationError):
            _lexicon(**update)


def test_lexicon_term_and_pair_rules():
    with pytest.raises(ValidationError):
        TerminologyLexiconTerm(normalized="", language=SOURCE, kind="synonym")
    with pytest.raises(ValidationError):
        TerminologyLexiconTerm(normalized="t", language="zz", kind="synonym")
    pair = {
        "entry_id": str(uuid.uuid4()),
        "source_language": SOURCE,
        "target_language": TARGET,
        "sources": ["术语甲乙丙"],
        "target": "term alpha beta",
        "target_normalized": "term alpha beta",
    }
    assert TerminologyTranslationPair.model_validate(pair).target == "term alpha beta"
    for update in [
        {"target_language": SOURCE},
        {"source_language": "any"},
        {"sources": []},
        {"sources": ["s"] * 17},
        {"target": ""},
        {"target": "x" * 65},
        {"target_normalized": ""},
    ]:
        with pytest.raises(ValidationError):
            TerminologyTranslationPair.model_validate({**pair, **update})


def test_stage_name_and_timeouts_include_terminology():
    assert StageTimeoutsMs(terminology=5).terminology == 5
    with pytest.raises(ValidationError):
        StageTimeoutsMs(terminology=0)
    options = RagRunOptions(disabled_stages=["terminology"], stage_timeouts_ms={"terminology": 40})
    assert options.disabled_stages == ["terminology"]
