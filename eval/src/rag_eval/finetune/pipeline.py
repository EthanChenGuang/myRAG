"""python -m rag_eval.finetune run --fixture: the Python pipeline end to end on the fixture corpus (06.1-16)."""
from pathlib import Path

PIPELINE_REPORT_FILE = "pipeline-report.json"
BUNDLES_DIR = "bundles"
INPUTS_DIR = "inputs"
KIT_DIR = "kit"
MODEL_DIR = "model"
MINED_SAMPLE_FILE = "training-pairs.synthetic.ndjson"
STEPS: tuple[str, ...] = ()
REPRODUCIBLE_REPORTS: tuple[str, ...] = ()


def run_fixture_pipeline(out: Path, **_kwargs) -> int:
    Path(out).mkdir(parents=True, exist_ok=True)
    (Path(out) / PIPELINE_REPORT_FILE).write_text('{"run_id": "stub", "steps": [], "reports": {}}')
    return 1


def main(argv: list[str] | None = None) -> int:
    args = list(argv or [])
    out = Path(args[args.index("--out") + 1]) if "--out" in args else Path("out")
    return run_fixture_pipeline(out)
