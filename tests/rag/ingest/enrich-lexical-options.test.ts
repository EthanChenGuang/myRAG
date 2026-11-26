import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { ingestLexical, lexicalFieldsFor } from '@/lib/rag/ingest/lexical-options';
import { buildProfileChunks } from '@/lib/rag/ingest/profile-chunks';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { emptyIngestState, type ChunkDraft, type StageContext } from '@/lib/rag/ingest/types';
import type { DocumentFields, IngestWriter } from '@/lib/rag/ingest/writer';
import * as detect from '@/lib/rag/lang/detect';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import * as chunkText from '@/lib/rag/lexical/chunk-text';
import { DICT_TOKEN_PREFIX, STEM_TOKEN_PREFIX, type LexicalOptions } from '@/lib/rag/lexical/options';
import { resetLexicalOptionsForTests, setLexicalOptionsResolverForTests, type ResolvedLexicalOptions } from '@/lib/rag/lexical/resolve-options';
import { lexicalText } from '@/lib/rag/lexical/tokenize';
import { mintScope } from '@/lib/rag/tenant/scope';

// Synthetic, neutral vocabulary only.
const HAN_TERM = '星蓝矩';
const LATIN_TERM = 'zento prisma';
const EN_TEXT =
  'This section describes the general structure of the zento prisma system and the relation between its parts. Each module has a clear task and the modules exchange data through agreed interfaces.';
const IT_TEXT =
  'Questa sezione descrive la struttura generale del sistema e le relazioni tra le sue parti. Ogni modulo ha un compito chiaro e i moduli scambiano i dati attraverso interfacce concordate.';
const ZH_TEXT = `本节说明系统的总体结构以及${HAN_TERM}各个组成部分之间的关系。每个模块都有明确的职责，模块之间通过约定的接口交换数据。`;
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const scope = mintScope('personal', TENANT_ID, null);

function stubDictionary(terms: string[]): NonNullable<LexicalOptions['dictionary']> {
  return {
    version: 's3.w5',
    match(normalized: string) {
      return terms.filter((term) => normalized.includes(term)).map((term) => ({ term }));
    },
  };
}

function lexicalKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => key.startsWith('lexical_')));
}

function draft(content: string, sectionPath: string[] = ['Intro']): ChunkDraft {
  return { content, section_path: sectionPath, chunk_kind: 'text', page_start: null, page_end: null, metadata: {} };
}

function stageContext(contents: string[]) {
  const calls: Array<{ documentId: string; fields: DocumentFields }> = [];
  const setFields = vi.fn(async (documentId: string, fields: DocumentFields) => {
    calls.push({ documentId, fields });
  });
  const ctx = {
    input: { scope },
    document: { id: 'doc-1', version: 1, resumed: false },
    identity: { tenantKey: `u:${TENANT_ID}`, filename: 'notes.md', fileSha256: 'x', docType: 'general', docTypeOrigin: 'default', bytes: null },
    config: loadIngestConfig({}),
    state: emptyIngestState(),
    signal: new AbortController().signal,
    warnings: [] as string[],
    work: { parseText: contents.join('\n\n'), parserVersion: null, chunks: contents.map((content) => draft(content)), chunksWritten: 0 },
    writer: { setFields } as unknown as IngestWriter,
  } as unknown as StageContext;
  return { ctx, calls };
}

function useSwitches(env: Record<string, string>): void {
  setRagDepsForTests({ ragEnv: () => env });
}

function useResolver(result: (language: string | null) => ResolvedLexicalOptions) {
  const seen: Array<{ language: string | null }> = [];
  setLexicalOptionsResolverForTests(async (_scope, _config, input) => {
    seen.push({ language: input.language });
    return result(input.language);
  });
  return seen;
}

/** The enrich output before this plan, computed with no options. */
function legacyDrafts(contents: string[]): Array<Pick<ChunkDraft, 'lexical_text' | 'content_hash' | 'metadata'>> {
  return contents.map((content) => ({
    lexical_text: chunkText.chunkLexicalText({ sectionPath: ['Intro'], content, chunkKind: 'text', metadata: {}, documentFilename: 'notes.md' }),
    content_hash: expect.any(String) as unknown as string,
    metadata: { lexical_version: 2 },
  }));
}

beforeEach(() => {
  useSwitches({});
});

