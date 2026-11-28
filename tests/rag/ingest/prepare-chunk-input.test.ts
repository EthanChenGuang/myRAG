import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';

vi.mock('@/lib/rag/patterns/tenant-line-pattern', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/patterns/tenant-line-pattern')>();
  return { ...actual, matchTenantLinePatterns: vi.fn(actual.matchTenantLinePatterns) };
});
vi.mock('@/lib/rag/ingest/rules/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/rules/load')>();
  return { ...actual, loadTenantRules: vi.fn(actual.loadTenantRules) };
});
vi.mock('@/lib/rag/ingest/prepare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/prepare')>();
  return { ...actual, prepareChunkInput: vi.fn(actual.prepareChunkInput) };
});

import { PAGE_TEXTS_ARTIFACT, isArtifactName, type ArtifactContext } from '@/lib/rag/ingest/artifacts';
import { resetObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import {
  CHUNK_PREP_SNAPSHOT_CAP,
  applyPrepareOutcome,
  candidateLines,
  loadPageLines,
  prepareChunkInput,
  type PrepareChunkInputArgs,
} from '@/lib/rag/ingest/prepare';
import { readPageLines } from '@/lib/rag/ingest/prepare/page-lines';
import { SECTION_HITS_CAP } from '@/lib/rag/ingest/prepare/section-hits';
import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import type { TenantRules } from '@/lib/rag/ingest/rules/load';
import { matchTenantLinePatterns } from '@/lib/rag/patterns/tenant-line-pattern';
import { loadTenantRules } from '@/lib/rag/ingest/rules/load';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { callerDocumentMetadata } from '@/lib/rag/ingest/document-metadata';
import { INGEST_STAGES } from '@/lib/rag/ingest/runner';
import { chunkStage } from '@/lib/rag/ingest/stages/chunk';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createFakeObjectStore } from '../../helpers/fake-object-store';
import { setObjectStoreForTests } from '@/lib/rag/ingest/object-store';

type ParseChunk = ParseResult['chunks'][number];

const matchSpy = vi.mocked(matchTenantLinePatterns);
const HEADER = 'Bulletin of the sample unit';
const MARKER = 'Internal draft marker zq';
const baseChunker = getProcessingProfile('general').chunker;

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const FILLER = 'The sample text continues with ordinary neutral sentences that carry the body of the page and nothing repeated.';

function body(page: number): string {
  return `Body paragraph ${WORDS[page - 1]} with plain sentences. ${FILLER} ${FILLER}`;
}

function pageText(page: number, total: number, extra: string[] = []): string {
  return [HEADER, '', body(page), ...extra, '', `Page ${page} of ${total}`].join('\n');
}

function documentOf(total: number, extraOnFirst: string[] = []) {
  const pages = Array.from({ length: total }, (_, index) => ({ page: index + 1, text: pageText(index + 1, total, index === 0 ? extraOnFirst : []) }));
  return { markdown: pages.map((entry) => entry.text).join('\n\n'), pageLines: readPageLines({ pages }) };
}

function rules(partial: Partial<TenantRules> = {}): TenantRules {
  return { ruleSet: null, boilerplateRules: [], ruleIds: [], fingerprint: 'a'.repeat(64), loadFailed: false, skipped: 0, ...partial };
}

const LINE_RULE_ID = '11111111-1111-4111-8111-111111111111';
const lineRule = rules({
  boilerplateRules: [{ id: LINE_RULE_ID, version: 2, kind: 'line', pattern: '^Internal draft', flags: 'u', maxLength: null, minPageShare: null, docType: null, source: null }],
  ruleIds: [{ kind: 'boilerplate_rule', id: LINE_RULE_ID, version: 2 }],
  fingerprint: 'b'.repeat(64),
});

function args(overrides: Partial<PrepareChunkInputArgs>): PrepareChunkInputArgs {
  const doc = documentOf(4, [MARKER]);
  return { markdown: doc.markdown, parseChunks: null, pageLines: doc.pageLines, baseChunker, mode: 'both', rules: rules(), ...overrides };
}

let logged: string[];

beforeEach(() => {
  matchSpy.mockClear();
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => void logged.push(JSON.stringify(parts)));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  resetObjectStoreForTests();
});

