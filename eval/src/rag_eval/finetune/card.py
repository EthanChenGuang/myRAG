"""python -m rag_eval.finetune card: the ModelVersionCard that `ft-models register` accepts (FT-08, FT-10; D-19, D-24, D-30).

card --bundle <run> --model <modeldir> --artifact-uri <uri> --version <ft-id> reads:
- offline-eval.json and offline-eval.provenance.json from `evaluate`: the report's sha256 must match the provenance, and the
  provenance must name this model directory (same file fingerprint), so a report cannot be attached to other weights;
- the base model and revision the report was scored against, which must still be a finetune.json base model; the card's
  query and document prompts are that base model's prompts;
- probe.json (ProbeSet, written by `train`; `--probe` overrides) computed with those prompts;
- training-report.json (TrainingRunReport; `--training-report` overrides) for training_config_sha256. When the model
  directory holds training-config.json (TrainingRunConfig; `--training-config` overrides), its sha256 must equal the
  report's, its dataset manifest hash the bundle's, and its base model and revision the evaluated ones;
- manifest.json: dataset_manifest_sha256 is its sha256, tenant_keys its tenants, scope `tenant` for a private dataset and
  `deployment` otherwise.

Status is `candidate` when the offline gate passed, else `rejected_offline` (the registry refuses those). The artifact URI is
validated by the contract (no userinfo, query string or fragment, D-30) and never printed. Output: card.json in the bundle
(or --out). Exit codes: 0 written; 2 usage or missing input; 1 integrity (modified or mismatched inputs).
"""
import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from pydantic import BaseModel, ValidationError
from rag_sidecar.contracts.finetune import (
    FinetuneConfig,
    ModelVersionCard,
    OfflineEvalReport,
    ProbeSet,
    TrainingRunConfig,
    TrainingRunReport,
)

from rag_eval.finetune import bundle
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.evaluate import (
    OFFLINE_REPORT_FILE,
    PROVENANCE_FILE,
    OfflineEvalProvenance,
    _write_json,
    model_fingerprint,
)

CARD_FILE = "card.json"
PROBE_FILE = "probe.json"
TRAINING_REPORT_FILE = "training-report.json"
TRAINING_CONFIG_FILE = "training-config.json"
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


class CardRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


@dataclass
class CardResult:
    exit_code: int
    card: ModelVersionCard | None = None


def _read(path: Path, model: type[BaseModel], missing: str, invalid: str) -> BaseModel:
    if not path.is_file():
        raise CardRefused(missing)
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except (ValidationError, ValueError, OSError):
        raise CardRefused(invalid, EXIT_FAILED) from None


def _build(fields: dict) -> ModelVersionCard:
    try:
        return ModelVersionCard(**fields)
    except ValidationError as exc:
        locations = {str(error["loc"][0]) for error in exc.errors() if error.get("loc")}
        if "artifact_uri" in locations:
            raise CardRefused("artifact_uri_invalid: no userinfo, query string or fragment (D-30)") from None
        if "id" in locations:
            raise CardRefused("version_invalid: --version must match ft-<lowercase id>") from None
        raise CardRefused("card_invalid", EXIT_FAILED) from None


