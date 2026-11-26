import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { ingestLexical, lexicalFieldsFor } from '@/lib/rag/ingest/lexical-options';
import { buildProfileChunks } from '@/lib/rag/ingest/profile-chunks';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { emptyIngestState, type ChunkDraft, type StageContext } from '@/lib/rag/ingest/types';
import type { DocumentFields, IngestWriter } from '@/lib/rag/ingest/writer';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import * as chunkText from '@/lib/rag/lexical/chunk-text';
import { QUANTITY_TOKEN_PREFIX, type LexicalOptions } from '@/lib/rag/lexical/options';
import { resetLexicalOptionsForTests, setLexicalOptionsResolverForTests, type ResolvedLexicalOptions } from '@/lib/rag/lexical/resolve-options';
import { mintScope } from '@/lib/rag/tenant/scope';

// Numbers, general symbols and invented words only.
const EN_TEXT = 'The zento module holds 2.5kg of material and reads 1,250 ml per cycle, about 40 % of the rated value for each part.';
const IT_TEXT = 'Il modulo zento contiene 2,5 kg di materiale e legge 1.250 ml per ciclo, circa il 40 % del valore nominale.';
const ZH_TEXT = '本模块装有2.5kg材料，每个周期读取1250 ml，约为额定值的40 %。';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const scope = mintScope('personal', TENANT_ID, null);
const Q = QUANTITY_TOKEN_PREFIX;

function draft(content: string): ChunkDraft {
  return { content, section_path: ['Intro'], chunk_kind: 'text', page_start: null, page_end: null, metadata: {} };
}

function stageContext(contents: string[]) {
  const calls: Array<{ documentId: string; fields: DocumentFields }> = [];
  const ctx = {
    input: { scope },
    document: { id: 'doc-1', version: 1, resumed: false },
    identity: { tenantKey: `u:${TENANT_ID}`, filename: 'notes.md', fileSha256: 'x', docType: 'general', docTypeOrigin: 'default', bytes: null },
    config: loadIngestConfig({}),
    state: emptyIngestState(),
    signal: new AbortController().signal,
    warnings: [] as string[],
    work: { parseText: contents.join('\n\n'), parserVersion: null, chunks: contents.map(draft), chunksWritten: 0 },
    writer: { setFields: vi.fn(async (documentId: string, fields: DocumentFields) => void calls.push({ documentId, fields })) } as unknown as IngestWriter,
  } as unknown as StageContext;
  return { ctx, calls };
}

function lexicalKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => key.startsWith('lexical_')));
}

function useSwitches(env: Record<string, string>): void {
  setRagDepsForTests({ ragEnv: () => env });
}

function stubDictionary(): NonNullable<LexicalOptions['dictionary']> {
  return { version: 's3.w5', match: () => [] };
}

const quantityTokens = (text: string | null | undefined) => (text ?? '').split(' ').filter((token) => token.startsWith(Q));

beforeEach(() => useSwitches({}));

