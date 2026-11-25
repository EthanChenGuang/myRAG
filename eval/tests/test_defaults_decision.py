import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

import rag_eval.defaults_decision as dd
from rag_eval.defaults_decision import DecisionRecord, build_decision, main

# Synthetic values only; nothing here is read from a committed baseline, gate report or live result.
REQUIRED = ["v2-default", "v2-default-no-cells", "v2-default-hosted-fake", "v2-default-hosted-fake-no-cells"]
SIMILARITY = [f"v2-default-similarity-floor{suffix}" for suffix in ("", "-no-cells", "-hosted-fake", "-hosted-fake-no-cells")]
NONE = ["v2-default-fallback-none", "v2-default-fallback-none-no-cells"]
MODES = ("prechunked", "ingest")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _check(status: str = "pass") -> dict:
    return {"name": "c", "slice": "overall", "metric": "recall_at_10", "direction": "higher", "observed": 0.7, "n": 40,
            "bound": 0.68, "baseline_mean": 0.7, "band": 0.02, "status": status}


def _mode(config: str, mode: str, passed: bool, legacy: bool = False) -> dict:
    ids = ["G6"] if legacy else ["G1", "G2", "G3", "G4", "G5"]
    status = "pass" if passed else "fail"
    return {
        "config": config,
        "mode": mode,
        "report_path": f"eval/out/p41/{config}-{mode}/report.json",
        "report_sha256": _sha(f"{config}-{mode}"),
        "run_id": f"run-{config}-{mode}",
        "run_config_hash": _sha(f"hash-{config}"),
        "created_at": "2026-01-02T00:00:00Z",
        "passed": passed,
        "criteria": [{"id": gid, "status": status, "checks": [_check(status)], "notes": []} for gid in ids],
    }


def _config(name: str, role: str, passed: bool = True) -> dict:
    return {"name": name, "role": role, "passed": passed,
            "modes": [_mode(name, mode, passed, legacy=role == "legacy") for mode in MODES]}


def _candidate(name: str, configs: list[str], failing: tuple[str, ...]) -> dict:
    reasons = [f"{c} failed" for c in configs if c in failing]
    return {"name": name, "configurations": configs, "passed": not reasons, "score": None, "comparisons": [], "reasons": reasons}


def _gate(
    root: Path,
    *,
    floor: str | None = "legacy_rule",
    fallback: str | None = "local_bm25",
    failing: tuple[str, ...] = (),
    g8: dict | None = None,
) -> dict:
    prechunked = root / "prechunked.json"
    ingest = root / "ingest.json"
    criteria = root / "criteria.json"
    for path, text in ((prechunked, "p"), (ingest, "i"), (criteria, "c")):
        if not path.exists():
            path.write_text(text, encoding="utf-8")
    g8 = g8 or {"single_tenant": True, "multi_tenant": True, "drop": True, "max1": True}
    g8_ok = all(g8.values())
    configs = [_config(name, "required", name not in failing) for name in REQUIRED]
    configs += [_config(name, "candidate", name not in failing) for name in SIMILARITY + NONE]
    configs.append(_config("legacy", "legacy", "legacy" not in failing))
    failures = [f"{name} failed" for name in failing]
    if floor is None:
        failures.append("floor: neither floor passes: no flip (D-13)")
    if fallback is None:
        failures.append("no-key fallback: neither fallback passes: no flip (D-13)")
    if not g8_ok:
        failures.append("G8 fail")
    return {
        "schema_version": 1,
        "refusal_basis": "single_threshold",
        "criteria_path": str(criteria),
        "criteria_sha256": dd.sha256_file(criteria),
        "criteria_changed_at": "2026-01-01T00:00:00+00:00",
        "absolute_ingest_recall_at_10_min": 0.5,
        "noise": {"k": 3.0, "floor": 0.02},
        "sources": [
            {"role": "baseline:prechunked", "path": str(prechunked), "sha256": dd.sha256_file(prechunked)},
            {"role": "baseline:ingest", "path": str(ingest), "sha256": dd.sha256_file(ingest)},
        ],
        "configurations": configs,
        "g8": {
            "status": "pass" if g8_ok else "fail",
            "two_tenant_matrix": {"single_tenant": g8["single_tenant"], "multi_tenant": g8["multi_tenant"]},
            "negative_checks": {"drop_top_candidate_fails": g8["drop"], "max_results_1_fails": g8["max1"]},
            "notes": [],
        },
        "selections": {"floor": floor, "no_key_fallback": fallback},
        "selection_details": {
            "floor": {"chosen": floor, "reason": "synthetic", "candidates": [
                _candidate("legacy_rule", REQUIRED, failing), _candidate("similarity", SIMILARITY, failing)]},
            "no_key_fallback": {"chosen": fallback, "reason": "synthetic", "candidates": [
                _candidate("local_bm25", REQUIRED[:2], failing), _candidate("none", NONE, failing)]},
        },
        "passed": not failures,
        "failures": failures,
        "live": None,
    }