describe('prepareChunkInput', () => {
  test('detect removes repeated page lines without a worker call and keeps body text', async () => {
    const result = await prepareChunkInput(args({ mode: 'detect', rules: lineRule }));
    expect(matchSpy).not.toHaveBeenCalled();
    expect(result.markdown).not.toContain(HEADER);
    expect(result.markdown).not.toMatch(/Page \d of 4/);
    expect(result.markdown).toContain('Body paragraph charlie');
    expect(result.markdown).toContain(MARKER);
    expect(result.report.lines_removed).toBe(8);
    expect(result.chunker).toBe(baseChunker);
    expect(result.snapshot.boilerplate?.mode).toBe('detect');
    expect(result.snapshot.fingerprint).toBe('0'.repeat(64));
  });

  test('a tenant line rule runs in one worker call with the distinct candidate lines and removes the matched line', async () => {
    const doc = documentOf(4, [MARKER, '| a | b |', '```', MARKER + ' fenced', '```', '# Heading line']);
    const result = await prepareChunkInput(args({ markdown: doc.markdown, pageLines: doc.pageLines, mode: 'rules', rules: lineRule }));
    expect(matchSpy).toHaveBeenCalledTimes(1);
    const request = matchSpy.mock.calls[0]![0];
    expect(request.patterns).toEqual([{ id: LINE_RULE_ID, kind: 'boilerplate_line', pattern: '^Internal draft', flags: 'u' }]);
    expect(request.lines).toEqual(candidateLines(doc.markdown));
    expect(request.lines).not.toContain('| a | b |');
    expect(request.lines).not.toContain('# Heading line');
    expect(request.lines).not.toContain(MARKER + ' fenced');
    expect(new Set(request.lines).size).toBe(request.lines.length);
    expect(result.markdown).not.toContain(`${MARKER}\n`);
    expect(result.markdown).toContain(MARKER + ' fenced');
    expect(result.markdown).toContain(HEADER);
    expect(result.snapshot.boilerplate?.ruleIds).toEqual([{ id: LINE_RULE_ID, version: 2 }]);
    expect(result.snapshot.fingerprint).toBe('b'.repeat(64));
    expect(result.snapshot.boilerplate?.removedLineKeys.every((entry) => /^[kd]:/.test(entry))).toBe(true);
  });

  test('no line rule: no worker call', async () => {
    await prepareChunkInput(args({ mode: 'both', rules: rules() }));
    expect(matchSpy).not.toHaveBeenCalled();
  });

  test('a worker timeout flags tenant_pattern_timeout, applies no pattern result and still applies detect', async () => {
    matchSpy.mockResolvedValueOnce({ kind: 'timeout' });
    const result = await prepareChunkInput(args({ mode: 'both', rules: lineRule }));
    expect(result.review).toEqual(['tenant_pattern_timeout']);
    expect(result.markdown).toContain(MARKER);
    expect(result.markdown).not.toContain(HEADER);
  });

  test('a failed rule load warns tenant_rules_unavailable and cleans by detect only', async () => {
    const result = await prepareChunkInput(args({ mode: 'both', rules: rules({ loadFailed: true, boilerplateRules: lineRule.boilerplateRules }) }));
    expect(matchSpy).not.toHaveBeenCalled();
    expect(result.warnings).toContain('tenant_rules_unavailable');
    expect(result.markdown).not.toContain(HEADER);
    expect(result.markdown).toContain(MARKER);
  });

  test('no page structure with detect in the mode warns boilerplate_pages_unavailable once; line patterns still apply', async () => {
    const result = await prepareChunkInput(args({ mode: 'both', pageLines: null, rules: lineRule }));
    expect(result.warnings.filter((code) => code === 'boilerplate_pages_unavailable')).toHaveLength(1);
    expect(result.markdown).toContain(HEADER);
    expect(result.markdown).not.toContain(`${MARKER}\n`);
  });

  test('removal above the review share is reported as boilerplate_above_threshold', async () => {
    const pages = Array.from({ length: 4 }, (_, index) => ({ page: index + 1, text: `${HEADER}\nShort ${index + 1}.\nPage ${index + 1} of 4` }));
    const result = await prepareChunkInput(args({ mode: 'detect', markdown: pages.map((entry) => entry.text).join('\n\n'), pageLines: readPageLines({ pages }) }));
    expect(result.report.share).toBeGreaterThan(0.2);
    expect(result.review).toEqual(['boilerplate_above_threshold']);
  });

  test('parser chunks: every text field is cleaned, emptied headings and chunks are dropped, inputs are not mutated', async () => {
    const chunks: ParseChunk[] = [
      { text: `${HEADER}\n${body(1)}`, contextualized_text: `${HEADER}\nctx body`, headings: [HEADER, 'Kept heading'], is_table: false, pages: [1], table_header: null },
      { text: 'Page 2 of 4', contextualized_text: 'Page 2 of 4', headings: [], is_table: false, pages: [2], table_header: null },
      { text: '| x |\n| y |', contextualized_text: '| x |', headings: [], is_table: true, pages: [3], table_header: `${HEADER}\n| x |` },
    ];
    const frozen = JSON.parse(JSON.stringify(chunks));
    const result = await prepareChunkInput(args({ mode: 'detect', parseChunks: chunks }));
    expect(chunks).toEqual(frozen);
    expect(result.parseChunks).toHaveLength(2);
    expect(result.parseChunks![0]).toMatchObject({ text: body(1), contextualized_text: 'ctx body', headings: ['Kept heading'] });
    expect(result.parseChunks![1]!.table_header).toBe('| x |');
    const none = await prepareChunkInput(args({ mode: 'detect', parseChunks: null }));
    expect(none.parseChunks).toBeNull();
  });

  test('nothing to remove: the same Markdown string and chunk list come back', async () => {
    const markdown = 'One plain line.\n\nAnother plain line.';
    const chunks: ParseChunk[] = [{ text: markdown, contextualized_text: markdown, headings: [], is_table: false, pages: [1], table_header: null }];
    const result = await prepareChunkInput(args({ mode: 'both', markdown, parseChunks: chunks, pageLines: null, rules: rules() }));
    expect(result.markdown).toBe(markdown);
    expect(result.parseChunks).toBe(chunks);
    expect(result.report.lines_removed).toBe(0);
  });

  test('a snapshot replays the first run without rules or a worker call, even when the rules changed', async () => {
    const first = await prepareChunkInput(args({ mode: 'both', rules: lineRule }));
    matchSpy.mockClear();
    const second = await prepareChunkInput(args({ mode: 'both', rules: rules(), snapshot: first.snapshot }));
    expect(matchSpy).not.toHaveBeenCalled();
    expect(second.markdown).toBe(first.markdown);
    expect(second.report).toEqual(first.report);
    expect(second.review).toEqual(first.review);
    expect(second.snapshot).toBe(first.snapshot);

    matchSpy.mockResolvedValueOnce({ kind: 'timeout' });
    const timedOut = await prepareChunkInput(args({ mode: 'both', rules: lineRule }));
    const replayed = await prepareChunkInput(args({ mode: 'both', rules: null, snapshot: timedOut.snapshot }));
    expect(replayed.review).toEqual(['tenant_pattern_timeout']);
    expect(replayed.markdown).toBe(timedOut.markdown);
  });

  test('a removal record over the cap is not applied; the snapshot is marked truncated and replays nothing', async () => {
    const lines = Array.from({ length: CHUNK_PREP_SNAPSHOT_CAP.maxEntries + 1 }, (_, index) => `Ruled line ${index.toString(36)}`);
    const markdown = ['Kept body sentence.', ...lines].join('\n');
    matchSpy.mockImplementationOnce(async (request) => ({
      kind: 'ok',
      hits: request.lines.map((line, inputIndex) => ({ inputIndex, patternId: LINE_RULE_ID, start: 0, end: 1 })).filter((hit) => request.lines[hit.inputIndex] !== 'Kept body sentence.'),
      skipped: [],
    }));
    const result = await prepareChunkInput(args({ mode: 'rules', markdown, pageLines: null, rules: lineRule }));
    expect(result.markdown).toBe(markdown);
    expect(result.report.lines_removed).toBe(0);
    expect(result.warnings).toContain('boilerplate_snapshot_too_large');
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.boilerplate?.removedLineKeys).toEqual([]);
    const replayed = await prepareChunkInput(args({ mode: 'rules', markdown, pageLines: null, snapshot: result.snapshot }));
    expect(replayed.markdown).toBe(markdown);
    expect(replayed.warnings).toContain('boilerplate_snapshot_too_large');
  });

  test('no log line holds a document line or a pattern', async () => {
    matchSpy.mockResolvedValueOnce({ kind: 'error', error: 'worker_failed' });
    await prepareChunkInput(args({ mode: 'both', rules: lineRule }));
    await prepareChunkInput(args({ mode: 'detect' }));
    for (const line of logged) {
      expect(line).not.toContain(MARKER);
      expect(line).not.toContain(HEADER);
      expect(line).not.toContain('^Internal draft');
    }
  });
});

