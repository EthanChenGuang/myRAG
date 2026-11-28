"""Walks a model's JSON Schema and lists every string or mapping key that is not constrained (D-26)."""

from typing import Any

from pydantic import BaseModel


def _constrained_string(node: dict[str, Any]) -> bool:
    return any(key in node for key in ("pattern", "enum", "const", "format"))


def unconstrained_strings(model: type[BaseModel], *, allow: frozenset[str] = frozenset()) -> list[str]:
    schema = model.model_json_schema(mode="serialization")
    defs = schema.get("$defs", {})
    found: list[str] = []

    def visit(node: Any, path: str) -> None:
        if isinstance(node, list):
            for index, entry in enumerate(node):
                visit(entry, f"{path}[{index}]")
            return
        if not isinstance(node, dict):
            return
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[-1]
            if f"#{name}" not in seen:
                seen.add(f"#{name}")
                visit(defs[name], f"{path}->{name}")
            return
        if node.get("type") == "string" and not _constrained_string(node):
            found.append(path)
        additional = node.get("additionalProperties")
        if isinstance(additional, dict):
            names = node.get("propertyNames")
            if not isinstance(names, dict) or not _constrained_string(names):
                found.append(f"{path}{{keys}}")
            visit(additional, f"{path}{{}}")
        for key, child in (node.get("properties") or {}).items():
            child_path = f"{path}.{key}"
            if key in allow:
                continue
            visit(child, child_path)
        for key in ("items", "anyOf", "oneOf", "allOf", "prefixItems"):
            if key in node:
                visit(node[key], path)

    seen: set[str] = set()
    visit(schema, model.__name__)
    return found


FREE_TEXT_NAMES = ("message", "query", "answer", "note", "question", "content", "text", "value", "before", "after")
