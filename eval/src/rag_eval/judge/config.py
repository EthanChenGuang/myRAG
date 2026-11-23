import re
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


_PROVIDER_FAMILIES = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google",
    "meta-llama": "meta-llama",
    "mistralai": "mistralai",
    "qwen": "qwen",
    "deepseek": "deepseek",
    "x-ai": "x-ai",
    "cohere": "cohere",
}
_ROUTER_PREFIXES = {"openrouter"}
_NAME_FAMILIES = (
    (re.compile(r"claude"), "anthropic"),
    (re.compile(r"^(gpt-|gpt\d|chatgpt|o\d(\b|-|$)|davinci)"), "openai"),
    (re.compile(r"^(gemini|gemma)"), "google"),
    (re.compile(r"^(llama|meta-llama)"), "meta-llama"),
    (re.compile(r"^(mistral|mixtral|codestral|ministral|pixtral|magistral|devstral)"), "mistralai"),
    (re.compile(r"^(qwen|qwq)"), "qwen"),
    (re.compile(r"^deepseek"), "deepseek"),
    (re.compile(r"^grok"), "x-ai"),
    (re.compile(r"^(command|c4ai)"), "cohere"),
)


def generator_family(model_id: str) -> str:
    """Return the vendor family of a model id, or raise JudgeFamilyError when it cannot be determined."""
    lowered = model_id.strip().lower()
    prefix, _, name = lowered.rpartition("/")
    if not lowered or lowered.startswith("~") or prefix in _ROUTER_PREFIXES or name in {"auto", ""}:
        raise JudgeFamilyError(f"cannot determine the model family of {model_id!r} (router or alias id); pin a concrete model")
    by_prefix = _PROVIDER_FAMILIES.get(prefix.split("/", 1)[0]) if prefix else None
    by_name = next((family for pattern, family in _NAME_FAMILIES if pattern.search(name)), None)
    if by_prefix and by_name and by_prefix != by_name:
        raise JudgeFamilyError(f"model id {model_id!r} names provider {by_prefix!r} but a {by_name!r} model")
    family = by_name or by_prefix
    if family is None:
        raise JudgeFamilyError(f"cannot determine the model family of {model_id!r}; refusing rather than assuming it differs")
    return family


def assert_judge_family_differs(config: JudgeConfig, generator_model: str) -> None:
    judge_id = config.judge_model.lower()
    if "claude" in judge_id:
        raise JudgeFamilyError(f"judge {config.judge_model!r} names a Claude model; the judge must not be Claude")
    prefix = judge_id.split("/", 1)[0]
    if config.judge_family.lower() != prefix or generator_family(config.judge_model) != config.judge_family.lower():
        raise JudgeFamilyError(
            f"judge_family {config.judge_family!r} does not match the prefix of judge_model {config.judge_model!r}"
        )
    generator = generator_family(generator_model)
    if config.judge_family.lower() == generator:
        raise JudgeFamilyError(
            f"judge family {config.judge_family!r} equals the generator family of {generator_model!r}; "
            "pin a judge from a different family"
        )
