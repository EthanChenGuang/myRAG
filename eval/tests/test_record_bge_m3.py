import importlib.util
import io
import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "eval" / "fixtures" / "embeddings"
SCRIPT = FIXTURE_DIR / "record_bge_m3.py"
TEXTS = FIXTURE_DIR / "bge-m3-texts.json"
REVISION = "5617a9f61b028005a4858fdac845db406aefb181"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


record = _load("record_bge_m3", SCRIPT)
generate = _load("generate_bge_m3_texts", FIXTURE_DIR / "generate_texts.py")


def _vector(seed: int) -> list[float]:
    return [math.sin(seed + index * 0.13) + 0.05 for index in range(1024)]


def _recording(path: Path, vectors: dict[str, list[float]], **overrides) -> Path:
    body = {
        "schema_version": 1,
        "model": "BAAI/bge-m3",
        "revision": REVISION,
        "mode": "hosted",
        "recorded_on": "2026-11-27",
        "texts_sha256": "a" * 64,
        "dims": 1024,
        "vectors": vectors,
        **overrides,
    }
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)


def test_tolerance_is_the_d26_definition():
    assert record.MIN_COSINE == 0.9999
    assert record.MAX_COMPONENT_DIFF == 1e-3
    assert record.REVISION == REVISION


def test_identical_recordings_compare_clean(tmp_path):
    vectors = {"en-short-1": _vector(1), "zh-short-1": _vector(2)}
    a = _recording(tmp_path / "a.json", vectors)
    b = _recording(tmp_path / "b.json", vectors, mode="sidecar")
    done = _run("--compare", str(a), str(b))
    assert done.returncode == 0, done.stdout + done.stderr
    assert "en-short-1" in done.stdout and "zh-short-1" in done.stdout
    assert "cosine=1.0000" in done.stdout


def test_scale_does_not_matter_because_vectors_are_normalized_first(tmp_path):
    a = _recording(tmp_path / "a.json", {"t": _vector(3)})
    b = _recording(tmp_path / "b.json", {"t": [7.5 * x for x in _vector(3)]})
    assert _run("--compare", str(a), str(b)).returncode == 0


def test_a_pair_beyond_the_tolerance_exits_non_zero(tmp_path):
    shifted = _vector(4)
    shifted[10] += 0.2
    a = _recording(tmp_path / "a.json", {"t": _vector(4), "u": _vector(5)})
    b = _recording(tmp_path / "b.json", {"t": shifted, "u": _vector(5)})
    done = _run("--compare", str(a), str(b))
    assert done.returncode == 1
    assert "BEYOND" in done.stdout


def test_one_component_beyond_1e3_fails_even_with_a_high_cosine():
    base = record.l2(_vector(6))
    other = list(base)
    other[0] += 0.0015
    cosine, diff = record.compare_vectors(base, other)
    assert cosine >= 0.9999
    assert diff > 1e-3
    assert not record.within_tolerance(cosine, diff)
    assert record.within_tolerance(0.9999, 1e-3)
    assert not record.within_tolerance(0.99989999, 1e-3)


def test_recordings_with_different_text_ids_are_refused(tmp_path):
    a = _recording(tmp_path / "a.json", {"t": _vector(1)})
    b = _recording(tmp_path / "b.json", {"u": _vector(1)})
    done = _run("--compare", str(a), str(b))
    assert done.returncode == 2
    assert "different text ids" in done.stdout


def test_recordings_of_another_revision_or_text_file_are_refused(tmp_path):
    a = _recording(tmp_path / "a.json", {"t": _vector(1)})
    assert _run("--compare", str(a), str(_recording(tmp_path / "b.json", {"t": _vector(1)}, revision="0" * 40))).returncode == 2
    assert _run("--compare", str(a), str(_recording(tmp_path / "c.json", {"t": _vector(1)}, texts_sha256="b" * 64))).returncode == 2


