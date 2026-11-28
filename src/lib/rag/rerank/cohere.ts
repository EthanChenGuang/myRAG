import { z } from 'zod/v3';
import { completeScores, RerankError } from './scores';
import { rerankerSupportedLanguages } from './languages';
import type { Reranker, RerankOptions, RerankScore } from './types';

const DEFAULT_BASE = 'https://api.cohere.com';

const CohereResponse = z
  .object({
    results: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        relevance_score: z.number().finite(),
        relevant_spans: z
          .array(
            z.object({
              start: z.number().int(),
              end: z.number().int(),
              score: z.number(),
            }),
          )
          .optional(),
      }),
    ),
    meta: z
      .object({
        billed_units: z.record(z.number()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface CohereRerankerDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  model: string;
}

function resolveBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_BASE;
}

function requestSignal(opts: RerankOptions): AbortSignal {
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    return AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  }
  return opts.signal;
}

export function createCohereReranker(deps: CohereRerankerDeps): Reranker {
  const base = resolveBaseUrl(deps.baseUrl);
  return {
    id: 'cohere',
    model: deps.model,
    scoreSemantics: 'calibrated',
    supportedLanguages: rerankerSupportedLanguages('cohere'),
    async rerank(query, docs, opts) {
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const res = await deps.fetch(`${base}/v2/rerank`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: deps.model,
          query,
          documents: docs,
          ...(opts.wantSpans ? { relevant_spans: { mode: 'enabled' } } : {}),
        }),
        signal: requestSignal(opts),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RerankError('cohere', res.status);
      }
      const parsed = CohereResponse.parse(await res.json());
      const rows = parsed.results.map((r) => ({
        index: r.index,
        score: r.relevance_score,
        spans: r.relevant_spans,
      }));
      const scores: RerankScore[] = completeScores(docs.length, rows);
      const usage = parsed.meta?.billed_units;
      return { scores, ...(usage ? { usage } : undefined) };
    },
  };
}