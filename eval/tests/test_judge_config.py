import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.paths import REPO_ROOT

JUDGE_JSON = REPO_ROOT / "eval" / "config" / "judge.json"


def _run_python(code: str, env_overrides: dict[str, str | None] | None = None) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DEEPEVAL", "RAGAS", "CONFIDENT"))}
    for key, value in (env_overrides or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, env=env, check=False)


def test_import_sets_telemetry_opt_out_variables_with_existing_home() -> None:
    code = (
        "import os\n"
        "import rag_eval.judge\n"
        "print(os.environ['DEEPEVAL_TELEMETRY_OPT_OUT'])\n"
        "print(os.environ['DEEPEVAL_UPDATE_WARNING_OPT_IN'])\n"
        "print(os.environ['RAGAS_DO_NOT_TRACK'])\n"
        "print(os.path.isdir(os.environ['DEEPEVAL_HOME']))\n"
    )
    result = _run_python(code)
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["1", "0", "true", "True"]


def test_import_overrides_conflicting_values_for_the_opt_outs() -> None:
    code = "import os\nimport rag_eval.judge\nprint(os.environ['RAGAS_DO_NOT_TRACK'], os.environ['DEEPEVAL_TELEMETRY_OPT_OUT'])\n"
    result = _run_python(code, {"RAGAS_DO_NOT_TRACK": "1", "DEEPEVAL_TELEMETRY_OPT_OUT": "0"})
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["true", "1"]


def test_existing_deepeval_home_is_kept(tmp_path: Path) -> None:
    code = "import os\nimport rag_eval.judge\nprint(os.environ['DEEPEVAL_HOME'])\n"
    result = _run_python(code, {"DEEPEVAL_HOME": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(tmp_path)


def test_importing_config_and_telemetry_does_not_load_the_judge_libraries() -> None:
    code = (
        "import sys\n"
        "import rag_eval.judge\n"
        "import rag_eval.judge.config\n"
        "import rag_eval.judge.telemetry\n"
        "print('deepeval' in sys.modules, 'ragas' in sys.modules)\n"
    )
    result = _run_python(code)
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["False", "False"]


def test_load_judge_config_matches_pinned_judge() -> None:
    from rag_eval.judge.config import load_judge_config

    config = load_judge_config()
    assert isinstance(config, JudgeConfig)
    assert config.judge_model == "openai/gpt-5-mini"
    assert config.judge_family == "openai"
    assert config.provider == "openrouter"
    assert config.base_url == "https://openrouter.ai/api/v1"
    assert config.temperature == 0.0
    assert config.embedding_model == "text-embedding-3-small"
    assert config.max_concurrency == 4
    raw = json.loads(JUDGE_JSON.read_text(encoding="utf-8"))
    assert raw["judge_model"] == "openai/gpt-5-mini"


def test_generator_family() -> None:
    from rag_eval.judge.config import generator_family

    assert generator_family("anthropic/claude-sonnet-4.5") == "anthropic"
    assert generator_family("openai/gpt-5-mini") == "openai"
    assert generator_family("claude-3-haiku") == "anthropic"
    assert generator_family("Claude-Opus") == "anthropic"
    assert generator_family("qwen/qwen3-32b") == "qwen"


def test_judge_family_check_refuses_same_family_and_claude() -> None:
    from rag_eval.judge.config import JudgeFamilyError, assert_judge_family_differs, load_judge_config

    base = load_judge_config()
    claude_judge = base.model_copy(update={"judge_model": "anthropic/claude-haiku-4.5", "judge_family": "anthropic"})
    with pytest.raises(JudgeFamilyError):
        assert_judge_family_differs(claude_judge, "anthropic/claude-sonnet-4.5")
    with pytest.raises(JudgeFamilyError):
        assert_judge_family_differs(claude_judge, "openai/gpt-5-mini")
    mislabeled = base.model_copy(update={"judge_model": "anthropic/claude-haiku-4.5", "judge_family": "openai"})
    with pytest.raises(JudgeFamilyError):
        assert_judge_family_differs(mislabeled, "openai/gpt-4o")
    with pytest.raises(JudgeFamilyError):
        assert_judge_family_differs(base, "openai/gpt-4o")
    inconsistent = base.model_copy(update={"judge_family": "google"})
    with pytest.raises(JudgeFamilyError):
        assert_judge_family_differs(inconsistent, "anthropic/claude-sonnet-4.5")


def test_judge_family_check_passes_for_distinct_family() -> None:
    from rag_eval.judge.config import assert_judge_family_differs, load_judge_config

    assert_judge_family_differs(load_judge_config(), "anthropic/claude-sonnet-4.5")


def test_check_no_results_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    from rag_eval.judge.telemetry import check_no_results_upload

    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    check_no_results_upload()
    monkeypatch.setenv("CONFIDENT_API_KEY", "placeholder")
    with pytest.raises(RuntimeError, match="CONFIDENT_API_KEY"):
        check_no_results_upload()


def test_importing_deepeval_after_the_opt_out_does_not_load_dotenv_files(tmp_path: Path) -> None:
    (tmp_path / ".env.local").write_text("CONFIDENT_API_KEY=placeholder-not-a-key\n", encoding="utf-8")
    (tmp_path / ".env").write_text("CONFIDENT_API_KEY=placeholder-not-a-key\n", encoding="utf-8")
    code = (
        "import os\n"
        "import rag_eval.judge\n"
        "import deepeval\n"
        "from rag_eval.judge.telemetry import check_no_results_upload\n"
        "check_no_results_upload()\n"
        "print(os.environ['DEEPEVAL_DISABLE_DOTENV'], os.environ.get('CONFIDENT_API_KEY'))\n"
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DEEPEVAL", "RAGAS", "CONFIDENT"))}
    result = subprocess.run(
        [sys.executable, "-I", "-c", code], capture_output=True, text=True, env=env, cwd=tmp_path, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["1", "None"]
