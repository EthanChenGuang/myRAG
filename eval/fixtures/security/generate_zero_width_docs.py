"""Deterministic generator for the zero-width fixtures (plan 03.2-40, D-33, D-46).

Run from the repository root:

    python3 eval/fixtures/security/generate_zero_width_docs.py --out eval/fixtures/security/text

The hidden fixture carries more zero-width characters than `zero_width_threshold` in config/rag/hidden-text-rules.json (5), spread
over U+200B, U+200C, U+200D, U+2060 and U+FEFF; it must be quarantined with a hidden_text reason and no chunk may keep one of them.
The clean fixtures carry a leading byte-order mark, which is not counted, and fewer zero-width characters than the threshold; they
are stripped and indexed, never quarantined. Text files only, standard library only, neutral synthetic prose in en, it and zh.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ZWSP, ZWNJ, ZWJ, WJ, BOM = "​", "‌", "‍", "⁠", "﻿"

HIDDEN = (
    "# Relay Notes\n\n"
    f"The blue{ZWSP} module{ZWSP} joins{ZWSP} the second{ZWNJ} relay{ZWJ} after the amber{WJ} light turns{BOM} steady.\n"
    f"The panel{ZWSP} stays closed during the night cycle and opens again at the first bell.\n"
)

CLEAN_BOM = (
    f"{BOM}# Note sul modulo\n\n"
    "Il modulo blu si collega al secondo relè dopo che la luce ambra resta accesa.\n"
    f"Il pannello resta chiuso{ZWSP} durante il ciclo notturno e si riapre al primo segnale.\n"
)

CLEAN_FEW = (
    "# 模块说明\n\n"
    f"蓝色模块在琥珀灯常亮后接入第二个继电器。{ZWJ}\n"
    f"面板在夜间周期保持关闭，{ZWNJ}在第一声铃响时重新打开。\n"
)

FIXTURES: dict[str, tuple[str, str, int]] = {
    # name: (text, expected, counted zero-width characters)
    "zero-width.md": (HIDDEN, "hidden_found", 8),
    "clean-bom.md": (CLEAN_BOM, "clean", 1),
    "clean-few.md": (CLEAN_FEW, "clean", 2),
}


def build_fixtures() -> dict[str, bytes]:
    return {name: text.encode("utf-8") for name, (text, _expected, _count) in FIXTURES.items()}


def manifest(built: dict[str, bytes]) -> dict:
    return {
        "generator": "eval/fixtures/security/generate_zero_width_docs.py",
        "fixtures": {
            name: {
                "sha256": hashlib.sha256(data).hexdigest(),
                "mime": "text/markdown",
                "expected": FIXTURES[name][1],
                "reason": "zero_width" if FIXTURES[name][1] == "hidden_found" else None,
                "zero_width": FIXTURES[name][2],
            }
            for name, data in built.items()
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "text")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    built = build_fixtures()
    for name, data in built.items():
        (args.out / name).write_bytes(data)
    (args.out / "manifest.json").write_text(
        json.dumps(manifest(built), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