describe('page-text artifact and loadPageLines', () => {
  const TENANT = 's:default';
  const LINEAGE = '22222222-2222-4222-8222-222222222222';

  function context(version: number): ArtifactContext {
    return { identity: { tenantKey: TENANT }, document: { lineageId: LINEAGE, version }, signal: new AbortController().signal, state: { artifacts: {} } };
  }

  function put(store: ReturnType<typeof createFakeObjectStore>, version: number, name: string, value: unknown) {
    store.objects.set(`${TENANT}/${LINEAGE}/${version}/${name}`, { bytes: new TextEncoder().encode(JSON.stringify(value)), contentType: 'application/json' });
  }

  test('the artifact name is page-texts.json and a fixed basename', () => {
    expect(PAGE_TEXTS_ARTIFACT).toBe('page-texts.json');
    expect(isArtifactName(PAGE_TEXTS_ARTIFACT)).toBe(true);
  });

  test('docling.json first, then the page texts, then the reused version, else null', async () => {
    const store = createFakeObjectStore();
    setObjectStoreForTests(store);
    expect(await loadPageLines(context(2), { reuseOfVersion: 1 })).toBeNull();
    put(store, 1, 'page-texts.json', { pages: [{ page: 1, text: 'reused line' }] });
    expect((await loadPageLines(context(2), { reuseOfVersion: 1 }))?.pages[0]?.keys).toEqual(['reused line']);
    expect(await loadPageLines(context(2))).toBeNull();
    put(store, 2, 'page-texts.json', { pages: [{ page: 1, text: 'own line' }] });
    expect((await loadPageLines(context(2), { reuseOfVersion: 1 }))?.pages[0]?.keys).toEqual(['own line']);
    put(store, 2, 'docling.json', { texts: [{ text: 'docling line', prov: [{ page_no: 1 }] }], pages: { '1': {} } });
    expect((await loadPageLines(context(2), { reuseOfVersion: 1 }))?.pages[0]?.keys).toEqual(['docling line']);
  });

  test('a store failure other than a missing object is rethrown', async () => {
    const store = createFakeObjectStore();
    store.failOn('get');
    setObjectStoreForTests(store);
    await expect(loadPageLines(context(2))).rejects.toThrow();
  });
});

