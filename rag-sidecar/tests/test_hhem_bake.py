import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from rag_sidecar.groundedness import bake as bake_module
from rag_sidecar.groundedness.bake import (
    FLAN_T5_FILES,
    FLAN_T5_MODEL_ID,
    FLAN_T5_REVISION,
    HHEM_FILES,
    HHEM_SAFETENSORS_SHA256,
    BakeError,
    bake,
    main,
)
from rag_sidecar.groundedness.local_hhem import HHEM_MODEL_ID
from rag_sidecar.settings import DEFAULT_HHEM_MODEL_REVISION

OTHER_COMMIT = "0" * 40


def _repo_dir(cache_dir: Path, repo_id: str) -> Path:
    return cache_dir / ("models--" + repo_id.replace("/", "--"))


class _FakeHub:
    def __init__(self, resolved: dict[str, str] | None = None, skip: set[str] | None = None):
        self.resolved = resolved or {}
        self.skip = skip or set()
        self.calls: list[dict] = []

    def __call__(self, repo_id, *, revision, allow_patterns, cache_dir):
        self.calls.append(
            {"repo_id": repo_id, "revision": revision, "allow_patterns": list(allow_patterns), "cache_dir": cache_dir}
        )
        commit = self.resolved.get(repo_id, revision if len(revision) == 40 else FLAN_T5_REVISION)
        repo = _repo_dir(Path(cache_dir), repo_id)
        snapshot = repo / "snapshots" / commit
        snapshot.mkdir(parents=True, exist_ok=True)
        (repo / "refs").mkdir(parents=True, exist_ok=True)
        (repo / "refs" / revision).write_text(commit, encoding="utf-8")
        for name in allow_patterns:
            if name in self.skip:
                continue
            (snapshot / name).write_bytes(f"{repo_id}/{name}".encode())
        return str(snapshot)


def _pinned_sha256(path: Path) -> str:
    repo_id = path.parents[2].name.removeprefix("models--").replace("--", "/")
    return bake_module.PINNED_SHA256[repo_id][path.name]


class _FakeLoader:
    def __init__(self, error: Exception | None = None):
        self.error = error
        self.calls: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error is not None:
            raise self.error
        return object()


@pytest.fixture()
def hf_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HHEM_MODEL_REVISION", raising=False)
    return tmp_path / "hf"


def test_pinned_constants_match_the_reviewed_artifacts():
    assert FLAN_T5_MODEL_ID == "google/flan-t5-base"
    assert FLAN_T5_REVISION == "7bcac572ce56db69c1ea7c8af255c5d7c9672fc2"
    assert HHEM_SAFETENSORS_SHA256 == "634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72"
    assert DEFAULT_HHEM_MODEL_REVISION == "de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8"
    assert FLAN_T5_FILES == (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "spiece.model",
    )
    assert set(HHEM_FILES) == {"config.json", "configuration_hhem_v2.py", "modeling_hhem_v2.py", "model.safetensors"}
    assert bake_module.PINNED_SHA256[HHEM_MODEL_ID]["model.safetensors"] == HHEM_SAFETENSORS_SHA256
    assert set(bake_module.PINNED_SHA256[FLAN_T5_MODEL_ID]) == set(FLAN_T5_FILES)
    assert set(bake_module.PINNED_SHA256[HHEM_MODEL_ID]) == {"configuration_hhem_v2.py", "modeling_hhem_v2.py", "model.safetensors"}


def test_bake_downloads_flan_then_hhem_with_pinned_revisions_and_file_lists(hf_home):
    hub = _FakeHub()
    loader = _FakeLoader()
    bake(download=hub, sha256=_pinned_sha256, load=loader)

    assert [call["repo_id"] for call in hub.calls] == [FLAN_T5_MODEL_ID, HHEM_MODEL_ID]
    flan, hhem = hub.calls
    assert flan["revision"] == "main"
    assert sorted(flan["allow_patterns"]) == sorted(FLAN_T5_FILES)
    assert hhem["revision"] == DEFAULT_HHEM_MODEL_REVISION
    assert sorted(hhem["allow_patterns"]) == sorted(HHEM_FILES)
    for call in hub.calls:
        assert Path(call["cache_dir"]) == hf_home / "hub"
        assert not any(name.endswith((".bin", ".h5", ".msgpack")) for name in call["allow_patterns"])
    assert "model.safetensors" not in flan["allow_patterns"]


