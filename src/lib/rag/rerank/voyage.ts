import { z } from 'zod/v3';
import { completeScores, RerankError } from './scores';
import type { Reranker, RerankOptions } from './types';

const DEFAULT_BASE = 'https://api.voyageai.com/v1';

const VoyageResponse = z
  .object({
    object: z.string().optional(),
    data: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        relevance_score: z.number().finite(),
      }),
    ),
    model: z.string().optional(),
    usage: z
      .object({
        total_tokens: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface VoyageRerankerDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  model: string;
}

function resolveBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const base = trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_BASE;
  if (!base.endsWith('/v1')) {
    throw new Error('[RAG Rerank] Voyage base URL must end with /v1');
  }
  return base;
}

function requestSignal(opts: RerankOptions): AbortSignal {
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    return AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  }
  return opts.signal;
}

export function createVoyageReranker(deps: VoyageRerankerDeps): Reranker {
  const base = resolveBaseUrl(deps.baseUrl);
  return {
    id: 'voyage',
    model: deps.model,
    scoreSemantics: 'calibrated',
    async rerank(query, docs, opts) {
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const res = await deps.fetch(`${base}/rerank`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: deps.model,
          query,
          documents: docs,
          truncation: true,
          return_documents: false,
        }),
        signal: requestSignal(opts),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RerankError('voyage', res.status);
      }
      const raw = await res.json();
      if (raw !== null && typeof raw === 'object' && 'results' in raw && !('data' in raw)) {
        throw new Error('[RAG Rerank] Voyage response used SDK results shape, not HTTP data[]');
      }
      const parsed = VoyageResponse.parse(raw);
      const rows = parsed.data.map((r) => ({ index: r.index, score: r.relevance_score }));
      const scores = completeScores(docs.length, rows);
      const usage: Record<string, number> = {};
      if (parsed.usage?.total_tokens !== undefined) {
        usage.total_tokens = parsed.usage.total_tokens;
      }
      return { scores, ...(Object.keys(usage).length ? { usage } : undefined) };
    },
  };
}