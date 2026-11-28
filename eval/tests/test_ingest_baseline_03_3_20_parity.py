"""03.3 verification G9: the 03.3-20 re-record of the ingest baseline changed only corpus entries.

Plan 03.3-20 (commit 63c89813) re-recorded eval/baselines/fixture-ingest-baseline.json with the templated collection. The file it
replaced is kept as history/fixture-ingest-baseline.pre-03.3-20.json; the file it wrote is kept byte for byte as
history/fixture-ingest-baseline.pre-05.2.1-12.json (the next re-record's "before", train 38), pinned here by sha256. Joined on item id,
every item that existed before Phase 3.3 has the same value for every metric in every run, no item was removed, and every added item
is a templated-collection item. Only the corpus and golden identity fields and the run records moved.
"""

import hashlib
import json

from rag_eval.paths import REPO_ROOT

HISTORY = REPO_ROOT / "eval/baselines/history"
BEFORE = HISTORY / "fixture-ingest-baseline.pre-03.3-20.json"
# The baseline 63c89813 wrote (git show 63c89813:eval/baselines/fixture-ingest-baseline.json), sha256 of the bytes.
RECORDED = HISTORY / "fixture-ingest-baseline.pre-05.2.1-12.json"
RECORDED_SHA256 = "e30dde74be58ec8f9d8100471ad9a29a9a45ae3f55480eaa757a0d5a4e93e14f"
PRE_33_ITEMS = 417
ADDED_ITEMS = 83
ADDED_PREFIX = "ingest-tpl-"
# Fields a re-record that only adds corpus entries and golden items may change.
CORPUS_FIELDS = {"corpus_sha256", "golden_manifest_sha256", "golden_set_version", "golden_sha256", "run_config_hash", "runs", "slices", "items"}


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_recorded_history_file_is_the_03_3_20_record():
    assert hashlib.sha256(RECORDED.read_bytes()).hexdigest() == RECORDED_SHA256


def test_every_pre_3_3_item_has_zero_metric_difference():
    before = _load(BEFORE)["items"]
    after = _load(RECORDED)["items"]
    assert len(before) == PRE_33_ITEMS
    assert not set(before) - set(after), "no pre-3.3 item was removed"
    differences = []
    for item_id, metrics in before.items():
        assert set(after[item_id]) == set(metrics), item_id
        for metric, runs in metrics.items():
            other = after[item_id][metric]
            assert len(other) == len(runs), (item_id, metric)
            for run, (old, new) in enumerate(zip(runs, other)):
                if old is None or new is None:
                    if old is not new:
                        differences.append((item_id, metric, run, old, new))
                elif new - old != 0:
                    differences.append((item_id, metric, run, old, new))
    assert differences == []


def test_only_templated_items_were_added_and_only_corpus_fields_moved():
    before = _load(BEFORE)
    after = _load(RECORDED)
    added = sorted(set(after["items"]) - set(before["items"]))
    assert len(added) == ADDED_ITEMS
    assert all(item_id.startswith(ADDED_PREFIX) for item_id in added), [i for i in added if not i.startswith(ADDED_PREFIX)]
    moved = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
    assert moved <= CORPUS_FIELDS, moved - CORPUS_FIELDS
    for key in ("deployment_mode", "embedder_id", "embedder_version", "embedder_source_sha256", "request_options", "golden_filter", "gate_population", "schema_version"):
        assert before.get(key) == after.get(key), key
    assert before["corpus_sha256"] != after["corpus_sha256"]
