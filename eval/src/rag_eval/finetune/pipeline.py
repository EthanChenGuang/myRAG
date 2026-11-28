"""python -m rag_eval.finetune run --fixture --out <dir> [--tiny] [--seed N]: the Python pipeline end to end on fixtures.

Chains every D-03 command through its Python entry point (not subprocesses) on the committed fixture corpus with fakes:
export (eval/fixtures/corpus as two tenants, purpose deployment, RAG_FINETUNE=on for that call only), generate and filter with the fixture
LLM, import-mined with a synthetic TrainingPair sample built from the exported chunks, FakeEncoder production vectors
written in the 06.1-10 file format, mine (vectors miner, false-negative audit with the fixture judge), kit, train (fake
trainer, or with --tiny a 1024-dim StaticEmbedding when the finetune extra is installed), evaluate and card. Real runs
are operator steps; this command refuses without --fixture and never calls the network.

The fixture run uses a fixed clock and zero prices, so re-running into the same --out reproduces the report hashes listed
in pipeline-report.json. --out must be empty, missing or a previous fixture run of this command (only then is it
replaced). Output carries ids, counts and codes only (D-31).
"""
import argparse
import contextlib
import hashlib
import json
import os
import shutil
import sys
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict
from rag_sidecar.contracts.feedback_loop import TrainingPair
from rag_sidecar.contracts.finetune import (
    AnswerabilityVerdict,
    ExportedChunk,
    FinetuneConfig,
    FinetunePair,
    PriceTable,
    SyntheticQuery,
    SyntheticQueryBatch,
    TokenPrice,
)

from rag_eval.finetune import (
    bundle,
    card,
    evaluate,
    export,
    filters,
    generate,
    kit,
    mined,
    miner,
    train,
    vectors_io,
)
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.decontam import (
    FIXTURE_GOLDEN_PATH,
    GoldenIndex,
    load_golden_items,
    load_golden_questions,
)
from rag_eval.finetune.encoders import (
    Encoder,
    FakeEncoder,
    SentenceTransformerEncoder,
    TextItem,
)
from rag_eval.finetune.llm import (
    GenerationRequest,
    GenerationResult,
    JudgeItem,
    JudgeResult,
    Usage,
)
from rag_eval.paths import REPO_ROOT

PIPELINE_REPORT_FILE = "pipeline-report.json"
BUNDLES_DIR = "bundles"
INPUTS_DIR = "inputs"
KIT_DIR = "kit"
MODEL_DIR = "model"
MINED_SAMPLE_FILE = "training-pairs.synthetic.ndjson"
MANAGED = (PIPELINE_REPORT_FILE, BUNDLES_DIR, INPUTS_DIR, KIT_DIR, MODEL_DIR)

FIXTURE_CORPUS = REPO_ROOT / "eval" / "fixtures" / "corpus"
# Two tenants over the same corpus: with s:default the five documents the golden set does not force into test all
# hash to train (no dev split, so kit refuses no_dev_pairs); these keys give train, dev and test documents.
FIXTURE_TENANTS = ("o:00000000-0000-4000-8000-000000000001", "o:00000000-0000-4000-8000-000000000003")
FIXTURE_CREATED_AT = "2026-01-01T00:00:00Z"
FIXTURE_PROFILE = "fixture-fake"
FIXTURE_MODEL = "fixture-fake-encoder"
FIXTURE_DIMS = 64
FIXTURE_ARTIFACT_URI = "fixture:model"
TINY_LEARNING_RATE = 1e-2
TINY_INIT_SCALE = 0.02
TINY_MAX_STEPS = 24
TINY_NOTE = "fixture: proves wiring, not real gain"
DEFAULT_SEED = 42
GOLDEN_EVERY = 10
STEPS = ("export", "generate", "filter", "import-mined", "vectors", "mine", "kit", "train", "evaluate", "card")
REPRODUCIBLE_REPORTS = (
    "manifest.json",
    "generate-report.json",
    "filter-report.json",
    "mined-report.json",
    "mining-report.json",
    "offline-eval.json",
    "card.json",
    "kit/training-config.json",
)

EXIT_OK = 0
EXIT_USAGE = 2


class PipelineRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_USAGE):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


# --- fixture LLM ------------------------------------------------------------------------------------------------


def _tag(text: str) -> str:
    return "k" + hashlib.sha256(f"ft-fixture|{text}".encode()).hexdigest()[:10]


