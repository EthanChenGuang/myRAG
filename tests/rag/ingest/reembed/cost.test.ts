import { describe, expect, it } from 'vitest';
import { BGE_M3_MODEL_ID } from '@/lib/rag/embeddings/types';
import { priceFor } from '@/lib/rag/embeddings/prices';
import { ESTIMATE_NOTE, SLOT_NOTE, estimateReembedCost } from '@/lib/rag/ingest/reembed/cost';

const TOTALS = { 's:default': { chunks: 4, tokens: 2_000_000 }, 'u:example': { chunks: 1, tokens: 500_000 } };

describe('re-embed cost (IW-4)', () => {
  it('prices a bge-m3 run with the catalog price instead of refusing the provider', () => {
    const report = estimateReembedCost('bge-m3', TOTALS, BGE_M3_MODEL_ID);
    const perMillion = priceFor('bge-m3', BGE_M3_MODEL_ID).usdPerMillionTokens;
    expect(report.tenants.map((tenant) => tenant.tenantKey)).toEqual(['s:default', 'u:example']);
    expect(report.totals.tokens).toBe(2_500_000);
    expect(report.totals.usd).toBeCloseTo(2.5 * perMillion, 9);
    expect(report.estimated).toBe(priceFor('bge-m3').tokensAreEstimates);
    expect(report.note).toBe(report.estimated ? ESTIMATE_NOTE : null);
  });

  it('prices bge-m3 with its default model when none is named', () => {
    expect(estimateReembedCost('bge-m3', TOTALS).totals.usd).toBeCloseTo(estimateReembedCost('bge-m3', TOTALS, BGE_M3_MODEL_ID).totals.usd, 12);
  });

  it('still refuses an unknown provider and keeps the slot note', () => {
    expect(() => estimateReembedCost('unknown-host', TOTALS)).toThrow(/no price table/);
    expect(estimateReembedCost('ft_slot_a', TOTALS).note).toBe(SLOT_NOTE);
  });
});
