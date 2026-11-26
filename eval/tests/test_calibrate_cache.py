import json

import pytest
from rag_sidecar.contracts.cache import SemanticCacheCalibration

from rag_eval.calibrate import __main__ as calibrate_cli
from rag_eval.calibrate import cache as c
from rag_eval.paths import REPO_ROOT

CONFIG = REPO_ROOT / "eval" / "config" / "semantic-cache.json"


def _row(pair_id, category, split, distance=None, outcome=None, bypass_reason=None):
    outcome = outcome or ("hit" if distance is not None else "miss")
    return {
        "pair_id": pair_id,
        "anchor_id": f"anchor-{pair_id}",
        "category": category,
        "split": split,
        "language": "en",
        "outcome": outcome,
        "hit": outcome == "hit",
        "distance": distance,
        "bypass_reason": bypass_reason,
        "anchor_outcome": "miss",
    }


def _synthetic(test_near_miss=None):
    rows = [_row(f"dev-para-{i}", "cache_paraphrase", "dev", round(0.01 * i, 4)) for i in range(1, 7)]
    rows += [_row(f"dev-near-{i}", "cache_near_miss", "dev", round(0.06 + 0.01 * i, 4)) for i in range(1, 4)]
    rows.append(_row("dev-near-code", "cache_near_miss", "dev", outcome="bypass", bypass_reason="protected_tokens"))
    rows += [_row("test-para-1", "cache_paraphrase", "test", 0.02), _row("test-para-2", "cache_paraphrase", "test", 0.09)]
    rows.append(_row("test-near-1", "cache_near_miss", "test", test_near_miss))
    return {"schema_version": 1, "source": "fixture", "embedding_profile_id": "fixture-ngram", "probe_max_distance": 0.2, "pairs": rows}


def _write(tmp_path, payload, name="cache-pairs.json"):
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_fit_picks_the_largest_dev_distance_below_the_nearest_near_miss():
    run = c.load_pairs_data(_synthetic())
    result = c.calibrate(run)
    profile = result.profile
    assert profile.embedding_profile_id == "fixture-ngram"
    assert profile.source == "calibrated"
    assert profile.max_distance == pytest.approx(0.06)
    assert profile.dev.near_miss_wrong_hit_rate == 0
    assert profile.dev.paraphrase_hit_rate == 1
    assert profile.dev.paraphrase_pairs == 6 and profile.dev.near_miss_pairs == 4
    assert profile.test.paraphrase_hit_rate == 0.5
    assert result.check_failures == []


def test_a_test_near_miss_below_the_threshold_fails_and_writes_source_default(tmp_path):
    run = c.load_pairs_data(_synthetic(test_near_miss=0.04))
    result = c.calibrate(run)
    assert result.profile.source == "default"
    assert result.profile.max_distance == c.DEFAULT_MAX_DISTANCE
    assert result.profile.test.near_miss_wrong_hit_rate == 1
    assert result.check_failures == ["test"]

    pairs = _write(tmp_path, _synthetic(test_near_miss=0.04))
    config = tmp_path / "semantic-cache.json"
    code = calibrate_cli.main(["cache", "--pairs", str(pairs), "--out", str(tmp_path / "out"), "--write", str(config), "--check"])
    assert code == 1
    written = SemanticCacheCalibration.model_validate_json(config.read_text(encoding="utf-8"))
    assert written.profiles[0].source == "default"
    assert written.profiles[0].test.near_miss_wrong_hit_rate == 1


def test_bypassed_pairs_count_as_misses_and_are_reported_by_reason():
    payload = _synthetic()
    payload["pairs"].append(_row("dev-para-tools", "cache_paraphrase", "dev", outcome="bypass", bypass_reason="relative_time"))
    result = c.calibrate(c.load_pairs_data(payload))
    assert result.profile.dev.paraphrase_pairs == 7
    assert result.profile.dev.paraphrase_hit_rate == pytest.approx(6 / 7)
    assert result.bypasses == {"dev": {"protected_tokens": 1, "relative_time": 1}, "test": {}}


def test_the_fit_never_reads_test_pairs():
    base = c.calibrate(c.load_pairs_data(_synthetic())).profile.max_distance
    payload = _synthetic()
    payload["pairs"] += [_row(f"test-extra-{i}", "cache_paraphrase", "test", 0.15 + 0.001 * i) for i in range(5)]
    assert c.fit_threshold(c.load_pairs_data(payload).pairs) == c.fit_threshold(c.load_pairs_data(_synthetic()).pairs)
    assert c.calibrate(c.load_pairs_data(payload)).profile.max_distance == base


def test_no_paraphrase_within_a_safe_distance_keeps_the_default():
    rows = [
        _row("dev-para-1", "cache_paraphrase", "dev", 0.12),
        _row("dev-near-1", "cache_near_miss", "dev", 0.05),
        _row("test-para-1", "cache_paraphrase", "test"),
        _row("test-near-1", "cache_near_miss", "test"),
    ]
    payload = {"schema_version": 1, "source": "fixture", "embedding_profile_id": "fixture-ngram", "probe_max_distance": 0.2, "pairs": rows}
    result = c.calibrate(c.load_pairs_data(payload))
    assert result.profile.source == "default"
    assert result.profile.max_distance == c.DEFAULT_MAX_DISTANCE
    assert result.check_failures == []


def test_check_gates_the_effective_threshold_of_the_config_file(tmp_path):
    pairs = _write(tmp_path, _synthetic(test_near_miss=0.045))
    config = tmp_path / "semantic-cache.json"
    config.write_text(json.dumps({"schema_version": 1, "profiles": []}), encoding="utf-8")
    assert calibrate_cli.main(["cache", "--pairs", str(pairs), "--out", str(tmp_path / "o1"), "--config", str(config), "--check"]) == 0
    assert calibrate_cli.main(
        ["cache", "--pairs", str(pairs), "--out", str(tmp_path / "o2"), "--config", str(config), "--check", "--default-distance", "0.05"]
    ) == 0
    assert calibrate_cli.main(
        ["cache", "--pairs", str(pairs), "--out", str(tmp_path / "o3"), "--config", str(config), "--check", "--default-distance", "0.1"]
    ) == 1


def test_fixture_pairs_never_calibrate_another_profile(tmp_path):
    pairs = _write(tmp_path, _synthetic())
    code = calibrate_cli.main(
        ["cache", "--pairs", str(pairs), "--out", str(tmp_path / "out"), "--profile", "openai-3-small-1536", "--write", str(tmp_path / "x.json")]
    )
    assert code == 2
    assert not (tmp_path / "x.json").exists()


def test_the_committed_file_validates_and_names_the_fixture_profile():
    calibration = SemanticCacheCalibration.model_validate_json(CONFIG.read_text(encoding="utf-8"))
    assert [profile.embedding_profile_id for profile in calibration.profiles] == ["fixture-ngram"]
