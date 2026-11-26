"""Phase 4.2 fixture documents and golden items (plan 04.2-37; D-10, D-20, D-22, D-32, D-50).

The new documents are described by structure only and use invented, neutral vocabulary. Every new item carries the tag
`phase42`. The two items per language whose asked identifier does not exist are `no_answer` items (the GoldenItem rule keeps
`answerable: false` to no_answer and small_talk); they carry `asked_identifier:<spelling>` like the identifier_near_miss items,
and the identifier block scores both. Ids follow the usual language-category-number rule; numbers were picked only so that
each kind has dev items under the pure hash split.
"""

import collections
import re
import unicodedata

import pytest

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden
from rag_eval.identifiers import is_near_miss, normalize_identifier
from rag_eval.matching import chunk_matches_span, normalize_text
from rag_eval.paths import REPO_ROOT

GOLDEN_PATH = REPO_ROOT / "eval/fixtures/golden.jsonl"
CORPUS_DIR = REPO_ROOT / "eval/fixtures/corpus"

LANGUAGES = ("zh", "en", "it")
MARK = "phase42"
DUP_COPIES = 30
ASKED = "asked_identifier:"
FEATURE_TAGS = {"feature:versions": 1, "feature:table_lookup": 1}
STEM_IT_ITEMS = 3

PHASE42_FILES = frozenset(
    f"{language}/{name}"
    for language in LANGUAGES
    for name in (
        f"dup-passage.template.{language}.md",
        f"dup-solo.{language}.md",
        f"versioned-note.v1.{language}.md",
        f"versioned-note.v2.{language}.md",
        f"grid-reference.{language}.md",
        f"coded-list-a.{language}.md",
        f"coded-list-b.{language}.md",
    )
) | {"it/morphology-note.it.md"}

# Example domains of the REQUIREMENTS.md neutrality rule; no Phase 4.2 fixture text may use them.
DOMAIN_WORDS = (
    "travel",
    "lodging",
    "hotel",
    "leave day",
    "vacation",
    "salary",
    "salaries",
    "wage",
    "payroll",
    "restaurant",
    "menu",
    "vpn",
    "password",
    "branch",
    "faq",
    "expense",
    "reimburse",
    "viaggio",
    "viaggi",
    "alloggio",
    "albergo",
    "ferie",
    "stipendio",
    "ristorante",
    "filiale",
    "rimborso",
    "trasferta",
    "差旅",
    "出差",
    "住宿",
    "酒店",
    "年假",
    "请假",
    "工资",
    "薪资",
    "薪水",
    "餐厅",
    "饭店",
    "密码",
    "分行",
    "支行",
    "报销",
)

LATIN_WORD = re.compile(r"[^\W\d_]+")
HAN_RUN = re.compile(r"[\u3400-\u9fff]+")
# Function words the fixture embedder drops (eval/harness/fixture-embedder.mts) do not count as content words.
LATIN_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "of",
        "to",
        "in",
        "on",
        "for",
        "and",
        "or",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "do",
        "does",
        "did",
        "what",
        "which",
        "who",
        "whom",
        "how",
        "many",
        "much",
        "can",
        "could",
        "i",
        "my",
        "me",
        "we",
        "our",
        "you",
        "your",
        "it",
        "its",
        "this",
        "that",
        "these",
        "those",
        "with",
        "at",
        "by",
        "from",
        "as",
        "if",
        "than",
        "then",
        "there",
        "have",
        "has",
        "had",
        "will",
        "would",
        "should",
        "not",
        "no",
        "per",
        "il",
        "lo",
        "la",
        "le",
        "gli",
        "un",
        "una",
        "uno",
        "di",
        "da",
        "in",
        "con",
        "su",
        "per",
        "tra",
        "fra",
        "e",
        "ed",
        "o",
        "che",
        "chi",
        "cosa",
        "come",
        "quanto",
        "quanti",
        "quale",
        "quali",
        "sono",
        "sei",
        "siamo",
        "siete",
        "era",
        "ero",
        "non",
        "del",
        "della",
        "dei",
        "delle",
        "al",
        "alla",
        "ai",
        "alle",
        "nel",
        "nella",
        "nei",
        "nelle",
        "mi",
        "ti",
        "ci",
        "vi",
        "si",
        "io",
        "tu",
        "lui",
        "lei",
        "noi",
        "voi",
        "loro",
        "ha",
        "ho",
        "hai",
        "abbiamo",
        "hanno",
    ]
)
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
HAN_STOPWORDS = sorted(
    [
        "多少",
        "可以",
        "什么",
        "怎么",
        "如何",
        "是否",
        "的",
        "是",
        "了",
        "在",
        "和",
        "有",
        "我",
        "你",
        "吗",
        "呢",
        "吧",
        "与",
        "及",
        "或",
        "就",
        "都",
        "也",
        "为",
    ],
    key=len,
    reverse=True,
)


