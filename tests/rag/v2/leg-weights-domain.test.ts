import { describe, expect, it } from 'vitest';
import {
  BindingActivationEvidenceSchema,
  RagRunRequestSchema,
  RetrievalParamsSchema,
} from '@/lib/rag-eval/contracts.generated';
import rawCommitted from '../../../eval/config/retrieval-params.json';
import samples from '../../fixtures/contracts/samples.json';

describe('domain leg weight and binding options', () => {
  it('parses the committed params without adding a domain weight', () => {
    const parsed = RetrievalParamsSchema.parse(rawCommitted);
    expect(Object.keys(parsed.leg_weights ?? {}).sort()).toEqual(['dense', 'exact_id', 'lexical']);
  });

  it('accepts a positive domain weight and rejects zero or null', () => {
    const withDomain = (domain: unknown) => RetrievalParamsSchema.safeParse({ leg_weights: { domain } });
    const parsed = withDomain(0.5);
    expect(parsed.success && parsed.data.leg_weights?.domain).toBe(0.5);
    expect(withDomain(0).success).toBe(false);
    expect(withDomain(null).success).toBe(false);
  });

  it('validates binding run options', () => {
    const request = (options: Record<string, unknown>) => RagRunRequestSchema.safeParse({ query: 'q', options });
    const parsed = request({
      embedding_bindings: { contract_legal: 'voyage-law-2-1024' },
      domain_control_leg: 'contract_legal',
    });
    expect(parsed.success && parsed.data.options?.embedding_bindings).toEqual({ contract_legal: 'voyage-law-2-1024' });
    expect(request({ domain_control_leg: 'memo' }).success).toBe(false);
    expect(request({ embedding_bindings: { contract_legal: 'Bad Profile' } }).success).toBe(false);
  });

  it('validates the Pydantic evidence sample and rejects a non-ISO recorded_at', () => {
    const sample = (samples as { samples: Record<string, unknown> }).samples.BindingActivationEvidence;
    expect(BindingActivationEvidenceSchema.safeParse(sample).success).toBe(true);
    expect(
      BindingActivationEvidenceSchema.safeParse({ ...(sample as object), recorded_at: 'yesterday' }).success,
    ).toBe(false);
  });
});
