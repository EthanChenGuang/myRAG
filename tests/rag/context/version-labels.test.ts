import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assemblyDocumentSelect,
  fetchAssemblyRows,
  resetVersionColumnsWarningForTests,
  VERSION_LABELS_MIGRATION_WARNING,
} from '@/lib/rag/context/fetch-rows';
import { effectiveDateOf, versionHeaderSuffix, versionLabelOf } from '@/lib/rag/context/version-labels';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { assembleContext, type AssembleInput, type AssemblyCandidate, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { docsFromBlocks } from '@/lib/rag/context/wrap';
import { buildAliasMap, createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import { buildClaudeCitationRequest } from '@/lib/rag/generation/citations/claude';

const BASE_SELECT = 'id, filename, created_at, content, metadata';
const VERSION_SELECT = `${BASE_SELECT}, version, doc_type, doc_date, effective_from, version_label`;
const DOC_A = '00000000-0000-4000-8000-0000000000e1';

interface Call {
  table: string;
  select?: string;
}

type Failure = { code?: string; message: string };

function fakeAdmin(rows: Array<Record<string, unknown>>, failSelect?: (select: string) => Failure | null) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table };
      const builder = {
        select(select: string) {
          call.select = select;
          return builder;
        },
        in() {
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          calls.push(call);
          const failure = table === 'documents' && call.select ? failSelect?.(call.select) ?? null : null;
          const result = failure ? { data: null, error: failure } : { data: table === 'documents' ? rows : [], error: null };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { client: client as never, calls };
}

const CANDIDATES: AssemblyCandidate[] = [{ chunk_id: 'c1', document_id: DOC_A, content: 'synthetic widget passage', similarity: 0.9 }];

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

describe('version label helpers (D-49)', () => {
  it('prefers the admin label over the integer version', () => {
    expect(versionLabelOf({ version_label: 'B-2', version: 3 }, 'en')).toBe('B-2');
  });

  it('renders the integer version through labels.version in the label language', () => {
    expect(versionLabelOf({ version_label: null, version: 3 }, 'en')).toBe('Version 3');
    expect(versionLabelOf({ version_label: '  ', version: 3 }, 'it')).toBe('Versione 3');
    expect(versionLabelOf({ version: 7 }, 'zh')).toBe('版本 7');
  });

  it('has no version label without a label or a version', () => {
    expect(versionLabelOf({}, 'en')).toBeNull();
  });

  it('prefers effective_from, then the document date, and always returns ISO dates', () => {
    expect(effectiveDateOf({ effective_from: '2026-03-01', doc_date: '2025-01-01' })).toBe('2026-03-01');
    expect(effectiveDateOf({ effective_from: null, doc_date: '2025-01-02' })).toBe('2025-01-02');
    expect(effectiveDateOf({ effective_from: '2026-03-01T00:00:00+00:00' })).toBe('2026-03-01');
    expect(effectiveDateOf({ effective_from: 'not a date', doc_date: null })).toBeNull();
    expect(effectiveDateOf({})).toBeNull();
  });

  it('joins the version and date labels, in the label language, with the date unchanged', () => {
    expect(versionHeaderSuffix({ version: 2, effective_from: '2026-03-01' }, 'en')).toBe(' · Version 2 · Effective from 2026-03-01');
    expect(versionHeaderSuffix({ version: 2, effective_from: '2026-03-01' }, 'it')).toBe(' · Versione 2 · In vigore dal 2026-03-01');
    expect(versionHeaderSuffix({ version_label: 'B-2' }, 'en')).toBe(' · B-2');
    expect(versionHeaderSuffix({ doc_date: '2025-01-02' }, 'en')).toBe(' · Effective from 2025-01-02');
    expect(versionHeaderSuffix({}, 'en')).toBe('');
  });
});

describe('conditional version columns (D-49, RESEARCH Pitfalls 14 and 15)', () => {
  it('leaves the select unchanged with the switch off', () => {
    expect(assemblyDocumentSelect()).toBe(BASE_SELECT);
  });

  it('adds the five columns once with the switch on', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    expect(assemblyDocumentSelect()).toBe(VERSION_SELECT);
    vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
    expect(assemblyDocumentSelect()).toBe(`${BASE_SELECT}, user_id, version, doc_type, doc_date, effective_from, version_label`);
  });

  it('reads the version columns in the existing batched read, adding no query', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const row = { id: DOC_A, filename: 'a.md', version: 2, doc_type: 'general', doc_date: null, effective_from: '2026-03-01', version_label: null };
    const admin = fakeAdmin([row]);
    const result = await fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal: new AbortController().signal });
    expect(admin.calls.map((call) => call.table)).toEqual(['documents', 'document_chunks']);
    expect(admin.calls[0]!.select).toBe(VERSION_SELECT);
    expect(result.documents.get(DOC_A)).toEqual(row);
  });

  it('retries once with the base select on an unknown column and warns once per process', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = (select: string) =>
      select.includes('version_label') ? { code: '42703', message: 'column documents.version_label does not exist' } : null;
    const row = { id: DOC_A, filename: 'a.md' };
    for (let run = 0; run < 2; run += 1) {
      const admin = fakeAdmin([row], missing);
      const result = await fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal: new AbortController().signal });
      expect(admin.calls.map((call) => call.select)).toEqual([VERSION_SELECT, BASE_SELECT, 'id, metadata']);
      expect(result.documents.get(DOC_A)).toEqual(row);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(VERSION_LABELS_MIGRATION_WARNING);
    expect(VERSION_LABELS_MIGRATION_WARNING).toContain('0801');
    expect(VERSION_LABELS_MIGRATION_WARNING).toContain('0941');
  });

  it('still throws on any other read error, and makes no retry with the switch off', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const admin = fakeAdmin([], () => ({ code: '57014', message: 'canceling statement' }));
    await expect(fetchAssemblyRows(CANDIDATES, { adminClient: admin.client, signal: new AbortController().signal })).rejects.toThrow(
      'documents lookup failed',
    );
    expect(admin.calls).toHaveLength(1);

    vi.stubEnv('RAG_VERSION_LABELS', '');
    const off = fakeAdmin([], () => ({ code: '42703', message: 'column documents.x does not exist' }));
    await expect(fetchAssemblyRows(CANDIDATES, { adminClient: off.client, signal: new AbortController().signal })).rejects.toThrow(
      'documents lookup failed',
    );
    expect(off.calls).toHaveLength(1);
  });
});

