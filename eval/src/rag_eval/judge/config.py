from pathlib import Path

from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.paths import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "eval" / "config" / "judge.json"


class JudgeFamilyError(ValueError):
    pass


def load_judge_config(path: Path | None = None) -> JudgeConfig:
    target = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    return JudgeConfig.model_validate_json(target.read_text(encoding="utf-8"))


def generator_family(model_id: str) -> str:
    lowered = model_id.lower()
    if "claude" in lowered:
        return "anthropic"
    return lowered.split("/", 1)[0]


def assert_judge_family_differs(config: JudgeConfig, generator_model: str) -> None:
    judge_id = config.judge_model.lower()
    if "claude" in judge_id:
        raise JudgeFamilyError(f"judge {config.judge_model!r} names a Claude model; the judge must not be Claude")
    prefix = judge_id.split("/", 1)[0]
    if config.judge_family.lower() != prefix:
        raise JudgeFamilyError(
            f"judge_family {config.judge_family!r} does not match the prefix of judge_model {config.judge_model!r}"
        )
    generator = generator_family(generator_model)
    if config.judge_family.lower() == generator:
        raise JudgeFamilyError(
            f"judge family {config.judge_family!r} equals the generator family of {generator_model!r}; "
            "pin a judge from a different family"
        )