@pytest.fixture(scope="module")
def items():
    return load_golden(GOLDEN_PATH)


@pytest.fixture(scope="module")
def phase42(items):
    return [item for item in items if MARK in item.tags]


@pytest.fixture(scope="module")
def documents():
    return load_corpus(CORPUS_DIR)


def _raw_text(relpath: str) -> str:
    path = CORPUS_DIR / relpath
    assert path.is_file(), f"missing fixture document {relpath}"
    return path.read_text(encoding="utf-8")


def _body(relpath: str) -> str:
    """Document text without the fixture-meta line and the chunk markers."""
    return COMMENT.sub(" ", _raw_text(relpath))


def _old_relpaths() -> list[str]:
    return sorted(
        f"{path.parent.name}/{path.name}"
        for path in CORPUS_DIR.glob("*/*.md")
        if f"{path.parent.name}/{path.name}" not in PHASE42_FILES
    )


def _content_words(text: str) -> set[str]:
    folded = unicodedata.normalize("NFKC", text).casefold()
    return {
        word
        for word in LATIN_WORD.findall(folded)
        if not HAN_RUN.fullmatch(word)
        and len(word) >= 4
        and word not in LATIN_STOPWORDS
    }


def _han_bigrams(text: str) -> set[str]:
    grams: set[str] = set()
    for run in HAN_RUN.findall(unicodedata.normalize("NFKC", text)):
        for stop in HAN_STOPWORDS:
            run = run.replace(stop, " ")
        for segment in run.split():
            grams |= {segment[i : i + 2] for i in range(len(segment) - 1)}
    return grams


def _counts(selected, key):
    return collections.Counter(key(item) for item in selected)


def test_every_phase42_file_exists_and_three_templates_are_committed():
    missing = sorted(
        relpath for relpath in PHASE42_FILES if not (CORPUS_DIR / relpath).is_file()
    )
    assert missing == [], missing
    assert len(sorted(CORPUS_DIR.glob("*/dup-passage.template.*.md"))) == 3


def test_templates_expand_to_thirty_generated_documents_per_language(documents):
    generated = [doc for doc in documents if doc.fixture_dup_template is not None]
    counts = collections.Counter(doc.language for doc in generated)
    assert {language: counts[language] for language in LANGUAGES} == {
        language: DUP_COPIES for language in LANGUAGES
    }, counts
    assert {doc.fixture_dup_template for doc in generated} == {
        f"dup-{language}" for language in LANGUAGES
    }
    assert not any(doc.filename.startswith("dup-passage.template") for doc in documents)


def test_each_language_has_one_version_pair(documents):
    for language in LANGUAGES:
        versions = sorted(
            (doc.version, doc.relpath)
            for doc in documents
            if doc.lineage == f"versioned-note-{language}"
        )
        assert [version for version, _ in versions] == [1, 2], (language, versions)
        assert {
            doc.filename
            for doc in documents
            if doc.lineage == f"versioned-note-{language}"
        } == {f"versioned-note.{language}.md"}
        # Ingest mode publishes version 2 over version 1 only when version 1 sorts first (04.2-28 hand-off).
        assert versions[0][1] < versions[1][1]


