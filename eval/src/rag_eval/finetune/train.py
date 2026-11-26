"""python -m rag_eval.finetune train. Stub."""
from dataclasses import dataclass
from typing import Any

REPORT_FILE = "training-report.json"
PROBE_FILE = "probe.json"
CHECKPOINT_DIR = ".checkpoints"


@dataclass(frozen=True)
class TrainLibrary:
    training_arguments: Any
    no_duplicates: Any
    cached_mnrl: Any
    mnrl: Any
    gist: Any
    cached_gist: Any
    matryoshka: Any
    ir_evaluator: Any
    dataset: Any
    trainer: Any


@dataclass
class TrainResult:
    exit_code: int
    report: Any = None


def installed_versions():
    return {}


def check_signatures():
    return ["stub"]


def effective_recipe(recipe, loss=None, matryoshka=None):
    return recipe


def load_kit_data(kit_dir):
    return None


def build_trainer_args(**kwargs):
    return {"loss": {}, "args": None, "train_dataset": {}, "evaluator": None}


def run_train(kit_dir, out, **kwargs):
    return TrainResult(0)


def main(argv=None):
    return 0
