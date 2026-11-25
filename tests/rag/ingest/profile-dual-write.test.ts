import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { setDefaultPipelineForTests } from '@/lib/rag/config';
import { deferredEmbedStage } from '@/lib/rag/ingest/stages/embed-write';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import { isV2Available, markV2Unavailable, resetV2ReadinessForTests } from '@/lib/rag/v2/readiness';
import { resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { ingest } from '@/lib/rag/ingest';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import { buildProfileChunks, type ChunkingProfileRow } from '@/lib/rag/ingest/profile-chunks';
import { IngestWriterError, profileRowIdFor } from '@/lib/rag/ingest/writer';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, callsOf, fakeIngestDb, installIngestDeps, unitVector, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const LEGACY_EMBEDDING = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-1024';
const CONTRACT = fs.readFileSync(path.resolve(__dirname, '../../../eval/fixtures/ingest/text/contract-zh.md'), 'utf8');

type Row = Record<string, unknown>;

function chunkingRow(id: string, docType: string, status: string, over: Row = {}): Row {
  return {
    id,
    doc_type: docType,
    child_tokens: 256,
    parent_mode: 'structure',
    parent_tokens: 1024,
    status,
    preset: '256/1024',
    previous_active_id: null,
    is_active: status === 'active',
    created_at: '2026-01-01T00:00:00Z',
    activated_at: null,
    activated_by: null,
    ...over,
  };
}

const LEGACY_CONTRACT = chunkingRow('legacy', 'contract_legal', 'active', { child_tokens: 768, parent_mode: 'none', parent_tokens: null });

function upload(docType: 'contract_legal' | 'general' = 'contract_legal') {
  return ingest({
    scope,
    source: 'config_upload',
    sourceKey: 'root/contract.md',
    text: CONTRACT,
    filename: 'contract.md',
    mimeType: 'text/markdown',
    docType,
    signal: new AbortController().signal,
  });
}

const names = (calls: RecordedRpc[]): string[] => calls.map((call) => call.fn);

let pipeline: string | undefined;

beforeEach(() => {
  pipeline = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: pipeline }) });
});