def test_each_table_document_has_a_key_column_and_two_more_columns(documents):
    for language in LANGUAGES:
        (doc,) = [
            doc for doc in documents if doc.filename == f"grid-reference.{language}.md"
        ]
        rows = [line for line in doc.content.splitlines() if line.startswith("|")]
        header = [cell.strip() for cell in rows[0].strip("|").split("|")]
        assert len(header) >= 3, (language, header)
        assert len(rows) >= 4, (language, rows)


def test_coded_lists_hold_near_misses_and_a_no_digit_identifier(phase42):
    for language in LANGUAGES:
        a = _raw_text(f"{language}/coded-list-a.{language}.md")
        b = _raw_text(f"{language}/coded-list-b.{language}.md")
        heading_a = [line[3:] for line in a.splitlines() if line.startswith("## ")]
        heading_b = [line[3:] for line in b.splitlines() if line.startswith("## ")]
        assert len(heading_a) == len(heading_b) >= 4
        assert any(not re.search(r"\d", identifier) for identifier in heading_a), (
            language
        )
        for left, right in zip(heading_a, heading_b):
            left_norm, right_norm = (
                normalize_identifier(left),
                normalize_identifier(right),
            )
            assert left_norm != right_norm
            assert is_near_miss(left_norm, right_norm), (left, right)


def test_italian_morphology_note_uses_the_invented_noun_only_in_its_plural():
    text = _raw_text("it/morphology-note.it.md").casefold()
    assert "sgrombelli" in text
    assert "sgrombello" not in text
    corpus = "\n".join(
        path.read_text(encoding="utf-8").casefold()
        for path in CORPUS_DIR.glob("*/*.md")
    )
    assert "sgrombello" not in corpus


def test_phase42_counts_per_category_and_language(phase42):
    cells = _counts(phase42, lambda item: (item.category, item.language))
    for language in LANGUAGES:
        found = cells[("duplicate_flood", language)]
        assert found == 3, ("duplicate_flood", language, found)
        found = cells[("identifier_near_miss", language)]
        assert found == 4, ("identifier_near_miss", language, found)
        absent = [
            item
            for item in phase42
            if item.language == language and item.category == "no_answer"
        ]
        assert len(absent) == 2, (
            "no_answer with an asked identifier",
            language,
            len(absent),
        )
        assert cells[("table", language)] == 1, ("table", language)
    stem = [item for item in phase42 if "feature:stem_it" in item.tags]
    assert len(stem) == STEM_IT_ITEMS and {item.language for item in stem} == {"it"}
    assert len(phase42) == 3 * (3 + 4 + 2 + 1 + 1) + STEM_IT_ITEMS


def test_feature_tags_once_per_language(phase42):
    for tag, per_language in FEATURE_TAGS.items():
        counts = _counts(
            [item for item in phase42 if tag in item.tags], lambda item: item.language
        )
        assert {language: counts[language] for language in LANGUAGES} == {
            language: per_language for language in LANGUAGES
        }, (tag, counts)