describe('applyPrepareOutcome', () => {
  test('stores the report under metadata.boilerplate and flags each review code with the run tenant key', async () => {
    const setFields = vi.fn(async () => undefined);
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db = {
      rpc: (name: string, params: Record<string, unknown>) => {
        calls.push([name, params]);
        const response = Promise.resolve({ data: [], error: null });
        return Object.assign(response, { abortSignal: () => response });
      },
    };
    const report = { cleaner_version: 1, rules_version: 1, lines_removed: 2, tokens_removed: 9, share: 0.3 };
    await applyPrepareOutcome(
      { writer: { setFields }, db: db as never, documentId: 'doc-1', tenantKey: 's:default' },
      { report, review: ['boilerplate_above_threshold', 'tenant_pattern_timeout'] },
    );
    expect(setFields).toHaveBeenCalledWith('doc-1', { metadata: { boilerplate: report } });
    expect(calls).toEqual([
      ['rag_flag_document_review', { p_document_id: 'doc-1', p_tenant_key: 's:default', p_reason: 'boilerplate_above_threshold' }],
      ['rag_flag_document_review', { p_document_id: 'doc-1', p_tenant_key: 's:default', p_reason: 'tenant_pattern_timeout' }],
    ]);
  });
});

describe('chunk stage wiring (D-06 to D-10)', () => {
  const prepareSpy = vi.mocked(prepareChunkInput);
  const loaderSpy = vi.mocked(loadTenantRules);

  function stageContext(mode: string, overrides: { docType?: 'general' | 'scanned_image'; deadline?: number; markdown?: string } = {}) {
    const env = mode === 'unset' ? {} : { RAG_INGEST_PIPELINE: 'unified', RAG_PAGE_BOILERPLATE: mode };
    const setFields = vi.fn(async () => undefined);
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const db = {
      rpc: (name: string, params: Record<string, unknown>) => {
        rpcCalls.push([name, params]);
        const response = Promise.resolve({ data: name === 'rag_tenant_rules_for' ? [] : [], error: null });
        return Object.assign(response, { abortSignal: () => response });
      },
    };
    const docType = overrides.docType ?? 'general';
    const ctx = {
      input: { scope: mintScope('single', null, null), source: 'config_upload' },
      deps: { db: () => db, now: () => 0 },
      writer: { setFields },
      config: loadIngestConfig(env),
      signal: new AbortController().signal,
      deadline: overrides.deadline ?? 50_000,
      identity: { tenantKey: 's:default', filename: 'doc.md', fileSha256: 'x', docType, docTypeOrigin: 'picked', profile: getProcessingProfile(docType), bytes: null },
      document: { id: 'doc-1', version: 1, lineageId: '33333333-3333-4333-8333-333333333333', resumed: false },
      warnings: [] as string[],
      state: emptyIngestState(),
      work: { parseText: overrides.markdown ?? documentOf(4, [MARKER]).markdown, parserVersion: null, chunks: [], chunksWritten: 0 },
    } as unknown as StageContext;
    return { ctx, setFields, rpcCalls };
  }

  beforeEach(() => {
    prepareSpy.mockClear();
    loaderSpy.mockClear();
  });

  test.each(['unset', 'off'])('mode %s: no preparation, no loader, no artifact read, no write, no snapshot; thirteen stages', async (mode) => {
    const store = createFakeObjectStore();
    setObjectStoreForTests(store);
    const { ctx, setFields, rpcCalls } = stageContext(mode);
    const before = ctx.work.parseText;
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expect(setFields).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect('chunkPrep' in ctx.state).toBe(false);
    expect(ctx.work.parseText).toBe(before);
    expect(INGEST_STAGES).toHaveLength(13);
  });

  test('mode detect on a document without page structure: warning, report stored, chunks cut, snapshot saved, no loader call', async () => {
    setObjectStoreForTests(createFakeObjectStore());
    const { ctx, setFields } = stageContext('detect');
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(ctx.warnings).toContain('boilerplate_pages_unavailable');
    expect(setFields).toHaveBeenCalledWith('doc-1', { metadata: { boilerplate: expect.objectContaining({ lines_removed: 0 }) } });
    expect(ctx.state.chunkPrep?.boilerplate?.mode).toBe('detect');
    expect(ctx.work.chunks.length).toBeGreaterThan(0);
  });

  test('with a snapshot in the state the stage replays it: no loader and no worker call', async () => {
    setObjectStoreForTests(createFakeObjectStore());
    const { ctx } = stageContext('rules');
    ctx.state.chunkPrep = { fingerprint: 'c'.repeat(64), boilerplate: { mode: 'rules', cleanerVersion: 1, rulesVersion: 1, ruleIds: [], removedLineKeys: [] }, warnings: [], truncated: false };
    await chunkStage.run(ctx);
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(matchSpy).not.toHaveBeenCalled();
  });

  test('a picture is not cleaned but records a snapshot with the mode and versions', async () => {
    setObjectStoreForTests(createFakeObjectStore());
    const { ctx, setFields } = stageContext('both', { docType: 'scanned_image' });
    const profile = ctx.identity!.profile;
    ctx.identity!.profile = { ...profile, chunker: { ...profile.chunker, kind: 'image_caption' } };
    await chunkStage.run(ctx);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(setFields).not.toHaveBeenCalled();
    expect(ctx.state.chunkPrep?.boilerplate).toMatchObject({ mode: 'both', cleanerVersion: 1, rulesVersion: 1, removedLineKeys: [] });
  });

  test('a needed worker call with less than the worker deadline plus two seconds left yields; without one it never yields for this reason', async () => {
    setObjectStoreForTests(createFakeObjectStore());
    loaderSpy.mockResolvedValueOnce(lineRule);
    const short = stageContext('rules', { deadline: 4_000 });
    expect(await chunkStage.run(short.ctx)).toEqual({ kind: 'yield', reason: 'deadline' });
    expect(prepareSpy).not.toHaveBeenCalled();

    loaderSpy.mockResolvedValueOnce(rules());
    const noRule = stageContext('rules', { deadline: 4_000 });
    expect(await chunkStage.run(noRule.ctx)).toEqual({ kind: 'next' });
  });

  test('a review code is flagged through the rpc with the run tenant key', async () => {
    setObjectStoreForTests(createFakeObjectStore());
    loaderSpy.mockResolvedValueOnce(lineRule);
    matchSpy.mockResolvedValueOnce({ kind: 'timeout' });
    const { ctx, rpcCalls } = stageContext('rules');
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(rpcCalls).toContainEqual(['rag_flag_document_review', { p_document_id: 'doc-1', p_tenant_key: 's:default', p_reason: 'tenant_pattern_timeout' }]);
  });

  test('callerDocumentMetadata drops the pipeline-owned keys and keeps an unrelated one', () => {
    expect(callerDocumentMetadata({ documentMetadata: { boilerplate: 'x', review_reasons: 'y', section_rules: 'z', note: 'kept' } })).toEqual({ note: 'kept' });
  });
});