afterEach(() => {
  resetRagDepsForTests();
  resetActiveProfileForTests();
  resetEmbeddingProvidersForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

async function runWith(options: { profiles?: Row[]; pipeline?: string; embedDocuments?: (texts: string[]) => Promise<number[][]> }) {
  pipeline = options.pipeline;
  const { db, calls } = fakeIngestDb({ chunkingProfiles: options.profiles ?? [LEGACY_CONTRACT] });
  const embedDocuments = vi.fn(options.embedDocuments ?? (async (texts: string[]) => texts.map(() => unitVector())));
  installIngestDeps({ db, embedDocuments: (texts) => embedDocuments(texts) });
  const result = await upload();
  return { result, calls, embedDocuments };
}

describe('buildProfileChunks', () => {
  const chunker = getProcessingProfile('contract_legal').chunker;
  const profile: ChunkingProfileRow = { id: 'p256', docType: 'contract_legal', childTokens: 256, parentMode: 'structure', parentTokens: 1024, status: 'building' };

  test('parents carry no lexical or embedding text; children carry lexical_text from chunkLexicalText and the embedding text of the Phase 3 builder', () => {
    const built = buildProfileChunks({ filename: 'contract.md', chunker, templateHeader: 'Contract' }, CONTRACT, profile);
    const expected = chunkParentChild(CONTRACT, { childTokens: 256, parentMode: 'structure', parentTokens: 1024 }, chunker);
    expect(built.parents.length).toBe(expected.parents.length);
    expect(built.parents.length).toBeGreaterThan(0);
    for (const parent of built.parents) {
      expect(Object.keys(parent).sort()).toEqual(['content', 'parent_index', 'section_path', 'token_count']);
    }
    expect(built.children.length).toBe(expected.children.length);
    expect(built.embeddingTexts).toHaveLength(built.children.length);
    built.children.forEach((child, index) => {
      expect(child.chunk_index).toBe(index);
      expect(child.parent_index).toBe(expected.children[index]?.parent_index);
      expect(child.lexical_text).toBe(
        chunkLexicalText({ sectionPath: child.section_path, content: child.content, chunkKind: child.chunk_kind, metadata: {}, documentFilename: 'contract.md' }),
      );
      expect(built.embeddingTexts[index]).toBe(buildEmbeddingText({ section_path: child.section_path, content: child.content, template_header: 'Contract' }));
      expect(child.metadata.lexical_version).toBeTypeOf('number');
      expect(child.content_hash).toMatch(/^[0-9a-f]{16,}$/);
    });
  });
});

describe('ingestion dual-write of chunking profiles', () => {
  test('with only legacy profiles under v2 the writer and embedding calls are the legacy ones', async () => {
    const baseline = await runWith({ pipeline: undefined });
    uninstallIngestDeps();
    resetRagDepsForTests();
    const v2 = await runWith({ pipeline: 'v2' });
    expect(v2.result.status).toBe('ready');
    expect(names(v2.calls).filter((fn) => fn !== 'rag_list_chunking_profiles')).toEqual(names(baseline.calls));
    expect(callsOf(v2.calls, 'rag_write_profile_chunks')).toHaveLength(0);
    expect(v2.embedDocuments).toHaveBeenCalledTimes(baseline.embedDocuments.mock.calls.length);
  });

  test('RAG_PIPELINE=legacy skips dual-write', async () => {
    const baseline = await runWith({});
    uninstallIngestDeps();
    resetRagDepsForTests();
    for (const value of [undefined, 'legacy']) {
      const run = await runWith({ pipeline: value, profiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')] });
      expect(run.result.status).toBe('ready');
      expect(names(run.calls)).toEqual(names(baseline.calls));
      expect(callsOf(run.calls, 'rag_write_profile_chunks')).toHaveLength(0);
      expect(callsOf(run.calls, 'rag_list_chunking_profiles')).toHaveLength(0);
      expect(run.embedDocuments).toHaveBeenCalledTimes(baseline.embedDocuments.mock.calls.length);
      expect(callsOf(run.calls, 'rag_write_chunks').map((call) => call.args)).toEqual(callsOf(baseline.calls, 'rag_write_chunks').map((call) => call.args));
      uninstallIngestDeps();
      resetRagDepsForTests();
    }
  });

  test('under v2 a contract also gets p256 parents and children for the new version before publish, embedded under the active embedding profile', async () => {
    const run = await runWith({ pipeline: 'v2', profiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')] });
    expect(run.result.status).toBe('ready');
    const order = names(run.calls);
    const writes = callsOf(run.calls, 'rag_write_profile_chunks');
    expect(writes).toHaveLength(1);
    const write = writes[0]?.args as Record<string, unknown>;
    expect(write.p_document_id).toBe(FAKE_DOCUMENT_ID);
    expect(write.p_tenant_key).toBe('s:default');
    expect(write.p_profile_id).toBe('p256');
    const parents = write.p_parents as Array<Record<string, unknown>>;
    const children = write.p_children as Array<Record<string, unknown>>;
    expect(parents.length).toBeGreaterThan(0);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => typeof child.lexical_text === 'string' && child.parent_index !== undefined)).toBe(true);
    const embeddings = write.p_embeddings as Record<string, number[][]>;
    expect(Object.keys(embeddings)).toEqual([LEGACY_EMBEDDING]);
    expect(embeddings[LEGACY_EMBEDDING]).toHaveLength(children.length);
    expect(write.p_final).toBe(true);
    expect(write.p_total).toBe(children.length);

    const lastLegacy = order.lastIndexOf('rag_write_chunks');
    const publish = order.indexOf('rag_publish_document_version');
    const profileWrite = order.indexOf('rag_write_profile_chunks');
    expect(lastLegacy).toBeGreaterThanOrEqual(0);
    expect(profileWrite).toBeGreaterThan(lastLegacy);
    expect(publish).toBeGreaterThan(profileWrite);
  });

  test('every building, ready or active non-legacy profile of the type is written; retired profiles and profiles of other types are not', async () => {
    const run = await runWith({
      pipeline: 'v2',
      profiles: [
        LEGACY_CONTRACT,
        chunkingRow('p-building', 'contract_legal', 'building'),
        chunkingRow('p-ready', 'contract_legal', 'ready', { child_tokens: 128, parent_tokens: 512 }),
        chunkingRow('p-retired', 'contract_legal', 'retired'),
        chunkingRow('p-other', 'general', 'building'),
      ],
    });
    expect(run.result.status).toBe('ready');
    expect(callsOf(run.calls, 'rag_write_profile_chunks').map((call) => call.args.p_profile_id)).toEqual(['p-building', 'p-ready']);
  });

  test('a doc type with no live non-legacy profile makes no extra write or embedding call', async () => {
    const baseline = await runWith({});
    uninstallIngestDeps();
    resetRagDepsForTests();
    const run = await runWith({ pipeline: 'v2', profiles: [LEGACY_CONTRACT, chunkingRow('p-other', 'general', 'building'), chunkingRow('p-old', 'contract_legal', 'retired')] });
    expect(callsOf(run.calls, 'rag_write_profile_chunks')).toHaveLength(0);
    expect(run.embedDocuments).toHaveBeenCalledTimes(baseline.embedDocuments.mock.calls.length);
  });

  test('a profile write failure fails the run before publish and nothing is published', async () => {
    pipeline = 'v2';
    const { db, calls } = fakeIngestDb({
      chunkingProfiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')],
      failures: { rag_write_profile_chunks: { code: 'XX000', message: 'boom' } },
    });
    installIngestDeps({ db });
    const result = await upload();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('profile_write_failed');
    expect(callsOf(calls, 'rag_publish_document_version')).toHaveLength(0);
    expect(callsOf(calls, 'rag_mark_document_failed')).toHaveLength(1);
  });

  test('an unreadable chunking registry under v2 fails the run retryably instead of skipping the profile', async () => {
    pipeline = 'v2';
    const { db, calls } = fakeIngestDb({ failures: { rag_list_chunking_profiles: { code: 'XX000', message: 'boom' } } });
    installIngestDeps({ db });
    const result = await upload();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('chunking_profiles_unavailable');
    expect(callsOf(calls, 'rag_publish_document_version')).toHaveLength(0);
  });

  test('with embedding profiles on, children are embedded under the active and the backfilling profile; a failing backfilling profile leaves a gap instead of failing the run', async () => {
    pipeline = 'v2';
    const registry: Row[] = [
      { id: LEGACY_EMBEDDING, provider: 'openai', model: 'text-embedding-3-small', dims: 1536, storage: 'legacy_column', status: 'active', query_instruction: null, score_calibration: {}, activated_at: null, activated_by: null, previous_active_id: null, has_evidence: false, created_at: '2026-01-01T00:00:00Z' },
      { id: VOYAGE, provider: 'voyage', model: 'voyage-4-large', dims: 1024, storage: 'halfvec', status: 'backfilling', query_instruction: null, score_calibration: {}, activated_at: null, activated_by: null, previous_active_id: null, has_evidence: false, created_at: '2026-01-01T00:00:00Z' },
    ];
    const registryClient = {
      rpc(fn: string) {
        const response = { data: fn === 'rag_list_embedding_profiles' ? registry : [], error: null };
        const request = { abortSignal: () => request, then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve(response).then(ok, bad) };
        return request;
      },
    };
    setRagDepsForTests({ adminClient: () => registryClient as never, now: () => 1_000_000, ragEnv: () => ({ RAG_PIPELINE: 'v2' }) });
    const voyageTexts: string[][] = [];
    let voyageFails = false;
    const voyage: EmbeddingProvider = {
      id: 'voyage',
      model: 'voyage-4-large',
      maxInputTokens: 32000,
      supportedDims: [256, 512, 1024, 2048],
      normalize: true,
      async embedDocuments(texts) {
        voyageTexts.push(texts);
        if (voyageFails) throw new Error('voyage down');
        return { vectors: texts.map(() => Array.from({ length: 1024 }, () => 0.5)), model: 'voyage-4-large', host: 'fixture', usage: { tokens: 1 } };
      },
      async embedQuery() {
        throw new Error('unused');
      },
    };
    setEmbeddingProvidersForTests({ voyage });
    const { db, calls } = fakeIngestDb({ chunkingProfiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')] });
    installIngestDeps({ db, env: { RAG_EMBEDDING_PROFILES: 'on' } });
    const result = await upload();
    expect(result.status).toBe('ready');
    const write = callsOf(calls, 'rag_write_profile_chunks')[0]?.args as Record<string, unknown>;
    const embeddings = write.p_embeddings as Record<string, unknown>;
    expect(Object.keys(embeddings).sort()).toEqual([LEGACY_EMBEDDING, VOYAGE].sort());
    const children = write.p_children as unknown[];
    const voyageValue = embeddings[VOYAGE] as { vectors: number[][]; host: string };
    expect(voyageValue.vectors).toHaveLength(children.length);
    expect(voyageValue.host).toBe('fixture');
    expect(voyageTexts.flat().some((text) => text.includes('第5条'))).toBe(true);

    uninstallIngestDeps();
    voyageFails = true;
    const failing = fakeIngestDb({
      chunkingProfiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')],
      backfillRuns: [{ profile_id: VOYAGE, run_id: 'run-voyage', status: 'running' }],
    });
    installIngestDeps({ db: failing.db, env: { RAG_EMBEDDING_PROFILES: 'on' } });
    const second = await upload();
    expect(second.status).toBe('ready');
    const secondWrite = callsOf(failing.calls, 'rag_write_profile_chunks')[0]?.args as Record<string, unknown>;
    expect(Object.keys(secondWrite.p_embeddings as Record<string, unknown>)).toEqual([LEGACY_EMBEDDING]);
    const firstChild = profileRowIdFor(FAKE_DOCUMENT_ID, 'p256', 'child', 0);
    const gaps = callsOf(failing.calls, 'rag_record_backfill_gap').filter((call) => (call.args.p_chunk_ids as string[]).includes(firstChild));
    expect(gaps.map((call) => [call.args.p_run_id, call.args.p_profile_id, call.args.p_reason])).toEqual([['run-voyage', VOYAGE, 'provider_failed']]);
    expect(gaps[0]?.args.p_chunk_ids).toEqual((secondWrite.p_children as Array<{ chunk_index: number }>).map((child) => profileRowIdFor(FAKE_DOCUMENT_ID, 'p256', 'child', child.chunk_index)));
  });
});

describe('the dual write follows the effective pipeline (D-07, D-24)', () => {
  const MISSING = { code: 'PGRST202', message: 'Could not find the function' };

  beforeEach(() => {
    setDefaultPipelineForTests(null);
    resetV2ReadinessForTests();
  });
  afterEach(() => {
    setDefaultPipelineForTests(null);
    resetV2ReadinessForTests();
  });

  async function runWithDb(options: { pipeline?: string; languages?: boolean | null; failures?: Record<string, { code: string; message: string }> }) {
    pipeline = options.pipeline;
    if (options.languages !== undefined) setRagDepsForTests({ languagesConfigured: () => options.languages ?? null });
    const { db, calls } = fakeIngestDb({ chunkingProfiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')], failures: options.failures });
    installIngestDeps({ db });
    const result = await upload();
    return { result, calls };
  }

  function reset(): void {
    uninstallIngestDeps();
    resetRagDepsForTests();
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: pipeline }) });
  }

  test('when the resolver says legacy the listing is never called and the legacy writes are unchanged', async () => {
    const baseline = await runWith({ pipeline: 'legacy', profiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')] });
    reset();

    setDefaultPipelineForTests('v2');
    const languages = await runWithDb({ languages: false });
    expect(languages.result.status).toBe('ready');
    expect(names(languages.calls)).toEqual(names(baseline.calls));
    expect(callsOf(languages.calls, 'rag_write_chunks').map((call) => call.args)).toEqual(callsOf(baseline.calls, 'rag_write_chunks').map((call) => call.args));
    reset();

    markV2Unavailable('hybrid_search_chunks');
    const unavailable = await runWithDb({});
    expect(unavailable.result.status).toBe('ready');
    expect(names(unavailable.calls)).toEqual(names(baseline.calls));
  });

  test('default v2 with a missing listing function completes as legacy, logs once and stops calling it', async () => {
    const baseline = await runWith({ pipeline: 'legacy', profiles: [LEGACY_CONTRACT, chunkingRow('p256', 'contract_legal', 'building')] });
    reset();

    setDefaultPipelineForTests('v2');
    for (const code of ['PGRST202', '42883']) {
      resetV2ReadinessForTests();
      const error = vi.mocked(console.error);
      error.mockClear();
      const first = await runWithDb({ failures: { rag_list_chunking_profiles: { ...MISSING, code } } });
      expect(first.result.status, code).toBe('ready');
      expect(callsOf(first.calls, 'rag_list_chunking_profiles'), code).toHaveLength(1);
      expect(callsOf(first.calls, 'rag_write_profile_chunks'), code).toHaveLength(0);
      expect(names(first.calls).filter((fn) => fn !== 'rag_list_chunking_profiles'), code).toEqual(names(baseline.calls));
      expect(isV2Available(), code).toBe(false);
      expect(error.mock.calls.filter((call) => String(call[0]).startsWith('[RAG Config]')), code).toHaveLength(1);
      reset();

      const second = await runWithDb({ failures: { rag_list_chunking_profiles: { ...MISSING, code } } });
      expect(second.result.status, code).toBe('ready');
      expect(callsOf(second.calls, 'rag_list_chunking_profiles'), code).toHaveLength(0);
      reset();
    }
  });

  test('explicit v2 with a missing listing function still fails with chunking_profiles_unavailable', async () => {
    const run = await runWithDb({ pipeline: 'v2', failures: { rag_list_chunking_profiles: MISSING } });
    expect(run.result.status).toBe('failed');
    expect(run.result.reason).toBe('chunking_profiles_unavailable');
    expect(isV2Available()).toBe(true);
  });

  test('default v2 with another listing failure still fails with chunking_profiles_unavailable', async () => {
    setDefaultPipelineForTests('v2');
    for (const code of ['57014', 'XX000']) {
      const run = await runWithDb({ failures: { rag_list_chunking_profiles: { code, message: 'boom' } } });
      expect(run.result.status, code).toBe('failed');
      expect(run.result.reason, code).toBe('chunking_profiles_unavailable');
      expect(isV2Available(), code).toBe(true);
      reset();
    }
  });

  test('default v2 with languages configured or no reader still dual writes', async () => {
    setDefaultPipelineForTests('v2');
    for (const languages of [true, null]) {
      const run = await runWithDb({ languages });
      expect(run.result.status).toBe('ready');
      expect(callsOf(run.calls, 'rag_write_profile_chunks')).toHaveLength(1);
      reset();
    }
  });

  describe('deferred embed', () => {
    function deferredContext(listing: () => Promise<ChunkingProfileRow[]>) {
      const writer = {
        listChunkingProfiles: vi.fn(listing),
        writeChunks: vi.fn(async (_id: string, batch: unknown[]) => ({ chunksWritten: batch.length, chunksDeleted: 0 })),
        writeProfileChunks: vi.fn(async () => ({ parentsWritten: 0, childrenWritten: 0, parentsDeleted: 0, childrenDeleted: 0 })),
        findBackfillRuns: vi.fn(async () => []),
      };
      const ctx = {
        identity: {
          tenantKey: 's:default',
          filename: 'contract.md',
          fileSha256: 'x',
          docType: 'contract_legal',
          docTypeOrigin: 'picked',
          profile: getProcessingProfile('contract_legal'),
          bytes: null,
        },
        document: { id: FAKE_DOCUMENT_ID, version: 1, lineageId: null },
        writer,
        signal: new AbortController().signal,
        warnings: [],
        state: emptyIngestState(),
        work: { parseText: CONTRACT, parserVersion: null, chunks: [], chunksWritten: 0 },
      } as unknown as StageContext;
      return { ctx, writer };
    }

    const missing = async (): Promise<ChunkingProfileRow[]> => {
      throw new IngestWriterError('rag_list_chunking_profiles', 'PGRST202');
    };

    test('resolver legacy: the listing is never called', async () => {
      setDefaultPipelineForTests('v2');
      setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: undefined }), languagesConfigured: () => false });
      const { ctx, writer } = deferredContext(missing);
      await expect(deferredEmbedStage.run(ctx)).resolves.toMatchObject({ kind: 'next', outcome: 'deferred' });
      expect(writer.listChunkingProfiles).not.toHaveBeenCalled();
    });

    test('default v2 with a missing listing function completes without the dual write', async () => {
      setDefaultPipelineForTests('v2');
      setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: undefined }) });
      const { ctx, writer } = deferredContext(missing);
      await expect(deferredEmbedStage.run(ctx)).resolves.toMatchObject({ kind: 'next', outcome: 'deferred' });
      expect(writer.listChunkingProfiles).toHaveBeenCalledTimes(1);
      expect(writer.writeProfileChunks).not.toHaveBeenCalled();
      expect(isV2Available()).toBe(false);
    });

    test('explicit v2 with a missing listing function fails with chunking_profiles_unavailable', async () => {
      setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2' }) });
      const { ctx } = deferredContext(missing);
      await expect(deferredEmbedStage.run(ctx)).rejects.toMatchObject({ reason: 'chunking_profiles_unavailable' });
      expect(isV2Available()).toBe(true);
    });
  });
});