def test_identifier_items_ask_in_different_spellings(phase42, documents):
    by_name = collections.defaultdict(list)
    for doc in documents:
        by_name[doc.filename].append(doc)
    for language in LANGUAGES:
        answerable = [
            item
            for item in phase42
            if item.language == language and item.category == "identifier_near_miss"
        ]
        absent = [
            item
            for item in phase42
            if item.language == language and item.category == "no_answer"
        ]
        for item in answerable + absent:
            asked = [tag[len(ASKED) :] for tag in item.tags if tag.startswith(ASKED)]
            assert len(asked) == 1 and asked[0], item.id
            assert asked[0] in item.question, item.id
        spellings = [
            next(tag[len(ASKED) :] for tag in item.tags if tag.startswith(ASKED))
            for item in answerable
        ]
        kinds = set()
        for spelling in spellings:
            if unicodedata.normalize("NFKC", spelling) != spelling:
                kinds.add("width")
            elif not re.search(r"[-_./\s]", spelling) and spelling == spelling.upper():
                kinds.add("separator")
            elif spelling == spelling.lower():
                kinds.add("case")
            else:
                kinds.add("mixed")
        assert kinds == {"separator", "case", "width", "mixed"}, (language, spellings)
        for item in answerable:
            asked = normalize_identifier(
                next(tag[len(ASKED) :] for tag in item.tags if tag.startswith(ASKED))
            )
            (span,) = item.gold_evidence
            assert asked in normalize_identifier(span.quote).replace(" ", ""), item.id
            assert item.answerable and span.document == f"coded-list-a.{language}.md"
        a_ids = {
            normalize_identifier(line[3:])
            for line in _raw_text(f"{language}/coded-list-a.{language}.md").splitlines()
            if line.startswith("## ")
        }
        b_ids = {
            normalize_identifier(line[3:])
            for line in _raw_text(f"{language}/coded-list-b.{language}.md").splitlines()
            if line.startswith("## ")
        }
        for item in absent:
            asked = normalize_identifier(
                next(tag[len(ASKED) :] for tag in item.tags if tag.startswith(ASKED))
            )
            assert (
                not item.answerable
                and not item.gold_evidence
                and "identifier_absent" in item.tags
            )
            assert asked not in a_ids | b_ids, item.id
            neighbours = [
                other for other in a_ids | b_ids if is_near_miss(asked, other)
            ]
            assert neighbours, item.id
        tenant = [item for item in answerable + absent if "tenant_pattern" in item.tags]
        assert len(tenant) == 1, language
        (tenant_item,) = tenant
        tenant_asked = next(
            tag[len(ASKED) :] for tag in tenant_item.tags if tag.startswith(ASKED)
        )
        assert not re.search(r"\d", unicodedata.normalize("NFKC", tenant_asked)), (
            tenant_item.id
        )


def test_duplicate_flood_items_have_one_copy_group_and_one_single_document_group(
    phase42,
):
    flood = [item for item in phase42 if item.category == "duplicate_flood"]
    assert len(flood) == 9
    for item in flood:
        assert item.answerable and item.evidence_groups is not None, item.id
        copies, single = item.evidence_groups
        assert copies == list(range(DUP_COPIES)) and single == [DUP_COPIES], item.id
        copy_documents = [item.gold_evidence[index].document for index in copies]
        assert copy_documents == [
            f"dup-passage-{n:02d}.{item.language}.md" for n in range(1, DUP_COPIES + 1)
        ], item.id
        assert len({item.gold_evidence[index].quote for index in copies}) == 1, item.id
        assert (
            item.gold_evidence[single[0]].document == f"dup-solo.{item.language}.md"
        ), item.id


def test_version_items_ask_across_both_versions(phase42):
    for item in [item for item in phase42 if "feature:versions" in item.tags]:
        assert (
            item.retrieval_filters is not None
            and item.retrieval_filters.versions == "all"
        ), item.id
        assert item.evidence_groups == [[0], [1]], item.id
        first, second = item.gold_evidence
        assert (
            first.document == second.document == f"versioned-note.{item.language}.md"
        ), item.id
        v1 = _raw_text(f"{item.language}/versioned-note.v1.{item.language}.md")
        v2 = _raw_text(f"{item.language}/versioned-note.v2.{item.language}.md")
        assert normalize_text(first.quote) in normalize_text(v1) and normalize_text(
            first.quote
        ) not in normalize_text(v2), item.id
        assert normalize_text(second.quote) in normalize_text(v2) and normalize_text(
            second.quote
        ) not in normalize_text(v1), item.id


def test_table_items_quote_one_row(phase42):
    for item in [item for item in phase42 if "feature:table_lookup" in item.tags]:
        (span,) = item.gold_evidence
        assert span.document == f"grid-reference.{item.language}.md", item.id
        rows = [
            line
            for line in _raw_text(f"{item.language}/{span.document}").splitlines()
            if line.startswith("|")
        ]
        matching = [
            row for row in rows if normalize_text(span.quote) in normalize_text(row)
        ]
        assert len(matching) == 1, (item.id, matching)
        cells = [cell.strip() for cell in matching[0].strip("|").split("|")]
        assert cells[0] in item.question and cells[1] in item.question, item.id