const DOC_B = '00000000-0000-4000-8000-0000000000e2';
const DOC_C = '00000000-0000-4000-8000-0000000000e3';

const ASSEMBLY_CANDIDATES: AssemblyCandidate[] = [
  { chunk_id: 'k1', document_id: DOC_A, content: 'first synthetic widget passage', similarity: 0.9 },
  { chunk_id: 'k2', document_id: DOC_B, content: 'second synthetic widget passage', similarity: 0.8 },
  { chunk_id: 'k3', document_id: DOC_C, content: 'third synthetic widget passage', similarity: 0.7 },
];

function baseRows(): Map<string, AssemblyDocumentRow> {
  return new Map<string, AssemblyDocumentRow>([
    [DOC_A, { id: DOC_A, filename: 'widgets.md', created_at: null, content: null, metadata: null }],
    [DOC_B, { id: DOC_B, filename: 'widgets.md', created_at: null, content: null, metadata: null }],
    [DOC_C, { id: DOC_C, filename: 'gadgets.md', created_at: null, content: null, metadata: null }],
  ]);
}

function versionRows(labelA: string | null = null): Map<string, AssemblyDocumentRow> {
  const rows = baseRows();
  rows.set(DOC_A, { ...rows.get(DOC_A)!, version: 2, doc_type: 'general', doc_date: null, effective_from: '2026-03-01', version_label: labelA });
  rows.set(DOC_B, { ...rows.get(DOC_B)!, version: 1, doc_type: 'general', doc_date: '2025-01-02', effective_from: null, version_label: null });
  rows.set(DOC_C, { ...rows.get(DOC_C)!, version: null, doc_type: 'general', doc_date: null, effective_from: null, version_label: null });
  return rows;
}

function assembleInput(documents: Map<string, AssemblyDocumentRow>, over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    queryText: 'synthetic widget passage',
    candidates: ASSEMBLY_CANDIDATES,
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: false,
    ...over,
  };
}

const VARIANTS: Array<[string, Partial<AssembleInput>]> = [
  ['plain', {}],
  ['labelled', { citationLabeler: createCitationLabeler() }],
  ['tagged', { contextTagging: true }],
  ['labelled and tagged', { citationLabeler: createCitationLabeler(), contextTagging: true }],
];

