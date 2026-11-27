"""Templated collection fixtures of the ingest fixture mode (plan 03.3-20; D-15, D-36, TPL-09).

The tests inspect pattern strings only; no tenant pattern of the fixture data is compiled or run here (plan 03.3-23 runs them
through the worker).
"""

import importlib.util
import itertools
import json
import os
import re
from pathlib import Path

import pytest
from rag_sidecar.contracts import ParseResult
from rag_sidecar.contracts.templated import (
    AttributeHeaderTemplate,
    AttributeImportRow,
    AttributeSchema,
    TenantRulesFile,
)
from test_fixture_pii import phone_violations
from test_ingest_fixtures import (
    OFF_SUBJECT_WORDS,
    _read,
    _sha256,
    generate,
    requires_reportlab,
    specs,
)

from rag_eval.paths import REPO_ROOT

INGEST = REPO_ROOT / "eval/fixtures/ingest"
TEMPLATED_DIR = INGEST / "templated"
LANGUAGES = ("zh", "en", "it")
FAMILY_SIZE = 12
FAMILY_IDS = [f"tpl-family-{language}-{number:02d}" for language in LANGUAGES for number in range(1, FAMILY_SIZE + 1)]
VARIANT_IDS = [f"tpl-variants-{language}" for language in LANGUAGES]
TEMPLATED_IDS = set(FAMILY_IDS) | set(VARIANT_IDS)
DATA_FILES = ("attribute-schema.json", "attributes.json", "section-rules.json", "boilerplate-rules.json", "header-template.json")
REGISTRY = REPO_ROOT / "config/rag/language-packs.json"
HAN = re.compile(r"[一-鿿]")
LATIN_WORD = re.compile(r"[^\W\d_]{4,}")
NUMBER_UNIT = re.compile(r"(?<![\d'.,A-Za-z-])(\d[\d'.,]*\d|\d) ?([^\W\d_]+)")


def _templated() -> dict:
    return {spec.id: spec for spec in getattr(specs, "templated_specs", lambda: ())()}


def _spec(spec_id: str):
    found = _templated()
    assert spec_id in found, f"{spec_id} has no spec"
    return found[spec_id]


def _manifest() -> dict:
    return json.loads(_read(INGEST / "manifest.json"))


def _entries() -> dict:
    return {entry["id"]: entry for entry in _manifest().get("templated_fixtures", [])}


def _entry(spec_id: str) -> dict:
    entries = _entries()
    assert spec_id in entries, f"{spec_id} is not in the manifest's templated_fixtures"
    return entries[spec_id]


def _facts(spec_id: str) -> dict:
    return _spec(spec_id).facts["templated"]


def _lines(spec) -> list[str]:
    return [line for line in specs.render_markdown(spec).splitlines() if line.strip()]


def _page_lines(spec, page: int) -> list:
    return [block for block in spec.blocks if block.page == page]


def _is_page_line(block, role: str) -> bool:
    return isinstance(block, getattr(specs, "PageLine", ())) and block.role == role


def _tokens(text: str) -> list[str]:
    return re.findall(r"[一-鿿]|[^\W_一-鿿]+", text)


# --- Specs -------------------------------------------------------------------------------------------------------------------


def test_templated_specs_are_39_digital_product_documents_kept_apart_from_the_other_lists():
    found = _templated()
    assert set(found) == TEMPLATED_IDS and len(found) == 39
    for spec in found.values():
        assert spec.doc_type == "product_technical" and spec.layer == "digital", spec.id
        assert spec.language == spec.id.split("-")[2], spec.id
    assert len(specs.all_specs()) == 12 and len(specs.long_table_specs()) == 6
    assert not TEMPLATED_IDS & {spec.id for spec in (*specs.all_specs(), *specs.long_table_specs())}
    assert any(spec.doc_type == "product_technical" for spec in specs.all_specs()), "an earlier product document exercises the fallback"


