"""python -m rag_eval.finetune train: fine-tune the base model from a verified training kit (FT-07; D-15..D-18, D-24).

`train --kit <kitdir> --out <modeldir> [--loss cached_mnrl|mnrl|gist|cached_gist] [--matryoshka] [--device cpu|cuda|mps]`

1. verify_kit: refuses a kit with any test file or row (kit_contains_test), unlisted or missing files and changed sha256s.
2. Refuses a host whose torch / transformers / sentence-transformers / datasets differ from the kit's pinned versions (the
   local "+cu..." / "+cpu" suffix of a build is ignored), and a base model whose dimension is not the slot's 1024.
3. Loads the base model at the pinned revision with the card prompts and trains per D-15: CachedMultipleNegativesRankingLoss
   (mini_batch_size from the recipe) on the n-tuple and the pairs dataset, BatchSamplers.NO_DUPLICATES, the recipe's batch
   size, learning rate, warmup ratio and epochs, bf16 only when the GPU supports it, the recipe seed; dev
   InformationRetrievalEvaluator every eval_steps with load_best_model_at_end on dev cosine nDCG@10. `--loss gist` /
   `cached_gist` use a second copy of the base model as guide; `--matryoshka` wraps the loss with the recipe's dims.
4. Writes into <modeldir>: the model, training-config.json (the effective TrainingRunConfig), training-report.json
   (TrainingRunReport; training_config_sha256 is the sha256 of training-config.json) and probe.json (ProbeSet: the three
   fixed probe texts embedded with the trained model and the query prompt, unit length).

Names and parameters are those of sentence-transformers 6.2.0 (check_signatures verifies them against the installed
library). Exit codes: 0 done, 1 kit integrity, 2 usage or host mismatch, 3 training failed. Output carries ids, counts and
codes only (D-31).
"""

import argparse
import hashlib
import importlib.metadata
import inspect
import os
import shutil
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

import numpy as np
from rag_sidecar.contracts.finetune import (
    FINETUNE_DIMS,
    PROBE_TEXTS,
    BaseModelSpec,
    FinetunePair,
    ProbeSet,
    TrainingRecipe,
    TrainingRunReport,
)

from rag_eval.finetune import bundle, kit
from rag_eval.finetune.kit import KitCorpusChunk, KitRefused
from rag_eval.finetune.miner import DEV_FILE, TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE

REPORT_FILE = "training-report.json"
PROBE_FILE = "probe.json"
CHECKPOINT_DIR = ".checkpoints"
EVALUATOR_NAME = "dev"
BEST_METRIC = f"eval_{EVALUATOR_NAME}_cosine_ndcg@10"
LOSS_CHOICES = ("cached_mnrl", "mnrl", "gist", "cached_gist")
FINETUNE_EXTRA_HINT = "install the finetune extra: uv sync --directory eval --extra finetune"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_TRAINING = 3

# Every keyword build_trainer_args passes, per callable; check_signatures compares them with the installed library.
USED_PARAMETERS: dict[str, tuple[str, ...]] = {
    "training_arguments": (
        "output_dir",
        "num_train_epochs",
        "max_steps",
        "per_device_train_batch_size",
        "per_device_eval_batch_size",
        "learning_rate",
        "warmup_ratio",
        "bf16",
        "batch_sampler",
        "eval_strategy",
        "eval_steps",
        "save_strategy",
        "save_steps",
        "save_total_limit",
        "load_best_model_at_end",
        "metric_for_best_model",
        "greater_is_better",
        "logging_steps",
        "seed",
        "data_seed",
        "prompts",
        "report_to",
        "use_cpu",
        "disable_tqdm",
    ),
    "cached_mnrl": ("model", "mini_batch_size"),
    "mnrl": ("model",),
    "gist": ("model", "guide"),
    "cached_gist": ("model", "guide", "mini_batch_size"),
    "matryoshka": ("model", "loss", "matryoshka_dims"),
    "ir_evaluator": (
        "queries",
        "corpus",
        "relevant_docs",
        "name",
        "query_prompt",
        "corpus_prompt",
        "main_score_function",
        "batch_size",
        "write_csv",
        "show_progress_bar",
    ),
    "trainer": ("model", "args", "train_dataset", "loss", "evaluator"),
}


class TrainRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE, hint: str | None = None):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.hint = hint

    def message(self) -> str:
        return f"{self.code}: {self.hint}" if self.hint else self.code


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