describe('section rules in prepareChunkInput (plan 03.3-12; D-11, D-13, D-17, D-20)', () => {
  const RULE_SET_ID = '66666666-6666-4666-8666-666666666666';
  const NAME_MARKER = 'Zqheading';
  const chunkerSchema = ProcessingProfileSetSchema.shape.profiles.element.shape.chunker;

  function sectionRules(headings: Array<{ pattern: string; name: string; required?: boolean }>, partial: Partial<TenantRules> = {}): TenantRules {
    return rules({
      ruleSet: {
        id: RULE_SET_ID,
        version: 4,
        docType: 'general',
        source: null,
        headings: headings.map((heading) => ({ pattern: heading.pattern, flags: 'u', name: heading.name, level: 1, required: heading.required ?? true, restart: false })),
        requireIncreasingNumbers: false,
        skipToc: true,
        tocMinRun: 3,
      },
      ruleIds: [{ kind: 'rule_set', id: RULE_SET_ID, version: 4 }],
      fingerprint: 'd'.repeat(64),
      ...partial,
    });
  }

  const bound = sectionRules([{ pattern: '^Bulletin', name: NAME_MARKER }]);
  const withLineRule = sectionRules([{ pattern: '^Bulletin', name: NAME_MARKER }], { boilerplateRules: lineRule.boilerplateRules, ruleIds: [{ kind: 'rule_set', id: RULE_SET_ID, version: 4 }, ...lineRule.ruleIds] });
  const unsatisfiable = sectionRules([{ pattern: '^Bulletin', name: NAME_MARKER }, { pattern: '^Absent heading', name: 'Absent' }]);

  test('one worker call carries the heading patterns first, then the line patterns', async () => {
    await prepareChunkInput(args({ mode: 'both', rules: withLineRule, sectionRules: 'on' }));
    expect(matchSpy).toHaveBeenCalledTimes(1);
    const request = matchSpy.mock.calls[0]![0];
    expect(request.patterns.map((entry) => [entry.id, entry.kind])).toEqual([
      ['h:0', 'heading'],
      [LINE_RULE_ID, 'boilerplate_line'],
    ]);
    expect(new Set(request.lines).size).toBe(request.lines.length);
    expect(request.lines).toContain(HEADER);
  });

  test('a satisfied document: hit lines are protected from cleaning and the rule-driven chunker is returned', async () => {
    const result = await prepareChunkInput(args({ mode: 'detect', rules: bound, sectionRules: 'on' }));
    expect(result.markdown.split(HEADER).length - 1).toBe(4);
    expect(result.markdown).not.toMatch(/Page \d of 4/);
    expect(result.chunker).not.toBe(baseChunker);
    expect(result.chunker).toEqual({
      ...baseChunker,
      kind: 'rule_sections',
      section_rules: { rule_set_id: RULE_SET_ID, version: 4, skip_toc: true, toc_min_run: 3, hits: { [HEADER]: { name: NAME_MARKER, level: 1, restart: false } } },
    });
    expect(chunkerSchema.safeParse(result.chunker).success).toBe(true);
    expect(result.review).toEqual([]);
    expect(result.sectionRules).toEqual({ rule_set_id: RULE_SET_ID, version: 4, satisfied: true, counts: { headings: 4, variants: 0, skipped: 0 } });
    expect(result.snapshot.sectionRules).toEqual({
      ruleSetId: RULE_SET_ID,
      ruleSetVersion: 4,
      toc: { skip: true, minRunLines: 3 },
      headingHits: { [HEADER]: { name: NAME_MARKER, level: 1, restart: false } },
      satisfied: true,
    });
    const off = await prepareChunkInput(args({ mode: 'detect', rules: bound }));
    expect(off.markdown).not.toContain(HEADER);
  });

  test('a document that does not satisfy its rule set keeps the profile chunker object and is flagged', async () => {
    const result = await prepareChunkInput(args({ mode: 'both', rules: unsatisfiable, sectionRules: 'on' }));
    expect(result.chunker).toBe(baseChunker);
    expect(result.review).toEqual(['section_rules_not_satisfied']);
    expect(result.markdown).toContain(HEADER);
    expect(result.snapshot.sectionRules?.satisfied).toBe(false);
    expect(result.sectionRules).toMatchObject({ satisfied: false });
  });

  test('cleaning off: no line is removed, the same string comes back, hits and selection run alone, no boilerplate part', async () => {
    const doc = documentOf(4, [MARKER]);
    const result = await prepareChunkInput(args({ mode: 'off', markdown: doc.markdown, rules: withLineRule, sectionRules: 'on' }));
    expect(result.markdown).toBe(doc.markdown);
    expect(matchSpy.mock.calls[0]![0].patterns.map((entry) => entry.kind)).toEqual(['heading']);
    expect(result.chunker.kind).toBe('rule_sections');
    expect(result.snapshot.boilerplate).toBeUndefined();
    expect(result.snapshot.sectionRules?.satisfied).toBe(true);
  });

  test('no bound rule set, or section rules off: no heading pattern is sent and the profile chunker object is returned', async () => {
    await prepareChunkInput(args({ mode: 'both', rules: rules(), sectionRules: 'on' }));
    expect(matchSpy).not.toHaveBeenCalled();
    const unbound = await prepareChunkInput(args({ mode: 'off', rules: rules(), sectionRules: 'on' }));
    expect(matchSpy).not.toHaveBeenCalled();
    expect(unbound.chunker).toBe(baseChunker);
    expect(unbound.review).toEqual([]);
    expect(unbound.snapshot.sectionRules).toBeUndefined();

    const reference = await prepareChunkInput(args({ mode: 'both', rules: lineRule }));
    matchSpy.mockClear();
    const ruleSetIgnored = await prepareChunkInput(args({ mode: 'both', rules: { ...withLineRule, fingerprint: lineRule.fingerprint } }));
    expect(matchSpy.mock.calls[0]![0].patterns.map((entry) => entry.kind)).toEqual(['boilerplate_line']);
    expect(ruleSetIgnored.chunker).toBe(baseChunker);
    expect(ruleSetIgnored.markdown).toBe(reference.markdown);
    expect(ruleSetIgnored.review).toEqual(reference.review);
    expect(ruleSetIgnored.report).toEqual(reference.report);
    expect(ruleSetIgnored.snapshot.sectionRules).toBeUndefined();
    expect(ruleSetIgnored.sectionRules).toBeNull();
    expect(reference.sectionRules).toBeNull();
  });

  test('a worker timeout: tenant_pattern_timeout, the profile chunker object, no hit used', async () => {
    matchSpy.mockResolvedValueOnce({ kind: 'timeout' });
    const result = await prepareChunkInput(args({ mode: 'detect', rules: bound, sectionRules: 'on' }));
    expect(result.review).toEqual(['tenant_pattern_timeout']);
    expect(result.chunker).toBe(baseChunker);
    expect(result.markdown).not.toContain(HEADER);
  });

  test('a hit map over the contract caps: the profile chunker object, a warning and section_rules_not_satisfied', async () => {
    const lines = Array.from({ length: SECTION_HITS_CAP.maxEntries + 1 }, (_, index) => `Entry ${index.toString(36)} text`);
    const markdown = lines.join('\n\nBody.\n\n');
    const result = await prepareChunkInput(args({ mode: 'off', markdown, pageLines: null, rules: sectionRules([{ pattern: '^Entry', name: 'Entry' }]), sectionRules: 'on' }));
    expect(result.chunker).toBe(baseChunker);
    expect(result.warnings).toContain('section_rules_snapshot_too_large');
    expect(result.review).toEqual(['section_rules_not_satisfied']);
    expect(result.snapshot.sectionRules?.headingHits).toEqual({});
  });

  test('a snapshot replays chunker, Markdown and review codes without rules or a worker call, whatever rule set is passed now', async () => {
    const first = await prepareChunkInput(args({ mode: 'both', rules: withLineRule, sectionRules: 'on' }));
    matchSpy.mockClear();
    for (const now of [rules(), unsatisfiable, null]) {
      const again = await prepareChunkInput(args({ mode: 'both', rules: now, sectionRules: 'on', snapshot: first.snapshot }));
      expect(matchSpy).not.toHaveBeenCalled();
      expect(again.chunker).toEqual(first.chunker);
      expect(again.markdown).toBe(first.markdown);
      expect(again.review).toEqual(first.review);
      expect(again.sectionRules).toEqual(first.sectionRules);
    }
    const failed = await prepareChunkInput(args({ mode: 'both', rules: unsatisfiable, sectionRules: 'on' }));
    const replayedFailure = await prepareChunkInput(args({ mode: 'both', rules: bound, sectionRules: 'on', snapshot: failed.snapshot }));
    expect(replayedFailure.chunker).toBe(baseChunker);
    expect(replayedFailure.review).toEqual(['section_rules_not_satisfied']);

    matchSpy.mockResolvedValueOnce({ kind: 'timeout' });
    const timedOut = await prepareChunkInput(args({ mode: 'detect', rules: bound, sectionRules: 'on' }));
    const replayedTimeout = await prepareChunkInput(args({ mode: 'detect', rules: null, sectionRules: 'on', snapshot: timedOut.snapshot }));
    expect(replayedTimeout.review).toEqual(['tenant_pattern_timeout']);
    expect(replayedTimeout.chunker).toBe(baseChunker);
  });

  test('no log line, warning or review code holds a heading name, a pattern or a line', async () => {
    const results = [
      await prepareChunkInput(args({ mode: 'both', rules: withLineRule, sectionRules: 'on' })),
      await prepareChunkInput(args({ mode: 'both', rules: unsatisfiable, sectionRules: 'on' })),
    ];
    matchSpy.mockResolvedValueOnce({ kind: 'error', error: 'worker_failed' });
    results.push(await prepareChunkInput(args({ mode: 'both', rules: bound, sectionRules: 'on' })));
    for (const line of logged) {
      for (const secret of [NAME_MARKER, '^Bulletin', HEADER, MARKER]) expect(line).not.toContain(secret);
    }
    for (const result of results) {
      for (const code of [...result.warnings, ...result.review, ...result.snapshot.warnings]) expect(code).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('chunk stage with section rules (plan 03.3-12)', () => {
  const prepareSpy = vi.mocked(prepareChunkInput);
  const loaderSpy = vi.mocked(loadTenantRules);
  const RULE_SET_ID = '77777777-7777-4777-8777-777777777777';

  const ruleSetRules = (headings: Array<{ pattern: string; name: string }>): TenantRules =>
    rules({
      ruleSet: {
        id: RULE_SET_ID,
        version: 2,
        docType: 'general',
        source: null,
        headings: headings.map((heading) => ({ ...heading, flags: 'u', level: 1, required: true, restart: false })),
        requireIncreasingNumbers: false,
        skipToc: true,
        tocMinRun: 3,
      },
      ruleIds: [{ kind: 'rule_set', id: RULE_SET_ID, version: 2 }],
    });

  function stageContext(env: Record<string, string>, overrides: { deadline?: number; picture?: boolean } = {}) {
    const setFields = vi.fn(async () => undefined);
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const db = {
      rpc: (name: string, params: Record<string, unknown>) => {
        rpcCalls.push([name, params]);
        const response = Promise.resolve({ data: [], error: null });
        return Object.assign(response, { abortSignal: () => response });
      },
    };
    const profile = getProcessingProfile('general');
    const identity = {
      tenantKey: 's:default',
      filename: 'doc.md',
      fileSha256: 'x',
      docType: 'general',
      docTypeOrigin: 'picked',
      profile: overrides.picture ? { ...profile, chunker: { ...profile.chunker, kind: 'image_caption' } } : profile,
      bytes: null,
    };
    const ctx = {
      input: { scope: mintScope('single', null, null), source: 'config_upload' },
      deps: { db: () => db, now: () => 0 },
      writer: { setFields },
      config: loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified', ...env }),
      signal: new AbortController().signal,
      deadline: overrides.deadline ?? 50_000,
      identity,
      document: { id: 'doc-1', version: 1, lineageId: '33333333-3333-4333-8333-333333333333', resumed: false },
      warnings: [] as string[],
      state: emptyIngestState(),
      work: { parseText: documentOf(4).markdown, parserVersion: null, chunks: [], chunksWritten: 0 },
    } as unknown as StageContext;
    return { ctx, identity, setFields, rpcCalls };
  }

  beforeEach(() => {
    prepareSpy.mockClear();
    loaderSpy.mockClear();
    setObjectStoreForTests(createFakeObjectStore());
  });

  test('switch on, cleaning off: the rule set is loaded for the binding, the run identity carries the effective chunker, the chunks follow the rule sections', async () => {
    loaderSpy.mockResolvedValueOnce(ruleSetRules([{ pattern: '^Bulletin', name: 'Unit' }]));
    const { ctx, identity, setFields } = stageContext({ RAG_SECTION_RULES: 'on' });
    const before = ctx.work.parseText;
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(loaderSpy).toHaveBeenCalledTimes(1);
    expect(loaderSpy.mock.calls[0]![1]).toEqual({ docType: 'general', source: 'config_upload' });
    expect(ctx.work.parseText).toBe(before);
    expect(ctx.identity).not.toBe(identity);
    expect(ctx.identity!.profile.chunker.kind).toBe('rule_sections');
    expect(identity.profile.chunker.kind).toBe(getProcessingProfile('general').chunker.kind);
    expect(ctx.identity!.profile.id).toBe(identity.profile.id);
    expect(ctx.work.chunks.every((chunk) => chunk.section_path[0] === 'Unit' && chunk.page_start === null)).toBe(true);
    expect(setFields).toHaveBeenCalledWith('doc-1', { metadata: { section_rules: { rule_set_id: RULE_SET_ID, version: 2, satisfied: true, counts: { headings: 4, variants: 0, skipped: 0 } } } });
    expect(ctx.state.chunkPrep?.sectionRules?.ruleSetId).toBe(RULE_SET_ID);
    expect(ctx.state.chunkPrep?.boilerplate).toBeUndefined();
  });

  test('a document that does not satisfy its rule set: profile chunker on the identity, flagged with the run tenant key', async () => {
    loaderSpy.mockResolvedValueOnce(ruleSetRules([{ pattern: '^Absent heading', name: 'Absent' }]));
    const { ctx, identity, rpcCalls } = stageContext({ RAG_SECTION_RULES: 'on', RAG_PAGE_BOILERPLATE: 'detect' });
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(ctx.identity).toBe(identity);
    expect(rpcCalls).toContainEqual(['rag_flag_document_review', { p_document_id: 'doc-1', p_tenant_key: 's:default', p_reason: 'section_rules_not_satisfied' }]);
  });

  test('no bound rule set: the identity is unchanged and no section_rules metadata is written', async () => {
    loaderSpy.mockResolvedValueOnce(rules());
    const { ctx, identity, setFields } = stageContext({ RAG_SECTION_RULES: 'on' });
    await chunkStage.run(ctx);
    expect(ctx.identity).toBe(identity);
    for (const call of setFields.mock.calls as unknown as Array<[string, { metadata: Record<string, unknown> }]>) {
      expect('section_rules' in call[1].metadata).toBe(false);
    }
  });

  test('a picture keeps its caption-only chunker: no preparation and no rule load with cleaning off', async () => {
    const { ctx, identity } = stageContext({ RAG_SECTION_RULES: 'on' }, { picture: true });
    await chunkStage.run(ctx);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(ctx.identity).toBe(identity);
  });

  test('a heading pattern call with too little time left yields', async () => {
    loaderSpy.mockResolvedValueOnce(ruleSetRules([{ pattern: '^Bulletin', name: 'Unit' }]));
    const { ctx } = stageContext({ RAG_SECTION_RULES: 'on' }, { deadline: 4_000 });
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'yield', reason: 'deadline' });
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('switch off: no rule load and no preparation', async () => {
    const { ctx, identity } = stageContext({});
    await chunkStage.run(ctx);
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(ctx.identity).toBe(identity);
  });
});