afterEach(() => {
  resetLexicalOptionsForTests();
  resetRagDepsForTests();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

describe('enrich: switches off (D-04, D-42)', () => {
  test('drafts are byte-identical to the drafts without options, version 2 and no stamp keys, for each language', async () => {
    const seen = useResolver(() => {
      throw new Error('resolver must not run with every switch off');
    });
    for (const text of [EN_TEXT, IT_TEXT, ZH_TEXT]) {
      const { ctx } = stageContext([text]);
      await enrichStage.run(ctx);
      const [chunk] = ctx.work.chunks;
      const [expected] = legacyDrafts([text]);
      expect(chunk!.lexical_text).toBe(expected!.lexical_text);
      expect(lexicalKeys(chunk!.metadata)).toEqual({ lexical_version: 2 });
      expect(chunk!.metadata).not.toHaveProperty('lexical_dict_version');
      expect(chunk!.metadata).not.toHaveProperty('lexical_patterns');
      expect(ctx.warnings).toEqual([]);
    }
    expect(seen).toEqual([]);
  });
});

describe('enrich: switches on', () => {
  test('stemming on: an it document gets _s_ tokens and version 4; an en document has no _s_ token and version 4', async () => {
    useSwitches({ RAG_LEXICAL_STEM_IT: 'true' });
    const seen = useResolver((language) => ({ options: { stemIt: true, language }, stamp: { dictVersion: null, patterns: null }, warnings: [] }));
    const it = stageContext([IT_TEXT]);
    await enrichStage.run(it.ctx);
    expect(it.ctx.work.chunks[0]!.lexical_text).toMatch(new RegExp(`(^| )${STEM_TOKEN_PREFIX}`, 'u'));
    expect(lexicalKeys(it.ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 4 });
    const en = stageContext([EN_TEXT]);
    await enrichStage.run(en.ctx);
    expect(en.ctx.work.chunks[0]!.lexical_text).not.toContain(STEM_TOKEN_PREFIX);
    expect(lexicalKeys(en.ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 4 });
    expect(seen.map((entry) => entry.language)).toEqual(['it', 'en']);
  });

  test('dictionary on: the _t_ token of a term, lexical_dict_version and version 3', async () => {
    useSwitches({ RAG_LEXICAL_DICTIONARY: 'true' });
    useResolver(() => ({ options: { dictionary: stubDictionary([LATIN_TERM, HAN_TERM]) }, stamp: { dictVersion: 's3.w5', patterns: null }, warnings: [] }));
    const { ctx } = stageContext([EN_TEXT]);
    await enrichStage.run(ctx);
    expect(ctx.work.chunks[0]!.lexical_text!.split(' ')).toContain(`${DICT_TOKEN_PREFIX}zento_prisma`);
    expect(lexicalKeys(ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 3, lexical_dict_version: 's3.w5' });
  });

  test('identifier index on: lexical_patterns is the fingerprint; a tenant-pattern identifier is one token plus its normalized form', async () => {
    useSwitches({ RAG_IDENTIFIER_INDEX: 'true' });
    useResolver(() => ({ options: { identifierPatterns: [/QV ?[0-9]{3}/giu] }, stamp: { dictVersion: null, patterns: 'p0123456789ab' }, warnings: [] }));
    const { ctx } = stageContext([`${EN_TEXT} See QV 123 for the rest.`]);
    await enrichStage.run(ctx);
    const chunk = ctx.work.chunks[0]!;
    expect(lexicalKeys(chunk.metadata)).toEqual({ lexical_version: 2, lexical_patterns: 'p0123456789ab' });
    expect(chunk.lexical_text!.split(' ')).toContain('qv123');
  });

  test('the language is detected before the first lexical text is built, and the document language is written as today', async () => {
    useSwitches({ RAG_LEXICAL_STEM_IT: 'true' });
    useResolver((language) => ({ options: { stemIt: true, language }, stamp: { dictVersion: null, patterns: null }, warnings: [] }));
    const order: string[] = [];
    const detectSpy = vi.spyOn(detect, 'detectLanguage');
    detectSpy.mockImplementation((text: string) => {
      order.push('detect');
      return text.includes('Questa') ? 'it' : null;
    });
    const realLexical = chunkText.chunkLexicalText;
    vi.spyOn(chunkText, 'chunkLexicalText').mockImplementation((input, options) => {
      order.push('lexical');
      return realLexical(input, options);
    });
    const { ctx, calls } = stageContext([IT_TEXT]);
    await enrichStage.run(ctx);
    expect(order.indexOf('detect')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('detect')).toBeLessThan(order.indexOf('lexical'));
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { language: 'it' } }]);
  });

  test('a resolver warning is added to the ingestion warnings and ingestion continues without a stamp', async () => {
    useSwitches({ RAG_LEXICAL_DICTIONARY: 'true' });
    useResolver(() => ({ options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: ['lexical_dictionary_unavailable'] }));
    const { ctx } = stageContext([EN_TEXT]);
    const outcome = await enrichStage.run(ctx);
    expect(outcome.kind).toBe('next');
    expect(ctx.warnings).toEqual(['lexical_dictionary_unavailable']);
    expect(lexicalKeys(ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 3 });
    expect(ctx.work.chunks[0]!.lexical_text).toBe(legacyDrafts([EN_TEXT])[0]!.lexical_text);
  });

  test('one resolve per document: later stages reuse the options enrich resolved', async () => {
    useSwitches({ RAG_LEXICAL_DICTIONARY: 'true' });
    const seen = useResolver(() => ({ options: { dictionary: stubDictionary([LATIN_TERM]) }, stamp: { dictVersion: 's3.w5', patterns: null }, warnings: ['identifier_patterns_unavailable'] }));
    const { ctx } = stageContext([EN_TEXT, EN_TEXT]);
    await enrichStage.run(ctx);
    await ingestLexical(ctx);
    expect(seen).toHaveLength(1);
    expect(ctx.warnings).toEqual(['identifier_patterns_unavailable']);
  });
});

