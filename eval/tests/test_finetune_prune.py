import os
from datetime import UTC, datetime, timedelta

from rag_sidecar.contracts.finetune import DatasetManifest

from rag_eval.finetune import bundle, cli, prune

TENANT_A = "o:00000000-0000-4000-8000-0000000000a1"
TENANT_B = "o:00000000-0000-4000-8000-0000000000b2"
NOW = datetime(2026, 11, 26, 12, 0, tzinfo=UTC)
SENTENCE = "a neutral synthetic sentence about entry seven"

TEXT_FILES = (
    "chunks.jsonl",
    "queries.raw.jsonl",
    "queries.kept.jsonl",
    "queries.test.kept.jsonl",
    "pairs.mined.jsonl",
    "train_ntuple.jsonl",
    "train_pairs.jsonl",
    "dev.jsonl",
    "vectors/o_x.ft-a-1024.f32",
    "vectors/o_x.ft-a-1024.rows.jsonl",
    "vectors/o_x.ft-a-1024.header.json",
    "cache/generate/ab.json",
    "kit/train_ntuple.jsonl",
    "kit/kit-manifest.json",
)
KEPT_FILES = (
    "manifest.json",
    "filter-report.json",
    "mining-report.json",
    "offline-eval.json",
    "offline-eval.provenance.json",
    "card.json",
)


def _bundle(root, run_id, *, tenants=(TENANT_A,), age_days=0):
    run_dir = bundle.new_run_dir(root, run_id)
    created = (NOW - timedelta(days=age_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle.write_manifest(
        run_dir,
        DatasetManifest(
            run_id=run_id,
            purpose="private" if len(tenants) == 1 else "deployment",
            split_rule="ft-sha256-first8hex-mod100-80-10-10",
            tenant_keys=sorted(tenants),
            counts={},
            files={},
            created_at=created,
        ),
    )
    for name in TEXT_FILES + KEPT_FILES[1:]:
        path = run_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(SENTENCE)
    stamp = (NOW - timedelta(days=age_days)).timestamp()
    for path in run_dir.rglob("*"):
        os.utime(path, (stamp, stamp))
    return run_dir


def _remaining(run_dir):
    return sorted(p.relative_to(run_dir).as_posix() for p in run_dir.rglob("*") if p.is_file())


def test_prune_old_bundle_loses_text_files_and_keeps_reports(tmp_path, capsys):
    old = _bundle(tmp_path, "run-old", age_days=40)
    young = _bundle(tmp_path, "run-young", age_days=5)
    before_young = _remaining(young)
    result = prune.run_prune(tmp_path, older_than_days=30, now=NOW)
    assert result.exit_code == 0
    assert _remaining(old) == sorted(KEPT_FILES)
    assert not (old / "vectors").exists() and not (old / "kit").exists() and not (old / "cache").exists()
    assert _remaining(young) == before_young
    assert result.deleted == {"run-old": sorted(TEXT_FILES)}
    out = capsys.readouterr().out
    assert "run-old" in out and f"{len(TEXT_FILES)} files" in out
    for name in ("chunks.jsonl", "vectors/o_x.ft-a-1024.f32", "kit/train_ntuple.jsonl"):
        assert name in out
    assert "run-young" not in out
    assert SENTENCE not in out


def test_prune_age_is_the_later_of_created_at_and_file_mtimes(tmp_path):
    run_dir = _bundle(tmp_path, "run-touched", age_days=40)
    recent = (NOW - timedelta(days=2)).timestamp()
    os.utime(run_dir / "dev.jsonl", (recent, recent))
    assert prune.run_prune(tmp_path, older_than_days=30, now=NOW).deleted == {}
    assert (run_dir / "chunks.jsonl").is_file()

    other = _bundle(tmp_path / "second", "run-new-manifest", age_days=40)
    manifest = bundle.read_manifest(other)
    bundle.write_manifest(other, manifest.model_copy(update={"created_at": "2026-11-25T00:00:00Z"}))
    stamp = (NOW - timedelta(days=40)).timestamp()
    os.utime(other / "manifest.json", (stamp, stamp))
    assert prune.run_prune(tmp_path / "second", older_than_days=30, now=NOW).deleted == {}


def test_prune_tenant_removes_bundles_listing_it_regardless_of_age(tmp_path, capsys):
    a_young = _bundle(tmp_path, "run-a", age_days=1)
    shared = _bundle(tmp_path, "run-ab", tenants=(TENANT_A, TENANT_B), age_days=2)
    b_only = _bundle(tmp_path, "run-b", tenants=(TENANT_B,), age_days=90)
    before_b = _remaining(b_only)
    result = prune.run_prune(tmp_path, tenant=TENANT_A, now=NOW)
    assert result.exit_code == 0
    assert set(result.deleted) == {"run-a", "run-ab"}
    assert _remaining(a_young) == sorted(KEPT_FILES)
    assert _remaining(shared) == sorted(KEPT_FILES)
    assert _remaining(b_only) == before_b
    assert TENANT_A not in capsys.readouterr().out


def test_prune_cli_defaults_and_refusals(tmp_path, capsys):
    _bundle(tmp_path, "run-old", age_days=31)
    _bundle(tmp_path, "run-edge", age_days=29)
    assert prune.main(["--root", str(tmp_path)], now=NOW) == 0
    out = capsys.readouterr().out
    assert "run-old" in out and "run-edge" not in out
    assert prune.main(["--root", str(tmp_path), "--tenant", "not a tenant"], now=NOW) == 2
    assert "tenant_invalid" in capsys.readouterr().err
    assert prune.main(["--root", str(tmp_path), "--older-than-days", "0"], now=NOW) == 2
    assert "older_than_days_invalid" in capsys.readouterr().err
    assert prune.main(["--root", str(tmp_path / "absent")], now=NOW) == 0
    assert "nothing to prune" in capsys.readouterr().out


def test_prune_skips_directories_without_a_valid_manifest(tmp_path, capsys):
    stray = tmp_path / "not-a-bundle"
    stray.mkdir()
    (stray / "chunks.jsonl").write_text(SENTENCE)
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "manifest.json").write_text("{}")
    (broken / "chunks.jsonl").write_text(SENTENCE)
    result = prune.run_prune(tmp_path, older_than_days=1, now=NOW + timedelta(days=400))
    assert result.deleted == {}
    assert (stray / "chunks.jsonl").is_file() and (broken / "chunks.jsonl").is_file()
    assert result.skipped == ["broken"]


def test_prune_command_is_dispatched():
    assert cli.COMMANDS["prune"] == "rag_eval.finetune.prune:main"
