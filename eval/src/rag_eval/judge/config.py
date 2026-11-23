from pathlib import Path

from pydantic import BaseModel, ConfigDict
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.paths import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "eval" / "config" / "judge.json"


class JudgeFamilyError(ValueError):
    pass


class JudgeFatalError(RuntimeError):
    pass


class JudgeCase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: str
    question: str
    answer: str
    contexts: list[str]
    reference: str | None = None


_REJECTION_HINTS = ("temperature", "unsupported", "not supported", "response_format", "json_schema")


def raise_if_fatal(exc: BaseException) -> None:
    """Re-raise provider failures that would repeat for every item as JudgeFatalError."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        status = getattr(current, "status_code", None)
        if status in (401, 403):
            raise JudgeFatalError(f"judge provider rejected the credentials (HTTP {status})") from exc
        if status in (400, 404, 422) and any(hint in str(current).lower() for hint in _REJECTION_HINTS):
            raise JudgeFatalError(
                f"judge provider rejected the request (HTTP {status}): {str(current)[:300]}; "
                "the pinned judge cannot run with temperature 0 and structured output, pin another non-Claude judge"
            ) from exc
        current = current.__cause__ or current.__context__


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
