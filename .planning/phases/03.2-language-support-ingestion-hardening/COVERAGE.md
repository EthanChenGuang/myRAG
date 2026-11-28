# API Coverage — LlamaParse OCR languages

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> Phase 3.2 sends one more parameter to an external API the app already calls: the LlamaParse OCR language list (plans 21 and 24). The sidecar route `POST /v1/hidden-text` is an internal service and is not listed. The DeepInfra BGE-M3 capabilities that were listed here moved with EMB-11 to Phase 3.2.1 (`.planning/phases/03.2.1-bge-m3-open-source-fallback-embedding/COVERAGE.md`).

| capability | decision | reason |
|---|---|---|
| llamaparse.v2.ocr_parameters.languages | INTEGRATE | |
| llamaparse.v1.language_form_field | INTEGRATE | |
| llamaparse.other_ocr_parameters | OPT-OUT | not needed: this phase changes only the OCR language list; other parse options stay as Phases 3 and 3.1 set them |
