import hashlib
import json
import os
import stat
import subprocess
import sys

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.finetune import ExportedChunk

from rag_eval.finetune import bundle, cli, textnorm
from rag_eval.paths import REPO_ROOT

DOC_A = "00000000-0000-4000-8000-00000000000a"


def _chunk(**overrides) -> dict:
    row = {
        "tenant_key": "s:default",
        "document_id": DOC_A,
        "chunk_id": "chunk-1",
        "chunk_index": 0,
        "content_hash": hashlib.sha256(b"x").hexdigest(),
        "language": "en",
        "split": "train",
        "text": "A neutral synthetic sentence.",
        "token_count": 5,
        "is_golden_test_evidence": False,
    }
    row.update(overrides)
    return row


# --- cli --------------------------------------------------------------------------------------------------------


def test_cli_table_names_every_d03_python_command():
    assert cli.COMMANDS == {
        "export": "rag_eval.finetune.export:main",
        "generate": "rag_eval.finetune.generate:main",
        "filter": "rag_eval.finetune.filters:main",
        "import-mined": "rag_eval.finetune.mined:main",
        "mine": "rag_eval.finetune.miner:main",
        "kit": "rag_eval.finetune.kit:main",
        "train": "rag_eval.finetune.train:main",
        "evaluate": "rag_eval.finetune.evaluate:main",
        "card": "rag_eval.finetune.card:main",
        "prune": "rag_eval.finetune.prune:main",
        "run": "rag_eval.finetune.pipeline:main",
    }


def test_cli_unknown_command_exits_2_with_usage(capsys):
    assert cli.main(["nonexistent"]) == 2
    err = capsys.readouterr().err
    assert "usage" in err
    assert "export" in err


def test_cli_no_command_exits_2(capsys):
    assert cli.main([]) == 2
    assert "usage" in capsys.readouterr().err


def test_cli_missing_module_exits_2_not_available(capsys, monkeypatch):
    monkeypatch.setitem(cli.COMMANDS, "train", "rag_eval.finetune._no_such_module_for_test:main")
    assert cli.main(["train"]) == 2
    assert "not available in this build" in capsys.readouterr().err


def test_cli_does_not_mask_a_missing_dependency_inside_an_existing_module(tmp_path, monkeypatch):
    pkg = tmp_path / "ft_cli_probe_pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "broken.py").write_text("import ft_cli_probe_missing_dependency\n\ndef main(argv):\n    return 0\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setitem(cli.COMMANDS, "train", "ft_cli_probe_pkg.broken:main")
    with pytest.raises(ModuleNotFoundError):
        cli.main(["train"])


def test_cli_passes_remaining_arguments_and_returns_the_exit_code(tmp_path, monkeypatch):
    pkg = tmp_path / "ft_cli_probe_ok"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "cmd.py").write_text("SEEN = []\n\ndef main(argv):\n    SEEN.append(list(argv))\n    return 7\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setitem(cli.COMMANDS, "kit", "ft_cli_probe_ok.cmd:main")
    assert cli.main(["kit", "--x", "1"]) == 7
    import ft_cli_probe_ok.cmd as probe

    assert probe.SEEN == [["--x", "1"]]


def test_cli_module_entry_point_train_not_available_in_this_build():
    result = subprocess.run(
        [sys.executable, "-m", "rag_eval.finetune", "train"], capture_output=True, text=True, cwd=REPO_ROOT / "eval"
    )
    assert result.returncode == 2
    assert "not available in this build" in result.stderr


def test_cli_module_entry_point_unknown_command():
    result = subprocess.run(
        [sys.executable, "-m", "rag_eval.finetune", "nonexistent"], capture_output=True, text=True, cwd=REPO_ROOT / "eval"
    )
    assert result.returncode == 2
    assert "usage" in result.stderr


# --- textnorm ---------------------------------------------------------------------------------------------------


def test_textnorm_normalize_nfkc_casefold_strips_space_and_punctuation():
    assert textnorm.normalize("Ｈello, 世界！ ") == "hello世界"
    assert textnorm.normalize("  What is\tthe  PERIOD?\n") == "whatistheperiod"
    assert textnorm.normalize("") == ""


def test_textnorm_char_ngrams():
    assert textnorm.char_ngrams("abcd", 3) == {"abc", "bcd"}
    assert textnorm.char_ngrams("ab", 3) == {"ab"}
    assert textnorm.char_ngrams("", 3) == set()


def test_textnorm_jaccard_and_containment():
    a, b = {"abc", "bcd"}, {"bcd", "cde"}
    assert textnorm.jaccard(a, b) == pytest.approx(1 / 3)
    assert textnorm.jaccard(a, a) == 1.0
    assert textnorm.jaccard(set(), set()) == 0.0
    assert textnorm.containment({"abc"}, a) == 1.0
    assert textnorm.containment(a, {"abc"}) == 0.5
    assert textnorm.containment(set(), a) == 0.0


# --- bundle -----------------------------------------------------------------------------------------------------


def test_bundle_new_run_dir_is_0700_and_refuses_an_existing_run(tmp_path):
    run_dir = bundle.new_run_dir(tmp_path / "out", "run-1")
    assert run_dir == tmp_path / "out" / "run-1"
    assert run_dir.is_dir()
    assert stat.S_IMODE(run_dir.stat().st_mode) == 0o700
    with pytest.raises(FileExistsError):
        bundle.new_run_dir(tmp_path / "out", "run-1")


def test_bundle_new_run_dir_refuses_a_bad_run_id(tmp_path):
    with pytest.raises(ValueError):
        bundle.new_run_dir(tmp_path, "../escape")


def test_bundle_write_jsonl_validates_and_round_trips(tmp_path):
    path = tmp_path / "chunks.jsonl"
    digest = bundle.write_jsonl(path, [_chunk(), ExportedChunk.model_validate(_chunk(chunk_id="chunk-2"))], ExportedChunk)
    assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
    rows = bundle.read_jsonl(path, ExportedChunk)
    assert [row.chunk_id for row in rows] == ["chunk-1", "chunk-2"]
    assert json.loads(path.read_text().splitlines()[0])["tenant_key"] == "s:default"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_bundle_write_jsonl_is_atomic_on_an_invalid_row(tmp_path):
    path = tmp_path / "chunks.jsonl"
    bundle.write_jsonl(path, [_chunk()], ExportedChunk)
    before = path.read_bytes()
    with pytest.raises(ValidationError):
        bundle.write_jsonl(path, [_chunk(chunk_id="ok"), _chunk(split="nope")], ExportedChunk)
    assert path.read_bytes() == before
    assert sorted(os.listdir(tmp_path)) == ["chunks.jsonl"]


def test_bundle_write_jsonl_refuses_a_row_of_another_model(tmp_path):
    from rag_sidecar.contracts.finetune import RetentionConfig

    with pytest.raises(TypeError):
        bundle.write_jsonl(tmp_path / "x.jsonl", [RetentionConfig(retention_days=3)], ExportedChunk)
