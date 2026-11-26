import hashlib
import json
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from rag_sidecar.contracts.golden import (
    DOCGROUP_SPLIT_RULE,
    ITEM_SPLIT_RULE,
    GoldenItem,
    GoldenSplitManifest,
    GoldSpan,
)

SPLIT_RULE = ITEM_SPLIT_RULE
NEAR_DUPLICATE_TAG = "near_duplicate_confirmed:"


def assign_split(item_id: str) -> str:
    bucket = int(hashlib.sha256(item_id.encode()).hexdigest()[:8], 16) % 100
    return "dev" if bucket < 70 else "test"


def load_manifest(path: Path) -> dict[str, str]:
    path = Path(path)
    if not path.exists():
        return {}
    manifest = GoldenSplitManifest.model_validate_json(path.read_text(encoding="utf-8"))
    return dict(manifest.assignments)


def write_manifest(path: Path, assignments: dict[str, str]) -> None:
    path = Path(path)
    manifest = GoldenSplitManifest(rule=SPLIT_RULE, assignments=assignments)
    payload = json.dumps(manifest.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


def _manifest_rule(path: Path) -> str | None:
    path = Path(path)
    if not path.exists():
        return None
    return GoldenSplitManifest.model_validate_json(path.read_text(encoding="utf-8")).rule


def freeze_splits(items: list[GoldenItem], manifest_path: Path) -> list[GoldenItem]:
    if _manifest_rule(manifest_path) == DOCGROUP_SPLIT_RULE:
        raise ValueError(f"{manifest_path} uses the {DOCGROUP_SPLIT_RULE} rule; a manifest never switches rule")
    assignments = load_manifest(manifest_path)
    seen: set[str] = set()
    frozen: list[GoldenItem] = []
    added = False
    for item in items:
        if item.id in seen:
            raise ValueError(f"duplicate golden item id: {item.id}")
        seen.add(item.id)
        recorded = assignments.get(item.id)
        if recorded is None:
            recorded = assign_split(item.id)
            assignments[item.id] = recorded
            added = True
        elif item.split != recorded:
            raise ValueError(
                f"item {item.id} has split {item.split!r} but the manifest froze {recorded!r}"
            )
        frozen.append(item if item.split == recorded else item.model_copy(update={"split": recorded}))
    if added:
        write_manifest(manifest_path, assignments)
    return frozen



# --- Document-group rule (D-21, D-29) ---


def _bucket(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 100


def assign_group_split(key: str) -> str:
    """Split of a brand-new group, from the smallest document key in it."""
    return "dev" if _bucket(key) < 70 else "test"


def group_id(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def document_key(span: GoldSpan) -> str:
    """The span's document id when it has one (D-29), else its document name."""
    if span.document_id:
        return span.document_id.lower()
    return "name:" + span.document.casefold()


def _item_keys(item: GoldenItem) -> list[str]:
    keys = sorted({document_key(span) for span in item.gold_evidence})
    return keys or [f"item:{item.id}"]


def _confirmed_pairs(items: Iterable[GoldenItem]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for item in items:
        for tag in item.tags:
            if tag.startswith(NEAR_DUPLICATE_TAG):
                pairs.append((item.id, tag[len(NEAR_DUPLICATE_TAG):]))
    return pairs


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, node: str) -> str:
        self.parent.setdefault(node, node)
        root = node
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[node] != root:
            self.parent[node], node = root, self.parent[node]
        return root

    def union(self, left: str, right: str) -> None:
        a, b = self.find(left), self.find(right)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


def _components(items: list[GoldenItem], pairs: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    """Item id -> sorted document keys of its group (union over shared documents and confirmed near-duplicates)."""
    uf = _UnionFind()
    known = {item.id for item in items}
    for item in items:
        node = f"id:{item.id}"
        for key in _item_keys(item):
            uf.union(node, f"key:{key}")
    for left, right in [*_confirmed_pairs(items), *pairs]:
        if left in known and right in known:
            uf.union(f"id:{left}", f"id:{right}")
    keys_by_root: dict[str, set[str]] = {}
    for item in items:
        for key in _item_keys(item):
            keys_by_root.setdefault(uf.find(f"key:{key}"), set()).add(key)
    return {item.id: sorted(keys_by_root[uf.find(f"id:{item.id}")]) for item in items}


def document_groups(items: list[GoldenItem], pairs: Iterable[tuple[str, str]] = ()) -> dict[str, str]:
    """Item id -> group id, sha256 of the smallest document key of its group."""
    return {item_id: group_id(keys[0]) for item_id, keys in _components(list(items), pairs).items()}


def load_group_manifest(path: Path) -> GoldenSplitManifest | None:
    path = Path(path)
    if not path.exists():
        return None
    return GoldenSplitManifest.model_validate_json(path.read_text(encoding="utf-8"))


def write_group_manifest(path: Path, assignments: dict[str, str], group_assignments: dict[str, str]) -> None:
    path = Path(path)
    manifest = GoldenSplitManifest(rule=DOCGROUP_SPLIT_RULE, assignments=assignments, group_assignments=group_assignments)
    payload = json.dumps(manifest.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


@dataclass(frozen=True)
class GroupSplitPlan:
    items: list[GoldenItem]
    assignments: dict[str, str]
    group_assignments: dict[str, str]
    item_groups: dict[str, str]
    changed: bool


def plan_group_splits(
    items: list[GoldenItem], manifest_path: Path, pairs: Iterable[tuple[str, str]] = ()
) -> GroupSplitPlan:
    """Compute the frozen docgroup splits without writing; raises ValueError on any conflict."""
    manifest = load_group_manifest(manifest_path)
    if manifest is not None and manifest.rule != DOCGROUP_SPLIT_RULE:
        raise ValueError(f"{manifest_path} uses the {manifest.rule} rule; a manifest never switches rule")
    assignments = dict(manifest.assignments) if manifest else {}
    group_assignments = dict(manifest.group_assignments or {}) if manifest else {}

    ids = [item.id for item in items]
    duplicates = sorted({item_id for item_id in ids if ids.count(item_id) > 1})
    if duplicates:
        raise ValueError(f"duplicate golden item id: {duplicates[0]}")
    missing = sorted(set(assignments) - set(ids))
    if missing:
        raise ValueError(f"split manifest lists items that are not in the golden set: {', '.join(missing)}")

    components = _components(list(items), pairs)
    members: dict[str, list[str]] = {}
    for item_id, keys in components.items():
        members.setdefault(keys[0], []).append(item_id)

    split_of: dict[str, str] = {}
    for min_key, member_ids in members.items():
        gid = group_id(min_key)
        frozen = {assignments[item_id] for item_id in member_ids if item_id in assignments}
        if gid in group_assignments:
            frozen.add(group_assignments[gid])
        if len(frozen) > 1:
            raise ValueError(
                f"group {gid[:16]} would join items frozen in dev and test ({', '.join(sorted(member_ids))}); "
                "a frozen split never moves"
            )
        split = frozen.pop() if frozen else assign_group_split(min_key)
        for item_id in member_ids:
            split_of[item_id] = split

    out: list[GoldenItem] = []
    changed = False
    for item in items:
        split = split_of[item.id]
        recorded = assignments.get(item.id)
        if recorded is not None and item.split != recorded:
            raise ValueError(f"item {item.id} has split {item.split!r} but the manifest froze {recorded!r}")
        if recorded is None:
            assignments[item.id] = split
            changed = True
        out.append(item if item.split == split else item.model_copy(update={"split": split}))

    item_groups = {item_id: group_id(keys[0]) for item_id, keys in components.items()}
    for item_id, gid in item_groups.items():
        if gid not in group_assignments:
            group_assignments[gid] = split_of[item_id]
            changed = True
    return GroupSplitPlan(out, assignments, group_assignments, item_groups, changed or manifest is None)


def freeze_group_splits(
    items: list[GoldenItem], manifest_path: Path, pairs: Iterable[tuple[str, str]] = ()
) -> list[GoldenItem]:
    """D-21: freeze splits by document group in a docgroup-rule manifest; adding items never moves a frozen one."""
    plan = plan_group_splits(items, manifest_path, pairs)
    if plan.changed:
        write_group_manifest(manifest_path, plan.assignments, plan.group_assignments)
    return plan.items
