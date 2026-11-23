import argparse
import sys
from pathlib import Path

from pydantic import BaseModel, ValidationError

from rag_sidecar import contracts


def _lookup(name: str) -> type[BaseModel] | None:
    candidate = getattr(contracts, name, None)
    if isinstance(candidate, type) and issubclass(candidate, BaseModel):
        return candidate
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.contracts.validate")
    parser.add_argument("--model", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--jsonl", type=Path)
    source.add_argument("--json", type=Path)
    args = parser.parse_args(argv)

    model = _lookup(args.model)
    if model is None:
        print(f"[contracts.validate] unknown model: {args.model}", file=sys.stderr)
        return 2

    if args.json is not None:
        try:
            model.model_validate_json(args.json.read_text(encoding="utf-8"))
        except ValidationError as error:
            print(f"[contracts.validate] {args.json}: {error}", file=sys.stderr)
            return 1
        print(f"[contracts.validate] {args.json}: valid {args.model}")
        return 0

    count = 0
    with args.jsonl.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                model.model_validate_json(line)
            except ValidationError as error:
                print(
                    f"[contracts.validate] {args.jsonl}:{line_number}: {error}",
                    file=sys.stderr,
                )
                return 1
            count += 1
    print(f"[contracts.validate] {args.jsonl}: {count} valid {args.model} line(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