@pytest.mark.parametrize("language", LANGUAGES)
def test_a_family_shares_its_heading_sequence_and_differs_only_in_four_lines(language):
    members = [_spec(f"tpl-family-{language}-{number:02d}") for number in range(1, FAMILY_SIZE + 1)]
    sequences = set()
    for spec in members:
        assert spec.page_count >= 4, spec.id
        headings = [block.text for block in spec.blocks if isinstance(block, specs.Heading) and block.level == 2]
        numbers = [int(re.match(r"(\d+)\.", text).group(1)) for text in headings]
        assert len(headings) == 5 and numbers == sorted(numbers) and len(set(numbers)) == 5, spec.id
        sequences.add(tuple(headings))
    assert len(sequences) == 1
    for left, right in itertools.combinations(members, 2):
        a, b = _lines(left), _lines(right)
        assert sum(1 for line in a if line in set(b)) / len(a) >= 0.8, (left.id, right.id)
        differing = [line for line in a if line not in set(b)]
        facts = _facts(left.id)
        allowed = {facts["identity"], facts["quantity"]["sentence"], *facts["member_sentences"].values()}
        assert set(differing) == allowed, (left.id, right.id)
    for spec in members:
        facts = _facts(spec.id)
        page_one = [block.text for block in _page_lines(spec, 1) if isinstance(block, specs.Paragraph)]
        assert facts["identity"] in page_one, spec.id
        for value in facts["attributes"].values():
            for item in value if isinstance(value, list) else [value]:
                assert item in facts["identity"], (spec.id, item)
        section_two = facts["member_sentences"]["section_2"]
        assert sum(section_two in _lines(other) for other in members) == 1, spec.id


def _number_style(spelling: str) -> tuple:
    number, unit = NUMBER_UNIT.fullmatch(spelling).groups()
    separators = re.findall(r"[^\d]", number)
    return (tuple(separators), " " in spelling, unit)


def _one_separator_three_digits(spelling: str) -> bool:
    number = NUMBER_UNIT.fullmatch(spelling).group(1)
    return bool(re.fullmatch(r"\d+[^\d]\d{3}", number))


@pytest.mark.parametrize("language", LANGUAGES)
def test_each_member_states_one_quantity_spelled_in_at_least_four_styles(language):
    registry = json.loads(_read(REGISTRY))["quantity"]
    quantities = [_facts(f"tpl-family-{language}-{number:02d}")["quantity"] for number in range(1, FAMILY_SIZE + 1)]
    assert len({quantity["canonical"] for quantity in quantities}) == FAMILY_SIZE
    styles = {_number_style(quantity["spelling"]) for quantity in quantities}
    assert len(styles) >= 4
    assert len({style[0] for style in styles}) >= 3 and {style[1] for style in styles} == {True, False}
    assert len({style[2] for style in styles}) >= 2, "the unit letter case varies"
    ambiguous = [quantity for quantity in quantities if _one_separator_three_digits(quantity["spelling"])]
    assert len(ambiguous) == 1 and ambiguous[0]["ambiguous"] is True
    assert sum(quantity["ambiguous"] for quantity in quantities) == 1
    for number, quantity in enumerate(quantities, start=1):
        unit = NUMBER_UNIT.fullmatch(quantity["spelling"]).group(2)
        assert unit.lower() in registry["unit_symbols"] and unit.lower() == quantity["unit"]
        assert set(re.findall(r"[^\d]", NUMBER_UNIT.fullmatch(quantity["spelling"]).group(1))) <= set(registry["decimal_separators"]) | set(registry["grouping_separators"])
        markdown = specs.render_markdown(_spec(f"tpl-family-{language}-{number:02d}"))
        assert len([match for match in NUMBER_UNIT.finditer(markdown) if match.group(2).lower() == quantity["unit"]]) == 1
        assert quantity["sentence"] in markdown


@pytest.mark.parametrize("language", LANGUAGES)
def test_the_variant_file_opens_with_contents_and_restarts_its_headings_three_times(language):
    spec = _spec(f"tpl-variants-{language}")
    facts = _facts(spec.id)
    lines = _lines(spec)
    headings = facts["heading_lines"]
    start = lines.index(headings[0])
    assert lines[start : start + len(headings)] == headings and len(headings) >= 3, "contents run of heading lines"
    restart = [index for index, line in enumerate(lines) if line.startswith("#") and line.lstrip("# ").startswith(facts["restart_heading"])]
    assert len(restart) == 3 == len(facts["designations"])
    for index, designation in zip(restart, facts["designations"]):
        assert lines[index].endswith(designation)
        assert designation in lines[index + 1] and not lines[index + 1].startswith("#")
        sentences = facts["variant_sentences"][designation]
        assert len(sentences) == 5
        for sentence in sentences:
            assert sum(line == sentence for line in lines) == 1 and designation in sentence
    for one, other in itertools.combinations(facts["designations"], 2):
        assert not set(facts["variant_sentences"][one]) & set(facts["variant_sentences"][other])


