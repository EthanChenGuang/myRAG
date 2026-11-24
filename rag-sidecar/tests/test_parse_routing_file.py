import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.routing import ParseRoutingConfig, default_parse_routing_config
from rag_sidecar.preflight.config import (
    default_routing_config_path,
    load_routing_config,
    reset_routing_config_cache,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
ROUTING_PATH = REPO_ROOT / "config" / "rag" / "parse-routing.json"


def _raw():
    return json.loads(ROUTING_PATH.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _clear_routing_cache():
    reset_routing_config_cache()
    yield
    reset_routing_config_cache()


def test_default_path_points_at_the_committed_routing_file():
    assert default_routing_config_path() == ROUTING_PATH


def test_file_validates_against_parse_routing_config():
    assert ParseRoutingConfig.model_validate(_raw()) == default_parse_routing_config().model_copy(
        update={
            "office_formats": {
                "docx": "native",
                "html": "native",
                "pptx": "structured",
                "xlsx": "structured",
            },
        },
    )


def test_presets_match_d48_starting_values():
    config = load_routing_config()
    presets = config.presets
    assert presets.fast == presets.fast.model_copy(
        update={"pdf_backend": "pypdfium2", "ocr": False, "table_mode": "off"},
    )
    assert presets.structured_layout.ocr is False
    assert presets.structured_layout.table_mode == "off"
    assert presets.structured_full.table_mode == "accurate"
    assert presets.structured_full.force_full_page_ocr in (None, False)
    assert presets.structured_ocr.ocr is True
    assert presets.structured_ocr.force_full_page_ocr is True
    assert presets.structured_ocr.table_mode == "accurate"
    assert presets.premium is None


def test_ladder_pdf_and_office_formats():
    config = load_routing_config()
    assert config.ladder["pdf"] == ["fast", "structured", "premium"]
    assert config.office_formats == {
        "docx": "native",
        "html": "native",
        "pptx": "structured",
        "xlsx": "structured",
    }


def test_every_cost_entry_carries_provenance():
    config = load_routing_config()
    for tier_name, tier_entry in config.costs.tier.model_dump().items():
        assert tier_entry["source"], tier_name
        assert tier_entry["as_of"], tier_name
    for layer_name, layer_entry in config.costs.layer.model_dump().items():
        assert layer_entry["source"], layer_name
        assert layer_entry["as_of"], layer_name
    assert "llamaindex" in config.costs.tier.premium.source.lower()
    assert config.costs.tier.fast.source == "assumed until measured"


def test_load_routing_config_memoises():
    first = load_routing_config()
    second = load_routing_config()
    assert first is second


def test_load_routing_config_rejects_unknown_keys(tmp_path: Path):
    broken = _raw()
    broken["rogue"] = True
    path = tmp_path / "parse-routing.json"
    path.write_text(json.dumps(broken), encoding="utf-8")
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        load_routing_config(path)


def test_load_routing_config_rejects_missing_cost_source(tmp_path: Path):
    broken = _raw()
    broken["costs"]["tier"]["fast"]["source"] = ""
    path = tmp_path / "parse-routing.json"
    path.write_text(json.dumps(broken), encoding="utf-8")
    with pytest.raises(ValidationError):
        load_routing_config(path)