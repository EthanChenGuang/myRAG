from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

BGE_M3_MODEL = "BAAI/bge-m3"
BGE_M3_DIMS = 1024
MAX_EMBED_INPUTS = 32
MAX_EMBED_INPUT_CHARS = 20_000

EmbedInput = Annotated[str, Field(min_length=1, max_length=MAX_EMBED_INPUT_CHARS)]
EmbedVector = Annotated[list[float], Field(min_length=BGE_M3_DIMS, max_length=BGE_M3_DIMS)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class EmbedRequest(_Contract):
    """Sidecar `POST /v1/embed` request (D-26)."""

    model: Literal["BAAI/bge-m3"] = BGE_M3_MODEL
    inputs: list[EmbedInput] = Field(min_length=1, max_length=MAX_EMBED_INPUTS)


class EmbedResponse(_Contract):
    """One L2-normalized dense vector per input, in input order (D-26)."""

    model: Literal["BAAI/bge-m3"] = BGE_M3_MODEL
    revision: str = Field(min_length=1, max_length=64)
    dims: Literal[1024] = BGE_M3_DIMS
    vectors: list[EmbedVector] = Field(min_length=1, max_length=MAX_EMBED_INPUTS)

    @model_validator(mode="after")
    def _dims_match(self) -> "EmbedResponse":
        if any(len(vector) != self.dims for vector in self.vectors):
            raise ValueError("every vector must have dims components")
        return self
