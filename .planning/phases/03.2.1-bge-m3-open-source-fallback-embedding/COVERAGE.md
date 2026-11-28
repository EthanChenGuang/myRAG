# API Coverage — DeepInfra embeddings endpoint (BAAI/bge-m3)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> Phase 3.2.1 adds one model to an external API the app already calls: DeepInfra's OpenAI-compatible embeddings endpoint (plans 01 to 03 and 05). The sidecar route `POST /v1/embed` is an internal service and is not listed. These rows were part of the Phase 3.2 matrix until EMB-11 moved here.

| capability | decision | reason |
|---|---|---|
| deepinfra.embeddings.create_dense | INTEGRATE | |
| deepinfra.embeddings.input_array | INTEGRATE | |
| deepinfra.embeddings.encoding_format_float | INTEGRATE | |
| deepinfra.embeddings.usage_token_counts | INTEGRATE | |
| deepinfra.embeddings.response_index | INTEGRATE | |
| deepinfra.embeddings.encoding_format_base64 | OPT-OUT | not needed: the identity check and the stored vectors use float values |
| deepinfra.embeddings.dimensions_parameter | OPT-OUT | not applicable: BAAI/bge-m3 has one fixed dimension (1024) and the provider sends no dimension |
| deepinfra.bge_m3.sparse_output | OPT-OUT | explicitly out of scope: only the dense output is used (CONTEXT Deferred Ideas; the lexical path covers sparse matching) |
| deepinfra.bge_m3.multi_vector_output | OPT-OUT | explicitly out of scope: only the dense output is used (CONTEXT Deferred Ideas) |
| deepinfra.native_inference_endpoint | OPT-OUT | not needed: the OpenAI-compatible endpoint is used, as the existing Qwen provider does |
