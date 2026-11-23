import types
import typing
from typing import Any

import rag_eval.judge  # noqa: F401  (applies the telemetry opt-out before the judge libraries load)
from deepeval.models import DeepEvalBaseLLM
from pydantic import BaseModel
from ragas.embeddings.base import BaseRagasEmbedding
from ragas.llms.base import InstructorBaseRagasLLM

FAIL_MARKER = "STUB-JUDGE-FAIL"


def _fill_annotation(annotation: Any, name: str) -> Any:
    origin = typing.get_origin(annotation)
    if origin is typing.Literal:
        values = typing.get_args(annotation)
        return "yes" if "yes" in values else values[0]
    if origin in (typing.Union, types.UnionType):
        options = [arg for arg in typing.get_args(annotation) if arg is not type(None)]
        return _fill_annotation(options[0], name)
    if origin in (list, typing.List):
        (inner,) = typing.get_args(annotation) or (str,)
        return [_fill_annotation(inner, name)]
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return fill_model(annotation)
    if annotation is bool:
        return True
    if annotation is int:
        return 1
    if annotation is float:
        return 1.0
    if annotation is str:
        return "yes" if "verdict" in name else "stub"
    if isinstance(annotation, type) and hasattr(annotation, "__members__"):
        members = list(annotation)
        for member in members:
            if str(member.value).lower() == "yes":
                return member
        return members[0]
    return "stub"


def fill_model(model: type[BaseModel]) -> BaseModel:
    values = {name: _fill_annotation(field.annotation, name) for name, field in model.model_fields.items()}
    return model.model_validate(values)


class StubDeepEvalLLM(DeepEvalBaseLLM):
    def __init__(self) -> None:
        super().__init__(model="stub-judge")
        self.calls = 0

    def load_model(self) -> "StubDeepEvalLLM":
        return self

    def _respond(self, prompt: str, schema: type[BaseModel] | None) -> Any:
        self.calls += 1
        if FAIL_MARKER in prompt:
            raise RuntimeError("stub judge refused to answer")
        if schema is None:
            return "stub"
        return fill_model(schema)

    def generate(self, prompt: str, schema: type[BaseModel] | None = None) -> Any:
        return self._respond(prompt, schema)

    async def a_generate(self, prompt: str, schema: type[BaseModel] | None = None) -> Any:
        return self._respond(prompt, schema)

    def get_model_name(self) -> str:
        return "stub-judge"


class StubRagasLLM(InstructorBaseRagasLLM):
    def __init__(self) -> None:
        self.calls = 0

    def _respond(self, prompt: str, response_model: type[BaseModel]) -> Any:
        self.calls += 1
        if FAIL_MARKER in prompt:
            raise RuntimeError("stub judge refused to answer")
        return fill_model(response_model)

    def generate(self, prompt: str, response_model: type[BaseModel]) -> Any:
        return self._respond(prompt, response_model)

    async def agenerate(self, prompt: str, response_model: type[BaseModel]) -> Any:
        return self._respond(prompt, response_model)


class StubEmbeddings(BaseRagasEmbedding):
    def embed_text(self, text: str, **kwargs: Any) -> list[float]:
        return [1.0, 0.0, 0.0]

    async def aembed_text(self, text: str, **kwargs: Any) -> list[float]:
        return [1.0, 0.0, 0.0]
