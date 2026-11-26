import { afterEach, describe, expect, it } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { validateUploadReplaces } from '@/lib/rag/ingest/versions/admin';
import { mintScope } from '@/lib/rag/tenant/scope';
import { PAIRS } from './fixtures/supersession-pairs';
import {
  contentOverlap,
  detectSupersessionCandidates,
  supersessionRules,
  type SupersessionDocument,
} from '@/lib/rag/ingest/versions/detect';
import { directionFor, normalizeTitle, titleOf, titleYear, versionMarkersFor } from '@/lib/rag/ingest/versions/title';

// Plan 03.2-45 (DATA-19, D-41): rules-only supersession detection. Titles and texts are neutral synthetic samples.

const EN = versionMarkersFor('en');
const ZH = versionMarkersFor('zh');
const IT = versionMarkersFor('it');

let counter = 0;
function doc(filename: string, extra: Partial<SupersessionDocument> = {}): SupersessionDocument {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  return {
    documentId: id,
    lineageId: `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    filename,
    docType: 'general',
    language: 'en',
    docDate: null,
    effectiveFrom: null,
    contentHash: `hash-${counter}`,
    content: null,
    ...extra,
  };
}

describe('normalizeTitle', () => {
  it('removes year and version markers of the language and collapses whitespace and case', () => {
    expect(normalizeTitle('Widget Catalogue 2023', EN)).toBe('widget catalogue');
    expect(normalizeTitle('widget_catalogue-2024', EN)).toBe(normalizeTitle('Widget  CATALOGUE (2023)', EN));
    expect(normalizeTitle('Widget Catalogue v2', EN)).toBe(normalizeTitle('Widget Catalogue V3.1', EN));
    expect(normalizeTitle('Widget Catalogue rev. 4', EN)).toBe('widget catalogue');
    expect(normalizeTitle('部件目录第二版', ZH)).toBe(normalizeTitle('部件目录第三版', ZH));
    expect(normalizeTitle('部件目录2023年', ZH)).toBe(normalizeTitle('部件目录 2024 年', ZH));
    expect(normalizeTitle('Catalogo componenti 2a edizione', IT)).toBe(normalizeTitle('Catalogo componenti 3a edizione', IT));
  });

  it('keeps titles apart that differ in any other word', () => {
    expect(normalizeTitle('Widget Catalogue 2023', EN)).not.toBe(normalizeTitle('Gadget Catalogue 2024', EN));
    expect(normalizeTitle('Widget Catalogue Summary v2', EN)).not.toBe(normalizeTitle('Widget Catalogue v3', EN));
  });

  it('normalizes an empty title, or one made only of markers, to nothing', () => {
    expect(normalizeTitle('', EN)).toBeNull();
    expect(normalizeTitle('   ', EN)).toBeNull();
    expect(normalizeTitle('2024', EN)).toBeNull();
    expect(normalizeTitle(null, EN)).toBeNull();
  });

  it('takes the title from the file name without its extension', () => {
    expect(titleOf('folder/Widget Catalogue 2023.pdf')).toBe('Widget Catalogue 2023');
    expect(titleYear('Widget Catalogue 2023', EN, supersessionRules().year_pattern)).toBe(2023);
    expect(titleYear('Widget Catalogue v2', EN, supersessionRules().year_pattern)).toBeNull();
  });
});

describe('directionFor', () => {
  const facts = (year: number | null, docDate: string | null = null, effectiveFrom: string | null = null) => ({ year, docDate, effectiveFrom });

  it('follows the year marker, then doc_date, then effective_from', () => {
    expect(directionFor(facts(2024), facts(2023))).toBe('a');
    expect(directionFor(facts(2023, '2025-01-01'), facts(2024, '2020-01-01'))).toBe('b');
    expect(directionFor(facts(null, '2025-03-01'), facts(null, '2025-01-01'))).toBe('a');
    expect(directionFor(facts(2024, '2025-01-01'), facts(2024, '2025-02-01'))).toBe('b');
    expect(directionFor(facts(null, null, '2026-01-01'), facts(null, null, '2025-01-01'))).toBe('a');
  });

  it('returns null when every value is equal or missing', () => {
    expect(directionFor(facts(null), facts(null))).toBeNull();
    expect(directionFor(facts(2024, '2025-01-01', '2025-01-01'), facts(2024, '2025-01-01', '2025-01-01'))).toBeNull();
    expect(directionFor(facts(2024), facts(null))).toBeNull();
  });
});

describe('detectSupersessionCandidates: title rule', () => {
  it('raises one candidate with a direction for two same-type titles that differ only by a year marker', () => {
    const newer = doc('Widget Catalogue 2024.md');
    const older = doc('Widget Catalogue 2023.md');
    const found = detectSupersessionCandidates(newer, [older]);
    expect(found).toHaveLength(1);
    expect(found[0]?.candidateDocumentId).toBe(older.documentId);
    expect(found[0]?.signals.title_match).toBe(true);
    expect(found[0]?.direction).toBe('document_newer');
    expect(detectSupersessionCandidates(older, [newer])[0]?.direction).toBe('candidate_newer');
  });

  it('has no direction when the markers carry no year and the dates are missing', () => {
    const found = detectSupersessionCandidates(doc('Widget Catalogue v3.md'), [doc('Widget Catalogue v2.md')]);
    expect(found).toHaveLength(1);
    expect(found[0]?.direction).toBeNull();
  });

  it('raises nothing across doc types, within one lineage, for other titles, empty titles or titles without a marker', () => {
    const base = doc('Widget Catalogue 2024.md');
    expect(detectSupersessionCandidates(base, [doc('Widget Catalogue 2023.md', { docType: 'contract' })])).toEqual([]);
    expect(detectSupersessionCandidates(base, [doc('Widget Catalogue 2023.md', { lineageId: base.lineageId })])).toEqual([]);
    expect(detectSupersessionCandidates(base, [doc('Gadget Catalogue 2023.md')])).toEqual([]);
    expect(detectSupersessionCandidates(doc('.md'), [doc('2023.md')])).toEqual([]);
    expect(detectSupersessionCandidates(doc('Widget Catalogue.md'), [doc('Widget Catalogue.md')])).toEqual([]);
    expect(detectSupersessionCandidates(doc('Widget Catalogue.md'), [doc('Widget Catalogue 2023.md')])).toEqual([]);
  });

  it('does not treat the same content as a version', () => {
    const base = doc('Widget Catalogue 2024.md', { contentHash: 'same' });
    expect(detectSupersessionCandidates(base, [doc('Widget Catalogue 2023.md', { contentHash: 'same' })])).toEqual([]);
  });
});

const REVISION_A = [
  'The blue widget weighs 12 grams and ships in boxes of 40 units.',
  'Each grey panel holds 6 brass screws spaced 15 millimetres apart.',
  'The copper rail is 120 centimetres long and rests on 3 brackets.',
  'Assembly takes about 25 minutes with two people working together.',
  'Store the finished frame in a dry room below 30 degrees.',
].join(' ');

const REVISION_B = [
  'The blue widget weighs 14 grams and ships in boxes of 40 units.',
  'Each grey panel holds 8 brass screws spaced 15 millimetres apart.',
  'The copper rail is 150 centimetres long and rests on 3 brackets.',
  'Assembly takes about 25 minutes with two people working together.',
  'Store the finished frame in a dry room below 30 degrees.',
].join(' ');

describe('detectSupersessionCandidates: content rule', () => {
  it('measures overlap on number-masked sentences and counts the numbers that differ', () => {
    const overlap = contentOverlap(REVISION_A, REVISION_B);
    expect(overlap.percent).toBe(100);
    expect(overlap.conflictingNumbers).toBe(3);
    expect(contentOverlap(REVISION_A, 'An unrelated note about the oak frame and its glass cover, written once.').percent).toBe(0);
  });

  it('raises a candidate for different titles whose contents overlap while numbers differ, without a direction unless dates give one', () => {
    const a = doc('Assembly notes.md', { content: REVISION_B });
    const b = doc('Workshop handout.md', { content: REVISION_A });
    const found = detectSupersessionCandidates(a, [b]);
    expect(found).toHaveLength(1);
    expect(found[0]?.signals.title_match).toBe(false);
    expect(found[0]?.signals.content_overlap_percent).toBeGreaterThanOrEqual(supersessionRules().content_overlap_min_percent);
    expect(found[0]?.signals.conflicting_numbers).toBeGreaterThanOrEqual(supersessionRules().min_conflicting_numbers);
    expect(found[0]?.direction).toBeNull();
    const dated = detectSupersessionCandidates(doc('Assembly notes.md', { content: REVISION_B, docDate: '2025-05-01' }), [
      doc('Workshop handout.md', { content: REVISION_A, docDate: '2024-05-01' }),
    ]);
    expect(dated[0]?.direction).toBe('document_newer');
  });

  it('raises nothing for identical content, equal numbers or text that was not loaded', () => {
    expect(detectSupersessionCandidates(doc('A.md', { content: REVISION_A, contentHash: 'h' }), [doc('B.md', { content: REVISION_B, contentHash: 'h' })])).toEqual([]);
    expect(detectSupersessionCandidates(doc('A.md', { content: REVISION_A }), [doc('B.md', { content: REVISION_A })])).toEqual([]);
    expect(detectSupersessionCandidates(doc('A.md', { content: REVISION_A }), [doc('B.md', { content: null })])).toEqual([]);
  });

  it('reads only a bounded amount of text per document', () => {
    const rules = { ...supersessionRules(), overlap_max_chars_per_document: 200 };
    const padding = 'The oak frame stands near the window and is cleaned every week by hand. '.repeat(10);
    const overlap = contentOverlap(padding + REVISION_A, padding + REVISION_B, rules);
    expect(overlap.conflictingNumbers).toBe(0);
  });
});

describe('fitted thresholds (config/rag/supersession-rules.json)', () => {
  it('separate every fixture pair: revisions raise, shared boilerplate, light edits and unrelated texts do not', () => {
    const rules = supersessionRules();
    for (const pair of PAIRS) {
      const overlap = contentOverlap(pair.a, pair.b, rules);
      const raised = overlap.percent >= rules.content_overlap_min_percent && overlap.conflictingNumbers >= rules.min_conflicting_numbers;
      expect(raised, pair.label).toBe(pair.expected);
    }
  });

  it('are data with a rules version, and every limit is bounded', () => {
    const rules = supersessionRules();
    expect(rules.rules_version).toMatch(/^supersession@/);
    expect(rules.overlap_max_documents).toBeLessThanOrEqual(50);
    expect(rules.overlap_max_chars_per_document).toBeLessThanOrEqual(100_000);
    expect(rules.max_title_candidates).toBeLessThanOrEqual(500);
  });
});

const ORG = '00000000-0000-4000-8000-0000000045c1';
const TARGET = '00000000-0000-4000-8000-0000000045d1';
const ORG_SCOPE = mintScope('org', '00000000-0000-4000-8000-0000000045a1', ORG);
const ON = { pipeline: 'unified', supersessionDetect: 'on' } as const;

function respond(data: unknown, error: { code: string; message: string } | null = null): RpcRequest {
  const response: RpcResponse = { data, error };
  const request: RpcRequest = { abortSignal: () => request, then: (ok, bad) => Promise.resolve(response).then(ok, bad) };
  return request;
}

describe('validateUploadReplaces (route-side "Replaces…" check)', () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const targets = new Map<string, Record<string, unknown>>();
  let fails = false;

  function install(): void {
    calls.length = 0;
    const db: RpcClient = {
      rpc(fn, args) {
        calls.push({ fn, args });
        if (fails) return respond(null, { code: 'XX000', message: 'connection reset' });
        const row = targets.get(`${String(args.p_tenant_key)}|${String(args.p_document_id)}`);
        return respond(row ? [row] : []);
      },
    };
    setIngestDepsForTests({ db: () => db });
  }

  afterEach(() => {
    resetIngestDepsForTests();
    targets.clear();
    fails = false;
  });

  const check = (raw: unknown, config: { pipeline: string; supersessionDetect: string } = ON, sourceKey = 'root/new.md') =>
    validateUploadReplaces(ORG_SCOPE, raw, { signal: new AbortController().signal, source: 'config_upload', sourceKey, config: config as never });

  it('accepts a current document of the upload\'s own tenant, asked with the scope\'s tenant key only', async () => {
    install();
    targets.set(`o:${ORG}|${TARGET}`, { document_id: TARGET, lineage_id: TARGET, source: 'config_upload', source_key: 'root/old.md' });
    expect(await check(TARGET.toUpperCase())).toEqual({ ok: true, replacesDocumentId: TARGET, ignored: false });
    expect(calls).toEqual([{ fn: 'rag_supersession_replace_target', args: { p_tenant_key: `o:${ORG}`, p_document_id: TARGET } }]);
  });

  it('refuses another tenant\'s or a non-current document, a malformed id and the upload\'s own lineage', async () => {
    install();
    expect(await check(TARGET)).toEqual({ ok: false, reason: 'replaces_not_found' });
    expect(await check('not-a-uuid')).toEqual({ ok: false, reason: 'invalid_replaces' });
    targets.set(`o:${ORG}|${TARGET}`, { document_id: TARGET, lineage_id: TARGET, source: 'config_upload', source_key: 'root/new.md' });
    expect(await check(TARGET)).toEqual({ ok: false, reason: 'replaces_same_lineage' });
    fails = true;
    expect(await check(TARGET)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is ignored without any lookup with the switch off or the legacy pipeline, and absent when the field is empty', async () => {
    install();
    expect(await check(TARGET, { pipeline: 'unified', supersessionDetect: 'off' })).toEqual({ ok: true, replacesDocumentId: undefined, ignored: true });
    expect(await check(TARGET, { pipeline: 'legacy', supersessionDetect: 'on' })).toEqual({ ok: true, replacesDocumentId: undefined, ignored: true });
    expect(await check('')).toEqual({ ok: true, replacesDocumentId: undefined, ignored: false });
    expect(await check(null)).toEqual({ ok: true, replacesDocumentId: undefined, ignored: false });
    expect(calls).toEqual([]);
  });
});