def test_stem_items_ask_the_singular_of_a_plural_only_word(phase42):
    for item in [item for item in phase42 if "feature:stem_it" in item.tags]:
        assert (
            "sgrombello" in item.question.casefold()
            and "sgrombelli" not in item.question.casefold()
        ), item.id
        (span,) = item.gold_evidence
        assert (
            span.document == "morphology-note.it.md"
            and "sgrombelli" in span.quote.casefold()
        ), item.id


def test_every_phase42_item_is_approved_synthetic_and_split(phase42):
    from rag_eval.split import assign_split

    for item in phase42:
        assert (
            item.review_status == "approved" and item.provenance == "synthetic_fixture"
        ), item.id
        assert item.split == assign_split(item.id), item.id
    for kind in ("duplicate_flood", "identifier_near_miss"):
        for language in LANGUAGES:
            splits = {
                item.split
                for item in phase42
                if item.category == kind and item.language == language
            }
            assert splits == {"dev", "test"}, (kind, language, splits)
    for tag in (*FEATURE_TAGS, "feature:stem_it", "tenant_pattern"):
        assert any(item.split == "dev" for item in phase42 if tag in item.tags), tag


def test_every_phase42_quote_is_found_in_its_loaded_document(phase42, documents):
    by_name = collections.defaultdict(list)
    for doc in documents:
        by_name[doc.filename].append(doc)
    for item in phase42:
        for span in item.gold_evidence:
            assert span.document in by_name, (item.id, span.document)
            chunks = [
                chunk
                for doc in by_name[span.document]
                for chunk in doc.chunks
                if chunk_matches_span(span.document, chunk.text, span)
            ]
            assert chunks, (item.id, span.document, span.quote)
            assert all(chunk.section == span.section for chunk in chunks), (
                item.id,
                span.section,
            )


# The 05.2-28 Phase 5.2 documents were written at the same time as these files and meet them only on these four common
# words (train 30). Both fixture baselines were re-recorded on the combined corpus with every earlier item unchanged; any
# other shared word, or one of these four in a pre-existing document, still fails.
CONCURRENT_P52_WORDS = {"basin", "closes", "griglia", "chiude"}
CONCURRENT_P52_FILES = {
    f"{language}/{name}.{language}.md"
    for language in ("en", "it", "zh")
    for name in ("p52-answers", "p52-rules-v1", "p52-rules-v2", "sec-links")
}


def test_new_documents_share_no_content_word_with_the_pre_existing_corpus(
    phase42, items
):
    old_words: dict[str, str] = {}
    old_bigrams: dict[str, str] = {}
    for relpath in _old_relpaths():
        text = _body(relpath)
        for word in _content_words(text):
            old_words.setdefault(word, relpath)
        for gram in _han_bigrams(text):
            old_bigrams.setdefault(gram, relpath)
    # Old questions too: a no_answer question must not start finding a new document (research pitfall 9).
    for item in items:
        if MARK in item.tags:
            continue
        for text in (item.question, *(turn.content for turn in item.conversation)):
            for word in _content_words(text):
                old_words.setdefault(word, f"golden:{item.id}")
            for gram in _han_bigrams(text):
                old_bigrams.setdefault(gram, f"golden:{item.id}")
    assert len(old_words) > 500 and len(old_bigrams) > 500
    for relpath in sorted(PHASE42_FILES):
        body = _body(relpath)
        for word in sorted(_content_words(body)):
            if word in CONCURRENT_P52_WORDS and old_words.get(word) in CONCURRENT_P52_FILES:
                continue
            assert word not in old_words, (word, relpath, old_words.get(word))
        for gram in sorted(_han_bigrams(body)):
            assert gram not in old_bigrams, (gram, relpath, old_bigrams.get(gram))


def test_phase42_text_uses_no_example_domain_word(phase42):
    texts = [_raw_text(relpath) for relpath in sorted(PHASE42_FILES)]
    texts += [
        text for item in phase42 for text in (item.question, item.expected_answer or "")
    ]
    for text in texts:
        folded = text.casefold()
        for word in DOMAIN_WORDS:
            if re.fullmatch(r"[a-z ]+", word):
                assert re.search(rf"\b{re.escape(word)}", folded) is None, (
                    word,
                    text[:80],
                )
            else:
                assert word not in folded, (word, text[:80])