def _pieces(text: str) -> list[str]:
    """Words of at least three characters; text written without spaces falls back to two-character pieces."""
    words = [w.strip(".,;:!?()[]{}\"'`*#|") for w in text.split()]
    words = [w for w in words if len(w) >= 3 and not w.isdigit()]
    if len(words) >= 8:
        return words
    dense = "".join(ch for ch in text if ch.isalnum())
    return [dense[i : i + 2] for i in range(0, max(len(dense) - 1, 0), 2)]


def fixture_query(text: str, variant: int, *, words: int = 5) -> str:
    """A deterministic query that shares a few strided pieces of the chunk plus the chunk's tag; never a verbatim copy."""
    pieces = _pieces(text)
    picked: list[str] = []
    if pieces:
        step = max(1, len(pieces) // (words + 1))
        start = (variant * 7 + 1) % len(pieces)
        for i in range(words):
            piece = pieces[(start + i * step * (variant + 2)) % len(pieces)]
            if piece not in picked:
                picked.append(piece)
    return " ".join([*reversed(picked), _tag(text)])


def _estimate(text: str) -> int:
    return max(1, len(text) // 4)


class FixtureQueryLLM:
    """Generator: one query per requested style from fixture_query (no cross-language items); for every
    golden_every-th chunk the last style's query is a golden question of the chunk's language, which the filters must
    drop as golden_overlap (D-09). Judge: answerable exactly
    when the query carries the tag of the judged chunk's text, so false negatives of the miner are judged not
    answerable. Usage is a character estimate; fixture prices are zero."""

    generator_model = "fixture-generator"
    judge_model = "fixture-judge"

    def __init__(self, golden: Mapping[str, Sequence[str]] | None = None, *, golden_every: int = GOLDEN_EVERY) -> None:
        self.generate_calls = 0
        self.judge_calls = 0
        self.golden = {language: list(questions) for language, questions in (golden or {}).items() if questions}
        self.golden_every = golden_every
        self.golden_emitted = 0

    def _query(self, chunk: Any, variant: int, last: bool) -> str:
        questions = self.golden.get(chunk.language)
        if last and questions and chunk.ref % self.golden_every == 0:
            self.golden_emitted += 1
            return questions[(chunk.ref // self.golden_every) % len(questions)]
        return fixture_query(chunk.text, variant)

    def submit_queries(self, request: GenerationRequest) -> GenerationResult:
        self.generate_calls += 1
        last = len(request.styles) - 1
        items = [
            SyntheticQuery(
                chunk_ref=chunk.ref,
                language=chunk.language,
                style=style,
                query=self._query(chunk, variant, variant == last),
            )
            for chunk in request.chunks
            for variant, style in enumerate(request.styles)
        ]
        usage = Usage(
            input_tokens=sum(_estimate(chunk.text) for chunk in request.chunks),
            output_tokens=sum(_estimate(item.query) for item in items),
        )
        return GenerationResult(SyntheticQueryBatch(items=items), usage)

    def judge_answerability(self, items: Sequence[JudgeItem], *, prompt_version: str) -> JudgeResult:
        del prompt_version
        self.judge_calls += 1
        verdicts = tuple(
            AnswerabilityVerdict(answerable=_tag(item.chunk_text) in item.query, confidence=0.9) for item in items
        )
        usage = Usage(input_tokens=sum(_estimate(i.query) + _estimate(i.chunk_text) for i in items), output_tokens=0)
        return JudgeResult(verdicts, usage)


# --- fixture inputs ---------------------------------------------------------------------------------------------


def fixture_config(base: FinetuneConfig | None = None, *, tiny: bool = False) -> FinetuneConfig:
    """The committed finetune.json with zero prices (fakes cost nothing) and, for --tiny, a CPU-sized recipe with the
    uncached loss (StaticEmbedding cannot be split into GradCache mini-batches)."""
    config = base or load_finetune_config()
    zero = TokenPrice(input_usd_per_mtok=0.0, output_usd_per_mtok=0.0)
    prices = PriceTable(generator=zero, judge=zero, gpu_hour_usd=None, reembed_usd_per_mtok=None)
    update: dict[str, Any] = {"prices": prices}
    if tiny:
        update["training"] = config.training.model_copy(
            update={
                "loss": "MultipleNegativesRankingLoss",
                "per_device_train_batch_size": 16,
                "mini_batch_size": 4,
                "eval_steps": 4,
                "learning_rate": TINY_LEARNING_RATE,
            }
        )
    return config.model_copy(update=update)


def _uuid(name: str) -> str:
    return str(uuid.uuid5(export.FIXTURE_NAMESPACE, f"pipeline:{name}"))


def synthetic_training_pairs(
    chunks: Sequence[ExportedChunk],
    *,
    every: int = 4,
    golden: Mapping[str, Sequence[str]] | None = None,
) -> list[TrainingPair]:
    """Phase 5.1.1 TrainingPair rows over the exported chunks: every `every`-th chunk is a positive with up to two expert
    negatives from other documents (one of them, where available, from a test-split document so the split guard is
    exercised); every fifth row is held_out, and every seventh row asks a golden question of its language (when one
    exists), which import-mined must drop as golden_overlap."""
    ordered = sorted(chunks, key=lambda c: (c.tenant_key, c.document_id, c.chunk_index))
    test_chunks = [c for c in ordered if c.split == "test"]
    rows: list[TrainingPair] = []
    for position, chunk in enumerate(ordered[::every]):
        others = [c for c in ordered if c.tenant_key == chunk.tenant_key and c.document_id != chunk.document_id]
        negatives: list[ExportedChunk] = []
        if others:
            negatives.append(others[(position * 5) % len(others)])
        tests = [c for c in test_chunks if c.tenant_key == chunk.tenant_key and c.document_id != chunk.document_id]
        if tests and tests[position % len(tests)] not in negatives:
            negatives.append(tests[position % len(tests)])
        rows.append(
            TrainingPair.model_validate(
                {
                    "tenant_key": chunk.tenant_key,
                    "query_masked": _mined_query(chunk, position, golden or {}),
                    "language": chunk.language,
                    "positive": {
                        "chunk_id": chunk.chunk_id,
                        "document_id": chunk.document_id,
                        "quote": "fixture quote",
                    },
                    "hard_negatives": [
                        {
                            "chunk_id": n.chunk_id,
                            "document_id": n.document_id,
                            "rank": rank,
                            "score": 0.5,
                            "confirmed": True,
                        }
                        for rank, n in enumerate(negatives, start=1)
                    ],
                    "document_group": f"group-{chunk.document_id[:8]}",
                    "split": "held_out" if position % 5 == 4 else "train",
                    "source": "production_feedback",
                    "review_item_id": _uuid(f"{chunk.tenant_key}:{chunk.chunk_id}"),
                }
            )
        )
    return rows


def _mined_query(chunk: ExportedChunk, position: int, golden: Mapping[str, Sequence[str]]) -> str:
    questions = golden.get(chunk.language) or []
    if questions and position % 7 == 3:
        return questions[(position // 7) % len(questions)]
    return fixture_query(chunk.text, 3, words=4)


def golden_by_language(paths: Sequence[Path]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for item in load_golden_items(paths):
        out.setdefault(item.language, []).append(item.question)
    return out


def _write_sample(path: Path, rows: Sequence[TrainingPair]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lines = [json.dumps(row.model_dump(mode="json"), sort_keys=True) + "\n" for row in rows]
    path.write_text("".join(lines), encoding="utf-8")


def _query_items(run_dir: Path, tenant_key: str) -> list[TextItem]:
    items: list[TextItem] = []
    for name in (filters.KEPT_FILE, filters.TEST_KEPT_FILE):
        if (run_dir / name).is_file():
            items += [
                TextItem(row.query_id, row.query)
                for row in bundle.read_jsonl(run_dir / name, generate.RawSyntheticQuery)
                if row.tenant_key == tenant_key
            ]
    if (run_dir / mined.PAIRS_FILE).is_file():
        items += [
            TextItem(p.pair_id, p.anchor)
            for p in bundle.read_jsonl(run_dir / mined.PAIRS_FILE, FinetunePair)
            if p.tenant_key == tenant_key
        ]
    return items


def write_fixture_vectors(run_dir: Path, encoder: Encoder) -> None:
    """Production vectors in the 06.1-10 layout: every exported chunk and every kept, test and mined query, per tenant."""
    chunks = bundle.read_jsonl(run_dir / bundle.CHUNKS_FILE, ExportedChunk)
    manifest = bundle.read_manifest(run_dir)
    for tenant_key in manifest.tenant_keys:
        own = [c for c in chunks if c.tenant_key == tenant_key]
        vectors_io.write_vector_set(
            run_dir,
            kind="chunks",
            tenant_key=tenant_key,
            profile_id=FIXTURE_PROFILE,
            model=FIXTURE_MODEL,
            ids=[c.chunk_id for c in own],
            matrix=encoder.encode_documents([TextItem(c.chunk_id, c.text) for c in own]),
        )
        items = _query_items(run_dir, tenant_key)
        vectors_io.write_vector_set(
            run_dir,
            kind="queries",
            tenant_key=tenant_key,
            profile_id=FIXTURE_PROFILE,
            model=FIXTURE_MODEL,
            ids=[i.id for i in items],
            matrix=encoder.encode_queries(items),
        )


# --- fake and tiny trainers -------------------------------------------------------------------------------------


class _Recorder:
    def __init__(self, *args: Any, **kwargs: Any):
        self.args = args
        self.kwargs = kwargs


class _FakeEvaluator(_Recorder):
    def __call__(self, model: Any) -> dict[str, float]:
        return {f"{train.EVALUATOR_NAME}_cosine_ndcg@10": 0.5}


class _FakeDataset:
    def __init__(self, columns: dict[str, list[str]]):
        self.columns = columns

    @classmethod
    def from_dict(cls, columns: dict[str, list[str]]) -> "_FakeDataset":
        return cls(columns)

    def __len__(self) -> int:
        return len(next(iter(self.columns.values())))


class _FakeState:
    global_step = 1
    best_metric = 0.5
    best_global_step = 1


class _FakeTrainer(_Recorder):
    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self.model = kwargs["model"]
        self.state = _FakeState()

    def train(self) -> Any:
        class Output:
            training_loss = 0.5

        return Output()


class FakeTrainModel:
    """A 1024-dim stand-in: encode() is seeded by prompt and text, save() writes a placeholder weights file."""

    def __init__(self, dims: int = train.FINETUNE_DIMS):
        self.dims = dims
        self.max_seq_length = 128

    def get_embedding_dimension(self) -> int:
        return self.dims

    def encode(self, texts: Sequence[str], prompt: str | None = None, normalize_embeddings: bool = False, **_: Any):
        import numpy as np

        rows = []
        for text in texts:
            seed = int(hashlib.sha256(f"{prompt}|{text}".encode()).hexdigest()[:8], 16)
            vector = np.random.default_rng(seed).normal(size=self.dims)
            rows.append(vector / np.linalg.norm(vector) if normalize_embeddings else vector)
        return np.stack(rows).astype("float32")

    def save(self, path: str) -> None:
        Path(path).mkdir(parents=True, exist_ok=True)
        (Path(path) / "model.safetensors").write_bytes(b"fixture weights")


def fake_library() -> train.TrainLibrary:
    return train.TrainLibrary(
        training_arguments=_Recorder,
        no_duplicates="NO_DUPLICATES",
        cached_mnrl=_Recorder,
        mnrl=_Recorder,
        gist=_Recorder,
        cached_gist=_Recorder,
        matryoshka=_Recorder,
        ir_evaluator=_FakeEvaluator,
        dataset=_FakeDataset,
        trainer=_FakeTrainer,
    )


def tiny_model(texts: Sequence[str], *, dims: int = train.FINETUNE_DIMS, seed: int = DEFAULT_SEED) -> Any:
    """An untrained StaticEmbedding SentenceTransformer over a word-level vocabulary of `texts` (finetune extra)."""
    import numpy as np
    import sentence_transformers
    from sentence_transformers.sentence_transformer.modules import StaticEmbedding
    from tokenizers import Tokenizer, models, pre_tokenizers

    vocab = {"[UNK]": 0}
    for text in texts:
        for word in text.lower().split():
            vocab.setdefault(word, len(vocab))
    tokenizer = Tokenizer(models.WordLevel(vocab=vocab, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    weights = (np.random.default_rng(seed).normal(size=(len(vocab), dims)) * TINY_INIT_SCALE).astype(np.float32)
    module = StaticEmbedding(tokenizer, embedding_weights=weights)
    return sentence_transformers.SentenceTransformer(modules=[module], device="cpu")


def _tiny_texts(run_dir: Path) -> list[str]:
    texts = [c.text for c in bundle.read_jsonl(run_dir / bundle.CHUNKS_FILE, ExportedChunk)]
    manifest = bundle.read_manifest(run_dir)
    for tenant_key in manifest.tenant_keys:
        texts += [item.text for item in _query_items(run_dir, tenant_key)]
    return texts


# --- run --------------------------------------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PipelineStep(_Strict):
    command: str
    exit_code: int


class PipelineReport(_Strict):
    fixture: bool
    run_id: str
    seed: int
    trainer: str
    tenant_keys: list[str]
    steps: list[PipelineStep]
    reports: dict[str, str]
    note: str | None = None
    tiny: dict[str, float] | None = None


@dataclass
class PipelineResult:
    exit_code: int
    report: PipelineReport | None = None
    steps: list[PipelineStep] = field(default_factory=list)


@contextlib.contextmanager
def scoped_env(name: str, value: str) -> Iterator[None]:
    """Sets one variable for the enclosed call only and restores the previous state, also on error."""
    previous = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous


def _is_fixture_run(out: Path) -> bool:
    try:
        report = PipelineReport.model_validate_json((out / PIPELINE_REPORT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return report.fixture and all(child.name in MANAGED for child in out.iterdir())


def _prepare_out(out: Path) -> None:
    if out.exists():
        if not out.is_dir():
            raise PipelineRefused("out_not_fixture_run")
        if any(out.iterdir()):
            if not _is_fixture_run(out):
                raise PipelineRefused("out_not_fixture_run")
            for name in MANAGED:
                target = out / name
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)


def _fix_clock(run_dir: Path) -> None:
    """Fixture runs record a fixed created_at, so the dataset manifest hash (and every hash bound to it) is stable."""
    manifest = bundle.read_manifest(run_dir)
    bundle.write_manifest(run_dir, manifest.model_copy(update={"created_at": FIXTURE_CREATED_AT}))


def _report_hashes(out: Path, run_dir: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for name in REPRODUCIBLE_REPORTS:
        path = out / name if name.startswith(f"{KIT_DIR}/") else run_dir / name
        hashes[name] = bundle.sha256_file(path)
    return hashes


def run_fixture_pipeline(
    out: Path,
    *,
    tiny: bool = False,
    seed: int = DEFAULT_SEED,
    config: FinetuneConfig | None = None,
    stdout: Any = None,
    stderr: Any = None,
) -> PipelineResult:
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    out = Path(out)
    steps: list[PipelineStep] = []
    try:
        if tiny:
            try:
                import sentence_transformers  # noqa: F401
            except ImportError:
                raise PipelineRefused("finetune_extra_missing: --tiny needs uv sync --extra finetune") from None
        _prepare_out(out)
    except PipelineRefused as exc:
        print(f"[Finetune] run refused: {exc.code}", file=stderr)
        return PipelineResult(exc.exit_code)

    cfg = fixture_config(config, tiny=tiny)
    cfg = cfg.model_copy(update={"training": cfg.training.model_copy(update={"seed": seed})})
    run_id = f"ft-fixture-s{seed}"
    bundles = out / BUNDLES_DIR
    run_dir = bundles / run_id
    kit_dir = out / KIT_DIR
    model_dir = out / MODEL_DIR
    sample = out / INPUTS_DIR / MINED_SAMPLE_FILE
    golden = GoldenIndex(load_golden_questions([FIXTURE_GOLDEN_PATH]))
    golden_questions = golden_by_language([FIXTURE_GOLDEN_PATH])
    llm = FixtureQueryLLM(golden_questions)
    production = FakeEncoder(dims=FIXTURE_DIMS, salt="ft-fixture-production")
    spec = next(m for m in cfg.base_models if m.default)
    versions = kit.lock_versions()

    def do_export() -> int:
        with scoped_env("RAG_FINETUNE", "on"):
            code = export.main(
                [
                    *[arg for tenant in FIXTURE_TENANTS for arg in ("--tenant", tenant)],
                    "--purpose",
                    "deployment",
                    "--out",
                    str(bundles),
                    "--run-id",
                    run_id,
                    "--source-dir",
                    str(FIXTURE_CORPUS),
                    "--golden",
                    str(FIXTURE_GOLDEN_PATH),
                ]
            )
        if code == EXIT_OK:
            _fix_clock(run_dir)
        return code

    def do_import_mined() -> int:
        chunks = bundle.read_jsonl(run_dir / bundle.CHUNKS_FILE, ExportedChunk)
        _write_sample(sample, synthetic_training_pairs(chunks, golden=golden_questions))
        return mined.main(["--bundle", str(run_dir), "--input", str(sample)], config=cfg, golden=golden)

    def do_vectors() -> int:
        write_fixture_vectors(run_dir, production)
        return EXIT_OK

    def do_kit() -> int:
        if tiny:
            versions.update(train.installed_versions())
        return kit.main(
            ["--bundle", str(run_dir), "--out", str(kit_dir)],
            config=cfg,
            git_commit=kit.git_head(),
            library_versions=versions,
        )

    def do_train() -> int:
        if tiny:
            texts = _tiny_texts(run_dir)
            return train.run_train(
                kit_dir,
                model_dir,
                device="cpu",
                model_factory=lambda base, device: tiny_model(texts, seed=seed),
                max_steps=TINY_MAX_STEPS,
                stdout=stdout,
                stderr=stderr,
            ).exit_code
        return train.run_train(
            kit_dir,
            model_dir,
            device="cpu",
            lib=fake_library(),
            model_factory=lambda base, device: FakeTrainModel(),
            installed=versions,
            stdout=stdout,
            stderr=stderr,
        ).exit_code

    def encoders(ref: str) -> Encoder:
        if tiny:
            prompts = {"query_prompt": spec.query_prompt, "document_prompt": spec.document_prompt}
            if ref == str(model_dir):
                return SentenceTransformerEncoder(str(model_dir), **prompts)
            return SentenceTransformerEncoder(tiny_model(_tiny_texts(run_dir), seed=seed), **prompts)
        salt = "ft-fixture-finetuned" if ref == str(model_dir) else f"ft-fixture-base:{ref}"
        return FakeEncoder(dims=FIXTURE_DIMS, salt=salt)

    commands: dict[str, Callable[[], int]] = {
        "export": do_export,
        "generate": lambda: generate.main(["--bundle", str(run_dir), "--budget-usd", "0"], llm=llm, config=cfg),
        "filter": lambda: filters.main(
            ["--bundle", str(run_dir), "--budget-usd", "0", "--fixture"], llm=llm, config=cfg, golden=golden
        ),
        "import-mined": do_import_mined,
        "vectors": do_vectors,
        "mine": lambda: miner.main(
            ["--bundle", str(run_dir), "--miner", "vectors", "--budget-usd", "0", "--seed", str(seed)],
            config=cfg,
            llm=llm,
        ),
        "kit": do_kit,
        "train": do_train,
        "evaluate": lambda: evaluate.main(
            ["--bundle", str(run_dir), "--finetuned", str(model_dir)], config=cfg, encoder_factory=encoders
        ),
        "card": lambda: card.main(
            [
                "--bundle",
                str(run_dir),
                "--model",
                str(model_dir),
                "--artifact-uri",
                FIXTURE_ARTIFACT_URI,
                "--version",
                f"ft-fixture-s{seed}",
            ],
            config=cfg,
        ),
    }
    for name in STEPS:
        code = int(commands[name]() or 0)
        steps.append(PipelineStep(command=name, exit_code=code))
        if code != EXIT_OK:
            print(f"[Finetune] run failed: step={name} exit={code}", file=stderr)
            return PipelineResult(code, steps=steps)

    tiny_scores = None
    if tiny:
        offline = evaluate.OfflineEvalReport.model_validate_json((run_dir / evaluate.OFFLINE_REPORT_FILE).read_text())
        tiny_scores = {
            "untrained_recall_at_10": offline.models.base.overall.recall_at_10,
            "trained_recall_at_10": offline.models.finetuned.overall.recall_at_10,
        }
    report = PipelineReport(
        fixture=True,
        run_id=run_id,
        seed=seed,
        trainer="tiny" if tiny else "fake",
        tenant_keys=sorted(FIXTURE_TENANTS),
        steps=steps,
        reports=_report_hashes(out, run_dir),
        note=TINY_NOTE if tiny else None,
        tiny=tiny_scores,
    )
    payload = json.dumps(report.model_dump(mode="json", exclude_none=True), sort_keys=True, indent=2) + "\n"
    bundle._atomic_write(out / PIPELINE_REPORT_FILE, payload.encode("utf-8"))
    print(f"[Finetune] run run_id={run_id} trainer={report.trainer} steps={len(steps)} reports={len(report.reports)}", file=stdout)
    return PipelineResult(EXIT_OK, report, steps)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune run", description=__doc__.split("\n", 1)[0])
    parser.add_argument("--fixture", action="store_true", help="run on the committed fixture corpus with fakes (required)")
    parser.add_argument("--out", required=True, type=Path, help="output directory (empty, missing or a previous fixture run)")
    parser.add_argument("--tiny", action="store_true", help="train a tiny StaticEmbedding (needs the finetune extra)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="training and mining seed")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if not args.fixture:
        print("[Finetune] run refused: fixture_required: real runs chain the commands as operator steps", file=sys.stderr)
        return EXIT_USAGE
    return run_fixture_pipeline(args.out, tiny=args.tiny, seed=args.seed).exit_code