describe('profile children, image captions and the extractor path use the document options and stamps', () => {
  const PROFILE = { id: 'p1', docType: 'general', childTokens: 200, parentMode: 'none', parentTokens: null, status: 'active' } as const;
  const CHUNKER = { kind: 'markdown_sections' } as never;
  const markdown = `# Intro\n\n${EN_TEXT}\n`;

  test('switches off: profile children are unchanged (version 2, no stamp keys)', () => {
    const plain = buildProfileChunks({ filename: 'notes.md', chunker: CHUNKER }, markdown, PROFILE);
    const off = buildProfileChunks(
      { filename: 'notes.md', chunker: CHUNKER, lexical: { version: 2, resolved: { options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] } } },
      markdown,
      PROFILE,
    );
    expect(off).toEqual(plain);
    expect(plain.children[0]!.metadata).toMatchObject({ lexical_version: 2 });
    expect(plain.children[0]!.metadata).not.toHaveProperty('lexical_dict_version');
  });

  test('switches on: profile children carry the dictionary token and the stamps', () => {
    const built = buildProfileChunks(
      {
        filename: 'notes.md',
        chunker: CHUNKER,
        lexical: { version: 3, resolved: { options: { dictionary: stubDictionary([LATIN_TERM]) }, stamp: { dictVersion: 's3.w5', patterns: 'p0123456789ab' }, warnings: [] } },
      },
      markdown,
      PROFILE,
    );
    const child = built.children[0]!;
    expect(child.lexical_text.split(' ')).toContain(`${DICT_TOKEN_PREFIX}zento_prisma`);
    expect(child.metadata).toMatchObject({ lexical_version: 3, lexical_dict_version: 's3.w5', lexical_patterns: 'p0123456789ab' });
  });

  test('image and extractor fields: off gives today’s text and no keys; on gives the options and the stamps', () => {
    const off = lexicalFieldsFor({ version: 2, resolved: { options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] } }, ['Intro'], EN_TEXT);
    expect(off).toEqual({ lexical_text: lexicalText(['Intro'], EN_TEXT), metadata: {} });
    const on = lexicalFieldsFor(
      { version: 3, resolved: { options: { dictionary: stubDictionary([LATIN_TERM]) }, stamp: { dictVersion: 's3.w5', patterns: null }, warnings: [] } },
      [],
      EN_TEXT,
    );
    expect(on.lexical_text.split(' ')).toContain(`${DICT_TOKEN_PREFIX}zento_prisma`);
    expect(on.metadata).toEqual({ lexical_version: 3, lexical_dict_version: 's3.w5' });
  });
});
