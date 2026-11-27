import json

import pytest

from rag_eval.paths import REPO_ROOT

FAMILIES_FILE = REPO_ROOT / "config" / "rag" / "model-families.json"
CASES_FILE = REPO_ROOT / "tests" / "fixtures" / "rag" / "model-family-cases.json"
CASES = json.loads(CASES_FILE.read_text(encoding="utf-8"))


def test_the_family_table_is_read_from_the_shared_file() -> None:
    from rag_eval.judge import config

    data = json.loads(FAMILIES_FILE.read_text(encoding="utf-8"))
    assert config.FAMILIES_PATH == FAMILIES_FILE
    assert config._PROVIDER_FAMILIES == data["provider_families"]
    assert config._ROUTER_PREFIXES == set(data["router_prefixes"])
    assert [(pattern.pattern, family) for pattern, family in config._NAME_FAMILIES] == [
        (entry["pattern"], entry["family"]) for entry in data["name_patterns"]
    ]


@pytest.mark.parametrize(("model_id", "family"), CASES["families"])
def test_generator_family_matches_the_shared_cases(model_id: str, family: str) -> None:
    from rag_eval.judge.config import generator_family

    assert generator_family(model_id) == family


@pytest.mark.parametrize("model_id", CASES["unknown"])
def test_generator_family_refuses_the_shared_unknown_cases(model_id: str) -> None:
    from rag_eval.judge.config import JudgeFamilyError, generator_family

    with pytest.raises(JudgeFamilyError):
        generator_family(model_id)