def test_a_missing_recording_is_refused(tmp_path):
    a = _recording(tmp_path / "a.json", {"t": _vector(1)})
    assert _run("--compare", str(a), str(tmp_path / "absent.json")).returncode == 2


def test_compare_never_prints_the_texts(tmp_path):
    texts = json.loads(TEXTS.read_text(encoding="utf-8"))["texts"]
    vectors = {entry["id"]: _vector(index) for index, entry in enumerate(texts)}
    a = _recording(tmp_path / "a.json", vectors)
    out = io.StringIO()
    assert record.compare(a, a, out=out) == 0
    printed = out.getvalue()
    for entry in texts:
        assert entry["text"][:20] not in printed


def test_the_module_imports_nothing_heavy():
    code = (
        "import importlib.util, sys;"
        f"spec = importlib.util.spec_from_file_location('r', {str(SCRIPT)!r});"
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m);"
        "heavy = {'torch', 'transformers', 'numpy', 'httpx', 'rag_sidecar', 'urllib.request'};"
        "print(sorted(heavy & set(sys.modules)))"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert done.stdout.strip() == "[]"


def test_record_embeds_each_text_in_its_own_call_and_keeps_no_key(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPINFRA_API_KEY", "placeholder-key-not-real-000")
    seen: list[str] = []

    def _embed(text: str) -> list[float]:
        seen.append(text)
        return _vector(len(seen))

    texts = tmp_path / "texts.json"
    texts.write_text(json.dumps({"texts": [{"id": "x1", "text": "one line"}, {"id": "x2", "text": "two line"}]}), encoding="utf-8")
    recording = record.record("hosted", texts, _embed)
    assert seen == ["one line", "two line"]
    assert set(recording["vectors"]) == {"x1", "x2"}
    assert recording["mode"] == "hosted"
    assert recording["revision"] == REVISION
    assert recording["texts_sha256"] == record.texts_sha256(texts)
    assert len(recording["recorded_on"]) == 10
    assert "placeholder-key" not in json.dumps(recording)


def test_record_refuses_a_vector_of_another_dimension(tmp_path):
    texts = tmp_path / "texts.json"
    texts.write_text(json.dumps({"texts": [{"id": "x1", "text": "one line"}]}), encoding="utf-8")
    with pytest.raises(ValueError):
        record.record("sidecar", texts, lambda _text: [1.0] * 768)


def test_hosted_mode_without_a_key_stops_before_any_call(tmp_path, monkeypatch):
    monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)
    with pytest.raises(SystemExit):
        record.main(["--mode", "hosted", "--out", str(tmp_path / "out.json")])
    assert not (tmp_path / "out.json").exists()


def test_fixture_texts_cover_zh_en_it_with_short_and_long_texts():
    texts = json.loads(TEXTS.read_text(encoding="utf-8"))["texts"]
    by_language: dict[str, list[dict]] = {}
    for entry in texts:
        by_language.setdefault(entry["language"], []).append(entry)
    assert sorted(by_language) == ["en", "it", "zh"]
    for entries in by_language.values():
        assert sum(1 for entry in entries if entry["kind"] == "short") >= 3
        assert sum(1 for entry in entries if entry["kind"] == "long") == 1
    assert len({entry["id"] for entry in texts}) == len(texts)


def test_long_texts_sit_just_under_the_app_input_limit():
    import tiktoken

    encoding = tiktoken.get_encoding("cl100k_base")
    for entry in json.loads(TEXTS.read_text(encoding="utf-8"))["texts"]:
        tokens = len(encoding.encode(entry["text"]))
        assert len(entry["text"]) <= 20_000
        assert tokens <= 4096
        if entry["kind"] == "long":
            assert tokens >= 3500 or len(entry["text"]) >= 19_000, entry["id"]


def test_fixture_texts_have_stable_bytes():
    import tiktoken

    encoding = tiktoken.get_encoding("cl100k_base")
    assert generate.render(lambda text: len(encoding.encode(text))) == TEXTS.read_text(encoding="utf-8")
