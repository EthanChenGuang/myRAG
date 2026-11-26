import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScopeTagSuggestionSchema } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import {
  MAX_SCOPE_LLM_TEXT_CHARS,
  setScopeSuggestLlmForTests,
  suggestScopeTags,
  type ScopeSuggestLlmInput,
  type ScopeVocabularyEntry,
} from '@/lib/rag/ingest/extractors/scope-suggest';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const signal = new AbortController().signal;

const VOCABULARY: ScopeVocabularyEntry[] = [
  { dimension: 'region', value: 'north-zone', label: 'North Zone', aliases: ['Zone N'], active: true },
  { dimension: 'region', value: 'old-zone', label: 'Old Zone', aliases: [], active: false },
  { dimension: 'legal_entity', value: 'entity-one', label: '甲实体', aliases: ['甲方主体'], active: true },
  { dimension: 'department', value: 'unit-alpha', label: 'Alpha', aliases: ['Team Alpha'], active: true },
];

function suggest(title: string, firstPage: string, extra: Partial<Parameters<typeof suggestScopeTags>[0]> = {}) {
  return suggestScopeTags({ title, firstPage, vocabulary: VOCABULARY, existing: [], ...extra });
}

function tags(result: Awaited<ReturnType<typeof suggestScopeTags>>): string[] {
  return result.suggestion.suggestions.map((item) => `${item.dimension}:${item.value}:${item.source}`);
}

describe('suggestScopeTags (rules)', () => {
  test('a label in the title and an alias on the first page are suggested with source rule', async () => {
    const result = await suggest('North Zone overview', 'A neutral text written for Team Alpha readers.');
    expect(tags(result)).toEqual(['region:north-zone:rule', 'department:unit-alpha:rule']);
    expect(ScopeTagSuggestionSchema.safeParse(result.suggestion).success).toBe(true);
  });

  test('matching is case-folded and on whole words; a label inside a longer word does not match', async () => {
    expect(tags(await suggest('north zone', ''))).toEqual(['region:north-zone:rule']);
    expect(tags(await suggest('Alphabet soup', 'Alphanumeric zoneN values'))).toEqual([]);
  });

  test('a zh label matches as an exact substring', async () => {
    expect(tags(await suggest('说明', '本文件适用于甲实体的全部人员。'))).toEqual(['legal_entity:entity-one:rule']);
  });

  test('retired entries are never suggested', async () => {
    expect(tags(await suggest('Old Zone notes', 'Old Zone'))).toEqual([]);
  });

  test('tags the uploader already set are not suggested again', async () => {
    expect(tags(await suggest('North Zone overview', 'Team Alpha', { existing: ['region:north-zone'] }))).toEqual(['department:unit-alpha:rule']);
  });

  test('an empty vocabulary suggests nothing and makes no model call', async () => {
    const call = vi.fn(async () => ({ suggestions: [] }));
    setScopeSuggestLlmForTests(call);
    try {
      const result = await suggestScopeTags({ title: 'North Zone', firstPage: 'x', vocabulary: [], existing: [], llm: { signal } });
      expect(result.suggestion.suggestions).toEqual([]);
      expect(call).not.toHaveBeenCalled();
    } finally {
      setScopeSuggestLlmForTests(null);
    }
  });
});

describe('suggestScopeTags (model step)', () => {
  afterEach(() => setScopeSuggestLlmForTests(null));

  test('a model value in the vocabulary is added with source model; one outside it is dropped', async () => {
    const seen: ScopeSuggestLlmInput[] = [];
    setScopeSuggestLlmForTests(async (input) => {
      seen.push(input);
      return {
        suggestions: [
          { dimension: 'legal_entity', value: 'entity-one', source: 'rule' },
          { dimension: 'region', value: 'invented-zone', source: 'model' },
          { dimension: 'region', value: 'old-zone', source: 'model' },
          { dimension: 'region', value: 'north-zone', source: 'model' },
        ],
      };
    });
    const result = await suggest('North Zone overview', 'A neutral text.', { llm: { signal } });
    expect(tags(result)).toEqual(['region:north-zone:rule', 'legal_entity:entity-one:model']);
    expect(seen[0]!.vocabulary.map((entry) => `${entry.dimension}:${entry.value}`)).toEqual([
      'region:north-zone',
      'legal_entity:entity-one',
      'department:unit-alpha',
    ]);
  });

  test('only the title and a bounded first-page excerpt are sent', async () => {
    const seen: ScopeSuggestLlmInput[] = [];
    setScopeSuggestLlmForTests(async (input) => {
      seen.push(input);
      return { suggestions: [] };
    });
    await suggest('Title', 'neutral words '.repeat(2000), { llm: { signal } });
    expect(seen[0]!.title).toBe('Title');
    expect(seen[0]!.text.length).toBeLessThanOrEqual(MAX_SCOPE_LLM_TEXT_CHARS);
  });

  test('a model error or an invalid answer keeps the rule suggestions', async () => {
    setScopeSuggestLlmForTests(async () => {
      throw new Error('boom');
    });
    const failed = await suggest('North Zone', '', { llm: { signal } });
    expect(tags(failed)).toEqual(['region:north-zone:rule']);
    expect(failed.warnings).toContain('scope_suggest_llm_failed');

    setScopeSuggestLlmForTests(async () => ({ suggestions: 'nope' }));
    const invalid = await suggest('North Zone', '', { llm: { signal } });
    expect(tags(invalid)).toEqual(['region:north-zone:rule']);
    expect(invalid.warnings).toContain('scope_suggest_llm_invalid');
  });
});