def load_library() -> TrainLibrary:
    """The sentence-transformers 6.2.0 names under their 6.x module paths (printed with inspect.signature in 06.1-12)."""
    try:
        from datasets import Dataset
        from sentence_transformers.sentence_transformer.evaluation import (
            InformationRetrievalEvaluator,
        )
        from sentence_transformers.sentence_transformer.losses import (
            CachedGISTEmbedLoss,
            CachedMultipleNegativesRankingLoss,
            GISTEmbedLoss,
            MatryoshkaLoss,
            MultipleNegativesRankingLoss,
        )
        from sentence_transformers.sentence_transformer.trainer import (
            SentenceTransformerTrainer,
        )
        from sentence_transformers.sentence_transformer.training_args import (
            BatchSamplers,
            SentenceTransformerTrainingArguments,
        )
    except ImportError as exc:
        raise TrainRefused("finetune_extra_missing", EXIT_USAGE, FINETUNE_EXTRA_HINT) from exc
    return TrainLibrary(
        training_arguments=SentenceTransformerTrainingArguments,
        no_duplicates=BatchSamplers.NO_DUPLICATES,
        cached_mnrl=CachedMultipleNegativesRankingLoss,
        mnrl=MultipleNegativesRankingLoss,
        gist=GISTEmbedLoss,
        cached_gist=CachedGISTEmbedLoss,
        matryoshka=MatryoshkaLoss,
        ir_evaluator=InformationRetrievalEvaluator,
        dataset=Dataset,
        trainer=SentenceTransformerTrainer,
    )


def check_signatures(lib: TrainLibrary | None = None) -> list[str]:
    """`callable.parameter` for every keyword this module passes that the installed library does not accept."""
    lib = lib or load_library()
    missing: list[str] = []
    for attr, names in USED_PARAMETERS.items():
        parameters = inspect.signature(getattr(lib, attr)).parameters
        missing += [f"{attr}.{name}" for name in names if name not in parameters]
    return missing


def installed_versions() -> dict[str, str]:
    out: dict[str, str] = {}
    for field_name, package in kit.LOCK_PACKAGES.items():
        try:
            out[field_name] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            raise TrainRefused("finetune_extra_missing", EXIT_USAGE, FINETUNE_EXTRA_HINT) from None
    return out


def _public(version: str) -> str:
    return version.split("+", 1)[0]


def check_versions(expected: Mapping[str, str], installed: Mapping[str, str]) -> None:
    differing = sorted(name for name in expected if _public(expected[name]) != _public(installed.get(name, "")))
    if differing:
        raise TrainRefused(
            "library_versions_differ",
            EXIT_USAGE,
            f"{','.join(differing)} differ from the kit; use the image built from eval/finetune/Dockerfile.train",
        )


def effective_recipe(recipe: TrainingRecipe, *, loss: str | None = None, matryoshka: bool | None = None) -> TrainingRecipe:
    """The kit recipe with the CLI's loss and Matryoshka choices applied; the result is what training-config.json records."""
    update: dict[str, Any] = {}
    if loss is not None:
        if loss not in LOSS_CHOICES:
            raise TrainRefused("loss_unknown")
        if loss in ("gist", "cached_gist"):
            update["gist"] = recipe.gist.model_copy(update={"enabled": True, "cached": loss == "cached_gist"})
        else:
            update["gist"] = recipe.gist.model_copy(update={"enabled": False})
            update["loss"] = "CachedMultipleNegativesRankingLoss" if loss == "cached_mnrl" else "MultipleNegativesRankingLoss"
    if matryoshka is not None:
        update["matryoshka"] = recipe.matryoshka.model_copy(update={"enabled": matryoshka})
    return recipe.model_copy(update=update) if update else recipe


@dataclass
class KitData:
    ntuple: list[FinetunePair] = field(default_factory=list)
    pairs: list[FinetunePair] = field(default_factory=list)
    dev: list[FinetunePair] = field(default_factory=list)
    corpus: list[KitCorpusChunk] = field(default_factory=list)


def _repeat(rows: Sequence[FinetunePair]) -> list[FinetunePair]:
    """Mined pairs carry weight 2 (D-08): the weight is applied by repetition."""
    return [pair for pair in rows for _ in range(pair.weight)]


