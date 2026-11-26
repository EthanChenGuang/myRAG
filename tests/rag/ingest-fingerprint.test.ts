import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IngestFingerprintPartsSchema, type IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import {
  EMBEDDING_PROFILE_VERSION,
  FINGERPRINT_CHUNKING_PROFILE_ID,
  buildIngestFingerprint,
  collectFingerprintParts,
  effectiveOcrLanguages,
  expectedFingerprintFor,
  getSettingsClassification,
  ingestionKeysOf,
  ocrEngineCodes,
} from '@/lib/rag/ingest/fingerprint';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { publishStage } from '@/lib/rag/ingest/stages/publish';
import { EMBEDDING_TEXT_VERSION } from '@/lib/rag/ingest/text/embedding-text';
import { effectiveEmbeddingTextVersion } from '@/lib/rag/ingest/text/table-rows';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import type { DocumentFields, IngestWriter } from '@/lib/rag/ingest/writer';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { mintScope } from '@/lib/rag/tenant/scope';

const HEX64 = /^[0-9a-f]{64}$/;
const DOC = '33333333-3333-4333-8333-333333333333';

function baseParts(overrides: Partial<IngestFingerprintParts> = {}): IngestFingerprintParts {
  return {
    parser_used: 'llamaparse',
    parser_version: 'v2-test',
    processing_profile_id: 'general@1',
    processing_profile_version: 1,
    ocr_engine_codes: ['llamaparse:ch_sim', 'llamaparse:it'],
    chunking_profile_id: 'legacy',
    lexical_version: 2,
    embedding_text_version: 1,
    embedding_profile_id: 'openai-3-small-1536',
    embedding_profile_version: 1,
    language_pack_versions: { zh: 1, it: 1 },
    switches: { language_aware_ingest: 'off', table_header_repeat: 'profile', table_row_serialization: 'false', caption_language: 'en' },
    ...overrides,
  };
}

function reversedKeys<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).reverse()) {
    const inner = value[key];
    out[key] = inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? reversedKeys(inner as Record<string, unknown>) : inner;
  }
  return out as T;
}

describe('buildIngestFingerprint', () => {
  test('is a lower-case sha256 hex string of 64 characters', () => {
    expect(buildIngestFingerprint(baseParts())).toMatch(HEX64);
  });

  test('does not depend on the key order of the parts or of nested maps', () => {
    expect(buildIngestFingerprint(reversedKeys(baseParts()))).toBe(buildIngestFingerprint(baseParts()));
  });

  test('pack versions are a map keyed by code, so the order the languages were typed in does not matter', () => {
    const a = buildIngestFingerprint(baseParts({ language_pack_versions: { it: 1, zh: 1 } }));
    const b = buildIngestFingerprint(baseParts({ language_pack_versions: { zh: 1, it: 1 } }));
    expect(a).toBe(b);
  });

  const changes: Array<[string, Partial<IngestFingerprintParts>]> = [
    ['parser_used', { parser_used: 'docling' }],
    ['parser_version', { parser_version: 'v3-test' }],
    ['processing_profile_id', { processing_profile_id: 'contract_legal@1' }],
    ['processing_profile_version', { processing_profile_version: 2 }],
    ['ocr_engine_codes', { ocr_engine_codes: ['llamaparse:ch_sim'] }],
    ['chunking_profile_id', { chunking_profile_id: 'other' }],
    ['lexical_version', { lexical_version: 3 }],
    ['embedding_text_version', { embedding_text_version: 2 }],
    ['embedding_profile_id', { embedding_profile_id: 'other-profile' }],
    ['embedding_profile_version', { embedding_profile_version: 2 }],
    ['language_pack_versions', { language_pack_versions: { zh: 2, it: 1 } }],
    ['language_aware_ingest', { switches: { ...baseParts().switches, language_aware_ingest: 'on' } }],
    ['table_header_repeat', { switches: { ...baseParts().switches, table_header_repeat: 'always' } }],
    ['table_row_serialization', { switches: { ...baseParts().switches, table_row_serialization: 'true' } }],
    ['caption_language', { switches: { ...baseParts().switches, caption_language: 'document' } }],
  ];
  for (const [name, change] of changes) {
    test(`changes when ${name} changes`, () => {
      expect(buildIngestFingerprint(baseParts(change))).not.toBe(buildIngestFingerprint(baseParts()));
    });
  }

  test('scope tags and effective dates are not parts: the builder refuses them instead of hashing them', () => {
    const withTags = { ...baseParts(), scopes: ['region:north'], effective_from: '2026-01-01' } as unknown as IngestFingerprintParts;
    expect(() => buildIngestFingerprint(withTags)).toThrow();
  });

  test('floats are refused, so no float formatting can change the hash', () => {
    expect(() => buildIngestFingerprint(baseParts({ lexical_version: 2.5 }))).toThrow();
  });
});