@pytest.mark.parametrize("spec_id", sorted(TEMPLATED_IDS))
def test_every_page_has_a_top_line_a_bottom_line_a_fragment_and_a_footer(spec_id):
    spec = _spec(spec_id)
    facts = _facts(spec_id)
    values = [item for value in facts["attributes"].values() for item in (value if isinstance(value, list) else [value])]
    tops = []
    for page in range(1, spec.page_count + 1):
        blocks = _page_lines(spec, page)
        body = [block for block in blocks if not (isinstance(block, specs.PageLine) and block.label == "page_footer")]
        assert _is_page_line(body[0], "top") and _is_page_line(body[-1], "bottom"), (spec_id, page)
        footers = [block for block in blocks if isinstance(block, specs.PageLine) and block.label == "page_footer"]
        assert len(footers) == 1 and footers[0].role == "footer", (spec_id, page)
        fragments = [index for index, block in enumerate(body) if _is_page_line(block, "fragment")]
        assert len(fragments) == 1, (spec_id, page)
        index = fragments[0]
        assert isinstance(body[index - 1], specs.Paragraph) and isinstance(body[index + 1], specs.Paragraph), (spec_id, page)
        assert len(_tokens(body[index].text)) <= 3
        tops.append(body[0].text)
        for line in (body[0].text, body[-1].text, body[index].text, footers[0].text):
            assert not any(value in line for value in values), (spec_id, line)
    assert len({re.sub(r"\d+", "#", top) for top in tops}) == 1
    assert facts["lines"]["top"] == tops


# --- Recordings and manifest ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("spec_id", sorted(TEMPLATED_IDS))
def test_the_recording_keeps_the_body_lines_and_drops_the_footer(spec_id):
    entry = _entry(spec_id)
    facts = _facts(spec_id)
    result = ParseResult.model_validate_json(_read(INGEST / entry["recorded"]["parse_result"]))
    spec = _spec(spec_id)
    assert result.page_count == spec.page_count == 4 and result.language == spec.language and result.parser == "docling"
    chunk_text = "\n".join(chunk.text for chunk in result.chunks)
    for text in (result.markdown, chunk_text):
        for line in (*facts["lines"]["top"], *facts["lines"]["bottom"], facts["lines"]["fragment"]):
            assert line in text, (spec_id, line)
        for line in facts["lines"]["footer"]:
            assert line not in text, (spec_id, line)
    docling = json.loads(_read(INGEST / entry["recorded"]["docling"]))
    footers = [item for item in docling["texts"] if item["label"] == "page_footer"]
    assert [item["text"] for item in footers] == facts["lines"]["footer"]
    assert all(item["content_layer"] == "furniture" for item in footers)
    assert all(item["prov"] and item["prov"][0]["page_no"] >= 1 for item in docling["texts"])
    assert len(docling["pages"]) == 4


@pytest.mark.parametrize("spec_id", sorted(TEMPLATED_IDS))
def test_the_declared_repeated_lines_make_up_at_least_five_percent_of_the_markdown(spec_id, monkeypatch):
    monkeypatch.setenv("TIKTOKEN_CACHE_DIR", os.environ.get("TIKTOKEN_CACHE_DIR") or str(REPO_ROOT / ".cache" / "tiktoken"))
    tiktoken = pytest.importorskip("tiktoken")
    encoding = tiktoken.get_encoding("cl100k_base")
    markdown = ParseResult.model_validate_json(_read(INGEST / _entry(spec_id)["recorded"]["parse_result"])).markdown
    lines = _facts(spec_id)["lines"]
    declared = [*lines["top"], *lines["bottom"], *[lines["fragment"]] * markdown.count(lines["fragment"])]
    share = sum(len(encoding.encode(line)) for line in declared) / len(encoding.encode(markdown))
    assert share >= 0.05, (spec_id, share)


def test_the_manifest_lists_the_templated_fixtures_in_the_shape_of_the_other_entries():
    manifest = _manifest()
    entries = manifest.get("templated_fixtures", [])
    assert [entry["id"] for entry in entries] == [spec.id for spec in specs.templated_specs()]
    reference = set(manifest["fixtures"][0]) - {"text"}
    for entry in entries:
        spec = _spec(entry["id"])
        assert set(entry) == reference, entry["id"]
        assert entry["path"] == f"pdf/{spec.id}.pdf" and entry["profile_id"] == "product_technical@1"
        assert entry["file_sha256"] == _sha256(_read(INGEST / entry["path"])), spec.id
        assert entry["expected"] == json.loads(json.dumps(spec.facts)), spec.id
        templated = entry["expected"]["templated"]
        assert {"lines", "heading_lines", "attributes", "page_count"} <= set(templated)
        assert set(templated["lines"]) == {"top", "bottom", "fragment", "footer"}
    assert len({entry["file_sha256"] for entry in entries}) == len(entries)
    assert not {entry["id"] for entry in entries} & {entry["id"] for entry in manifest["fixtures"]}