def _probe(name: str, vendor: str, model: str) -> dict:
    return {"name": name, "vendor": vendor, "model": model, "requests": 30, "n": 75, "ok": 30, "errors": 0,
            "p50_ms": 100.0, "p95_ms": 150.0, "status_counts": {"200": 30}}


def _model(name: str, vendor: str, model: str, tier: str, *, recall: float = 0.9, mrr: float = 0.8, p95: float | None = 150.0) -> dict:
    return {
        "run_config": name, "run_id": f"live-{name}", "n": 90, "recall_at_10": recall, "mrr": mrr,
        "recall_at_10_by_language": {}, "name": name, "vendor": vendor, "model": model, "tier": tier,
        "harness_requests": 90, "rerank_skipped": 0, "p50_ms": 100.0, "p95_ms": p95, "errors": 0, "request_count": 120,
        "probe": _probe(name, vendor, model),
    }


def _live(status: str = "complete", *, chat_p95: float = 300.0, voice_p95: float = 200.0, chat_recall: float = 0.9) -> dict:
    models = [
        _model("live-cohere-pro", "cohere", "rerank-v5.0-pro", "chat", recall=chat_recall, p95=chat_p95),
        _model("live-cohere-fast", "cohere", "rerank-v5.0-fast", "voice", p95=voice_p95),
        _model("live-voyage-3", "voyage", "rerank-3", "chat"),
        _model("live-voyage-3-lite", "voyage", "rerank-3-lite", "voice"),
    ]
    refs = {
        "local_bm25": {"run_config": "v2-default-no-cells", "run_id": "ref-bm25", "n": 90, "recall_at_10": 0.9, "mrr": 0.8,
                       "recall_at_10_by_language": {}},
        "none": {"run_config": "v2-default-fallback-none-no-cells", "run_id": "ref-none", "n": 90, "recall_at_10": 0.9,
                 "mrr": 0.8, "recall_at_10_by_language": {}},
    }
    return {
        "schema_version": 1, "status": status, "stop_reason": None, "created_at": "2026-01-03T00:00:00Z", "git_sha": None,
        "cap": 600, "total_requests": 0 if status == "pending_live" else 588, "dev_items_total": 90, "dev_items_used": 90,
        "sampled": False, "golden_sha256": "g" * 64, "baseline_sha256": "b" * 64,
        "band": {"recall_at_10": 0.02, "mrr": 0.02}, "latency_budgets_ms": {"chat": 600.0, "voice": 250.0},
        "offline_references": refs, "models": [] if status == "pending_live" else models, "verdicts": [],
        "g7": {}, "indicative_refusal_fit": {"status": "skipped", "reason": "synthetic"}, "caveat": "synthetic",
    }


def _write(path: Path, data: dict) -> Path:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _build(tmp_path: Path, gate: dict | None = None, live: dict | None = None, **kwargs) -> DecisionRecord:
    gate_path = _write(tmp_path / "gate.json", gate or _gate(tmp_path))
    live_path = _write(tmp_path / "live.json", live or _live())
    return build_decision(gate_path, live_path, **kwargs)


