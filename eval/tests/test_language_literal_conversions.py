import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.languages import LANGUAGE_CODES

from rag_eval import corpus, review_queue
from rag_eval.draft.config import DraftConfig, load_draft_config


def test_eval_language_lists_are_the_registry_codes():
    assert corpus.CORPUS_LANGUAGES == LANGUAGE_CODES
    assert review_queue.LANGUAGES == LANGUAGE_CODES
    assert LANGUAGE_CODES == ("zh", "en", "it")


def test_draft_config_accepts_registry_codes_and_refuses_others():
    config = load_draft_config()
    assert list(config.languages) == ["zh", "en", "it"]
    data = config.model_dump()
    data["languages"] = ["xx"]
    with pytest.raises(ValidationError, match="unknown language code 'xx'"):
        DraftConfig.model_validate(data)


def test_draft_config_schema_keeps_the_language_enum():
    items = DraftConfig.model_json_schema()["properties"]["languages"]["items"]
    assert items == {"enum": list(LANGUAGE_CODES), "type": "string"}
