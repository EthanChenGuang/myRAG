"""Writes bge-m3-texts.json: synthetic, subject-neutral texts in zh, en and it for the BGE-M3 identity fixture (D-26).

Per language several short texts and one long text close to the app's input limit for this profile (4096 cl100k_base
tokens, BGE_M3_APP_INPUT_TOKEN_LIMIT, and the 20,000-character EmbedRequest limit). The output is deterministic:
running this script again must give the committed bytes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "bge-m3-texts.json"
LONG_MAX_CL100K_TOKENS = 4000
LONG_MAX_CHARS = 19_500

SHORT: dict[str, list[str]] = {
    "zh": [
        "夜空中最亮的行星常在黄昏后出现在西方低空。",
        "这条河流在雨季会把上游的细沙带到下游的平原。",
        "陶工把湿润的黏土放在转盘中央，慢慢拉出碗的形状。",
        "候鸟在秋天沿着海岸线向南飞行，途中会在湿地停留。",
    ],
    "en": [
        "The brightest planet often appears low in the western sky shortly after dusk.",
        "During the wet season the river carries fine sand from the hills down to the plain.",
        "A potter centres the damp clay on the wheel and slowly raises the walls of a bowl.",
        "Migrating birds follow the coastline south in autumn and rest in the marshes along the way.",
    ],
    "it": [
        "Il pianeta più luminoso appare spesso basso nel cielo a ovest poco dopo il tramonto.",
        "Nella stagione delle piogge il fiume trasporta sabbia fine dalle colline fino alla pianura.",
        "Il vasaio centra l'argilla umida sul tornio e solleva lentamente le pareti di una ciotola.",
        "Gli uccelli migratori seguono la costa verso sud in autunno e sostano nelle paludi lungo il percorso.",
    ],
}

# Long texts: every sentence is built from one subject, one action and one detail, in a fixed order.
LONG_PARTS: dict[str, tuple[list[str], list[str], list[str], str]] = {
    "zh": (
        ["山谷里的冰川", "海边的灯塔", "城外的石桥", "古老的天文台", "高原上的湖泊", "森林里的苔藓", "沙漠中的沙丘", "峡湾里的潮水"],
        ["在清晨缓慢地改变着形状", "在风雨中保持着稳定", "随着季节交替呈现不同的颜色", "被研究者用仪器仔细记录", "在夜晚反射着微弱的光", "每年都向前移动一小段距离"],
        ["测量结果被整理成表格供以后比较。", "附近的岩层记录了很久以前的气候。", "观察者注意到温度和湿度的细小变化。", "这种现象在每年的同一时期重复出现。", "地图上的等高线清楚地显示了这一点。", "长期的观测数据让变化的规律更加明显。"],
        "",
    ),
    "en": (
        ["The valley glacier", "The coastal lighthouse", "The old stone bridge", "The hilltop observatory", "The mountain lake", "The forest moss", "The desert dune", "The fjord tide"],
        ["changes its outline slowly in the early morning", "stays steady through wind and rain", "shows a different colour as the seasons turn", "is recorded carefully by instruments", "reflects a faint light during the night", "moves a short distance forward every year"],
        ["the measurements are kept in tables for later comparison.", "the nearby rock layers preserve a climate of long ago.", "observers note small shifts in temperature and humidity.", "the same pattern returns at the same time each year.", "the contour lines on the map show this clearly.", "long series of observations make the pattern easier to see."],
        " ",
    ),
    "it": (
        ["Il ghiacciaio della valle", "Il faro sulla costa", "Il vecchio ponte di pietra", "L'osservatorio sulla collina", "Il lago di montagna", "Il muschio del bosco", "La duna del deserto", "La marea del fiordo"],
        ["cambia lentamente forma al mattino presto", "resta stabile con il vento e la pioggia", "mostra un colore diverso al cambio delle stagioni", "viene registrato con cura dagli strumenti", "riflette una luce debole durante la notte", "avanza di un breve tratto ogni anno"],
        ["le misure sono raccolte in tabelle per confronti futuri.", "gli strati di roccia vicini conservano un clima di molto tempo fa.", "gli osservatori notano piccoli cambiamenti di temperatura e umidità.", "lo stesso andamento ritorna nello stesso periodo ogni anno.", "le curve di livello sulla carta lo mostrano con chiarezza.", "lunghe serie di osservazioni rendono il fenomeno più evidente."],
        " ",
    ),
}


def _sentence(language: str, index: int) -> str:
    subjects, actions, details, _ = LONG_PARTS[language]
    subject = subjects[index % len(subjects)]
    action = actions[(index // len(subjects)) % len(actions)]
    detail = details[(index * 5 + index // 7) % len(details)]
    if language == "zh":
        return f"{subject}{action}，{detail}"
    return f"{subject} {action}, and {detail}" if language == "en" else f"{subject} {action}, e {detail}"


def _long_text(language: str, count_tokens) -> str:
    separator = LONG_PARTS[language][3]
    sentences: list[str] = []
    index = 0
    while True:
        candidate = separator.join([*sentences, _sentence(language, index)])
        if len(candidate) > LONG_MAX_CHARS or count_tokens(candidate) > LONG_MAX_CL100K_TOKENS:
            return separator.join(sentences)
        sentences.append(_sentence(language, index))
        index += 1


def build(count_tokens) -> dict:
    texts: list[dict] = []
    for language in ("zh", "en", "it"):
        for number, text in enumerate(SHORT[language], start=1):
            texts.append({"id": f"{language}-short-{number}", "language": language, "kind": "short", "text": text})
        texts.append({"id": f"{language}-long-1", "language": language, "kind": "long", "text": _long_text(language, count_tokens)})
    return {"schema_version": 1, "note": "synthetic subject-neutral texts; generated by generate_texts.py", "texts": texts}


def render(count_tokens) -> str:
    return json.dumps(build(count_tokens), ensure_ascii=False, indent=1) + "\n"


def _cl100k():
    import tiktoken

    encoding = tiktoken.get_encoding("cl100k_base")
    return lambda text: len(encoding.encode(text))


if __name__ == "__main__":
    OUT.write_text(render(_cl100k()), encoding="utf-8")
    print(f"wrote {OUT}", file=sys.stderr)