# ---------- status


def test_a_passing_gate_with_g8_and_no_blocker_flips(tmp_path):
    record = _build(tmp_path)
    assert record.status == "flip"
    assert record.reasons == []
    assert record.provisional is True
    assert record.refusal_floor == "legacy_rule"
    assert record.auto_no_key_fallback == "local_bm25"


@pytest.mark.parametrize(
    ("gate_kwargs", "fragment"),
    [
        ({"failing": ("v2-default",)}, "v2-default failed"),
        ({"floor": None}, "floor"),
        ({"fallback": None}, "fallback"),
        ({"g8": {"single_tenant": True, "multi_tenant": False, "drop": True, "max1": True}}, "multi_tenant"),
        ({"g8": {"single_tenant": True, "multi_tenant": True, "drop": False, "max1": True}}, "drop_top_candidate"),
    ],
)
def test_any_failed_condition_is_not_flipped_with_a_reason(tmp_path, gate_kwargs, fragment):
    record = _build(tmp_path, _gate(tmp_path, **gate_kwargs))
    assert record.status == "not_flipped"
    assert any(fragment in reason for reason in record.reasons), record.reasons


def test_a_failing_legacy_run_is_not_flipped(tmp_path):
    record = _build(tmp_path, _gate(tmp_path, failing=("legacy",)))
    assert record.status == "not_flipped"
    assert any("legacy" in reason for reason in record.reasons)


def test_an_open_04_1_05_blocker_is_not_flipped(tmp_path):
    record = _build(tmp_path, blockers=["a section 14 case fails"])
    assert record.status == "not_flipped"
    assert any("a section 14 case fails" in reason for reason in record.reasons)


def test_the_similarity_floor_carries_the_flip_only_through_its_own_configurations(tmp_path):
    gate = _gate(tmp_path, floor="similarity", fallback="none", failing=tuple(REQUIRED))
    gate["failures"] = []
    gate["passed"] = True
    record = _build(tmp_path, gate)
    assert record.status == "flip"
    assert record.refusal_floor == "similarity"
    assert record.defaults["RAG_REFUSAL_FLOOR"] == "similarity"
    assert record.auto_no_key_fallback == "none"


def test_a_chosen_fallback_whose_configuration_failed_is_not_flipped(tmp_path):
    gate = _gate(tmp_path, floor="similarity", fallback="local_bm25", failing=("v2-default-no-cells",))
    gate["failures"] = []
    gate["passed"] = True
    record = _build(tmp_path, gate)
    assert record.status == "not_flipped"
    assert any("v2-default-no-cells (no-key fallback local_bm25) failed" in reason for reason in record.reasons)


def test_a_gate_whose_chosen_floor_configuration_failed_is_not_flipped_even_if_passed_says_true(tmp_path):
    gate = _gate(tmp_path, failing=("v2-default-hosted-fake",))
    gate["failures"] = []
    gate["passed"] = True
    record = _build(tmp_path, gate)
    assert record.status == "not_flipped"
    assert any("v2-default-hosted-fake" in reason for reason in record.reasons)


# ---------- G7 and hosted profiles


def test_g7_inputs_list_the_live_hash_each_run_id_and_the_offline_references(tmp_path):
    record = _build(tmp_path)
    assert record.g7.live_result.sha256 == dd.sha256_file(tmp_path / "live.json")
    assert {m.name: m.run_id for m in record.g7.models} == {
        "live-cohere-pro": "live-live-cohere-pro",
        "live-cohere-fast": "live-live-cohere-fast",
        "live-voyage-3": "live-live-voyage-3",
        "live-voyage-3-lite": "live-live-voyage-3-lite",
    }
    assert record.g7.offline_references["local_bm25"].run_id == "ref-bm25"
    assert record.g7.offline_references["none"].run_id == "ref-none"
    assert record.g7.status == "complete"


