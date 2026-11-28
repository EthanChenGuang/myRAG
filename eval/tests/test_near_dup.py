import pytest

from rag_eval.near_dup import NEAR_DUPLICATE_THRESHOLD, jaccard, near_duplicates

LONG_ZH = "系统管理员在每个工作日结束之前需要检查所有上传到共享目录里的文件是否完整"

PAIRS = [
    ("en exact repeat", "How many inputs does the widget accept?", "How many inputs does the widget accept?", True),
    ("en spacing and punctuation", "How many inputs does the widget accept?", "how many inputs, does the widget accept", True),
    ("en different question", "How many inputs does the widget accept?", "Where is the widget manual stored?", False),
    ("zh exact repeat", "系统每次最多可以上传几个文件", "系统每次最多可以上传几个文件", True),
    ("zh punctuation only", "系统每次最多可以上传几个文件？", "系统每次，最多可以上传几个文件", True),
    ("zh long, one measure word at the end", LONG_ZH + "个", LONG_ZH + "份", True),
    ("zh short, one measure word in the middle", "系统每次最多可以上传几个文件", "系统每次最多可以上传几份文件", False),
    ("zh unrelated", "系统每次最多可以上传几个文件", "共享目录由谁负责维护", False),
]


def test_threshold_pinned():
    assert NEAR_DUPLICATE_THRESHOLD == 0.85


@pytest.mark.parametrize(("label", "left", "right", "expected"), PAIRS, ids=[row[0] for row in PAIRS])
def test_fixture_pairs(label, left, right, expected):
    score = jaccard(left, right)
    assert (score >= NEAR_DUPLICATE_THRESHOLD) is expected, f"{label}: {score:.3f}"
    pairs = near_duplicates([("item-a", left), ("item-b", right)])
    assert bool(pairs) is expected
    if expected:
        ((a, b, value),) = pairs
        assert (a, b) == ("item-a", "item-b") and value == pytest.approx(score)


def test_jaccard_is_symmetric_and_bounded():
    left, right = "系统每次最多可以上传几个文件", "系统每次最多可以上传几份文件"
    assert jaccard(left, right) == jaccard(right, left)
    assert 0 < jaccard(left, right) < 1
    assert jaccard("abc", "abc") == 1.0
    assert jaccard("", "abc") == 0.0


def test_short_texts_compare_as_whole_strings():
    assert jaccard("ab", "AB") == 1.0
    assert jaccard("ab", "ac") == 0.0


def test_near_duplicates_lists_every_pair_once_in_input_order():
    rows = [("x-1", "How many inputs does the widget accept?"), ("x-2", "Where is the manual?"), ("x-3", "how many inputs does the widget accept")]
    assert [(a, b) for a, b, _ in near_duplicates(rows)] == [("x-1", "x-3")]