def load_kit_data(kit_dir: Path) -> KitData:
    kit_dir = Path(kit_dir)
    return KitData(
        ntuple=_repeat(bundle.read_jsonl(kit_dir / TRAIN_NTUPLE_FILE, FinetunePair)),
        pairs=_repeat(bundle.read_jsonl(kit_dir / TRAIN_PAIRS_FILE, FinetunePair)),
        dev=bundle.read_jsonl(kit_dir / DEV_FILE, FinetunePair),
        corpus=bundle.read_jsonl(kit_dir / kit.DEV_CORPUS_FILE, KitCorpusChunk),
    )


def _key(tenant_key: str, object_id: str) -> str:
    return f"{tenant_key}#{object_id}"


def _ntuple_columns(rows: Sequence[FinetunePair]) -> dict[str, list[str]]:
    n = min(len(pair.negatives) for pair in rows)
    columns: dict[str, list[str]] = {"anchor": [p.anchor for p in rows], "positive": [p.positive for p in rows]}
    for i in range(n):
        columns[f"negative_{i + 1}"] = [p.negatives[i].text for p in rows]
    return columns


def _pair_columns(rows: Sequence[FinetunePair]) -> dict[str, list[str]]:
    return {"anchor": [p.anchor for p in rows], "positive": [p.positive for p in rows]}


def _column_prompts(columns: Sequence[str], query_prompt: str, document_prompt: str) -> dict[str, str] | None:
    prompts = {name: (query_prompt if name == "anchor" else document_prompt) for name in columns}
    prompts = {name: prompt for name, prompt in prompts.items() if prompt}
    return prompts or None


def build_dev_evaluator(data: KitData, base: BaseModelSpec, lib: TrainLibrary, batch_size: int) -> Any:
    corpus = {_key(c.tenant_key, c.chunk_id): c.text for c in data.corpus}
    queries: dict[str, str] = {}
    relevant: dict[str, set[str]] = {}
    for pair in data.dev:
        positive = _key(pair.tenant_key, pair.positive_chunk_id)
        if positive not in corpus:
            raise KitRefused("kit_rows_invalid")
        qid = _key(pair.tenant_key, pair.pair_id)
        queries[qid] = pair.anchor
        relevant[qid] = {positive}
    return lib.ir_evaluator(
        queries=queries,
        corpus=corpus,
        relevant_docs=relevant,
        name=EVALUATOR_NAME,
        query_prompt=base.query_prompt or None,
        corpus_prompt=base.document_prompt or None,
        main_score_function="cosine",
        batch_size=batch_size,
        write_csv=False,
        show_progress_bar=False,
    )


def _loss(model: Any, recipe: TrainingRecipe, lib: TrainLibrary, guide: Any) -> Any:
    if recipe.gist.enabled:
        if guide is None:
            raise ValueError("GIST losses need the guide model (the base model)")
        if recipe.gist.cached:
            loss = lib.cached_gist(model=model, guide=guide, mini_batch_size=recipe.mini_batch_size)
        else:
            loss = lib.gist(model=model, guide=guide)
    elif recipe.loss == "CachedMultipleNegativesRankingLoss":
        loss = lib.cached_mnrl(model=model, mini_batch_size=recipe.mini_batch_size)
    else:
        loss = lib.mnrl(model=model)
    if recipe.matryoshka.enabled:
        loss = lib.matryoshka(model=model, loss=loss, matryoshka_dims=list(recipe.matryoshka.dims))
    return loss