describe('version labels in assembly (D-48, D-50)', () => {
  it.each(VARIANTS)('switch off: the %s context and blocks equal those without version columns', (_name, over) => {
    const without = assembleContext(assembleInput(baseRows(), over));
    const withColumns = assembleContext(assembleInput(versionRows('B-2'), over));
    expect(withColumns.context).toBe(without.context);
    expect(withColumns.blocks.map(({ documentVersion: _v, ...rest }) => rest)).toEqual(without.blocks.map(({ documentVersion: _v, ...rest }) => rest));
    for (const block of withColumns.blocks) {
      expect(Object.prototype.hasOwnProperty.call(block, 'versionLabel')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(block, 'effectiveFrom')).toBe(false);
    }
  });

  it('switch off: the legacy document lines are unchanged', () => {
    const output = assembleContext(assembleInput(versionRows()));
    expect(output.context).toContain('--- Document: widgets.md (2 relevant chunks) ---');
    expect(output.blocks.map((block) => block.title)).toEqual(['widgets.md', 'widgets.md', 'gadgets.md']);
  });

  it('switch on: titles, document lines and labeler headers carry the suffix; block fields are set', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const plain = assembleContext(assembleInput(versionRows()));
    expect(plain.context).toContain('--- Document: widgets.md · Version 2 · Effective from 2026-03-01 (1 relevant chunks) ---');
    expect(plain.context).toContain('--- Document: widgets.md · Version 1 · Effective from 2025-01-02 (1 relevant chunks) ---');
    expect(plain.context).toContain('--- Document: gadgets.md (1 relevant chunks) ---');
    expect(plain.blocks.map((block) => block.title)).toEqual([
      'widgets.md · Version 2 · Effective from 2026-03-01',
      'widgets.md · Version 1 · Effective from 2025-01-02',
      'gadgets.md',
    ]);
    expect(plain.blocks.map((block) => [block.documentVersion, block.versionLabel, block.effectiveFrom])).toEqual([
      [2, 'Version 2', '2026-03-01'],
      [1, 'Version 1', '2025-01-02'],
      [null, undefined, undefined],
    ]);
    expect(Object.prototype.hasOwnProperty.call(plain.blocks[2], 'versionLabel')).toBe(false);

    const labelled = assembleContext(assembleInput(versionRows('B-2'), { citationLabeler: createCitationLabeler() }));
    expect(labelled.context).toContain('[S1] widgets.md · B-2 · Effective from 2026-03-01\n');
    expect(labelled.context).toContain('[S2] widgets.md · Version 1 · Effective from 2025-01-02\n');
    expect(labelled.blocks.map((block) => block.text)).toEqual(
      assembleContext(assembleInput(baseRows(), { citationLabeler: createCitationLabeler() })).blocks.map((block) => block.text),
    );
  });

  it('switch on with tagging: <doc> carries escaped version and effective attributes', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const output = assembleContext(assembleInput(versionRows('a"b<c>'), { citationLabeler: createCitationLabeler(), contextTagging: true }));
    expect(output.context).toContain('<doc id="S1" source="widgets.md" version="a&quot;b&lt;c&gt;" effective="2026-03-01">');
    expect(output.context).toContain('<doc id="S2" source="widgets.md" version="Version 1" effective="2025-01-02">');
    expect(output.context).toContain('<doc id="S3" source="gadgets.md">');
    expect(output.context).not.toContain('version="a"b');
    const docs = docsFromBlocks(output.blocks);
    expect(docs[0]).toMatchObject({ version: 'a"b<c>', effective: '2026-03-01' });
    expect(docs[2]).not.toHaveProperty('version');
  });

  it('switch on: the Claude document title carries the suffix through block.title', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const output = assembleContext(assembleInput(versionRows(), { citationLabeler: createCitationLabeler() }));
    const aliasMap = buildAliasMap(output.blocks);
    const request = buildClaudeCitationRequest({
      provider: (() => ({})) as never,
      aliasMap,
      system: 'system',
      history: [],
      question: 'q',
      anthropicId: 'claude-test',
    });
    const parts = (request.messages.at(-1)!.content as Array<{ providerOptions?: { anthropic?: { title?: string } } }>).filter(
      (part) => part.providerOptions,
    );
    expect(parts.map((part) => part.providerOptions!.anthropic!.title)).toEqual([
      'widgets.md · Version 2 · Effective from 2026-03-01',
      'widgets.md · Version 1 · Effective from 2025-01-02',
      'gadgets.md',
    ]);
  });

  it('switch on: labels follow the question language among the enabled languages, else the primary language', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    resetLanguageSettingsForTests();
    const italian = assembleContext(
      assembleInput(versionRows(), {
        queryText: 'Qual è il valore indicato nella sezione del documento sintetico per questo parametro e quando è stato aggiornato?',
      }),
    );
    expect(italian.blocks[0]!.title).toBe('widgets.md · Versione 2 · In vigore dal 2026-03-01');
    const unclear = assembleContext(assembleInput(versionRows(), { queryText: '42' }));
    expect(unclear.blocks[0]!.title).toBe('widgets.md · Version 2 · Effective from 2026-03-01');
  });

  it('switch on: rows without version columns (fallback read) render today\'s titles', () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    const output = assembleContext(assembleInput(baseRows()));
    expect(output.blocks.map((block) => block.title)).toEqual(['widgets.md', 'widgets.md', 'gadgets.md']);
    expect(output.context).toContain('--- Document: gadgets.md (1 relevant chunks) ---');
  });
});
