"""Deterministic generator for the judge calibration seed set (Phase 5.3 D-31).

Run from the repository root:

    uv run --directory eval python fixtures/judge-calibration/generate_seed.py
    uv run --directory eval python fixtures/judge-calibration/generate_seed.py --check

Every case is built from a structural template about a synthetic unit with an invented code and three
attributes (a level, a state and a cycle position). The answer kind fixes the labels by construction:

    supported       faithful, relevant
    off_question    faithful, not relevant (states another attribute the contexts give)
    unsupported     not faithful, relevant (states the asked attribute, which the contexts do not give)
    added_claim     not faithful, relevant (correct answer plus one statement the contexts do not give)
    off_unsupported not faithful, not relevant (states another attribute the contexts do not give)

The fifth kind keeps answer relevance between 40% and 60% positive per language. Generation uses the
standard library only; --check also validates every case as JudgeSeedCase.

Labels are constructed, not confirmed: every generated case is `draft`. Only a named human reviewer
(checkpoint H-5) may confirm labels, by editing review_status and reviewed_by in seed.jsonl and setting
LABEL_CONFIRMATION below to "confirmed". The generator never confirms a case; it carries a reviewer's
fields over from the committed file so that regenerating does not discard them.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any

LABEL_CONFIRMATION = "unconfirmed"

SEED = 5301
LANGUAGES = ("zh", "en", "it")
ATTRIBUTES = ("level", "state", "cycle")
KIND_COUNTS = (
    ("supported", 16),
    ("off_question", 14),
    ("unsupported", 8),
    ("added_claim", 8),
    ("off_unsupported", 14),
)
LENGTH_PAIRS_PER_LANGUAGE = 12
PERTURBATION_GROUPS_PER_LANGUAGE = 12
CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ"
STATES = {
    "zh": ("启用", "暂停", "关闭", "待命"),
    "en": ("active", "paused", "closed", "standby"),
    "it": ("attivo", "sospeso", "chiuso", "in attesa"),
}
LABELS = {
    "supported": (True, True, False),
    "off_question": (True, False, False),
    "unsupported": (False, True, True),
    "added_claim": (False, True, True),
    "off_unsupported": (False, False, True),
}
REVIEW_FIELDS = ("review_status", "reviewed_by")

OUT_PATH = Path(__file__).resolve().parent / "seed.jsonl"


def _value_text(lang: str, attribute: str, value: Any) -> str:
    if attribute == "level":
        return {"zh": f"等级为 {value}", "en": f"level {value}", "it": f"livello {value}"}[lang]
    if attribute == "state":
        return {"zh": f"状态为{value}", "en": f"in the {value} state", "it": f"nello stato {value}"}[lang]
    cycle, step = value
    return {
        "zh": f"位于第 {cycle} 周期第 {step} 步",
        "en": f"at cycle {cycle}, step {step}",
        "it": f"al ciclo {cycle}, passo {step}",
    }[lang]


def _fact(lang: str, code: str, attribute: str, value: Any) -> str:
    text = _value_text(lang, attribute, value)
    if lang == "zh":
        if attribute == "level":
            return f"单元 {code} 的{text}。"
        return f"单元 {code} {text}。"
    if lang == "en":
        verb = "has" if attribute == "level" else "is"
        return f"Unit {code} {verb} {text}."
    verb = "ha il" if attribute == "level" else "è"
    return f"L'unità {code} {verb} {text}."


def _context(lang: str, code: str, attribute: str, value: Any) -> str:
    lead = {
        "zh": "记录说明：",
        "en": "The record states the following.",
        "it": "Il registro riporta quanto segue.",
    }[lang]
    sep = "" if lang == "zh" else " "
    return f"{lead}{sep}{_fact(lang, code, attribute, value)}"


def _question(lang: str, code: str, attribute: str) -> str:
    return {
        "zh": {
            "level": f"单元 {code} 的等级是多少？",
            "state": f"单元 {code} 当前是什么状态？",
            "cycle": f"单元 {code} 位于哪个周期和哪一步？",
        },
        "en": {
            "level": f"What is the level of unit {code}?",
            "state": f"What state is unit {code} in?",
            "cycle": f"Which cycle and step is unit {code} at?",
        },
        "it": {
            "level": f"Qual è il livello dell'unità {code}?",
            "state": f"Qual è lo stato dell'unità {code}?",
            "cycle": f"Qual è il ciclo dell'unità {code} e a che passo si trova?",
        },
    }[lang][attribute]


def _short(lang: str, attribute: str, value: Any) -> str:
    if attribute == "level":
        return {"zh": f"等级 {value}。", "en": f"Level {value}.", "it": f"Livello {value}."}[lang]
    if attribute == "state":
        return {"zh": f"{value}。", "en": f"{value.capitalize()}.", "it": f"{value.capitalize()}."}[lang]
    cycle, step = value
    return {
        "zh": f"第 {cycle} 周期第 {step} 步。",
        "en": f"Cycle {cycle}, step {step}.",
        "it": f"Ciclo {cycle}, passo {step}.",
    }[lang]


def _also(lang: str, code: str, attribute: str, value: Any) -> str:
    text = _value_text(lang, attribute, value)
    if lang == "zh":
        joiner = "的" if attribute == "level" else ""
        return f"记录还说明，该单元{joiner}{text}。"
    if lang == "en":
        verb = "has" if attribute == "level" else "is"
        return f"The record also states that unit {code} {verb} {text}."
    verb = "ha il" if attribute == "level" else "è"
    return f"Il registro indica inoltre che l'unità {code} {verb} {text}."


def _added(lang: str, code: str, attribute: str, value: Any) -> str:
    text = _value_text(lang, attribute, value)
    if lang == "zh":
        joiner = "的" if attribute == "level" else ""
        return f"此外，该单元{joiner}{text}。"
    if lang == "en":
        verb = "has" if attribute == "level" else "is"
        return f"In addition, unit {code} {verb} {text}."
    verb = "ha il" if attribute == "level" else "è"
    return f"Inoltre l'unità {code} {verb} {text}."


def _restate(lang: str, answer: str) -> str:
    tail = {
        "zh": "换句话说，以上就是该单元的情况，记录中的这一点没有其他说明。",
        "en": "In other words, that is how the unit stands, and the record adds nothing further on this point.",
        "it": "In altre parole, questa è la situazione dell'unità, e il registro non aggiunge altro su questo punto.",
    }[lang]
    sep = "" if lang == "zh" else " "
    return f"{answer}{sep}{tail}"


def _assert(lang: str, answer: str) -> str:
    lead = {
        "zh": "毫无疑问，",
        "en": "Without any doubt: ",
        "it": "Senza alcun dubbio: ",
    }[lang]
    return f"{lead}{answer}"


def _random_value(rng: random.Random, lang: str, attribute: str, avoid: Any = None) -> Any:
    while True:
        if attribute == "level":
            value: Any = rng.randint(2, 98)
        elif attribute == "state":
            value = rng.choice(STATES[lang])
        else:
            value = (rng.randint(2, 40), rng.randint(1, 9))
        if value != avoid:
            return value


def _code(rng: random.Random, used: set[str]) -> str:
    while True:
        code = f"{rng.choice(CODE_LETTERS)}{rng.randint(2, 9)}{rng.choice(CODE_LETTERS)}-{rng.randint(10, 99)}"
        if code not in used:
            used.add(code)
            return code


def _case(
    case_id: str,
    lang: str,
    question: str,
    contexts: list[str],
    answer: str,
    kind: str,
    **extra: Any,
) -> dict[str, Any]:
    faithful, relevant, unsupported = LABELS[kind]
    case: dict[str, Any] = {
        "id": case_id,
        "language": lang,
        "question": question,
        "contexts": contexts,
        "answer": answer,
        "expected": {"faithfulness": faithful, "answer_relevance": relevant},
        "unsupported_content": unsupported,
        "variant": "base",
    }
    case.update(extra)
    case["review_status"] = "draft"
    return case


def _language_cases(lang: str) -> list[dict[str, Any]]:
    rng = random.Random(SEED + LANGUAGES.index(lang))
    kinds = [kind for kind, count in KIND_COUNTS for _ in range(count)]
    rng.shuffle(kinds)
    supported_indexes = [index for index, kind in enumerate(kinds) if kind == "supported"]
    pair_indexes = set(rng.sample(supported_indexes, LENGTH_PAIRS_PER_LANGUAGE))
    perturbation_indexes = set(rng.sample(range(len(kinds)), PERTURBATION_GROUPS_PER_LANGUAGE))
    used_codes: set[str] = set()
    sep = "" if lang == "zh" else " "
    cases: list[dict[str, Any]] = []

    for index, kind in enumerate(kinds):
        number = f"{index + 1:03d}"
        base_id = f"seed-{lang}-{number}"
        code = _code(rng, used_codes)
        asked = ATTRIBUTES[index % len(ATTRIBUTES)]
        others = [attribute for attribute in ATTRIBUTES if attribute != asked]
        rng.shuffle(others)
        given, absent = others
        values = {attribute: _random_value(rng, lang, attribute) for attribute in ATTRIBUTES}
        question = _question(lang, code, asked)

        if kind == "unsupported":
            contexts = [_context(lang, code, given, values[given]), _context(lang, code, absent, values[absent])]
            answer = _fact(lang, code, asked, values[asked])
        else:
            contexts = [_context(lang, code, asked, values[asked]), _context(lang, code, given, values[given])]
            if kind == "supported":
                answer = _fact(lang, code, asked, values[asked])
            elif kind == "off_question":
                answer = _fact(lang, code, given, values[given])
            elif kind == "added_claim":
                answer = f"{_fact(lang, code, asked, values[asked])}{sep}{_added(lang, code, absent, values[absent])}"
            else:
                answer = _fact(lang, code, absent, values[absent])

        cases.append(_case(base_id, lang, question, contexts, answer, kind))

        if index in pair_indexes:
            pair_id = f"seed-{lang}-pair-{number}"
            long_answer = f"{answer}{sep}{_also(lang, code, given, values[given])}"
            for variant, text in (("long", long_answer), ("short", _short(lang, asked, values[asked]))):
                cases.append(
                    _case(
                        f"{base_id}-{variant}",
                        lang,
                        question,
                        contexts,
                        text,
                        kind,
                        variant=variant,
                        base_id=base_id,
                        pair_id=pair_id,
                    )
                )

        if index in perturbation_indexes:
            group = f"seed-{lang}-pert-{number}"
            for variant, text in (("expanded", _restate(lang, answer)), ("assertive", _assert(lang, answer))):
                cases.append(
                    _case(
                        f"{base_id}-{variant}",
                        lang,
                        question,
                        contexts,
                        text,
                        kind,
                        variant=variant,
                        base_id=base_id,
                        perturbation_group=group,
                    )
                )
    return cases


def build_cases() -> list[dict[str, Any]]:
    return [case for lang in LANGUAGES for case in _language_cases(lang)]


def _committed_reviews(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    reviews: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("review_status", "draft") != "draft":
            reviews[row["id"]] = {field: row[field] for field in REVIEW_FIELDS if field in row}
    return reviews


def render(cases: list[dict[str, Any]], reviews: dict[str, dict[str, Any]]) -> str:
    lines = []
    for case in cases:
        row = dict(case)
        row.update(reviews.get(row["id"], {}))
        lines.append(json.dumps(row, ensure_ascii=False))
    return "\n".join(lines) + "\n"


def _validate(text: str) -> list[str]:
    from rag_sidecar.contracts.judge_calibration import JudgeSeedCase

    errors = []
    for number, line in enumerate(text.splitlines(), start=1):
        try:
            JudgeSeedCase.model_validate_json(line)
        except ValueError as exc:
            errors.append(f"line {number}: {exc}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 when the committed file differs")
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    args = parser.parse_args(argv)

    text = render(build_cases(), _committed_reviews(args.out))
    if args.check:
        errors = _validate(text)
        for error in errors:
            print(f"[Judge Seed] invalid case {error}", file=sys.stderr)
        committed = args.out.read_text(encoding="utf-8") if args.out.exists() else None
        if committed != text:
            print(f"[Judge Seed] {args.out} differs from the generator output", file=sys.stderr)
            return 1
        return 1 if errors else 0
    args.out.write_text(text, encoding="utf-8")
    print(f"[Judge Seed] wrote {len(text.splitlines())} cases to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