def test_flan_main_at_another_commit_fails_naming_both_commits(hf_home):
    hub = _FakeHub(resolved={FLAN_T5_MODEL_ID: OTHER_COMMIT})
    loader = _FakeLoader()
    with pytest.raises(BakeError) as caught:
        bake(download=hub, sha256=_pinned_sha256, load=loader)
    assert caught.value.code != 0
    message = str(caught.value)
    assert FLAN_T5_REVISION in message and OTHER_COMMIT in message
    assert loader.calls == []


def test_flan_refs_main_pointing_elsewhere_fails(hf_home):
    hub = _FakeHub()
    loader = _FakeLoader()

    def download(repo_id, **kwargs):
        path = hub(repo_id, **kwargs)
        if repo_id == FLAN_T5_MODEL_ID:
            (_repo_dir(Path(kwargs["cache_dir"]), repo_id) / "refs" / "main").write_text(OTHER_COMMIT)
        return path

    with pytest.raises(BakeError) as caught:
        bake(download=download, sha256=_pinned_sha256, load=loader)
    assert OTHER_COMMIT in str(caught.value) and FLAN_T5_REVISION in str(caught.value)
    assert loader.calls == []


def test_hhem_snapshot_at_another_revision_fails(hf_home):
    hub = _FakeHub(resolved={HHEM_MODEL_ID: OTHER_COMMIT})
    loader = _FakeLoader()
    with pytest.raises(BakeError) as caught:
        bake(download=hub, sha256=_pinned_sha256, load=loader)
    assert OTHER_COMMIT in str(caught.value) and DEFAULT_HHEM_MODEL_REVISION in str(caught.value)
    assert loader.calls == []


def test_unreviewed_hhem_model_revision_setting_fails_before_download(hf_home, monkeypatch):
    monkeypatch.setenv("HHEM_MODEL_REVISION", OTHER_COMMIT)
    hub = _FakeHub()
    with pytest.raises(BakeError) as caught:
        bake(download=hub, sha256=_pinned_sha256, load=_FakeLoader())
    assert OTHER_COMMIT in str(caught.value) and DEFAULT_HHEM_MODEL_REVISION in str(caught.value)
    assert hub.calls == []


def test_safetensors_hash_mismatch_fails(hf_home):
    def sha256(path: Path) -> str:
        return "f" * 64 if path.name == "model.safetensors" else _pinned_sha256(path)

    loader = _FakeLoader()
    with pytest.raises(BakeError) as caught:
        bake(download=_FakeHub(), sha256=sha256, load=loader)
    assert caught.value.code != 0
    assert HHEM_SAFETENSORS_SHA256 in str(caught.value) and "f" * 64 in str(caught.value)
    assert loader.calls == []


@pytest.mark.parametrize("name", ["modeling_hhem_v2.py", "configuration_hhem_v2.py", "tokenizer.json"])
def test_remote_code_or_tokenizer_hash_mismatch_fails(hf_home, name):
    def sha256(path: Path) -> str:
        return "e" * 64 if path.name == name else _pinned_sha256(path)

    loader = _FakeLoader()
    with pytest.raises(BakeError):
        bake(download=_FakeHub(), sha256=sha256, load=loader)
    assert loader.calls == []


def test_missing_downloaded_file_fails(hf_home):
    loader = _FakeLoader()
    with pytest.raises(BakeError) as caught:
        bake(download=_FakeHub(skip={"tokenizer.json"}), sha256=_pinned_sha256, load=loader)
    assert "tokenizer.json" in str(caught.value)
    assert loader.calls == []


