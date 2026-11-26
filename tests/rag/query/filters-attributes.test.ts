import { afterEach, describe, expect, test } from 'vitest';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { buildRetrievalFilters, parseRetrievalFilters } from '@/lib/rag/query/filters';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const ID_C = '00000000-0000-4000-8000-000000000003';
const NO_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

/** Today's answer for a body carrying `attributes`, recorded before plan 03.3-18. */
const OFF_ANSWER = { ok: false, details: [{ path: 'attributes', message: "Unrecognized key(s) in object: 'attributes'" }] };

const BODIES: unknown[] = [
  undefined,
  {},
  { docTypes: ['contract_legal'], languages: ['it'] },
  { documentIds: [ID_A, ID_B] },
  { sources: ['config_upload'], dateRange: { from: '2024-01-01', to: '2024-12-31' } },
  { scopes: { region: ['north'] }, includeUntagged: true },
  { versions: 'all' },
  { documentIds: [] },
  { tenant: 'x' },
];

afterEach(() => {
  uninstallDeps();
  resetRagConfigForTests();
});

describe('explicit attributes filter while the switch is effectively off', () => {
  test('a body with attributes gets exactly the unrecognized-key answer of today', () => {
    expect(parseRetrievalFilters({ attributes: { alpha_code: ['x1'] } }, { attributeFilter: 'off' })).toEqual(OFF_ANSWER);
    expect(parseRetrievalFilters({ attributes: { alpha_code: ['x1'] } })).toEqual(OFF_ANSWER);
    expect(parseRetrievalFilters({ attributes: {} })).toEqual(OFF_ANSWER);
  });

  test('the default reads the effective switch: RAG_ATTRIBUTE_FILTER without its needs stays off', () => {
    installDeps({ ragEnv: () => ({ RAG_ATTRIBUTE_FILTER: 'hard' }) });
    expect(parseRetrievalFilters({ attributes: { alpha_code: ['x1'] } })).toEqual(OFF_ANSWER);
  });

  test('the default reads the effective switch: with its needs met the filter is accepted', () => {
    installDeps({ ragEnv: () => ({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_DOC_ATTRIBUTES: 'true', RAG_PIPELINE: 'v2' }) });
    expect(parseRetrievalFilters({ attributes: { alpha_code: ['x1'] } })).toEqual({ ok: true, filters: { attributes: { alpha_code: ['x1'] } } });
  });

  test('every body without attributes parses to the same value in both switch states', () => {
    for (const body of BODIES) {
      const off = parseRetrievalFilters(body, { attributeFilter: 'off' });
      expect(parseRetrievalFilters(body), JSON.stringify(body)).toEqual(off);
      expect(parseRetrievalFilters(body, { attributeFilter: 'hard' }), JSON.stringify(body)).toEqual(off);
      expect(parseRetrievalFilters(body, { attributeFilter: 'soft' }), JSON.stringify(body)).toEqual(off);
    }
  });
});

describe('explicit attributes filter while the switch is on', () => {
  for (const mode of ['hard', 'soft'] as const) {
    test(`${mode}: keys sorted, values sorted and de-duplicated`, () => {
      const result = parseRetrievalFilters({ attributes: { beta_list: ['y1'], alpha_code: ['x2', 'x1', 'x1'] }, docTypes: ['general'] }, { attributeFilter: mode });
      expect(result).toEqual({ ok: true, filters: { docTypes: ['general'], attributes: { alpha_code: ['x1', 'x2'], beta_list: ['y1'] } } });
      if (result.ok) expect(Object.keys(result.filters!.attributes!)).toEqual(['alpha_code', 'beta_list']);
    });
  }

  test('an empty object, or a key with an empty list, is no filter for it', () => {
    expect(parseRetrievalFilters({ attributes: {} }, { attributeFilter: 'hard' })).toEqual({ ok: true });
    expect(parseRetrievalFilters({ attributes: { alpha_code: [] } }, { attributeFilter: 'hard' })).toEqual({ ok: true });
    expect(parseRetrievalFilters({ attributes: { alpha_code: [], beta_list: ['y1'] } }, { attributeFilter: 'hard' })).toEqual({
      ok: true,
      filters: { attributes: { beta_list: ['y1'] } },
    });
  });

  test('malformed entries are refused with the path of the offending entry', () => {
    const cases: [unknown, string][] = [
      [{ Alpha: ['x'] }, 'attributes.Alpha'],
      [{ '1abc': ['x'] }, 'attributes.1abc'],
      [{ ['a'.repeat(41)]: ['x'] }, `attributes.${'a'.repeat(41)}`],
      [Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`k${index}`, ['v']])), 'attributes'],
      [{ alpha_code: Array.from({ length: 51 }, (_, index) => `v${index}`) }, 'attributes.alpha_code'],
      [{ alpha_code: ['x', ''] }, 'attributes.alpha_code.1'],
      [{ alpha_code: ['x'.repeat(201)] }, 'attributes.alpha_code.0'],
      [{ alpha_code: 'x' }, 'attributes.alpha_code'],
      [{ alpha_code: [7] }, 'attributes.alpha_code.0'],
      [['x'], 'attributes'],
    ];
    for (const [attributes, path] of cases) {
      const result = parseRetrievalFilters({ attributes }, { attributeFilter: 'hard' });
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.details.map((detail) => detail.path), path).toContain(path);
    }
    expect(parseRetrievalFilters({ attributes: { alpha_code: ['é'.repeat(200)] } }, { attributeFilter: 'hard' }).ok).toBe(true);
  });

  test('other filter errors are reported as before with the switch on', () => {
    expect(parseRetrievalFilters({ documentIds: [], attributes: { alpha_code: ['x'] } }, { attributeFilter: 'hard' })).toEqual(
      parseRetrievalFilters({ documentIds: [] }, { attributeFilter: 'off' }),
    );
  });
});

