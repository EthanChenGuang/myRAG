import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyCandidate, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { fetchAssemblyRows, resetVersionColumnsWarningForTests } from '@/lib/rag/context/fetch-rows';
import {
  detectMixedVersions,
  findVersionConflicts,
  findVersionGroups,
  recordAnswerConflict,
  summarizeVersionConflicts,
  versionConflictTrace,
  type VersionBlock,
  type VersionConflict,
} from '@/lib/rag/context/version-conflicts';
import { buildAnswerChecksInput } from '@/lib/rag/generation/answer-checks';
import type { AnswerCollector } from '@/lib/rag/generation/answer-collector';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';

const DOC_OLD = '00000000-0000-4000-8000-0000000000a1';
const DOC_NEW = '00000000-0000-4000-8000-0000000000a2';
const TENANT = 's:default';

const SHARED = 'Each unit of the synthetic widget line is inspected by the north team before shipping.';
const OLD_TEXT = `${SHARED} The calibration interval for the widget line is 30 days. Reports are filed in the shared folder each week.`;
const NEW_TEXT = `${SHARED} The calibration interval for the widget line is 45 days. Reports are filed in the shared folder each week.`;

function block(overrides: Partial<VersionBlock> & Pick<VersionBlock, 'documentId'>): VersionBlock {
  return {
    filename: 'Rule set A v1.pdf',
    docType: 'manual',
    effectiveFrom: null,
    version: 1,
    text: OLD_TEXT,
    ...overrides,
  };
}

const OLDER = block({ documentId: DOC_OLD, filename: 'Rule set A v1.pdf', effectiveFrom: '2026-01-01', text: OLD_TEXT });
const NEWER = block({ documentId: DOC_NEW, filename: 'Rule set A v2.pdf', effectiveFrom: '2026-06-01', text: NEW_TEXT });

beforeEach(() => {
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', '');
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', '');
  vi.stubEnv('RAG_VERSION_LABELS', '');
  vi.stubEnv('RAG_SECURITY_EVENTS', '');
  resetLanguageSettingsForTests();
  resetVersionColumnsWarningForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLanguageSettingsForTests();
});

describe('version groups (D-52 rule a and supersession rows)', () => {
  it('groups two documents of one doc type whose titles are equal once the markers are removed', () => {
    const groups = findVersionGroups([OLDER, NEWER], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rule).toBe('title_match');
  });

  it('groups different titles through a confirmed supersession row as supersession_link', () => {
    const renamed = { ...NEWER, filename: 'Widget handbook.pdf' };
    expect(findVersionGroups([OLDER, renamed], [])).toHaveLength(0);
    const groups = findVersionGroups([OLDER, renamed], [{ documentId: DOC_NEW, candidateDocumentId: DOC_OLD, status: 'confirmed' }]);
    expect(groups.map((group) => group.rule)).toEqual(['supersession_link']);
  });

  it('a pending candidate row groups as supersession_candidate', () => {
    const renamed = { ...NEWER, filename: 'Widget handbook.pdf' };
    const groups = findVersionGroups([OLDER, renamed], [{ documentId: DOC_OLD, candidateDocumentId: DOC_NEW, status: 'pending' }]);
    expect(groups.map((group) => group.rule)).toEqual(['supersession_candidate']);
  });

  it('never groups documents of different doc types', () => {
    expect(findVersionGroups([OLDER, { ...NEWER, docType: 'form' }], [])).toHaveLength(0);
    expect(findVersionGroups([OLDER, { ...NEWER, docType: null }], [])).toHaveLength(0);
  });
});

describe('version conflicts (D-52 rule b)', () => {
  it('a strongly overlapping pair that differs in one number is a conflict; the later effective date is the latest', () => {
    const pairs = findVersionConflicts(findVersionGroups([OLDER, NEWER], []));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ newerDocumentId: DOC_NEW, olderDocumentId: DOC_OLD, rule: 'title_match' });
    const summary = summarizeVersionConflicts(pairs)!;
    expect(versionConflictTrace(summary)).toEqual({ document_ids: [DOC_OLD, DOC_NEW], latest_document_id: DOC_NEW, group_rule: 'title_match' });
  });

  it('without dates the higher version is the newer one', () => {
    const pairs = findVersionConflicts(
      findVersionGroups([{ ...OLDER, effectiveFrom: null, version: 3 }, { ...NEWER, effectiveFrom: null, version: 2 }], []),
    );
    expect(pairs[0]).toMatchObject({ newerDocumentId: DOC_OLD, olderDocumentId: DOC_NEW });
  });

  it('equal titles with no differing number or date are no conflict', () => {
    expect(findVersionConflicts(findVersionGroups([OLDER, { ...NEWER, text: OLD_TEXT }], []))).toEqual([]);
  });

  it('texts that do not overlap are no conflict even with differing numbers', () => {
    const unrelated = { ...NEWER, text: 'A separate synthetic note lists 12 storage shelves. Another line mentions 7 crates.' };
    expect(findVersionConflicts(findVersionGroups([OLDER, unrelated], []))).toEqual([]);
  });
});

