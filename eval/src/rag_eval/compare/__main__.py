import argparse
import sys

from rag_eval.compare import frameworks


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="rag_eval.compare", description="myRAG eval comparisons")
    parser.add_argument("command", choices=("frameworks",))
    parsed, rest = parser.parse_known_args(args[:1])
    if parsed.command == "frameworks":
        return frameworks.main(args[1:] + rest)
    return frameworks.EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