def build_trainer_args(
    *,
    model: Any,
    recipe: TrainingRecipe,
    base: BaseModelSpec,
    data: KitData,
    output_dir: Path,
    lib: TrainLibrary,
    device: str,
    guide: Any = None,
    bf16_supported: bool = False,
    max_steps: int | None = None,
) -> dict[str, Any]:
    """The keyword arguments for SentenceTransformerTrainer (D-15)."""
    datasets: dict[str, Any] = {}
    columns: list[str] = []
    if data.ntuple:
        cols = _ntuple_columns(data.ntuple)
        datasets["ntuple"] = lib.dataset.from_dict(cols)
        columns += [c for c in cols if c not in columns]
    if data.pairs:
        cols = _pair_columns(data.pairs)
        datasets["pairs"] = lib.dataset.from_dict(cols)
        columns += [c for c in cols if c not in columns]
    if not datasets:
        raise TrainRefused("no_train_pairs")
    loss = _loss(model, recipe, lib, guide)
    args = lib.training_arguments(
        output_dir=str(output_dir),
        num_train_epochs=recipe.num_train_epochs,
        max_steps=max_steps if max_steps is not None else -1,
        per_device_train_batch_size=recipe.per_device_train_batch_size,
        per_device_eval_batch_size=recipe.per_device_train_batch_size,
        learning_rate=recipe.learning_rate,
        warmup_ratio=recipe.warmup_ratio,
        bf16=bool(recipe.bf16 and device == "cuda" and bf16_supported),
        batch_sampler=lib.no_duplicates,
        eval_strategy="steps",
        eval_steps=recipe.eval_steps,
        save_strategy="steps",
        save_steps=recipe.eval_steps,
        save_total_limit=2,
        load_best_model_at_end=recipe.load_best_model_at_end,
        metric_for_best_model=BEST_METRIC,
        greater_is_better=True,
        logging_steps=recipe.eval_steps,
        seed=recipe.seed,
        data_seed=recipe.seed,
        prompts=_column_prompts(columns, base.query_prompt, base.document_prompt),
        report_to="none",
        use_cpu=device == "cpu",
        disable_tqdm=True,
    )
    return {
        "model": model,
        "args": args,
        "train_dataset": datasets,
        "loss": {name: loss for name in datasets},
        "evaluator": build_dev_evaluator(data, base, lib, recipe.per_device_train_batch_size),
    }


def load_base_model(base: BaseModelSpec, device: str) -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise TrainRefused("finetune_extra_missing", EXIT_USAGE, FINETUNE_EXTRA_HINT) from exc
    prompts = {name: prompt for name, prompt in (("query", base.query_prompt), ("document", base.document_prompt)) if prompt}
    model = SentenceTransformer(base.id, revision=base.revision, device=device, prompts=prompts or None)
    model.max_seq_length = base.max_seq_length
    return model


def detect_device() -> tuple[str, bool]:
    """(device, bf16 supported) of this host."""
    try:
        import torch
    except ImportError:
        return "cpu", False
    if torch.cuda.is_available():
        return "cuda", bool(torch.cuda.is_bf16_supported())
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps", False
    return "cpu", False


def probe_set(model: Any, base: BaseModelSpec) -> ProbeSet:
    vectors = model.encode(
        list(PROBE_TEXTS),
        prompt=base.query_prompt or None,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    matrix = np.asarray(vectors, dtype=np.float64)
    matrix = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    return ProbeSet(
        texts=list(PROBE_TEXTS),
        query_prompt=base.query_prompt,
        document_prompt=base.document_prompt,
        vectors=[[float(x) for x in row] for row in matrix],
    )


def _best_step(state: Any) -> int | None:
    step = getattr(state, "best_global_step", None)
    if step is not None:
        return int(step)
    checkpoint = getattr(state, "best_model_checkpoint", None)
    if checkpoint:
        tail = Path(checkpoint).name.rsplit("-", 1)[-1]
        return int(tail) if tail.isdigit() else None
    return None


def _dev_ndcg(state: Any, final_metrics: Mapping[str, float] | None) -> float | None:
    value = getattr(state, "best_metric", None)
    if value is None and final_metrics:
        value = final_metrics.get(f"{EVALUATOR_NAME}_cosine_ndcg@10")
    return None if value is None else min(max(float(value), 0.0), 1.0)


def _write_json(path: Path, payload: bytes) -> str:
    return bundle._atomic_write(path, payload)


@dataclass
class TrainResult:
    exit_code: int
    report: TrainingRunReport | None = None


def _prepare_out(out: Path) -> None:
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise TrainRefused("out_exists")
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)


