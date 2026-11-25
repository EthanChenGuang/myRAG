import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { EmbeddingProfileMismatchError } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { LEGACY_PROFILE, type EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import { embedQueries, embedQueriesForEvalProfile } from '@/lib/rag/embeddings/query-embedding';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import {
  createFixtureTranslator,
  getTranslator,
  resetTranslatorForTests,
  setTranslatorForTests,
  type TranslationTable,
} from '@/lib/rag/query/translate';
import { buildQueryVariants } from '@/lib/rag/query/variants';

const ROOT = path.resolve(__dirname, '../../..');
const TABLE_PATH = path.join(ROOT, 'eval/fixtures/translation-table.json');
const GOLDEN_PATH = path.join(ROOT, 'eval/fixtures/golden.jsonl');
const signal = new AbortController().signal;

interface GoldenRow {
  id: string;
  category: string;
  review_status: string;
  language: string;
  evidence_language: string;
  question: string;
}

function readTable(): TranslationTable {
  return JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as TranslationTable;
}

function crossLingualItems(): GoldenRow[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenRow)
    .filter((row) => row.category === 'cross_lingual' && row.review_status === 'approved');
}

function norm(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

const CODE_RE = /[A-Z]+[_-][A-Z0-9_-]+|\b[A-Z]{2,}\d+\b/gu;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const NUMBER_RE = /\d+(?:[.,]\d+)?\s?%|\b\d+\.\d+\b/gu;
const CAPS_RE = /\b[A-Z]{2,}(?: [A-Z]{2,})*\b/gu;
const TITLE_RE = /\b[A-Z][a-z]+(?: [A-Z][a-z]+){2,}\b/gu;
const HAN_RE = /\p{Script=Han}{4,}/gu;

function protectedTokens(question: string, language: string): string[] {
  const found = new Set<string>();
  for (const re of [CODE_RE, EMAIL_RE, NUMBER_RE, CAPS_RE, TITLE_RE]) {
    for (const match of question.matchAll(re)) found.add(match[0]);
  }
  if (language !== 'zh') for (const match of question.matchAll(HAN_RE)) found.add(match[0]);
  return [...found];
}

describe('buildQueryVariants', () => {
  it('puts the original first, then the translated variant', () => {
    const variants = buildQueryVariants('What is the warranty?', 'en', [{ text: 'Qual è la garanzia?', language: 'it' }]);
    expect(variants).toEqual([
      { text: 'What is the warranty?', language: 'en', kind: 'original' },
      { text: 'Qual è la garanzia?', language: 'it', kind: 'translated' },
    ]);
  });

  it('keeps the original, then provided variants, then translate-stage output', () => {
    const variants = buildQueryVariants(
      'What is the warranty?',
      'en',
      [{ text: 'Qual è la garanzia?', language: 'it' }],
      [{ text: '保修期是多久？', language: 'zh', kind: 'translated' }],
    );
    expect(variants.map((variant) => variant.text)).toEqual(['What is the warranty?', '保修期是多久？', 'Qual è la garanzia?']);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'translated', 'translated']);
  });

  it('removes duplicates by text and never lets a provided variant replace the original', () => {
    const variants = buildQueryVariants(
      'What is the warranty?',
      'en',
      [
        { text: 'Qual è la garanzia?', language: 'it' },
        { text: '  qual è la garanzia?  ', language: 'it' },
        { text: 'what is the warranty?', language: 'en' },
      ],
      [{ text: 'Something else', language: 'en', kind: 'original' }],
    );
    expect(variants.map((variant) => variant.text)).toEqual(['What is the warranty?', 'Qual è la garanzia?']);
    expect(variants[0]?.kind).toBe('original');
  });

  it('cuts to three variants', () => {
    const variants = buildQueryVariants('q', 'en', [
      { text: 'a', language: 'it' },
      { text: 'b', language: 'zh' },
      { text: 'c', language: 'it' },
      { text: 'd', language: 'zh' },
    ]);
    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.text)).toEqual(['q', 'a', 'b']);
  });

  it('returns only the original with nothing to add', () => {
    expect(buildQueryVariants('q', null)).toEqual([{ text: 'q', language: null, kind: 'original' }]);
  });
});