const ROWS: Record<string, AssemblyDocumentRow> = {
  [DOC_OLD]: { id: DOC_OLD, filename: 'Rule set A v1.pdf', content: OLD_TEXT, version: 1, doc_type: 'manual', effective_from: '2026-01-01', doc_date: null, version_label: null },
  [DOC_NEW]: { id: DOC_NEW, filename: 'Rule set A v2.pdf', content: NEW_TEXT, version: 1, doc_type: 'manual', effective_from: '2026-06-01', doc_date: null, version_label: null },
};

const CANDIDATES: AssemblyCandidate[] = [
  { chunk_id: 'c-new', document_id: DOC_NEW, content: NEW_TEXT, similarity: 0.92 },
  { chunk_id: 'c-old', document_id: DOC_OLD, content: OLD_TEXT, similarity: 0.9 },
];

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    queryText: 'calibration interval widget line',
    candidates: CANDIDATES,
    documents: new Map(Object.entries(ROWS)),
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: false,
    ...overrides,
  };
}

describe('assembly labels the older block (D-52)', () => {
  it('appends labels.older_version to the older block only and keeps both blocks', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const out = assembleContext(input({ versionPairs: [] }));
    const older = out.blocks.find((entry) => entry.documentId === DOC_OLD)!;
    const newer = out.blocks.find((entry) => entry.documentId === DOC_NEW)!;
    expect(older.title).toContain('Older version');
    expect(newer.title).not.toContain('Older version');
    expect(out.context).toContain('30 days');
    expect(out.context).toContain('45 days');
    expect(out.context).toMatch(/--- Document: Rule set A v1\.pdf[^\n]*Older version/);
    expect(versionConflictTrace(out.versionConflict!)).toEqual({
      document_ids: [DOC_NEW, DOC_OLD],
      latest_document_id: DOC_NEW,
      group_rule: 'title_match',
    });
  });

  it('a supersession link row groups renamed documents', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const documents = new Map(Object.entries(ROWS));
    documents.set(DOC_NEW, { ...ROWS[DOC_NEW]!, filename: 'Widget handbook.pdf' });
    const out = assembleContext(
      input({ documents, versionPairs: [{ documentId: DOC_NEW, candidateDocumentId: DOC_OLD, status: 'confirmed' }] }),
    );
    expect(out.versionConflict?.group_rule).toBe('supersession_link');
    expect(out.blocks.find((entry) => entry.documentId === DOC_OLD)!.title).toContain('Older version');
  });

  it('switch off: no field and the context equals the run without supersession rows', () => {
    const withRows = assembleContext(input({ versionPairs: [{ documentId: DOC_NEW, candidateDocumentId: DOC_OLD, status: 'confirmed' }] }));
    const without = assembleContext(input());
    expect(withRows).toEqual(without);
    expect('versionConflict' in without).toBe(false);
    expect(without.context).not.toContain('Older version');
  });

  it('switch on without a conflict: no field', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const documents = new Map(Object.entries(ROWS));
    documents.set(DOC_NEW, { ...ROWS[DOC_NEW]!, doc_type: 'form' });
    const out = assembleContext(input({ documents, versionPairs: [] }));
    expect('versionConflict' in out).toBe(false);
    expect(out.context).not.toContain('Older version');
  });
});

interface Call {
  table: string;
  filters: Array<[string, string, unknown]>;
}

function fakeAdmin(pairRows: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      const builder = {
        select() {
          return builder;
        },
        in(column: string, values: unknown) {
          call.filters.push(['in', column, values]);
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(['eq', column, value]);
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          calls.push(call);
          const data = table === 'documents' ? Object.values(ROWS) : table === 'rag_supersession_candidates' ? pairRows : [];
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { client: client as never, calls };
}

describe('batched supersession read (D-48, T-05.2-223)', () => {
  const signal = new AbortController().signal;

  it('switch off: no supersession query and no rows field', async () => {
    const admin = fakeAdmin();
    const rows = await fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal, access: { mode: 'off' }, tenantKey: TENANT });
    expect(admin.calls.map((call) => call.table)).toEqual(['documents', 'document_chunks']);
    expect('versionPairs' in rows).toBe(false);
  });

  it('switch on: one query filtered by the tenant key and the request document ids', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const admin = fakeAdmin([{ document_id: DOC_NEW, candidate_document_id: DOC_OLD, status: 'confirmed' }]);
    const rows = await fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal, access: { mode: 'off' }, tenantKey: TENANT });
    const reads = admin.calls.filter((call) => call.table === 'rag_supersession_candidates');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters).toContainEqual(['eq', 'tenant_key', TENANT]);
    expect(reads[0]!.filters).toContainEqual(['in', 'document_id', [DOC_NEW, DOC_OLD]]);
    expect(reads[0]!.filters).toContainEqual(['in', 'candidate_document_id', [DOC_NEW, DOC_OLD]]);
    expect(rows.versionPairs).toEqual([{ documentId: DOC_NEW, candidateDocumentId: DOC_OLD, status: 'confirmed' }]);
  });

  it('switch on without a tenant key: no supersession query', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const admin = fakeAdmin();
    await fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal, access: { mode: 'off' } });
    expect(admin.calls.some((call) => call.table === 'rag_supersession_candidates')).toBe(false);
  });
});