def run_train(
    kit_dir: Path,
    out: Path,
    *,
    loss: str | None = None,
    matryoshka: bool | None = None,
    device: str | None = None,
    lib: TrainLibrary | None = None,
    model_factory: Callable[[BaseModelSpec, str], Any] | None = None,
    trainer_factory: Callable[..., Any] | None = None,
    installed: Mapping[str, str] | None = None,
    max_steps: int | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> TrainResult:
    """`model_factory(base, device)` replaces loading the hub model (tests); it is called a second time for the GIST
    guide. `installed` replaces the host's library versions (tests)."""
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    kit_dir, out = Path(kit_dir), Path(out)
    started = time.monotonic()
    try:
        manifest = kit.verify_kit(kit_dir)
        config = kit.read_training_config(kit_dir)
        recipe = effective_recipe(config.recipe, loss=loss, matryoshka=matryoshka)
        check_versions(config.library_versions.model_dump(), installed if installed is not None else installed_versions())
        if out.exists() and (not out.is_dir() or any(out.iterdir())):
            raise TrainRefused("out_exists")
        lib = lib or load_library()
        detected, bf16_supported = detect_device()
        device = device or detected
        if device not in ("cpu", "cuda", "mps"):
            raise TrainRefused("device_unknown")
        factory = model_factory or load_base_model
        model = factory(manifest.base_model, device)
        if int(model.get_embedding_dimension()) != FINETUNE_DIMS:
            raise TrainRefused("dims_mismatch", EXIT_USAGE, f"the base model must produce {FINETUNE_DIMS} dimensions")
        guide = factory(manifest.base_model, device) if recipe.gist.enabled else None
        data = load_kit_data(kit_dir)
        _prepare_out(out)
        checkpoints = out / CHECKPOINT_DIR
        kwargs = build_trainer_args(
            model=model,
            recipe=recipe,
            base=manifest.base_model,
            data=data,
            output_dir=checkpoints,
            lib=lib,
            device=device,
            guide=guide,
            bf16_supported=bf16_supported,
            max_steps=max_steps,
        )
    except (KitRefused, TrainRefused) as exc:
        print(f"[Finetune] train refused: {exc.message()}", file=stderr)
        return TrainResult(exc.exit_code)

    trainer = (trainer_factory or lib.trainer)(**kwargs)
    try:
        output = trainer.train()
        trained = getattr(trainer, "model", None) or model
        final_metrics = None
        if getattr(trainer.state, "best_metric", None) is None:
            final_metrics = kwargs["evaluator"](trained)
        trained.save(str(out))
        effective = config.model_copy(update={"recipe": recipe})
        config_sha = _write_json(
            out / kit.TRAINING_CONFIG_FILE, kit._canonical(effective.model_dump(mode="json"))
        )
        probe = probe_set(trained, manifest.base_model)
        _write_json(out / PROBE_FILE, kit._canonical(probe.model_dump(mode="json")))
        loss_value = getattr(output, "training_loss", None)
        report = TrainingRunReport(
            run_id=manifest.run_id,
            training_config_sha256=config_sha,
            examples={"ntuple": len(data.ntuple), "pairs": len(data.pairs)},
            steps=int(trainer.state.global_step),
            final_train_loss=None if loss_value is None or not np.isfinite(loss_value) else max(float(loss_value), 0.0),
            best_step=_best_step(trainer.state),
            best_dev_ndcg_at_10=_dev_ndcg(trainer.state, final_metrics),
            duration_seconds=round(time.monotonic() - started, 3),
            device=device,
        )
        _write_json(out / REPORT_FILE, kit._canonical(report.model_dump(mode="json")))
    except (KitRefused, TrainRefused) as exc:
        print(f"[Finetune] train failed: {exc.message()}", file=stderr)
        return TrainResult(exc.exit_code)
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"[Finetune] train failed: {type(exc).__name__}", file=stderr)
        return TrainResult(EXIT_TRAINING)
    finally:
        shutil.rmtree(out / CHECKPOINT_DIR, ignore_errors=True)
    digest = hashlib.sha256((out / PROBE_FILE).read_bytes()).hexdigest()[:12]
    print(
        f"[Finetune] train run_id={report.run_id} device={report.device} steps={report.steps} "
        f"ntuple={report.examples['ntuple']} pairs={report.examples['pairs']} best_step={report.best_step} "
        f"best_dev_ndcg_at_10={report.best_dev_ndcg_at_10} probe={digest}",
        file=stdout,
    )
    return TrainResult(EXIT_OK, report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune train")
    parser.add_argument("--kit", required=True, type=Path, help="kit directory built by kit")
    parser.add_argument("--out", required=True, type=Path, help="model directory (must not exist or be empty)")
    parser.add_argument("--loss", choices=LOSS_CHOICES, default=None, help="loss (default: the recipe's)")
    parser.add_argument("--matryoshka", action="store_true", default=None, help="wrap the loss with MatryoshkaLoss")
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default=None, help="default: detected")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    return run_train(
        args.kit, args.out, loss=args.loss, matryoshka=args.matryoshka, device=args.device
    ).exit_code