describe('extract stage: scope suggestions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallIngestDeps();
    setScopeSuggestLlmForTests(null);
    vi.restoreAllMocks();
  });

  const TEXT = '# Overview\n\nThis neutral text is written for Team Alpha readers and covers a plain process.\n';
  const VOCAB_ROWS = VOCABULARY.map(({ dimension, value, label, aliases, active }) => ({ dimension, value, label, aliases, active }));

  async function run(env: Record<string, string>, options: { vocabulary?: Array<Record<string, unknown>>; scopes?: string[] } = {}) {
    const { db, calls } = fakeIngestDb({ answers: { rag_scope_vocabulary_for: () => options.vocabulary ?? VOCAB_ROWS } });
    installIngestDeps({ db, env });
    const result = await ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/north-zone-overview.md',
      text: TEXT,
      filename: 'North Zone overview.md',
      mimeType: 'text/markdown',
      signal,
      ...(options.scopes ? { options: { scopes: options.scopes } } : {}),
    });
    return { result, calls };
  }

  function stored(calls: RecordedRpc[]): unknown[] {
    return callsOf(calls, 'rag_set_document_fields')
      .map((call) => (call.args.p_fields as { metadata?: Record<string, unknown> }).metadata)
      .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined && 'scope_suggestions' in metadata)
      .map((metadata) => metadata.scope_suggestions);
  }

  function writtenChunks(calls: RecordedRpc[]): unknown[] {
    return callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as unknown[]);
  }

  const ON = { RAG_SCOPE_TAGS: 'true', RAG_SCOPE_TAG_SUGGEST: 'true' };

  test('suggestions are stored in metadata.scope_suggestions and never applied to the tags or the chunks', async () => {
    const off = await run({});
    uninstallIngestDeps();
    const on = await run(ON);
    expect(on.result.status).toBe('ready');
    const values = stored(on.calls);
    expect(values).toHaveLength(1);
    expect(ScopeTagSuggestionSchema.parse(values[0])).toEqual({
      suggestions: [
        { dimension: 'region', value: 'north-zone', source: 'rule' },
        { dimension: 'department', value: 'unit-alpha', source: 'rule' },
      ],
    });
    expect(callsOf(on.calls, 'rag_set_document_scopes')).toHaveLength(0);
    for (const call of callsOf(on.calls, 'rag_set_document_fields')) expect(call.args.p_fields).not.toHaveProperty('scopes');
    expect(writtenChunks(on.calls)).toEqual(writtenChunks(off.calls));
  });

  test('tags the uploader set are not suggested again', async () => {
    const { calls } = await run(ON, { scopes: ['region:north-zone'] });
    expect(stored(calls)).toEqual([{ suggestions: [{ dimension: 'department', value: 'unit-alpha', source: 'rule' }] }]);
  });

  test.each([
    ['RAG_SCOPE_TAG_SUGGEST=false', { RAG_SCOPE_TAGS: 'true', RAG_SCOPE_TAG_SUGGEST: 'false' }],
    ['RAG_SCOPE_TAGS=false', { RAG_SCOPE_TAGS: 'false', RAG_SCOPE_TAG_SUGGEST: 'true' }],
  ])('with %s nothing is read, computed or stored', async (_name, env) => {
    const call = vi.fn(async () => ({ suggestions: [] }));
    setScopeSuggestLlmForTests(call);
    const { calls } = await run({ ...env, RAG_DOC_TYPE_LLM_DETECT: 'true' });
    expect(callsOf(calls, 'rag_scope_vocabulary_for')).toHaveLength(0);
    expect(stored(calls)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  test('an empty vocabulary stores nothing and makes no model call', async () => {
    const call = vi.fn(async () => ({ suggestions: [] }));
    setScopeSuggestLlmForTests(call);
    const { calls } = await run({ ...ON, RAG_DOC_TYPE_LLM_DETECT: 'true' }, { vocabulary: [] });
    expect(callsOf(calls, 'rag_scope_vocabulary_for')).toHaveLength(1);
    expect(stored(calls)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  test('the model step runs only when the doc-type model is allowed too; its out-of-vocabulary values are dropped', async () => {
    const call = vi.fn(async () => ({
      suggestions: [
        { dimension: 'legal_entity', value: 'entity-one', source: 'model' },
        { dimension: 'department', value: 'not-listed', source: 'model' },
      ],
    }));
    setScopeSuggestLlmForTests(call);
    await run(ON);
    expect(call).not.toHaveBeenCalled();
    uninstallIngestDeps();

    const { calls } = await run({ ...ON, RAG_DOC_TYPE_LLM_DETECT: 'true' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(stored(calls)).toEqual([
      {
        suggestions: [
          { dimension: 'region', value: 'north-zone', source: 'rule' },
          { dimension: 'department', value: 'unit-alpha', source: 'rule' },
          { dimension: 'legal_entity', value: 'entity-one', source: 'model' },
        ],
      },
    ]);
  });

  test('an unreadable vocabulary never fails the stage', async () => {
    const { db } = fakeIngestDb({ failures: { rag_scope_vocabulary_for: { code: 'XX000', message: 'boom' } } });
    installIngestDeps({ db, env: ON });
    const result = await ingest({ scope, source: 'config_upload', sourceKey: 'root/a.md', text: TEXT, filename: 'a.md', mimeType: 'text/markdown', signal });
    expect(result.status).toBe('ready');
    expect(result.warnings).toContain('scope_suggestions_unavailable');
  });
});
