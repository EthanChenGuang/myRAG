EXIT_OK, EXIT_INPUT, EXIT_PRIVATE = 0, 2, 6
SKIP_NOTICE = "::notice::[Weekly Report] no private eval data; skipping"


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def main(argv=None) -> int:
    return EXIT_OK