@requires_reportlab
def test_templated_pdfs_regenerate_to_the_committed_bytes(tmp_path):
    written = generate.generate(tmp_path / "pdf", tmp_path / "text", cjk_font=None)
    for spec_id in TEMPLATED_IDS:
        assert spec_id in written, spec_id
        assert _sha256(_read(INGEST / "pdf" / f"{spec_id}.pdf")) == written[spec_id], f"{spec_id}.pdf differs from the generator output"


# --- Rule data files ---------------------------------------------------------------------------------------------------------


def _data(name: str) -> dict:
    path = TEMPLATED_DIR / name
    assert path.is_file(), f"{path.relative_to(REPO_ROOT)} is missing"
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_attribute_schema_defines_the_four_fixture_keys():
    schema = AttributeSchema.model_validate(_data("attribute-schema.json"))
    by_key = {definition.key: definition for definition in schema.definitions}
    assert set(by_key) == {"alpha_code", "beta_label", "gamma_group", "delta_tags"}
    alpha, beta, gamma, delta = (by_key[key] for key in ("alpha_code", "beta_label", "gamma_group", "delta_tags"))
    assert (alpha.type, alpha.filterable, alpha.in_identifier_index) == ("code", True, True)
    assert (beta.type, beta.filterable, beta.in_header) == ("text", True, True)
    assert (gamma.type, gamma.filterable, gamma.in_header, gamma.soft) == ("text", True, True, True)
    assert (delta.type, delta.in_header) == ("text_list", True)


def test_attribute_rows_name_every_new_document_by_source_key():
    schema = {definition["key"]: definition for definition in _data("attribute-schema.json")["definitions"]}
    rows = [AttributeImportRow.model_validate(row) for row in _data("attributes.json")["rows"]]
    assert [row.source_key for row in rows] == [f"root/{spec.id}.pdf" for spec in specs.templated_specs()]
    assert all(row.source == "config_upload" for row in rows)
    for row in rows:
        spec_id = row.source_key.removeprefix("root/").removesuffix(".pdf")
        assert set(row.attributes) <= set(schema), spec_id
        assert row.attributes == _facts(spec_id)["attributes"], spec_id
        for key, value in row.attributes.items():
            assert isinstance(value, list) == (schema[key]["type"] == "text_list"), (spec_id, key)
    for key in ("beta_label", "alpha_code"):
        values = [row.attributes[key] for row in rows]
        assert len(set(values)) == len(values), key


def _heading_word(line: str) -> str:
    return line.split(". ", 1)[1]


def test_one_section_rule_set_covers_the_headings_of_all_three_languages():
    rules = TenantRulesFile.model_validate(_data("section-rules.json"))
    assert len(rules.section_rule_sets) == 1 and not rules.boilerplate_rules
    rule_set = rules.section_rule_sets[0]
    assert rule_set.doc_type == "product_technical" and rule_set.source is None and rule_set.enabled
    assert rule_set.require_increasing_numbers and rule_set.skip_toc and rule_set.toc_min_run == 3
    for language in LANGUAGES:
        headings = _facts(f"tpl-variants-{language}")["heading_lines"]
        for position, line in enumerate(headings):
            holders = [heading for heading in rule_set.headings if _heading_word(line) in heading.pattern]
            assert len(holders) == 1, (language, line)
            holder = holders[0]
            assert holder.pattern.startswith(f"^{position + 1}"), holder.pattern
            assert holder.restart == (position == 0) and holder.level == 2
            assert holder.name == f"section_{position + 1}"
    for heading in rule_set.headings:
        assert heading.pattern.startswith("^") and len(heading.pattern) <= 200 and heading.flags in ("u", "iu")


def test_boilerplate_rules_hold_one_line_rule_per_language_and_one_fragment_rule():
    rules = TenantRulesFile.model_validate(_data("boilerplate-rules.json"))
    assert not rules.section_rule_sets
    lines = [rule for rule in rules.boilerplate_rules if rule.kind == "line"]
    fragments = [rule for rule in rules.boilerplate_rules if rule.kind == "fragment"]
    assert len(lines) == 3 and len(fragments) == 1
    for language in LANGUAGES:
        declared = _facts(f"tpl-variants-{language}")["lines"]
        top = re.sub(r" \d+$", "", declared["top"][0])
        holders = [rule for rule in lines if top in (rule.pattern or "")]
        assert len(holders) == 1, language
        assert re.sub(r" \d+$", "", declared["bottom"][0]) in holders[0].pattern
    for rule in rules.boilerplate_rules:
        assert rule.doc_type == "product_technical" and rule.source is None and rule.enabled
        if rule.kind == "line":
            assert rule.pattern.startswith("^") and len(rule.pattern) <= 200 and rule.flags in ("u", "iu")
    fragment = fragments[0]
    for spec in specs.templated_specs():
        assert len(_facts(spec.id)["lines"]["fragment"]) <= fragment.max_length