describe('buildRetrievalFilters and the attribute id list', () => {
  test('without attributeDocumentIds the existing cases return exactly the objects of today', () => {
    expect(buildRetrievalFilters({ referencedDocumentIds: [] })).toEqual({ currentOnly: true });
    expect(buildRetrievalFilters({ explicit: { documentIds: [ID_A, ID_B] }, referencedDocumentIds: [ID_B, ID_C] })).toEqual({ currentOnly: true, documentIds: [ID_B] });
    expect(buildRetrievalFilters({ explicit: { documentIds: [ID_A] }, referencedDocumentIds: [ID_C] })).toEqual({ currentOnly: true, documentIds: [NO_DOCUMENT_ID] });
    expect(buildRetrievalFilters({ referencedDocumentIds: [ID_C] })).toEqual({ currentOnly: true, documentIds: [ID_C] });
    expect(
      buildRetrievalFilters({ explicit: { docTypes: ['general'], scopes: ['region:north'], scopesIncludeUntagged: true }, referencedDocumentIds: [], effectiveOn: '2024-05-01' }),
    ).toEqual({ currentOnly: true, docTypes: ['general'], scopes: ['region:north'], scopesIncludeUntagged: true, effectiveOn: '2024-05-01' });
  });

  test('the built object never carries attributes', () => {
    const built = buildRetrievalFilters({ explicit: { attributes: { alpha_code: ['x1'] }, docTypes: ['general'] }, referencedDocumentIds: [] });
    expect(built).toEqual({ currentOnly: true, docTypes: ['general'] });
    expect('attributes' in built).toBe(false);
  });

  test('the list narrows alone, and intersects with explicit and referenced ids', () => {
    expect(buildRetrievalFilters({ referencedDocumentIds: [], attributeDocumentIds: [ID_B, ID_A] })).toEqual({ currentOnly: true, documentIds: [ID_B, ID_A] });
    expect(buildRetrievalFilters({ explicit: { documentIds: [ID_A, ID_B] }, referencedDocumentIds: [], attributeDocumentIds: [ID_B, ID_C] })).toEqual({
      currentOnly: true,
      documentIds: [ID_B],
    });
    expect(buildRetrievalFilters({ explicit: { documentIds: [ID_A, ID_B] }, referencedDocumentIds: [ID_B], attributeDocumentIds: [ID_B] })).toEqual({
      currentOnly: true,
      documentIds: [ID_B],
    });
  });

  test('an empty intersection or an empty list matches nothing', () => {
    expect(buildRetrievalFilters({ referencedDocumentIds: [], attributeDocumentIds: [] })).toEqual({ currentOnly: true, documentIds: [NO_DOCUMENT_ID] });
    expect(buildRetrievalFilters({ referencedDocumentIds: [ID_A], attributeDocumentIds: [ID_B] })).toEqual({ currentOnly: true, documentIds: [NO_DOCUMENT_ID] });
    expect(buildRetrievalFilters({ explicit: { documentIds: [ID_A] }, referencedDocumentIds: [ID_C], attributeDocumentIds: [ID_A, ID_C] })).toEqual({
      currentOnly: true,
      documentIds: [NO_DOCUMENT_ID],
    });
  });
});