def test_live_checks_inside_the_budgets_keep_every_profile_hosted(tmp_path):
    record = _build(tmp_path)
    assert record.auto_hosted_profiles == ["chat", "embed", "eval", "voice"]
    assert record.hosted.dropped == []
    assert record.hosted.preference == "cohere"


def test_voice_leaves_hosted_rerank_when_the_fast_p95_is_over_250(tmp_path):
    record = _build(tmp_path, live=_live(voice_p95=250.5))
    assert record.auto_hosted_profiles == ["chat", "embed", "eval"]
    assert [d.profile for d in record.hosted.dropped] == ["voice"]
    assert "250" in record.hosted.dropped[0].reason


def test_voice_at_exactly_250_stays_hosted(tmp_path):
    record = _build(tmp_path, live=_live(voice_p95=250.0))
    assert "voice" in record.auto_hosted_profiles


def test_chat_embed_and_eval_leave_when_the_chat_p95_is_over_600(tmp_path):
    record = _build(tmp_path, live=_live(chat_p95=600.1))
    assert record.auto_hosted_profiles == ["voice"]
    assert sorted(d.profile for d in record.hosted.dropped) == ["chat", "embed", "eval"]


def test_chat_embed_and_eval_leave_when_hosted_quality_is_below_the_local_references_minus_the_band(tmp_path):
    record = _build(tmp_path, live=_live(chat_recall=0.9 - 0.021))
    assert record.auto_hosted_profiles == ["voice"]
    assert all("Recall@10" in d.reason for d in record.hosted.dropped)
    inside = _build(tmp_path, live=_live(chat_recall=0.9 - 0.019))
    assert inside.auto_hosted_profiles == ["chat", "embed", "eval", "voice"]


def test_a_pending_live_result_records_g7_not_run_and_keeps_the_code_default(tmp_path):
    record = _build(tmp_path, live=_live("pending_live"))
    assert record.g7.status == "pending_live"
    assert record.g7.models == []
    assert record.hosted.basis == "pending_live"
    assert record.auto_hosted_profiles == ["chat", "embed", "eval", "voice"]
    assert record.status == "flip"


# ---------- record shape


def test_the_defaults_map_holds_exactly_the_d01_variables_as_strings(tmp_path):
    record = _build(tmp_path)
    assert record.defaults == {
        "RAG_PIPELINE": "v2",
        "RAG_LEXICAL_SEARCH": "true",
        "RAG_RERANKER": "auto",
        "RAG_REFUSAL_THRESHOLD": "true",
        "RAG_REFUSAL_FLOOR": "legacy_rule",
    }


def test_no_secret_typed_variable_in_the_defaults_map(tmp_path):
    data = json.loads(_build(tmp_path).model_dump_json())
    for name in ("COHERE_API_KEY", "VOYAGE_API_KEY", "RAG_VOICE_TOKEN_SECRET"):
        bad = dict(data)
        bad["defaults"] = {**data["defaults"], name: "x"}
        with pytest.raises(ValidationError):
            DecisionRecord.model_validate(bad)
    missing = dict(data)
    missing["defaults"] = {k: v for k, v in data["defaults"].items() if k != "RAG_RERANKER"}
    with pytest.raises(ValidationError):
        DecisionRecord.model_validate(missing)


def test_templates_keep_the_pipeline_implicit(tmp_path):
    data = json.loads(_build(tmp_path).model_dump_json())
    assert data["implicit_in_templates"] == ["RAG_PIPELINE"]
    data["implicit_in_templates"] = ["RAG_PIPELINE", "RAG_RERANKER"]
    with pytest.raises(ValidationError):
        DecisionRecord.model_validate(data)


def test_refusal_basis_is_single_threshold(tmp_path):
    record = _build(tmp_path)
    assert record.refusal_basis == "single_threshold"
    text = record.model_dump_json().lower()
    assert "rag_mode" not in text and "rag mode" not in text
    data = json.loads(record.model_dump_json())
    data["rag_mode"] = "strict"
    with pytest.raises(ValidationError):
        DecisionRecord.model_validate(data)