def run_card(
    run_dir: Path,
    *,
    model_dir: Path,
    artifact_uri: str,
    version: str,
    probe_path: Path | None = None,
    training_report_path: Path | None = None,
    training_config_path: Path | None = None,
    out_path: Path | None = None,
    config: FinetuneConfig | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> CardResult:
    out = out or sys.stdout
    err = err or sys.stderr
    run_dir, model_dir = Path(run_dir), Path(model_dir)
    try:
        config = config or load_finetune_config()
        if not (run_dir / bundle.MANIFEST_FILE).is_file():
            raise CardRefused("bundle_not_found")
        if not model_dir.is_dir():
            raise CardRefused("model_not_found: --model must be the trained model directory")
        try:
            manifest = bundle.read_manifest(run_dir)
        except (ValueError, OSError):
            raise CardRefused("manifest_invalid", EXIT_FAILED) from None
        report_path = run_dir / OFFLINE_REPORT_FILE
        report = _read(
            report_path, OfflineEvalReport, "offline_report_missing: run evaluate first", "offline_report_invalid"
        )
        provenance = _read(
            run_dir / PROVENANCE_FILE,
            OfflineEvalProvenance,
            "offline_report_missing: run evaluate first",
            "offline_provenance_invalid",
        )
        assert isinstance(report, OfflineEvalReport) and isinstance(provenance, OfflineEvalProvenance)
        if provenance.report_sha256 != bundle.sha256_file(report_path):
            raise CardRefused("offline_report_modified: run evaluate again", EXIT_FAILED)
        if provenance.finetuned_kind != "model_dir" or provenance.finetuned_sha256 != model_fingerprint(model_dir):
            raise CardRefused("offline_report_other_model: evaluate this model directory first", EXIT_FAILED)
        spec = next(
            (
                m
                for m in config.base_models
                if m.id == provenance.base_model and m.revision == provenance.base_revision
            ),
            None,
        )
        if spec is None:
            raise CardRefused("base_model_unknown: the evaluated base model is not in finetune.json", EXIT_FAILED)

        probe = _read(probe_path or model_dir / PROBE_FILE, ProbeSet, "probe_missing", "probe_invalid")
        assert isinstance(probe, ProbeSet)
        if probe.query_prompt != spec.query_prompt or probe.document_prompt != spec.document_prompt:
            raise CardRefused("probe_prompt_mismatch: probe vectors were not computed with the card prompts", EXIT_FAILED)

        training = _read(
            training_report_path or model_dir / TRAINING_REPORT_FILE,
            TrainingRunReport,
            "training_report_missing",
            "training_report_invalid",
        )
        assert isinstance(training, TrainingRunReport)
        dataset_sha = bundle.sha256_file(run_dir / bundle.MANIFEST_FILE)
        config_path = training_config_path or model_dir / TRAINING_CONFIG_FILE
        if training_config_path is not None or config_path.is_file():
            run_config = _read(config_path, TrainingRunConfig, "training_config_missing", "training_config_invalid")
            assert isinstance(run_config, TrainingRunConfig)
            if bundle.sha256_file(config_path) != training.training_config_sha256:
                raise CardRefused("training_config_mismatch: the report names another training config", EXIT_FAILED)
            if run_config.dataset_manifest_sha256 != dataset_sha:
                raise CardRefused("dataset_manifest_mismatch: the model was trained on another bundle", EXIT_FAILED)
            if (run_config.base_model, run_config.base_revision) != (spec.id, spec.revision):
                raise CardRefused("base_model_mismatch: evaluate with the trained base model", EXIT_FAILED)

        card = _build(
            {
                "id": version,
                "base_model": spec.id,
                "base_revision": spec.revision,
                "dims": spec.dims,
                "scope": "tenant" if manifest.purpose == "private" else "deployment",
                "tenant_keys": list(manifest.tenant_keys),
                "dataset_manifest_sha256": dataset_sha,
                "training_config_sha256": training.training_config_sha256,
                "query_prompt": spec.query_prompt,
                "document_prompt": spec.document_prompt,
                "offline": report,
                "status": "candidate" if report.passed else "rejected_offline",
                "probe": probe,
                "artifact_uri": artifact_uri,
            }
        )
    except CardRefused as exc:
        print(f"[Finetune] card refused: {exc.code}", file=err)
        return CardResult(exc.exit_code)
    except (ValueError, OSError):
        print("[Finetune] card refused: config_invalid", file=err)
        return CardResult(EXIT_USAGE)

    target = Path(out_path) if out_path is not None else run_dir / CARD_FILE
    _write_json(target, card)
    reasons = "" if report.passed else " (" + ", ".join(report.reasons) + ")"
    print(
        f"[Finetune] card: {card.id} status {card.status}{reasons}, scope {card.scope}, {len(card.tenant_keys)} tenants, "
        f"base {card.base_model}; written to {target.name}",
        file=out,
    )
    return CardResult(EXIT_OK, card)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune card")
    parser.add_argument("--bundle", required=True, type=Path, help="run directory holding offline-eval.json")
    parser.add_argument("--model", required=True, type=Path, help="trained model directory")
    parser.add_argument("--artifact-uri", required=True, help="where the weights are stored (no credentials)")
    parser.add_argument("--version", required=True, help="model version id, ft-<lowercase id>")
    parser.add_argument("--probe", type=Path, default=None, help="probe.json (default <model>/probe.json)")
    parser.add_argument("--training-report", type=Path, default=None, help="default <model>/training-report.json")
    parser.add_argument("--training-config", type=Path, default=None, help="default <model>/training-config.json")
    parser.add_argument("--out", type=Path, default=None, help="card path (default <bundle>/card.json)")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(argv: list[str] | None = None, *, config: FinetuneConfig | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if config is None:
        try:
            config = load_finetune_config(args.config)
        except (ValueError, OSError):
            print("[Finetune] card refused: config_invalid", file=sys.stderr)
            return EXIT_USAGE
    return run_card(
        args.bundle,
        model_dir=args.model,
        artifact_uri=args.artifact_uri,
        version=args.version,
        probe_path=args.probe,
        training_report_path=args.training_report,
        training_config_path=args.training_config,
        out_path=args.out,
        config=config,
    ).exit_code
