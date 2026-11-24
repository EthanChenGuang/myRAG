import importlib.util
import re
from pathlib import Path

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
tiktoken = pytest.importorskip("tiktoken")

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker  # noqa: E402
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer  # noqa: E402
from docling_core.types.doc import DoclingDocument  # noqa: E402

from rag_sidecar.contracts import DoclingOptions, ParseJobRequest, ParseResult  # noqa: E402
from rag_sidecar.parse import docling_adapter  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "docling"
ARTIFACT_NAME = re.compile(r"[a-z0-9_.-]{1,64}")
SEPARATOR_ROW = re.compile(r"^\|[-: |]+\|$")


def _builder():
    spec = importlib.util.spec_from_file_location("build_docling_fixtures", FIXTURES / "build_fixtures.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load(name: str) -> DoclingDocument:
    return DoclingDocument.load_from_json(FIXTURES / f"{name}.json")


def _request(**overrides) -> ParseJobRequest:
    values = {
        "profile_id": "general@1",
        "profile_version": 1,
        "docling": DoclingOptions(
            ocr=True,
            force_full_page_ocr=False,
            table_mode="accurate",
            heading_hierarchy=True,
            generate_picture_images=True,
        ),
        "ocr_languages": ["zh", "en", "it"],
        "max_tokens": 200,
        "repeat_table_header": True,
    }
    values.update(overrides)
    return ParseJobRequest(**values)


def _convert(name: str, tmp_path: Path, **overrides) -> ParseResult:
    return docling_adapter.to_parse_result(_load(name), _request(**overrides), tmp_path)


def _token_count(text: str) -> int:
    return len(tiktoken.get_encoding("cl100k_base").encode(text))


def test_committed_fixtures_equal_a_fresh_build():
    fresh = _builder().build_all()
    assert set(fresh) == {"table-report", "headings-zh", "pictures"}
    for name, payload in fresh.items():
        assert (FIXTURES / f"{name}.json").read_bytes() == payload, name


def test_every_table_chunk_starts_with_the_header_row_and_separator(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    for chunk in tables:
        lines = chunk.text.splitlines()
        assert lines[0].startswith("| Item") and "Quantity" in lines[0]
        assert SEPARATOR_ROW.match(lines[1])


def test_table_header_is_the_header_row_and_separator_of_each_table_chunk(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    for chunk in tables:
        assert chunk.table_header == "\n".join(chunk.text.splitlines()[:2])
    assert all(chunk.table_header is None for chunk in result.chunks if not chunk.is_table)


def test_a_disabled_header_repeat_leaves_later_table_chunks_without_a_header(tmp_path):
    result = _convert("table-report", tmp_path, repeat_table_header=False)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert len(tables) > 1
    assert "Quantity" in tables[0].text.splitlines()[0]
    assert all("Quantity" not in chunk.text.splitlines()[0] for chunk in tables[1:])


def test_every_contextualized_text_is_within_max_tokens_on_cl100k(tmp_path):
    for name in ("table-report", "headings-zh"):
        result = _convert(name, tmp_path, max_tokens=200)
        assert result.chunks
        for chunk in result.chunks:
            assert 0 < _token_count(chunk.contextualized_text) <= 200


def test_contextualized_text_carries_the_heading_path(tmp_path):
    result = _convert("table-report", tmp_path)
    tables = [chunk for chunk in result.chunks if chunk.is_table]
    assert tables
    for chunk in tables:
        assert chunk.contextualized_text.splitlines()[:3] == ["Quarterly stock report", "Line items", chunk.text.splitlines()[0]]


def test_chinese_headings_come_outermost_first_with_their_pages(tmp_path):
    result = _convert("headings-zh", tmp_path)
    by_headings = {tuple(chunk.headings): chunk for chunk in result.chunks}
    chapter = by_headings.get(("示例股份有限公司 2025 年度报告", "第三章 资产负债表"))
    clause = by_headings.get(("示例股份有限公司 2025 年度报告", "第三章 资产负债表", "第5条 流动资产"))
    assert chapter is not None and clause is not None
    assert chapter.pages == [1]
    assert clause.pages == [2]
    assert "第5条 流动资产" in clause.contextualized_text


def test_pictures_carry_page_bbox_share_and_an_artifact_name(tmp_path):
    result = _convert("pictures", tmp_path)
    assert [picture.page for picture in result.pictures] == [1, 2]
    first, second = result.pictures
    assert first.bbox == pytest.approx([100, 100, 300, 300])
    assert first.page_area_share == pytest.approx(200 * 200 / (600 * 800))
    assert second.bbox == pytest.approx([50, 100, 550, 500])
    assert second.page_area_share == pytest.approx(500 * 400 / (600 * 800))
    assert first.image_ref != second.image_ref
    for picture in result.pictures:
        assert ARTIFACT_NAME.fullmatch(picture.image_ref)
        assert picture.image_ref in result.artifacts
        assert (tmp_path / picture.image_ref).read_bytes().startswith(b"\x89PNG")


def test_the_docling_json_is_written_and_listed_as_an_artifact(tmp_path):
    result = _convert("pictures", tmp_path)
    assert "docling.json" in result.artifacts
    assert all(ARTIFACT_NAME.fullmatch(name) for name in result.artifacts)
    assert all((tmp_path / name).is_file() for name in result.artifacts)
    reloaded = DoclingDocument.load_from_json(tmp_path / "docling.json")
    assert [text.text for text in reloaded.texts] == [text.text for text in _load("pictures").texts]


def test_a_picture_without_image_data_is_skipped_with_a_warning(tmp_path):
    doc = _load("pictures")
    doc.pictures[0].image = None
    result = docling_adapter.to_parse_result(doc, _request(), tmp_path)
    assert [picture.page for picture in result.pictures] == [2]
    assert result.warnings == ["picture_image_unavailable"]


def test_parser_fields_page_count_and_markdown(tmp_path):
    result = _convert("table-report", tmp_path)
    assert result.parser == "docling"
    assert re.fullmatch(r"docling-\d+\.\d+\.\d+", result.parser_version)
    assert result.page_count == 2
    assert result.partial is False
    assert "Quarterly stock report" in result.markdown.splitlines()[0]
    assert "| Item 39" in result.markdown
    assert ParseResult.model_validate_json(result.model_dump_json()) == result


def test_language_is_the_majority_language_of_the_chunks(tmp_path):
    assert _convert("headings-zh", tmp_path).language == "zh"
    assert _convert("table-report", tmp_path).language == "en"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("The invoice must be paid within thirty days of the date of issue.", "en"),
        ("Il pagamento della fattura deve essere effettuato entro trenta giorni dalla data di emissione.", "it"),
        ("本合同自双方签字盖章之日起生效，有效期为三年。", "zh"),
        ("1234 5678 ---", None),
        ("", None),
    ],
)
def test_detect_language(text, expected):
    assert docling_adapter.detect_language(text) == expected


def test_the_chunker_is_configured_with_the_markdown_table_serializer():
    provider = docling_adapter.MarkdownTableProvider()
    serializer = provider.get_serializer(DoclingDocument(name="empty"))
    assert type(serializer.table_serializer).__name__ == "MarkdownTableSerializer"
    tokenizer = OpenAITokenizer(tokenizer=tiktoken.get_encoding("cl100k_base"), max_tokens=200)
    assert isinstance(HybridChunker(tokenizer=tokenizer, serializer_provider=provider), HybridChunker)