describe('translator slot', () => {
  afterEach(() => resetTranslatorForTests());

  it('is the none translator by default and yields no translation', async () => {
    const translator = getTranslator();
    expect(translator.name).toBe('none');
    await expect(translator.translate('What is the warranty?', { signal, sourceLanguage: 'en' })).resolves.toEqual([]);
  });

  it('serves a registered translator until it is reset', async () => {
    const custom = { name: 'custom', translate: async () => [{ text: 'x', language: 'it' }] };
    setTranslatorForTests(custom);
    expect(getTranslator()).toBe(custom);
    resetTranslatorForTests();
    expect(getTranslator().name).toBe('none');
  });
});

describe('fixture translator', () => {
  const table: TranslationTable = {
    version: 1,
    entries: [{ question: 'What is the warranty for XR-2000?', translations: [{ language: 'it', text: 'Qual è la garanzia per XR-2000?' }] }],
  };

  it('returns the table translations for a normalised question and nothing for unknown text', async () => {
    const translator = createFixtureTranslator(table);
    expect(translator.name).toBe('fixture');
    await expect(translator.translate('  WHAT IS THE WARRANTY for XR-2000?  ', { signal, sourceLanguage: 'en' })).resolves.toEqual([
      { language: 'it', text: 'Qual è la garanzia per XR-2000?' },
    ]);
    await expect(translator.translate('An unknown question', { signal, sourceLanguage: 'en' })).resolves.toEqual([]);
  });

  it('rejects a malformed table', () => {
    expect(() => createFixtureTranslator({ version: 2, entries: [] } as unknown as TranslationTable)).toThrow(/translation table/i);
    expect(() =>
      createFixtureTranslator({ version: 1, entries: [{ question: 'q', translations: [{ language: 'it', text: '' }] }] }),
    ).toThrow(/translation table/i);
  });
});

describe('committed translation table', () => {
  it('covers every approved cross_lingual golden question with one translation into the evidence language', () => {
    const table = readTable();
    const byQuestion = new Map(table.entries.map((entry) => [norm(entry.question), entry]));
    const items = crossLingualItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const entry = byQuestion.get(norm(item.question));
      expect(entry, `table entry for ${item.id}`).toBeDefined();
      expect(entry?.translations.map((translation) => translation.language), item.id).toEqual([item.evidence_language]);
      expect(entry?.translations[0]?.text.trim().length, item.id).toBeGreaterThan(0);
      expect(norm(entry?.translations[0]?.text ?? ''), item.id).not.toBe(norm(item.question));
    }
  });

  it('has no entry that is not a golden question', () => {
    const questions = new Set(crossLingualItems().map((item) => norm(item.question)));
    for (const entry of readTable().entries) expect(questions.has(norm(entry.question)), entry.question).toBe(true);
  });

  it('keeps codes, emails, percentages, decimals, names and capitalised terms verbatim in every entry', () => {
    const items = crossLingualItems();
    for (const item of items) {
      const entry = readTable().entries.find((row) => norm(row.question) === norm(item.question));
      const text = entry?.translations[0]?.text ?? '';
      for (const token of protectedTokens(item.question, item.language)) {
        expect(text.includes(token), `${item.id} keeps ${token}`).toBe(true);
      }
    }
  });

  it('serves a translation for a golden question through the fixture translator', async () => {
    const translator = createFixtureTranslator(readTable());
    const item = crossLingualItems().find((row) => row.id === 'xl-en-it-03');
    const out = await translator.translate(item?.question ?? '', { signal, sourceLanguage: 'en' });
    expect(out).toHaveLength(1);
    expect(out[0]?.language).toBe('it');
  });
});

const scope = mintScope('single', null, null);
const QUESTION = 'What is the warranty?';
const ITALIAN = 'Qual è la garanzia?';

const questionTable: TranslationTable = {
  version: 1,
  entries: [{ question: QUESTION, translations: [{ language: 'it', text: ITALIAN }] }],
};

function v2Config(over: Record<string, string> = {}) {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', ...over });
}

