"""Optional keys that are left out of the serialised object when unset (Phase 5.1.1 D-03a, D-29).

The JSON Schema of such a field is the plain value schema without a default, so the generated Zod schema treats
the key as optional and a parse of an object without it adds nothing.
"""

from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


def omit_none_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    any_of = schema.pop("anyOf", None)
    if any_of:
        values = [entry for entry in any_of if entry.get("type") != "null"]
        if len(values) != 1:
            raise ValueError("omit_none_schema expects exactly one non-null branch")
        schema.update(values[0])


class OmitNoneModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    _omit_when_none: ClassVar[tuple[str, ...]] = ()

    @model_serializer(mode="wrap")
    def _drop_unset(self, handler: SerializerFunctionWrapHandler):  # noqa: ANN202 - an annotation would replace the field schema
        data = handler(self)
        for key in self._omit_when_none:
            if key in data and data[key] is None:
                del data[key]
        return data