const CONFLICT: VersionConflict = summarizeVersionConflicts(findVersionConflicts(findVersionGroups([OLDER, NEWER], [])))!;
const BLOCKS = [
  { documentId: DOC_OLD, text: OLD_TEXT },
  { documentId: DOC_NEW, text: NEW_TEXT },
];

describe('mixed versions after generation (D-52)', () => {
  it('the newer value only: false', () => {
    expect(detectMixedVersions({ answerText: 'The interval is 45 days.', conflict: CONFLICT, blocks: BLOCKS, question: 'What is the interval?' })).toBe(false);
  });

  it('a value only in the older block and one only in the newer block: true', () => {
    expect(
      detectMixedVersions({ answerText: 'The interval is 30 days or 45 days.', conflict: CONFLICT, blocks: BLOCKS, question: 'What is the interval?' }),
    ).toBe(true);
  });

  it('a historical question by the temporal detector: false', () => {
    expect(
      detectMixedVersions({
        answerText: 'The interval was 30 days and is now 45 days.',
        conflict: CONFLICT,
        blocks: BLOCKS,
        question: 'How did the interval change during 2026?',
      }),
    ).toBe(false);
  });

  it('a pair without an order is never mixed', () => {
    const unordered: VersionConflict = { ...CONFLICT, pairs: CONFLICT.pairs.map((pair) => ({ ...pair, newerDocumentId: null, olderDocumentId: null })) };
    expect(detectMixedVersions({ answerText: '30 days or 45 days', conflict: unordered, blocks: BLOCKS, question: 'interval?' })).toBe(false);
  });

  function collector(text: string): AnswerCollector {
    return {
      finalText: () => text,
      finishReason: () => 'stop',
      truncated: () => false,
      sentences: () => null,
      textPartById: () => null,
    } as unknown as AnswerCollector;
  }

  it('checks carry version_conflict with mixed_versions; the answer text is unchanged', () => {
    const text = 'The interval is 30 days or 45 days.';
    const c = collector(text);
    const checks = buildAnswerChecksInput({ collector: c, retrievalResult: { versionConflict: CONFLICT, blocks: BLOCKS }, question: 'What is the interval?' });
    expect(checks.version_conflict).toEqual({ document_ids: [DOC_OLD, DOC_NEW], latest_document_id: DOC_NEW, group_rule: 'title_match', mixed_versions: true });
    expect(c.finalText()).toBe(text);
  });

  it('no conflict means no key', () => {
    const checks = buildAnswerChecksInput({ collector: collector('45 days'), retrievalResult: { blocks: BLOCKS } });
    expect('version_conflict' in checks).toBe(false);
  });
});

describe('hand-off scheduling (D-52, D-55)', () => {
  it('schedules nothing without a conflict and never writes inline', () => {
    const schedule = vi.fn();
    recordAnswerConflict({ tenantKey: TENANT, conflict: null }, { schedule });
    expect(schedule).not.toHaveBeenCalled();
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    recordAnswerConflict({ tenantKey: TENANT, conflict: CONFLICT }, { schedule, rpc });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a raise failure is logged once with ids and the review item is still queued', async () => {
    const log = vi.fn();
    const enqueue = vi.fn(async () => 'item');
    let task: (() => Promise<void>) | null = null;
    recordAnswerConflict(
      { tenantKey: TENANT, conflict: CONFLICT, traceId: 'trace-1' },
      { schedule: (run) => (task = run), rpc: async () => ({ data: null, error: { message: 'not_found' } }), enqueue, log },
    );
    await task!();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toEqual({ documentId: DOC_NEW, candidateDocumentId: DOC_OLD, reason: 'not_found' });
    expect(enqueue).toHaveBeenCalledWith(
      { tenantKey: TENANT, reason: 'version_conflict', documentIds: [DOC_OLD, DOC_NEW], detector: 'version_conflict', traceId: 'trace-1' },
      undefined,
    );
  });

  it('a rejecting rpc never escapes the task', async () => {
    let task: (() => Promise<void>) | null = null;
    recordAnswerConflict(
      { tenantKey: TENANT, conflict: CONFLICT },
      { schedule: (run) => (task = run), rpc: async () => Promise.reject(new Error('boom')), enqueue: async () => null, log: () => {} },
    );
    await expect(task!()).resolves.toBeUndefined();
  });
});