function queryInput(config: ReturnType<typeof v2Config>, extra: Record<string, unknown> = {}) {
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  return {
    collector,
    args: {
      input: { scope, query: QUESTION, profile: 'eval' as const, signal: new AbortController().signal, ...extra },
      scope,
      config,
      profile: 'eval' as const,
      signal: new AbortController().signal,
      collector,
    },
  };
}

function stageOf(collector: ReturnType<typeof createTraceCollector>, name: string) {
  return collector.stages().find((row) => row.name === name);
}

describe('translate stage in the query group', () => {
  beforeEach(() => {
    uninstallDeps();
    resetTranslatorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetTranslatorForTests();
    uninstallDeps();
    vi.restoreAllMocks();
  });

  it('is disabled with the switch off: one variant and the translator is never called', async () => {
    const translate = vi.fn(async () => [{ text: ITALIAN, language: 'it' }]);
    setTranslatorForTests({ name: 'spy', translate });
    const { args, collector } = queryInput(v2Config());
    const out = await runQueryStages(args);
    expect(out.variants).toEqual([{ text: QUESTION, language: 'en', kind: 'original' }]);
    expect(translate).not.toHaveBeenCalled();
    expect(stageOf(collector, 'translate')?.status).toBe('disabled');
  });

  it('adds the translated variant from the fixture translator when the switch is on', async () => {
    setTranslatorForTests(createFixtureTranslator(questionTable));
    const { args, collector } = queryInput(v2Config({ RAG_LEXICAL_TRANSLATION: 'true' }));
    const out = await runQueryStages(args);
    expect(out.variants).toEqual([
      { text: QUESTION, language: 'en', kind: 'original' },
      { text: ITALIAN, language: 'it', kind: 'translated' },
    ]);
    expect(stageOf(collector, 'translate')?.status).toBe('ok');
  });

  it('adds nothing and reports translator_none while no translator is registered', async () => {
    const { args, collector } = queryInput(v2Config({ RAG_LEXICAL_TRANSLATION: 'true' }));
    const out = await runQueryStages(args);
    expect(out.variants).toHaveLength(1);
    const record = stageOf(collector, 'translate');
    expect(record?.status).toBe('ok');
    expect(record?.detail).toBe('translator_none');
  });

  it('skips a translator that throws and keeps the original-only search', async () => {
    setTranslatorForTests({
      name: 'broken',
      translate: async () => {
        throw new Error('translator down');
      },
    });
    const { args, collector } = queryInput(v2Config({ RAG_LEXICAL_TRANSLATION: 'true' }));
    const out = await runQueryStages(args);
    expect(out.variants).toEqual([{ text: QUESTION, language: 'en', kind: 'original' }]);
    expect(stageOf(collector, 'translate')?.status).toBe('skipped');
  });

  it('skips a translator that outlives the stage timeout', async () => {
    setTranslatorForTests({
      name: 'slow',
      translate: (_text, { signal: stageSignal }) =>
        new Promise((_resolve, reject) => stageSignal.addEventListener('abort', () => reject(stageSignal.reason), { once: true })),
    });
    const { args, collector } = queryInput(v2Config({ RAG_LEXICAL_TRANSLATION: 'true' }), {});
    const out = await runQueryStages({
      ...args,
      stageOverrides: { timeouts: { translate: 50 } },
    });
    expect(out.variants).toHaveLength(1);
    expect(stageOf(collector, 'translate')?.status).toBe('skipped');
  });

  it('orders the original, then caller variants (Phase 6 seam), then translate output, capped at three', async () => {
    setTranslatorForTests(
      createFixtureTranslator({
        version: 1,
        entries: [
          {
            question: QUESTION,
            translations: [
              { language: 'it', text: ITALIAN },
              { language: 'zh', text: '保修是什么？' },
            ],
          },
        ],
      }),
    );
    const { args } = queryInput(v2Config({ RAG_LEXICAL_TRANSLATION: 'true' }), {
      queryVariants: [{ text: 'Warranty terms', language: 'en', kind: 'translated' }],
    });
    const out = await runQueryStages(args);
    expect(out.variants.map((variant) => variant.text)).toEqual([QUESTION, 'Warranty terms', ITALIAN]);
  });
});

