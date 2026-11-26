import argparse


def _today() -> str:
    return ""


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.feedback_exports")
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--kind", required=True, choices=("dictionary", "training"))
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token-env", default="RAG_ADMIN_BEARER")
    parser.add_argument("--out")
    parser.parse_args(argv)
    return 0