def test_every_criterion_appears_with_numbers_and_the_runs_and_baselines_are_recorded(tmp_path):
    record = _build(tmp_path)
    assert [c.id for c in record.criteria] == ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]
    g1 = record.criteria[0]
    assert g1.results and g1.results[0].checks[0].observed == 0.7 and g1.results[0].checks[0].n == 40
    assert {(r.config, r.mode) for r in record.runs} >= {("v2-default", "ingest"), ("legacy", "prechunked")}
    assert all(len(r.run_config_hash) == 64 for r in record.runs)
    assert record.baselines.ingest.sha256 == dd.sha256_file(tmp_path / "ingest.json")
    assert record.baselines.prechunked.sha256 == dd.sha256_file(tmp_path / "prechunked.json")
    assert record.criteria_file.sha256 == dd.sha256_file(tmp_path / "criteria.json")
    assert record.gate.sha256 == dd.sha256_file(tmp_path / "gate.json")


# ---------- CLI: build and check-current


def _cli_build(tmp_path: Path, out: Path, gate: dict | None = None) -> int:
    gate_path = _write(tmp_path / "gate.json", gate or _gate(tmp_path))
    live_path = _write(tmp_path / "live.json", _live())
    return main(["build", "--gate", str(gate_path), "--live", str(live_path), "--out", str(out)])


def test_build_writes_json_and_markdown_atomically_and_a_rerun_is_byte_identical(tmp_path):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    first_json = (tmp_path / "decision.json").read_bytes()
    first_md = (tmp_path / "decision.md").read_bytes()
    assert not list(tmp_path.glob("*.tmp"))
    assert _cli_build(tmp_path, out) == 0
    assert (tmp_path / "decision.json").read_bytes() == first_json
    assert (tmp_path / "decision.md").read_bytes() == first_md
    record = DecisionRecord.model_validate_json(first_json)
    assert record.status == "flip"
    markdown = first_md.decode()
    assert "provisional" in markdown.lower()
    for gid in ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"):
        assert gid in markdown


def test_build_keeps_the_hand_written_part_of_the_markdown(tmp_path):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    md = tmp_path / "decision.md"
    md.write_text(md.read_text(encoding="utf-8") + "\nA hand-written note.\n", encoding="utf-8")
    kept = md.read_bytes()
    assert _cli_build(tmp_path, out) == 0
    assert md.read_bytes() == kept


def test_build_of_a_not_flipped_gate_lists_the_failing_criteria_in_the_markdown(tmp_path):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out, _gate(tmp_path, failing=("v2-default-no-cells",))) == 0
    markdown = (tmp_path / "decision.md").read_text(encoding="utf-8")
    assert "not_flipped" in markdown
    assert "v2-default-no-cells" in markdown


def test_check_current_passes_on_unchanged_inputs(tmp_path, capsys):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    assert main(["check-current", "--decision", str(tmp_path / "decision.json")]) == 0


def test_a_re_recorded_baseline_makes_the_decision_stale(tmp_path, capsys):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    (tmp_path / "ingest.json").write_text("re-recorded", encoding="utf-8")
    capsys.readouterr()
    assert main(["check-current", "--decision", str(tmp_path / "decision.json")]) == 1
    assert str(tmp_path / "ingest.json") in capsys.readouterr().err


def test_a_changed_criteria_file_makes_the_decision_stale(tmp_path, capsys):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    (tmp_path / "criteria.json").write_text("changed", encoding="utf-8")
    capsys.readouterr()
    assert main(["check-current", "--decision", str(tmp_path / "decision.json")]) == 1
    assert "criteria.json" in capsys.readouterr().err


def test_check_current_rejects_a_record_that_does_not_validate(tmp_path, capsys):
    out = tmp_path / "decision"
    assert _cli_build(tmp_path, out) == 0
    path = tmp_path / "decision.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["provisional"] = False
    path.write_text(json.dumps(data), encoding="utf-8")
    assert main(["check-current", "--decision", str(path)]) == 2