describe('OCR engine codes', () => {
  test('Docling uses the first language only, through the registry rapidocr code', () => {
    expect(ocrEngineCodes('docling', ['zh', 'en', 'it'])).toEqual(['rapidocr:ch']);
    expect(ocrEngineCodes('docling', ['it'])).toEqual(['rapidocr:it']);
  });

  test('LlamaParse uses every language through the registry llamaparse code', () => {
    expect(ocrEngineCodes('llamaparse', ['zh', 'en', 'it'])).toEqual(['llamaparse:ch_sim', 'llamaparse:en', 'llamaparse:it']);
  });

  test('a mixed document lists both engines; a text document has no OCR code', () => {
    expect(ocrEngineCodes('mixed', ['zh', 'it'])).toEqual(['rapidocr:ch', 'llamaparse:ch_sim', 'llamaparse:it']);
    expect(ocrEngineCodes('text', ['zh', 'it'])).toEqual([]);
  });

  test('the effective OCR languages follow registry order, never the typed order, and fall back to the profile list', () => {
    const configured = (languages: string[]) => ({ configured: true, languages, primary: languages[0] ?? null, monolingual: languages.length === 1 });
    expect(effectiveOcrLanguages(['zh', 'en', 'it'], configured(['it', 'zh']))).toEqual(['zh', 'it']);
    expect(effectiveOcrLanguages(['zh', 'en', 'it'], configured(['zh', 'it']))).toEqual(['zh', 'it']);
    expect(effectiveOcrLanguages(['zh', 'en', 'it'], { configured: false, languages: [], primary: null, monolingual: false })).toEqual(['zh', 'en', 'it']);
  });
});

function fakeWriter(calls: string[]): IngestWriter {
  return {
    async setFields(documentId: string, fields: DocumentFields) {
      calls.push(`setFields:${documentId}:${JSON.stringify(fields)}`);
    },
    async publish(documentId: string) {
      calls.push(`publish:${documentId}`);
      return { outcome: 'held', documentId, version: 1, supersededDocumentId: null };
    },
    async holdForReview(documentId: string) {
      calls.push(`holdForReview:${documentId}`);
      return { documentId, version: 1 };
    },
  } as unknown as IngestWriter;
}

