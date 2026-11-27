import json
import subprocess
from pathlib import Path

import pytest
from test_report_runner import QUOTE, _item, _manifest, _trace

from rag_eval.draft import writer
from rag_eval.golden_io import golden_sha256, write_golden
from rag_eval.metrics import score_items
from rag_eval.report import build_report, write_report
from rag_eval.runner import main

HEADING = "## Production-weighted score (report only)"
STRATA = {
    "items": [
        {"item_id": "en-general-001", "cluster_id": "c-01", "language": "en"},
        {"item_id": "en-general-002", "cluster_id": "c-01", "language": "en"},
        {"item_id": "en-general-003", "cluster_id": "c-02", "language": "en"},
    ]
}
SHARES = {"shares": {"c-01": 0.6, "c-02": 0.2, "c-03": 0.2}}


@pytest.fixture
def private_root(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    private = repo / "eval" / "golden" / "private"
    private.mkdir(parents=True)
    (repo / ".gitignore").write_text("eval/golden/private/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    monkeypatch.setattr(writer, "REPO_ROOT", repo)
    monkeypatch.setattr(writer, "PRIVATE_DIR", private)
    return private


def _golden():
    return [
        _item(f"en-general-00{n}", "en", answerable=True).model_copy(update={"provenance": "production"}) for n in (1, 2, 3)
    ]


def _traces():
    hit = [("doc.en.md", f"intro {QUOTE} outro")]
    return [_trace("en-general-001", hit), _trace("en-general-002", [("doc.en.md", "unrelated text")]), _trace("en-general-003", hit)]


def _report():
    golden = _golden()
    return build_report(_manifest(), score_items(_traces(), golden), golden)


def _set_dir(root: Path, *, strata: bool = True, shares: bool = True) -> Path:
    set_dir = root / "domain" / "tenant-a"
    set_dir.mkdir(parents=True)
    write_golden(set_dir / "golden.jsonl", _golden())
    if strata:
        (set_dir / "strata.json").write_text(json.dumps(STRATA), encoding="utf-8")
    if shares:
        (set_dir / "production-shares.json").write_text(json.dumps(SHARES), encoding="utf-8")
    return set_dir


def test_real_set_report_shows_unweighted_weighted_and_uncovered_share(private_root, tmp_path):
    report = _report()
    _, md_path = write_report(report, tmp_path / "out", set_dir=_set_dir(private_root))
    md = md_path.read_text(encoding="utf-8")
    assert HEADING in md
    section = md[md.index(HEADING) :]
    assert "Unweighted recall@5 (gated): 0.667" in section
    assert "Production-weighted recall@5 (report only): 0.625" in section
    assert "Production share with no test item: 0.200" in section


def test_weighted_numbers_stay_out_of_report_json(private_root, tmp_path):
    report = _report()
    plain_json, _ = write_report(report, tmp_path / "plain")
    weighted_json, _ = write_report(report, tmp_path / "weighted", set_dir=_set_dir(private_root))
    assert plain_json.read_bytes() == weighted_json.read_bytes()


def test_fixture_report_is_byte_identical(private_root, tmp_path):
    report = _report()
    _, baseline = write_report(report, tmp_path / "baseline")
    public = tmp_path / "public-set"
    public.mkdir()
    (public / "strata.json").write_text(json.dumps(STRATA), encoding="utf-8")
    (public / "production-shares.json").write_text(json.dumps(SHARES), encoding="utf-8")
    _, with_public = write_report(report, tmp_path / "public", set_dir=public)
    assert baseline.read_bytes() == with_public.read_bytes()
    assert HEADING not in baseline.read_text(encoding="utf-8")


@pytest.mark.parametrize("missing", ["strata", "shares"])
def test_a_private_set_without_both_files_renders_no_weighted_section(private_root, tmp_path, missing):
    report = _report()
    _, baseline = write_report(report, tmp_path / "baseline")
    set_dir = _set_dir(private_root, strata=missing != "strata", shares=missing != "shares")
    _, md_path = write_report(report, tmp_path / "out", set_dir=set_dir)
    assert md_path.read_bytes() == baseline.read_bytes()


def test_score_cli_on_a_private_set_renders_the_weighted_section(private_root, tmp_path):
    set_dir = _set_dir(private_root)
    golden_path = set_dir / "golden.jsonl"
    traces_path = tmp_path / "traces.jsonl"
    traces_path.write_text(
        "".join(json.dumps(t.model_dump(mode="json"), sort_keys=True) + "\n" for t in _traces()), encoding="utf-8"
    )
    manifest_path = tmp_path / "run.json"
    manifest = _manifest(golden_sha256(golden_path)).model_copy(update={"item_count": 3})
    manifest_path.write_text(manifest.model_dump_json(), encoding="utf-8")
    out = tmp_path / "out"
    args = ["score", "--traces", str(traces_path), "--golden", str(golden_path), "--manifest", str(manifest_path), "--out", str(out)]
    assert main(args) == 0
    md = (out / "report.md").read_text(encoding="utf-8")
    assert HEADING in md
    assert "Production-weighted recall@5 (report only): 0.625" in md
