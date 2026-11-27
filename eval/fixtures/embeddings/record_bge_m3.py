import sys

REVISION = ""
MIN_COSINE = 0.0
MAX_COMPONENT_DIFF = 0.0


def l2(vector):
    return list(vector)


def compare_vectors(a, b):
    return 1.0, 0.0


def within_tolerance(cosine, diff):
    return True


def texts_sha256(path):
    return ""


def compare(a_path, b_path, out=sys.stdout):
    return 0


def record(mode, texts_path, embed_one, revision=REVISION):
    return {"vectors": {}}


def main(argv=None):
    return 0


if __name__ == "__main__":
    sys.exit(main())