def test_the_header_template_names_only_header_attributes():
    template = AttributeHeaderTemplate.model_validate(_data("header-template.json"))
    in_header = {definition["key"] for definition in _data("attribute-schema.json")["definitions"] if definition["in_header"]}
    placeholders = set(re.findall(r"\{([^{}]*)\}", template.template))
    assert placeholders and placeholders <= in_header and len(template.template) <= 200


# --- Vocabulary --------------------------------------------------------------------------------------------------------------


def _earlier_texts() -> dict[str, str]:
    texts: dict[str, str] = {}
    for path in sorted((REPO_ROOT / "eval/fixtures/corpus").rglob("*")):
        if path.is_file():
            texts[path.relative_to(REPO_ROOT).as_posix()] = path.read_text(encoding="utf-8", errors="ignore")
    for spec in (*specs.all_specs(), *specs.long_table_specs()):
        texts[f"spec:{spec.id}"] = specs.render_markdown(spec) + json.dumps(spec.facts, ensure_ascii=False)
    for path in sorted((REPO_ROOT / "eval/fixtures/parse/chain").glob("*.parse.json")):
        texts[path.relative_to(REPO_ROOT).as_posix()] = json.loads(path.read_text(encoding="utf-8"))["markdown"]
    return texts


def _new_text(spec) -> str:
    footers = [block.text for block in spec.blocks if isinstance(block, specs.PageLine) and block.label == "page_footer"]
    return specs.render_markdown(spec) + "\n" + "\n".join(footers)


def test_new_texts_share_no_content_word_with_earlier_fixtures_or_the_corpus():
    earlier = _earlier_texts()
    words: dict[str, str] = {}
    trigrams: dict[str, str] = {}
    for name, text in earlier.items():
        for word in LATIN_WORD.findall(text.casefold()):
            words.setdefault(word, name)
        for run in re.findall(r"[一-鿿]{3,}", text):
            for index in range(len(run) - 2):
                trigrams.setdefault(run[index : index + 3], name)
    for spec in _templated().values():
        text = _new_text(spec)
        if spec.language == "zh":
            for run in re.findall(r"[一-鿿]{3,}", text):
                for index in range(len(run) - 2):
                    trigram = run[index : index + 3]
                    assert trigram not in trigrams, f"{spec.id} shares {trigram!r} with {trigrams.get(trigram)}"
        else:
            for word in LATIN_WORD.findall(text.casefold()):
                assert word not in words, f"{spec.id} shares {word!r} with {words.get(word)}"


def test_new_texts_hold_no_off_subject_wording_and_no_phone_pattern():
    for spec in _templated().values():
        text = _new_text(spec).lower()
        assert [word for word in OFF_SUBJECT_WORDS if word in text] == [], spec.id
        assert phone_violations(text) == [], spec.id


# --- Loader ------------------------------------------------------------------------------------------------------------------


def test_the_python_loader_returns_every_fixture_and_the_five_data_files():
    assert importlib.util.find_spec("rag_eval.templated_fixtures") is not None, "rag_eval.templated_fixtures is missing"
    from rag_eval.templated_fixtures import load_templated_fixtures

    dump = load_templated_fixtures()
    assert [fixture["id"] for fixture in dump["fixtures"]] == [spec.id for spec in specs.templated_specs()]
    assert set(dump["data"]) == {"attribute_schema", "attributes", "section_rules", "boilerplate_rules", "header_template"}
    for fixture in dump["fixtures"]:
        assert fixture["source"] == "config_upload"
        assert fixture["source_key"] == f"root/{fixture['file_name']}" and fixture["file_name"] == f"{fixture['id']}.pdf"
        assert fixture["attributes"] == fixture["templated"]["attributes"]
    for name in DATA_FILES:
        assert (TEMPLATED_DIR / name).is_file(), name


def test_the_loader_has_no_regular_expression_on_fixture_patterns():
    source = Path(REPO_ROOT / "eval/src/rag_eval/templated_fixtures.py")
    assert source.is_file(), "rag_eval.templated_fixtures is missing"
    assert not re.search(r"\bre\.(compile|match|search|fullmatch|findall|finditer|sub|split)\b|^import re$", source.read_text(encoding="utf-8"), re.MULTILINE)
