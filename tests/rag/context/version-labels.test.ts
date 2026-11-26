import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assemblyDocumentSelect,
  fetchAssemblyRows,
  resetVersionColumnsWarningForTests,
  VERSION_LABELS_MIGRATION_WARNING,
} from '@/lib/rag/context/fetch-rows';
import { effectiveDateOf, versionHeaderSuffix, versionLabelOf } from '@/lib/rag/context/version-labels';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import type { AssemblyCandidate } from '@/lib/rag/context/assemble';

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