function contextFor(env: Record<string, string>, calls: string[], parserUsed = 'llamaparse'): StageContext {
  const profile = getProcessingProfile('general');
  return {
    input: {
      scope: mintScope('single', null, null),
      source: 'config_upload',
      sourceKey: 'root/sample.md',
      text: 'A neutral sentence about a blue widget.',
      filename: 'sample.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    },
    deps: getIngestDeps(),
    writer: fakeWriter(calls),
    config: loadIngestConfig(env),
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
    state: { ...emptyIngestState(), embeddingTargets: ['openai-3-small-1536'] },
    warnings: [],
    identity: { tenantKey: 's:default', filename: 'sample.md', fileSha256: 'a'.repeat(64), docType: 'general', docTypeOrigin: 'picked', profile, bytes: null },
    document: { id: DOC, version: 1, lineageId: 'lineage', resumed: false },
    parserUsed,
    work: { parseText: null, parserVersion: 'v2-test', chunks: [], chunksWritten: 0 },
  };
}

describe('collectFingerprintParts and the publish stage', () => {
  const saved = { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };

  beforeEach(() => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'it,zh';
    process.env.RAG_PRIMARY_LANGUAGE = 'zh';
    resetLanguageSettingsForTests();
  });
  afterEach(() => {
    for (const [name, value] of [['RAG_SUPPORTED_LANGUAGES', saved.supported], ['RAG_PRIMARY_LANGUAGE', saved.primary]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLanguageSettingsForTests();
    vi.restoreAllMocks();
  });

  test('the parts come from the run: parser, profile, OCR codes of the parser, versions and the four switches', () => {
    const parts = collectFingerprintParts(contextFor({ RAG_TABLE_HEADER_REPEAT: 'always', RAG_CAPTION_LANGUAGE: 'document' }, []));
    expect(IngestFingerprintPartsSchema.parse(parts)).toEqual(parts);
    expect(parts).toEqual({
      parser_used: 'llamaparse',
      parser_version: 'v2-test',
      processing_profile_id: 'general@1',
      processing_profile_version: 1,
      ocr_engine_codes: ['llamaparse:ch_sim', 'llamaparse:it'],
      chunking_profile_id: FINGERPRINT_CHUNKING_PROFILE_ID,
      lexical_version: LEXICAL_VERSION,
      embedding_text_version: EMBEDDING_TEXT_VERSION,
      embedding_profile_id: 'openai-3-small-1536',
      embedding_profile_version: EMBEDDING_PROFILE_VERSION,
      language_pack_versions: { zh: 1, it: 1 },
      switches: { language_aware_ingest: 'off', table_header_repeat: 'always', table_row_serialization: 'false', caption_language: 'document' },
    });
  });

  test('RAG_TABLE_ROW_SERIALIZATION: the parts carry the effective embedding-text version and the hash changes with the switch (D-21)', () => {
    const off = collectFingerprintParts(contextFor({}, []));
    const on = collectFingerprintParts(contextFor({ RAG_TABLE_ROW_SERIALIZATION: 'true' }, []));
    expect(off.embedding_text_version).toBe(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, false));
    expect(off.embedding_text_version).toBe(EMBEDDING_TEXT_VERSION);
    expect(on.embedding_text_version).toBe(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true));
    expect(on.lexical_version).toBe(off.lexical_version);
    expect(buildIngestFingerprint(on)).not.toBe(buildIngestFingerprint(off));
    expect(expectedFingerprintFor(off, { RAG_TABLE_ROW_SERIALIZATION: 'true' }).fingerprint).toBe(buildIngestFingerprint(on));
  });

  test('typing the supported languages in another order gives one fingerprint', () => {
    const first = buildIngestFingerprint(collectFingerprintParts(contextFor({}, [])));
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,it';
    resetLanguageSettingsForTests();
    expect(buildIngestFingerprint(collectFingerprintParts(contextFor({}, [])))).toBe(first);
  });

  test('a Docling document is not changed by dropping a language that is not its OCR language', () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
    resetLanguageSettingsForTests();
    const before = buildIngestFingerprint(collectFingerprintParts(contextFor({}, [], 'docling')));
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,it';
    resetLanguageSettingsForTests();
    expect(buildIngestFingerprint(collectFingerprintParts(contextFor({}, [], 'docling')))).toBe(before);
  });

  test('a resumed run whose parse version was not kept in memory takes it from the run state', () => {
    const ctx = contextFor({}, []);
    ctx.work.parserVersion = 'stored';
    ctx.state.parserVersion = 'v2-test';
    expect(collectFingerprintParts(ctx).parser_version).toBe('v2-test');
  });

  test('publish writes the fingerprint and its parts before the publish call', async () => {
    const calls: string[] = [];
    const ctx = contextFor({}, calls);
    await publishStage.run(ctx);
    const parts = collectFingerprintParts(ctx);
    expect(calls).toEqual([
      `setFields:${DOC}:${JSON.stringify({ ingest_fingerprint: buildIngestFingerprint(parts), metadata: { ingest_fingerprint_parts: parts } })}`,
      `publish:${DOC}`,
    ]);
  });

  test('publish writes the fingerprint before holding a version for review', async () => {
    const calls: string[] = [];
    const ctx = contextFor({}, calls);
    ctx.state.approval = { mode: 'members', required: true, reason: 'member_upload', uploader_id: null, decided_at: '2026-01-02T03:04:05.000Z' };
    await publishStage.run(ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"ingest_fingerprint":"');
    expect(calls[1]).toBe(`holdForReview:${DOC}`);
  });
});

