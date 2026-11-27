BGE_M3_REVISION = ""
BGE_M3_MAX_MODEL_TOKENS = 0


class EmbedInputTooLong(ValueError):
    def __init__(self, index: int, limit: int) -> None:
        super().__init__("")
        self.index = index
        self.limit = limit


class BgeM3Embedder:
    def __init__(self, model, tokenizer, *, revision: str) -> None:
        self.revision = revision

    def embed(self, texts: list[str]) -> list[list[float]]:
        return []


def resolve_embedder(settings):
    return None
