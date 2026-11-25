# Phase 7: External Backends & Release Defaults - Discussion Log

> **Audit trail only.** Do not use this file as input to planning, research or execution agents.
> The decisions are in CONTEXT.md. This log keeps the alternatives that were considered.

**Date:** 2026-11-24
**Phase:** 07-external-backends-release-defaults
**Mode:** `--auto`. The recommended option was chosen for every question, per the user's standing instruction.
**Areas discussed:** Outbox shape, Worker hosting, Collections per profile, External payload, Tenant isolation layers, Re-validation, Readiness and fallback, Voice backend, Lexical parity, Canary seeding, Config UI coverage, Test-connection, Regression design, Default decision rule, Inventory format, Review-queue promotion, Failure report

---

## Outbox shape
| Option | Selected |
|---|---|
| Notification-only outbox with triggers; no-op when no target is enabled | ✓ |
| An outbox with a payload snapshot | |
| Dual-write from ingestion | |

## Worker hosting
| Option | Selected |
|---|---|
| A TS drain route time-sliced under 60 s, plus an after() kick, plus Vercel Cron or pg_cron + pg_net, plus a CLI | ✓ |
| The Python sidecar worker | |
| A dedicated always-on Node service | |

## Collections per profile
| Option | Selected |
|---|---|
| One collection per embedding profile on both backends | ✓ |
| Weaviate named vectors per profile in one collection | |

## External payload
| Option | Selected |
|---|---|
| Vectors, `lexical_text` and filter fields only; hydration from Supabase | ✓ |
| The full chunk text and metadata | |

## Tenant isolation layers
| Option | Selected |
|---|---|
| Adapter tenancy, then re-validation, then servable-only sync, then canaries (including a planted foreign point) | ✓ |
| Adapter tenancy only | |

## Re-validation
| Option | Selected |
|---|---|
| A server-only RPC with the tenant_key predicate, through the admin client (the Phase 4 pattern) | ✓ |
| A query with the user JWT under RLS | |

[auto] Phase 4 put v2 retrieval on the admin client with tenant arguments, and embed and voice have no user JWT. One pattern for every entry point wins.

## Readiness and fallback
| Option | Selected |
|---|---|
| An index_state table, reconcile match plus a lag limit, pgvector fallback with `degraded` | ✓ |
| Fail the request when the backend is down | |

## Voice backend
| Option | Selected |
|---|---|
| A separate `RAG_RETRIEVAL_BACKEND_VOICE`, default pgvector | ✓ |
| Voice follows the chat backend | |

## Lexical parity
| Option | Selected |
|---|---|
| Index the shared tokenizer output (Weaviate whitespace BM25, Qdrant idf sparse vector) | ✓ |
| Vendor tokenizers (`gse_ch`, Qdrant multilingual) | |

## Canary seeding
| Option | Selected |
|---|---|
| Through the real ingest, outbox and drain path | ✓ |
| Direct inserts into the stores | |

## Config UI coverage
| Option | Selected |
|---|---|
| Generated from manifest metadata, with a check-config completeness rule | ✓ |
| A hand-written panel per switch | |

## Test-connection
| Option | Selected |
|---|---|
| An app admin route through the real adapters | ✓ |
| Probes inside config-server.js | |

## Regression design
| Option | Selected |
|---|---|
| Two-stage: dev grid, then test-split finalists on three backends, then switch ablation | ✓ |
| A full factorial on the test split | |

## Default decision rule
| Option | Selected |
|---|---|
| Beat the incumbent beyond noise, no slice regression, budgets held; pgvector unless beaten beyond CI width; security wins ties; live record only | ✓ |
| Best mean score wins | |

## Inventory format
| Option | Selected |
|---|---|
| A Pydantic JSON with generated Markdown and a check-config rule | ✓ |
| A hand-written Markdown table | |

## Review-queue promotion
| Option | Selected |
|---|---|
| A config-server panel, with promotion through the extended Python CLI (execFile), 3-gram near-duplicate check and append-only | ✓ |
| A JavaScript re-implementation of split and dedup | |

## Failure report
| Option | Selected |
|---|---|
| `rag_eval.failure_report` with the layer derived from the trace, nightly | ✓ |

## Claude's Discretion
- Module layout, checksum bucketing, batch and backoff constants, the sparse hash, the UI layout and the report formatting.

## Deferred Ideas
- Legacy path removal.
- Per-tenant vendor opt-out.
- Native backend fusion.
- A rule and profile editor in the UI.
- Qdrant JWT claims.
