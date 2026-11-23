import inspect
import json
import os
from pathlib import Path

import pytest

from rag_sidecar import export_schemas
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS, SAMPLES_PATH, SCHEMAS_DIR, export_all

REPO_ROOT = Path(__file__).resolve().parents[2]


def _contains_self_ref(node, title):
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref == f"#/$defs/{title}":
            return True
        return any(_contains_self_ref(value, title) for value in node.values())
    if isinstance(node, list):
        return any(_contains_self_ref(value, title) for value in node)
    return False


def _snapshot(directory: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in sorted(directory.iterdir())}


def test_export_twice_is_byte_identical_and_removes_stale_files(tmp_path):
    out_dir = tmp_path / "schemas"
    samples_path = tmp_path / "fixtures" / "samples.json"
    export_all(out_dir, samples_path)
    first = _snapshot(out_dir)
    first_samples = samples_path.read_bytes()

    (out_dir / "Removed.schema.json").write_text("{}\n", encoding="utf-8")
    export_all(out_dir, samples_path)

    assert _snapshot(out_dir) == first
    assert samples_path.read_bytes() == first_samples
    assert "Removed.schema.json" not in _snapshot(out_dir)
    assert sorted(path.name for path in out_dir.iterdir()) == sorted(
        f"{model.__name__}.schema.json" for model, _ in CONTRACTS
    )
    assert list(samples_path.parent.glob("*.tmp")) == []


def test_every_model_has_one_schema_one_sample_and_no_self_ref(tmp_path):
    out_dir = tmp_path / "schemas"
    samples_path = tmp_path / "samples.json"
    export_all(out_dir, samples_path)
    samples = json.loads(samples_path.read_text(encoding="utf-8"))

    names = [model.__name__ for model, _ in CONTRACTS]
    assert len(names) == len(set(names))
    assert sorted(samples["samples"]) == sorted(names)
    for model, _mode in CONTRACTS:
        schema = json.loads((out_dir / f"{model.__name__}.schema.json").read_text(encoding="utf-8"))
        assert schema["title"] == model.__name__
        assert not _contains_self_ref(schema, model.__name__)
        validated = model.model_validate(samples["samples"][model.__name__])
        assert validated.model_dump(mode="json") == samples["samples"][model.__name__]


def test_null_variants_round_trip_through_pydantic():
    built = build_samples()
    by_name = {model.__name__: model for model, _ in CONTRACTS}
    assert {entry["model"] for entry in built["variants"].values()} <= set(by_name)

    trace = by_name["RagTrace"].model_validate(built["variants"]["RagTrace:answer_null"]["value"])
    assert trace.answer is None
    assert trace.model_dump(mode="json")["answer"] is None

    item = by_name["GoldenItem"].model_validate(built["variants"]["GoldenItem:no_answer_null_expected"]["value"])
    assert item.expected_answer is None and item.answerable is False

    request = by_name["RagRunRequest"].model_validate(built["variants"]["RagRunRequest:query_only"]["value"])
    assert request.rag_mode == "strict" and request.include_answer is False and request.conversation == []


def test_committed_samples_match_a_fresh_build():
    committed = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(build_samples()))
    text = SAMPLES_PATH.read_text(encoding="utf-8")
    assert text == json.dumps(committed, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def test_default_paths_derive_from_the_repository_not_the_working_directory(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    defaults = inspect.signature(export_all).parameters
    assert defaults["out_dir"].default == REPO_ROOT / "rag-sidecar" / "schemas" == SCHEMAS_DIR
    assert defaults["samples_path"].default == REPO_ROOT / "tests" / "fixtures" / "contracts" / "samples.json"
    assert SCHEMAS_DIR.is_absolute() and SAMPLES_PATH.is_absolute()


def test_interrupted_write_leaves_existing_files_and_no_temp_file(tmp_path, monkeypatch):
    out_dir = tmp_path / "schemas"
    samples_path = tmp_path / "samples.json"
    export_all(out_dir, samples_path)
    before = _snapshot(out_dir)
    before_samples = samples_path.read_bytes()

    def failing_replace(src, dst):
        raise OSError("simulated interruption")

    monkeypatch.setattr(export_schemas.os, "replace", failing_replace)
    with pytest.raises(OSError):
        export_all(out_dir, samples_path)
    monkeypatch.undo()

    assert _snapshot(out_dir) == before
    assert samples_path.read_bytes() == before_samples
    assert [name for name in os.listdir(out_dir) if name.endswith(".tmp")] == []
    assert [name for name in os.listdir(tmp_path) if name.endswith(".tmp")] == []
