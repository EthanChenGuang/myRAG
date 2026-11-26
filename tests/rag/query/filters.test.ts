import { describe, expect, it } from 'vitest';
import { buildRetrievalFilters, effectiveVersionScope, parseRetrievalFilters } from '@/lib/rag/query/filters';

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

describe('parseRetrievalFilters: versions (D-12)', () => {
  it.each([
    ['all', { versionScope: 'all' }],
    [{ from: '2026-01-01' }, { versionScope: { from: '2026-01-01' } }],
    [{ to: '2026-06-30' }, { versionScope: { to: '2026-06-30' } }],
    [{ from: '2026-01-01', to: '2026-06-30' }, { versionScope: { from: '2026-01-01', to: '2026-06-30' } }],
  ])('parses versions %j into versionScope', (versions, expected) => {
    expect(parseRetrievalFilters({ versions })).toEqual({ ok: true, filters: expected });
  });

  it('carries no versionScope for current, so a body with only current is no filter', () => {
    expect(parseRetrievalFilters({ versions: 'current' })).toEqual({ ok: true });
    expect(parseRetrievalFilters({ versions: 'current', languages: ['it'] })).toEqual({ ok: true, filters: { languages: ['it'] } });
  });

  it('keeps versionScope next to the other filters', () => {
    expect(parseRetrievalFilters({ versions: 'all', languages: ['en'] })).toEqual({
      ok: true,
      filters: { languages: ['en'], versionScope: 'all' },
    });
  });

  it.each([
    ['latest'],
    [{}],
    [{ from: '01/02/2026' }],
    [{ from: '2026-06-30', to: '2026-01-01' }],
    [{ from: '2026-01-01', mode: 'all' }],
    [3],
  ])('rejects versions %j with a detail on the versions path', (versions) => {
    const result = parseRetrievalFilters({ versions });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details.length).toBeGreaterThan(0);
      for (const detail of result.details) expect(detail.path.startsWith('versions')).toBe(true);
    }
  });

  it('never copies the version scope into the backend filters', () => {
    const parsed = parseRetrievalFilters({ versions: 'all' });
    if (!parsed.ok) throw new Error('expected ok');
    const filters = buildRetrievalFilters({ explicit: parsed.filters, referencedDocumentIds: [] });
    expect(filters).toEqual({ currentOnly: true });
  });
});

describe('effectiveVersionScope (D-12, D-40, D-58)', () => {
  const on = { v2: { versionScope: true, embedVersionScope: false } };
  const off = { v2: { versionScope: false, embedVersionScope: false } };
  const embedOn = { v2: { versionScope: true, embedVersionScope: true } };

  it('is current without a request or for an explicit current', () => {
    expect(effectiveVersionScope(on, 'chat', undefined)).toEqual({ scope: 'current', ignored: false });
    expect(effectiveVersionScope(on, 'chat', 'current')).toEqual({ scope: 'current', ignored: false });
  });

  it('honours the request when the switch is on', () => {
    expect(effectiveVersionScope(on, 'chat', 'all')).toEqual({ scope: 'all', ignored: false });
    expect(effectiveVersionScope(on, 'eval', { from: '2026-01-01' })).toEqual({ scope: { from: '2026-01-01' }, ignored: false });
  });

  it('ignores the request with the switch off, for voice, and for embed without the embed switch', () => {
    expect(effectiveVersionScope(off, 'chat', 'all')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(on, 'voice', 'all')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(embedOn, 'voice', 'all')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(on, 'embed', 'all')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(embedOn, 'embed', 'all')).toEqual({ scope: 'all', ignored: false });
  });

  it('the embed channel needs the embed switch whatever the profile (D-58)', () => {
    expect(effectiveVersionScope(on, 'chat', 'all', 'embed')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(on, 'eval', 'all', 'embed')).toEqual({ scope: 'current', ignored: true });
    expect(effectiveVersionScope(embedOn, 'chat', 'all', 'embed')).toEqual({ scope: 'all', ignored: false });
    expect(effectiveVersionScope(embedOn, 'voice', 'all', 'embed')).toEqual({ scope: 'current', ignored: true });
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

  it('matches nothing when the explicit and the referenced document ids share none (filters only narrow)', () => {
    const filters = buildRetrievalFilters({
      explicit: { documentIds: [ID_A] },
      referencedDocumentIds: [ID_C],
    });
    expect(filters.documentIds).toEqual(['00000000-0000-0000-0000-000000000000']);
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