function recordingBackend(calls: BackendSearchRequest[], state: { active: number; maxActive: number }): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      calls.push(req);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.active -= 1;
      const index = calls.indexOf(req);
      return {
        dense: [hit(`dense-${index}`, { rank: 1, similarity: 0.9 })],
        lexical: req.lexicalTokens.length > 0 ? [hit(`lexical-${index}`, { rank: 1, lexicalScore: 1, language: req.lexicalLanguages?.[0] ?? null })] : [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

describe('parallel per-variant search', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('searches both variants concurrently, restricts only the translated lexical leg, and fuses dense:i and lexical:i', async () => {
    const config = v2Config();
    const calls: BackendSearchRequest[] = [];
    const state = { active: 0, maxActive: 0 };
    setRetrievalBackendForTests(recordingBackend(calls, state));
    installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();

    const output = await runSearchStages({
      input: { scope, query: QUESTION, profile: 'eval', signal: new AbortController().signal },
      scope,
      config,
      profile: 'eval',
      params: effectiveRetrievalParams('eval', config, null),
      embedding: { vector: [1, 0, 0], profile: null },
      variantEmbeddings: [
        { vector: [1, 0, 0], profile: null },
        { vector: [0, 1, 0], profile: null },
      ],
      variants: [
        { text: QUESTION, language: 'en', kind: 'original' },
        { text: ITALIAN, language: 'it', kind: 'translated' },
      ],
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    expect(calls).toHaveLength(2);
    expect(state.maxActive).toBe(2);
    expect(calls[0]?.lexicalLanguages).toBeNull();
    expect(calls[1]?.lexicalLanguages).toEqual(['it']);
    expect(calls[0]?.denseVector).toEqual([1, 0, 0]);
    expect(calls[1]?.denseVector).toEqual([0, 1, 0]);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    const lists = new Set(output.fusedHits.flatMap((row) => Object.keys(row.ranks)));
    expect([...lists].sort()).toEqual(['dense:0', 'dense:1', 'lexical:0', 'lexical:1']);
  });

  it('leaves the lexical leg of a lone original variant unrestricted even when its language is known', async () => {
    const config = v2Config();
    const calls: BackendSearchRequest[] = [];
    setRetrievalBackendForTests(recordingBackend(calls, { active: 0, maxActive: 0 }));
    installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();

    await runSearchStages({
      input: { scope, query: QUESTION, profile: 'eval', signal: new AbortController().signal },
      scope,
      config,
      profile: 'eval',
      params: effectiveRetrievalParams('eval', config, null),
      embedding: { vector: [1, 0, 0], profile: null },
      variants: [{ text: QUESTION, language: 'en', kind: 'original' }],
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.lexicalLanguages).toBeNull();
  });
});

describe('v2 pipeline with the translation seam', () => {
  const embedded: string[] = [];
  const embedState = { active: 0, maxActive: 0 };

  function install(env: Record<string, string>) {
    embedded.length = 0;
    embedState.active = 0;
    embedState.maxActive = 0;
    installDeps({
      adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
      embedder: async (text) => {
        embedded.push(text);
        embedState.active += 1;
        embedState.maxActive = Math.max(embedState.maxActive, embedState.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        embedState.active -= 1;
        return [0.1, 0.2, 0.3];
      },
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', ...env }),
    });
  }

  beforeEach(() => {
    uninstallDeps();
    resetTranslatorForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetTranslatorForTests();
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  async function retrieve() {
    await verifyV2Startup();
    return runRetrieval({
      scope,
      query: QUESTION,
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
  }

  it('with the switch off embeds once and calls the backend once', async () => {
    const calls: BackendSearchRequest[] = [];
    setRetrievalBackendForTests(recordingBackend(calls, { active: 0, maxActive: 0 }));
    install({});
    setTranslatorForTests(createFixtureTranslator(questionTable));
    const result = await retrieve();
    expect(result.status).toBe('ok');
    expect(embedded).toEqual([QUESTION]);
    expect(calls).toHaveLength(1);
  });

  it('with the fixture translator on embeds both variants in parallel and searches both concurrently', async () => {
    const calls: BackendSearchRequest[] = [];
    const state = { active: 0, maxActive: 0 };
    setRetrievalBackendForTests(recordingBackend(calls, state));
    install({ RAG_LEXICAL_TRANSLATION: 'true' });
    setTranslatorForTests(createFixtureTranslator(questionTable));
    const result = await retrieve();
    expect(result.status).toBe('ok');
    expect([...embedded].sort()).toEqual([ITALIAN, QUESTION].sort());
    expect(embedState.maxActive).toBe(2);
    expect(calls.map((call) => call.lexicalLanguages)).toEqual([null, ['it']]);
    expect(state.maxActive).toBe(2);
  });

  it('survives a translator failure: degraded, original-only search, no error', async () => {
    const calls: BackendSearchRequest[] = [];
    setRetrievalBackendForTests(recordingBackend(calls, { active: 0, maxActive: 0 }));
    install({ RAG_LEXICAL_TRANSLATION: 'true' });
    setTranslatorForTests({
      name: 'broken',
      translate: async () => {
        throw new Error('translator down');
      },
    });
    const result = await retrieve();
    expect(result.status).toBe('degraded');
    expect(embedded).toEqual([QUESTION]);
    expect(calls).toHaveLength(1);
  });
});

describe('embedQueries', () => {
  const batchProfile: EmbeddingProfile = {
    ...LEGACY_PROFILE,
    id: 'voyage-test-3',
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 3,
    storage: 'halfvec',
  };
  const signal = new AbortController().signal;

  beforeEach(() => uninstallDeps());
  afterEach(() => uninstallDeps());

  it('uses one provider batch call when the profile provider offers one', async () => {
    const batch = vi.fn(async (texts: string[]) => texts.map((_text, index) => ({ vector: [index, 1, 0], model: 'voyage-4-large' })));
    const single = vi.fn(async () => ({ vector: [0, 0, 1], model: 'voyage-4-large' }));
    installDeps({ profileBatchEmbedder: batch, profileEmbedder: single });
    const out = await embedQueriesForEvalProfile(['one', 'two'], signal, batchProfile);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    expect(out.map((row) => row.vector)).toEqual([
      [0, 1, 0],
      [1, 1, 0],
    ]);
    expect(out.every((row) => row.profile?.id === 'voyage-test-3')).toBe(true);
  });

  it('embeds in parallel when the provider offers no batch call', async () => {
    let active = 0;
    let maxActive = 0;
    const single = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { vector: [0, 0, 1], model: 'voyage-4-large' };
    });
    installDeps({ profileBatchEmbedder: async () => null, profileEmbedder: single });
    const out = await embedQueriesForEvalProfile(['one', 'two'], signal, batchProfile);
    expect(single).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
    expect(out).toHaveLength(2);
  });

  it('rejects a batch answer from another model or with the wrong number of vectors', async () => {
    installDeps({ profileBatchEmbedder: async (texts) => texts.map(() => ({ vector: [0, 0, 1], model: 'other-model' })) });
    await expect(embedQueriesForEvalProfile(['one', 'two'], signal, batchProfile)).rejects.toBeInstanceOf(EmbeddingProfileMismatchError);
    installDeps({ profileBatchEmbedder: async () => [{ vector: [0, 0, 1], model: 'voyage-4-large' }] });
    await expect(embedQueriesForEvalProfile(['one', 'two'], signal, batchProfile)).rejects.toThrow();
  });

  it('with profiles off embeds each text with the legacy embedder in parallel; one text is exactly one call', async () => {
    const embedder = vi.fn(async () => [0.1, 0.2, 0.3]);
    installDeps({ embedder });
    const many = await embedQueries(['one', 'two'], signal);
    expect(embedder).toHaveBeenCalledTimes(2);
    expect(many.map((row) => row.profile)).toEqual([null, null]);
    embedder.mockClear();
    const one = await embedQueries(['only'], signal);
    expect(embedder).toHaveBeenCalledTimes(1);
    expect(one).toEqual([{ vector: [0.1, 0.2, 0.3], profile: null }]);
  });
});