afterEach(() => {
  resetLexicalOptionsForTests();
  resetRagDepsForTests();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

describe('enrich: RAG_LEXICAL_QUANTITY off (D-05, D-33)', () => {
  test('drafts equal the option-free text, version 2 and no resolver call, for each language', async () => {
    const seen: unknown[] = [];
    setLexicalOptionsResolverForTests(async () => {
      seen.push(1);
      throw new Error('resolver must not run with every switch off');
    });
    for (const text of [EN_TEXT, IT_TEXT, ZH_TEXT]) {
      const { ctx } = stageContext([text]);
      await enrichStage.run(ctx);
      const chunk = ctx.work.chunks[0]!;
      const expected = chunkText.chunkLexicalText({ sectionPath: ['Intro'], content: text, chunkKind: 'text', metadata: {}, documentFilename: 'notes.md' });
      expect(chunk.lexical_text).toBe(expected);
      expect(quantityTokens(chunk.lexical_text)).toEqual([]);
      expect(lexicalKeys(chunk.metadata)).toEqual({ lexical_version: 2 });
    }
    expect(seen).toEqual([]);
  });

  test('another switch on without quantity keeps its own version and writes no _q_ token', async () => {
    useSwitches({ RAG_LEXICAL_STEM_IT: 'true' });
    setLexicalOptionsResolverForTests(async (_s, _c, input) => ({ options: { stemIt: true, language: input.language }, stamp: { dictVersion: null, patterns: null }, warnings: [] }));
    const { ctx } = stageContext([IT_TEXT]);
    await enrichStage.run(ctx);
    expect(quantityTokens(ctx.work.chunks[0]!.lexical_text)).toEqual([]);
    expect(lexicalKeys(ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 4 });
  });
});

describe('enrich: RAG_LEXICAL_QUANTITY on (D-31, D-33)', () => {
  test('quantity alone, the real resolver: _q_ tokens after the natural tokens and version 6, in each language', async () => {
    useSwitches({ RAG_LEXICAL_QUANTITY: 'true' });
    for (const text of [EN_TEXT, IT_TEXT, ZH_TEXT]) {
      const { ctx } = stageContext([text]);
      await enrichStage.run(ctx);
      const chunk = ctx.work.chunks[0]!;
      const tokens = (chunk.lexical_text ?? '').split(' ');
      expect(tokens).toContain(`${Q}2.5kg`);
      expect(tokens).toContain(`${Q}1250ml`);
      expect(tokens).toContain(`${Q}40%`);
      const firstQ = tokens.findIndex((token) => token.startsWith(Q));
      expect(tokens.slice(firstQ).every((token) => token.startsWith(Q) || token.startsWith('_'))).toBe(true);
      expect(lexicalKeys(chunk.metadata)).toEqual({ lexical_version: 6 });
      expect(ctx.warnings).toEqual([]);
    }
  });

  test.each([
    [{ RAG_LEXICAL_DICTIONARY: 'true' }, 7],
    [{ RAG_LEXICAL_STEM_IT: 'true' }, 8],
    [{ RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true' }, 9],
  ])('with %o the stamped version is %i', async (extra, version) => {
    useSwitches({ RAG_LEXICAL_QUANTITY: 'true', ...extra });
    const dictionary = 'RAG_LEXICAL_DICTIONARY' in extra;
    setLexicalOptionsResolverForTests(async (_s, _c, input) => ({
      options: { quantity: true, ...(dictionary ? { dictionary: stubDictionary() } : {}), ...('RAG_LEXICAL_STEM_IT' in extra ? { stemIt: true, language: input.language } : {}) },
      stamp: { dictVersion: dictionary ? 's3.w5' : null, patterns: null },
      warnings: [],
    }));
    const { ctx } = stageContext([EN_TEXT]);
    await enrichStage.run(ctx);
    expect(quantityTokens(ctx.work.chunks[0]!.lexical_text)).toContain(`${Q}2.5kg`);
    expect(lexicalKeys(ctx.work.chunks[0]!.metadata)).toMatchObject({ lexical_version: version });
  });

  test('profile children, image captions, the extractor path and the attribute header use the same options and version', async () => {
    useSwitches({ RAG_LEXICAL_QUANTITY: 'true' });
    const { ctx } = stageContext([EN_TEXT]);
    const lexical = await ingestLexical(ctx);
    expect(lexical.version).toBe(6);
    expect(lexical.resolved.options).toEqual({ quantity: true });

    const built = buildProfileChunks(
      { filename: 'notes.md', chunker: { kind: 'markdown_sections' } as never, lexical },
      `# Intro\n\n${EN_TEXT}\n`,
      { id: 'p1', docType: 'general', childTokens: 200, parentMode: 'none', parentTokens: null, status: 'active' } as const,
    );
    expect(quantityTokens(built.children[0]!.lexical_text)).toContain(`${Q}2.5kg`);
    expect(built.children[0]!.metadata).toMatchObject({ lexical_version: 6 });

    const caption = lexicalFieldsFor(lexical, [], 'A label reading 12 V and 300 mA');
    expect(quantityTokens(caption.lexical_text)).toEqual(expect.arrayContaining([`${Q}12v`, `${Q}300ma`]));
    expect(caption.metadata).toEqual({ lexical_version: 6 });

    const headed = chunkText.chunkLexicalText(
      { sectionPath: ['Intro'], content: 'zento part', chunkKind: 'text', metadata: {}, documentFilename: 'notes.md', attributeHeader: 'weight: 7,5 kg' },
      lexical.resolved.options,
    );
    expect(quantityTokens(headed)).toContain(`${Q}7.5kg`);
  });

  test('a resolver warning never fails ingestion and no log line holds chunk text', async () => {
    useSwitches({ RAG_LEXICAL_QUANTITY: 'true', RAG_LEXICAL_DICTIONARY: 'true' });
    setLexicalOptionsResolverForTests(async () => ({ options: { quantity: true }, stamp: { dictVersion: null, patterns: null }, warnings: ['lexical_dictionary_unavailable'] }));
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const { ctx } = stageContext([EN_TEXT]);
    const outcome = await enrichStage.run(ctx);
    expect(outcome.kind).toBe('next');
    expect(ctx.warnings).toEqual(['lexical_dictionary_unavailable']);
    expect(lexicalKeys(ctx.work.chunks[0]!.metadata)).toEqual({ lexical_version: 7 });
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('zento');
  });
});