describe('expectedFingerprintFor', () => {
  test('the stored parts with no proposed change give the stored fingerprint', () => {
    const parts = baseParts();
    expect(expectedFingerprintFor(parts, {}).fingerprint).toBe(buildIngestFingerprint(parts));
  });

  test('a proposed switch value changes the matching part only', () => {
    const expected = expectedFingerprintFor(baseParts(), { RAG_TABLE_HEADER_REPEAT: 'always' });
    expect(expected.parts).toEqual(baseParts({ switches: { ...baseParts().switches, table_header_repeat: 'always' } }));
  });

  test('RAG_TABLE_ROW_SERIALIZATION moves its switch part and the effective embedding-text version together, both ways (D-21)', () => {
    const on = expectedFingerprintFor(baseParts(), { RAG_TABLE_ROW_SERIALIZATION: 'true' });
    expect(on.parts).toEqual(
      baseParts({
        embedding_text_version: effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true),
        switches: { ...baseParts().switches, table_row_serialization: 'true' },
      }),
    );
    expect(on.fingerprint).not.toBe(buildIngestFingerprint(baseParts()));
    const back = expectedFingerprintFor(on.parts, { RAG_TABLE_ROW_SERIALIZATION: 'false' });
    expect(back.parts).toEqual(baseParts());
    expect(back.fingerprint).toBe(buildIngestFingerprint(baseParts()));
    expect(expectedFingerprintFor(on.parts, { RAG_TABLE_ROW_SERIALIZATION: 'true' }).parts).toEqual(on.parts);
  });

  test('a proposed language set changes the OCR codes of a LlamaParse document, not of a Docling document reading the same first language', () => {
    const llama = expectedFingerprintFor(baseParts(), { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' });
    expect(llama.parts.ocr_engine_codes).toEqual(['llamaparse:ch_sim', 'llamaparse:en', 'llamaparse:it']);
    const docling = baseParts({ parser_used: 'docling', ocr_engine_codes: ['rapidocr:ch'], language_pack_versions: { zh: 1 } });
    expect(expectedFingerprintFor(docling, { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' }).fingerprint).toBe(buildIngestFingerprint(docling));
  });

  test('scope tags and effective dates in the proposal change nothing', () => {
    const parts = baseParts();
    expect(expectedFingerprintFor(parts, { RAG_SCOPE_TAGS: 'true', RAG_EFFECTIVE_DATES: 'true' }).fingerprint).toBe(buildIngestFingerprint(parts));
  });
});

describe('legacy ingest pipeline', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  test('only the unified pipeline writes the fingerprint: no legacy writer outside src/lib/rag/ingest names the column', () => {
    const root = path.join(process.cwd(), 'src');
    const writers = sourceFiles(root)
      .filter((file) => !file.endsWith('contracts.generated.ts'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('ingest_fingerprint'))
      .map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.filter((file) => !file.startsWith('lib/rag/ingest/'))).toEqual([]);
  });
});

describe('settings classification', () => {
  const D47_INGESTION: Record<string, string> = {
    RAG_SUPPORTED_LANGUAGES: 'reparse',
    RAG_LANGUAGE_AWARE_INGEST: 'rechunk',
    RAG_TABLE_HEADER_REPEAT: 'rechunk',
    RAG_TABLE_ROW_SERIALIZATION: 'rechunk',
    RAG_CAPTION_LANGUAGE: 'recaption',
    RAG_DOC_TRANSLATION: 'retranslate',
    RAG_DOC_TRANSLATION_MODEL: 'retranslate',
    RAG_HIDDEN_TEXT_CHECK: 'rescan',
    RAG_INGEST_LINK_CHECK: 'rescan',
    RAG_OUTPUT_LINK_ALLOWLIST: 'rescan',
  };
  const D47_QUERY = [
    'RAG_PRIMARY_LANGUAGE',
    'RAG_BGE_M3_SERVING',
    'RAG_UPLOAD_APPROVAL',
    'RAG_SCOPE_TAGS',
    'RAG_SCOPE_TAG_SUGGEST',
    'RAG_SUPERSESSION_DETECT',
    'RAG_EFFECTIVE_DATES',
    'RAG_EFFECTIVE_DATE_LLM_EXTRACT',
  ];

  test('the loader validates the file once and returns every entry', () => {
    const classification = getSettingsClassification();
    expect(classification.schema_version).toBe(1);
    expect(getSettingsClassification()).toBe(classification);
    expect(classification.entries.length).toBeGreaterThan(100);
  });

  test('ingestionKeysOf returns each of the ten ingestion-side variables of D-47 with its mechanism', () => {
    const proposed = Object.fromEntries(Object.keys(D47_INGESTION).map((name) => [name, 'x']));
    expect(ingestionKeysOf(proposed)).toEqual(
      Object.entries(D47_INGESTION)
        .map(([name, mechanism]) => ({ name, mechanism }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  test('ingestionKeysOf leaves out query-side and unknown keys', () => {
    const proposed = Object.fromEntries([...D47_QUERY, 'RAG_RERANKER', 'RAG_NOT_A_SETTING', 'OPENAI_API_KEY'].map((name) => [name, 'x']));
    expect(ingestionKeysOf(proposed)).toEqual([]);
    expect(ingestionKeysOf({ RAG_PARSER: 'docling', RAG_PIPELINE: 'v2' })).toEqual([{ name: 'RAG_PARSER', mechanism: 'reparse' }]);
  });
});