def test_passing_checks_load_once_offline_at_the_pinned_revision(hf_home):
    loader = _FakeLoader()
    bake(download=_FakeHub(), sha256=_pinned_sha256, load=loader)
    assert len(loader.calls) == 1
    args, kwargs = loader.calls[0]
    assert args == (HHEM_MODEL_ID,)
    assert kwargs == {"revision": DEFAULT_HHEM_MODEL_REVISION, "trust_remote_code": True, "local_files_only": True}


def test_missing_tokenizer_dependency_names_the_sentencepiece_decision(hf_home):
    loader = _FakeLoader(ImportError("T5Tokenizer requires the SentencePiece library but it was not found"))
    with pytest.raises(BakeError) as caught:
        bake(download=_FakeHub(), sha256=_pinned_sha256, load=loader)
    message = str(caught.value)
    assert caught.value.code != 0
    assert "sentencepiece" in message.lower()
    assert "05-05" in message
    assert "rejected" in message


def test_other_load_error_fails_without_the_sentencepiece_note(hf_home):
    loader = _FakeLoader(OSError("couldn't connect to huggingface.co"))
    with pytest.raises(BakeError) as caught:
        bake(download=_FakeHub(), sha256=_pinned_sha256, load=loader)
    assert "offline load" in str(caught.value)
    assert "05-05" not in str(caught.value)


def test_bake_requires_hf_home(monkeypatch):
    monkeypatch.delenv("HF_HOME", raising=False)
    hub = _FakeHub()
    with pytest.raises(BakeError) as caught:
        bake(download=hub, sha256=_pinned_sha256, load=_FakeLoader())
    assert "HF_HOME" in str(caught.value)
    assert hub.calls == []


def test_main_returns_non_zero_on_failure(hf_home, capsys):
    hub = _FakeHub(resolved={FLAN_T5_MODEL_ID: OTHER_COMMIT})
    assert main([], download=hub, sha256=_pinned_sha256, load=_FakeLoader()) == 1
    assert OTHER_COMMIT in capsys.readouterr().err


def test_main_returns_zero_on_success(hf_home):
    assert main([], download=_FakeHub(), sha256=_pinned_sha256, load=_FakeLoader()) == 0


def test_default_sha256_streams_the_file(tmp_path):
    path = tmp_path / "blob"
    path.write_bytes(b"x" * 3_000_000)
    assert bake_module.file_sha256(path) == hashlib.sha256(b"x" * 3_000_000).hexdigest()


def test_offline_check_subprocess_runs_with_offline_environment(monkeypatch):
    seen: dict = {}

    def run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(bake_module.subprocess, "run", run)
    bake_module.offline_load(HHEM_MODEL_ID, revision=DEFAULT_HHEM_MODEL_REVISION, trust_remote_code=True, local_files_only=True)
    assert seen["env"]["HF_HUB_OFFLINE"] == "1"
    assert seen["env"]["TRANSFORMERS_OFFLINE"] == "1"
    assert "rag_sidecar.groundedness.bake" in seen["cmd"]
    assert DEFAULT_HHEM_MODEL_REVISION in seen["cmd"]


def test_offline_check_subprocess_failure_carries_the_child_error(monkeypatch):
    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, "", "ImportError: requires the SentencePiece library")

    monkeypatch.setattr(bake_module.subprocess, "run", run)
    with pytest.raises(RuntimeError) as caught:
        bake_module.offline_load(HHEM_MODEL_ID, revision=DEFAULT_HHEM_MODEL_REVISION, trust_remote_code=True, local_files_only=True)
    assert "SentencePiece" in str(caught.value)


def test_importing_bake_does_not_import_heavy_modules(tmp_path):
    code = (
        "import sys\n"
        "import rag_sidecar.groundedness.bake\n"
        "print(*(name in sys.modules for name in ('torch', 'transformers', 'huggingface_hub')))\n"
    )
    env = {**os.environ, "HF_HOME": str(tmp_path)}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, check=True)
    assert out.stdout.split() == ["False", "False", "False"]
