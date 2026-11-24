import { describe, expect, it } from 'vitest';
import { buildRetrievalFilters, parseRetrievalFilters } from '@/lib/rag/query/filters';

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const ID_C = '00000000-0000-4000-8000-000000000003';

describe('parseRetrievalFilters', () => {
  it('accepts undefined as no filters', () => {
    expect(parseRetrievalFilters(undefined)).toEqual({ ok: true });
  });

  it('accepts valid docTypes and languages', () => {
    const result = parseRetrievalFilters({ docTypes: ['contract_legal'], languages: ['it'] });
    expect(result).toEqual({
      ok: true,
      filters: { docTypes: ['contract_legal'], languages: ['it'] },
    });
  });

  it('rejects an empty documentIds array', () => {
    const result = parseRetrievalFilters({ documentIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'documentIds' })])
      );
    }
  });

  it('rejects unknown keys', () => {
    const result = parseRetrievalFilters({ tenant: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'tenant' })])
      );
    }
  });

  it('rejects dateRange when from is after to', () => {
    const result = parseRetrievalFilters({
      dateRange: { from: '2024-12-31', to: '2024-01-01' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'dateRange' })])
      );
    }
  });
});

describe('buildRetrievalFilters', () => {
  it('intersects explicit and referenced document ids', () => {
    const filters = buildRetrievalFilters({
      explicit: { documentIds: [ID_A, ID_B] },
      referencedDocumentIds: [ID_B, ID_C],
    });
    expect(filters).toEqual({
      currentOnly: true,
      documentIds: [ID_B],
    });
  });

  it('uses referenced ids when explicit has none', () => {
    const filters = buildRetrievalFilters({
      explicit: undefined,
      referencedDocumentIds: [ID_C],
    });
    expect(filters).toEqual({
      currentOnly: true,
      documentIds: [ID_C],
    });
  });

  it('omits documentIds when neither source provides any', () => {
    const filters = buildRetrievalFilters({
      explicit: { languages: ['en'] },
      referencedDocumentIds: [],
    });
    expect(filters).toEqual({
      currentOnly: true,
      languages: ['en'],
    });
    expect(filters).not.toHaveProperty('documentIds');
  });

  it('keeps an explicit dateRange and always sets currentOnly', () => {
    const filters = buildRetrievalFilters({
      explicit: { dateRange: { from: '2024-01-01', to: '2024-06-30' } },
      referencedDocumentIds: [],
    });
    expect(filters).toEqual({
      currentOnly: true,
      dateRange: { from: '2024-01-01', to: '2024-06-30' },
    });
  });
});