# API Coverage — Phase 1 external services

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Phase 1 calls external APIs only from eval tooling (nightly judge tier, live generation, golden drafting); the PR smoke tier calls none of them (127.0.0.1 fakes and stubs).

## OpenRouter (judge model and live eval generator; plans 01-08, 01-09, 01-12)

| capability | decision | reason |
|---|---|---|
| openrouter.chat-completions | INTEGRATE | |
| openrouter.structured-output-json-schema | INTEGRATE | |
| openrouter.temperature-control | INTEGRATE | |
| openrouter.streaming | OPT-OUT | not needed: judge scoring and eval answers consume complete responses |
| openrouter.tool-calling | OPT-OUT | not needed: eval generation reproduces today's prompt without tools; webSearch is out of the eval endpoint (web_search is fixed false) |
| openrouter.embeddings | OPT-OUT | not needed: Ragas embeddings use the OpenAI embeddings API already used by the app |
| openrouter.models-list | OPT-OUT | not needed: judge and generator ids are pinned in config |
| openrouter.provider-routing-preferences | OPT-OUT | not needed yet: pinned model id is sufficient for reproducibility in Phase 1 |
| openrouter.generation-stats-and-credits | OPT-OUT | not needed yet: cost tracking is not a Phase 1 requirement |

## Anthropic Messages API (golden-set drafting; plan 01-10)

| capability | decision | reason |
|---|---|---|
| anthropic.messages-create | INTEGRATE | |
| anthropic.tool-use-structured-output | INTEGRATE | |
| anthropic.streaming | OPT-OUT | not needed: drafted batches are validated as complete tool inputs |
| anthropic.message-batches | OPT-OUT | not needed yet: 50-200 items are drafted synchronously in a few calls |
| anthropic.prompt-caching | OPT-OUT | not needed yet: one-off drafting runs |
| anthropic.token-counting | OPT-OUT | not needed: document batches are sized by a character budget |
| anthropic.files-api | OPT-OUT | not needed: document text is sent inline from the workspace reader |
| anthropic.citations | OPT-OUT | explicitly out of scope: Claude Citations are Phase 5 (GEN-01) |
| anthropic.models-list | OPT-OUT | not needed: drafting model id is pinned in eval/config/draft.json |

## OpenAI API (Ragas answer-relevance embeddings; plan 01-09)

| capability | decision | reason |
|---|---|---|
| openai.embeddings | INTEGRATE | |
| openai.chat-completions | OPT-OUT | not needed: the judge runs through OpenRouter (D-15, D-22) |
| openai.other-endpoints (images, audio, files, batches) | OPT-OUT | explicitly out of scope for the eval tier |

## Supabase PostgREST (drafting workspace reader; plan 01-10)

| capability | decision | reason |
|---|---|---|
| supabase.select-documents | INTEGRATE | |
| supabase.select-document-chunks | INTEGRATE | |
| supabase.filters-eq-is-in | INTEGRATE | |
| supabase.pagination-limit-offset | INTEGRATE | |
| supabase.rpc-functions | OPT-OUT | not needed: drafting reads tables; the app's retrieval RPCs are existing code exercised through the eval route |
| supabase.insert-update-delete | OPT-OUT | explicitly out of scope: the drafting tool is read-only |
| supabase.storage | OPT-OUT | not needed: image files are not drafted into golden items |
| supabase.auth-user-sessions | OPT-OUT | not needed: the offline tool uses the service-role key with an explicit workspace filter |
| supabase.realtime | OPT-OUT | not needed |

## DeepEval / Confident AI hosted platform (plan 01-09)

| capability | decision | reason |
|---|---|---|
| deepeval.local-metrics-library | INTEGRATE | |
| deepeval.results-upload-and-dashboard | OPT-OUT | explicitly out of scope: document text must not leave for results hosting (prohibition in plan 01-09) |
| deepeval.telemetry | OPT-OUT | explicitly disabled by DEEPEVAL_TELEMETRY_OPT_OUT=1 (D-15) |

## Ragas (plans 01-09, 01-10)

| capability | decision | reason |
|---|---|---|
| ragas.collections-metrics | INTEGRATE | |
| ragas.testset-generation | INTEGRATE | |
| ragas.usage-tracking | OPT-OUT | explicitly disabled by RAGAS_DO_NOT_TRACK=true (D-15) |
| ragas.prompt-language-adaptation | OPT-OUT | not needed yet: not available on the collections metrics (research A4); zh/it judging is hand-checked at the first live run |
