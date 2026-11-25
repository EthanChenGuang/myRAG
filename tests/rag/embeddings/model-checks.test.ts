import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { EmbeddingProfileMismatchError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests, verifyActiveEmbeddingProfileAtStartup } from '@/lib/rag/embeddings/active-profile';
import { embedQuery, resetProfileFailureLogForTests } from '@/lib/rag/embeddings/query-embedding';
import { getEmbeddingProviderFor, resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { ingest } from '@/lib/rag/ingest';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { runReembed } from '@/lib/rag/ingest/reembed/run';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const LAW = 'voyage-law-2-1024';
const LEGACY = 'openai-3-small-1536';
const DIMS = 1024;
const VOYAGE_KEY = 'test-voyage-key-placeholder-0123456789';
const TEXT = 'Section one. The first paragraph describes a neutral sample process in plain words.\n\nSection two. The second paragraph adds another neutral sentence.';

const mutableEnv = env as unknown as Record<string, unknown>;
const savedVoyageKey = mutableEnv.VOYAGE_API_KEY;

type Row = Record<string, unknown>;

function profileRow(id: string, over: Row = {}): Row {
  return {
    id,
    provider: 'voyage',
    model: 'voyage-law-2',
    dims: DIMS,
    storage: 'halfvec',
    status: 'active',
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const LEGACY_ROW = profileRow(LEGACY, { provider: 'openai', model: 'text-embedding-3-small', dims: 1536, storage: 'legacy_column' });

function request(response: RpcResponse): RpcRequest {
  const pending: RpcRequest = {
    abortSignal: () => pending,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return pending;
}

function installRegistry(rows: Row[]): void {
  const client: RpcClient = { rpc: (fn) => request({ data: fn === 'rag_list_embedding_profiles' ? rows : [], error: null }) };
  setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
}

interface Fake {
  provider: EmbeddingProvider;
  queries: number;
  documents: number;
}

/** A fake Voyage provider registered for one model; `echo` is the model its responses report. */
function fakeVoyage(model: string, echo = model): Fake {
  const state: Fake = { provider: null as unknown as EmbeddingProvider, queries: 0, documents: 0 };
  const vector = () => Array.from({ length: DIMS }, () => 0.01);
  state.provider = {
    id: 'voyage',
    model,
    maxInputTokens: 16000,
    supportedDims: [DIMS],
    normalize: true,
    async embedQuery() {
      state.queries += 1;
      return { vectors: [vector()], model: echo, host: 'fake', usage: { tokens: 3 } };
    },
    async embedDocuments(texts) {
      state.documents += 1;
      return { vectors: texts.map(vector), model: echo, host: 'fake', usage: { tokens: texts.length } };
    },
  };
  return state;
}

/** Stands in for the voyage-4-large default so no test reaches the network. */
function guardDefault(): Fake {
  return fakeVoyage('voyage-4-large');
}

beforeEach(() => {
  mutableEnv.VOYAGE_API_KEY = VOYAGE_KEY;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  mutableEnv.VOYAGE_API_KEY = savedVoyageKey;
  resetRagDepsForTests();
  resetIngestDepsForTests();
  uninstallIngestDeps();
  resetActiveProfileForTests();
  resetEmbeddingProvidersForTests();
  resetProfileFailureLogForTests();
  vi.restoreAllMocks();
});

describe('startup and query checks resolve the profile model (D-02)', () => {
  beforeEach(() => {
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
    installRegistry([profileRow(LAW)]);
  });

  it('a voyage-law-2 profile passes the startup check and embeds a query at its dims', async () => {
    const law = fakeVoyage('voyage-law-2');
    const base = guardDefault();
    setEmbeddingProvidersForTests({ voyage: base.provider, 'voyage:voyage-law-2': law.provider });

    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict.status).toBe('ok');

    const result = await embedQuery('a neutral sample question', new AbortController().signal);
    expect(result.vector).toHaveLength(DIMS);
    expect(result.profile?.id).toBe(LAW);
    expect(law.queries).toBe(1);
    expect(base.queries).toBe(0);
  });

  it('a same-dimension model swap behind the law profile fails per request with kind model', async () => {
    const swapped = fakeVoyage('voyage-law-2', 'voyage-4-large');
    setEmbeddingProvidersForTests({ voyage: guardDefault().provider, 'voyage:voyage-law-2': swapped.provider });

    expect((await verifyActiveEmbeddingProfileAtStartup()).status).toBe('ok');
    const error = await embedQuery('a neutral sample question', new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProfileMismatchError);
    expect((error as EmbeddingProfileMismatchError).kind).toBe('model');
    expect(swapped.queries).toBe(1);
  });

  it('a provider-keyed fake reporting another model still stands in for the default and fails the startup check', async () => {
    installRegistry([profileRow('voyage-4-large-1024', { model: 'voyage-4-large' })]);
    const other = fakeVoyage('some-other-model');
    setEmbeddingProvidersForTests({ voyage: other.provider });

    expect(getEmbeddingProviderFor('voyage', 'voyage-4-large')).toBe(other.provider);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict.status).toBe('mismatch');
    expect(verdict.status === 'mismatch' ? verdict.reason : null).toBe('model_mismatch');
  });
});

describe('the ingest model check resolves the profile model', () => {
  async function uploadWith(provider: EmbeddingProvider) {
    setRagDepsForTests({ ragEnv: () => ({}) });
    installRegistry([LEGACY_ROW, profileRow(LAW, { status: 'backfilling' })]);
    setEmbeddingProvidersForTests({ voyage: guardDefault().provider, 'voyage:voyage-law-2': provider });
    const { db, calls } = fakeIngestDb({ backfillRuns: [{ profile_id: LAW, run_id: 'run-law', status: 'running' }] });
    installIngestDeps({ db, env: { RAG_EMBEDDING_PROFILES: 'on' } });
    const result = await ingest({
      scope: mintScope('single', null, null),
      source: 'config_upload',
      sourceKey: 'root/sample.md',
      text: TEXT,
      filename: 'sample.md',
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });
    const writes = callsOf(calls, 'rag_write_chunks');
    const embeddings = (writes[0]?.args.p_embeddings ?? {}) as Record<string, unknown>;
    return { result, embeddings };
  }

  it('dual-writes a backfilling voyage-law-2 profile', async () => {
    const law = fakeVoyage('voyage-law-2');
    const { result, embeddings } = await uploadWith(law.provider);
    expect(result.status).toBe('ready');
    expect(Object.keys(embeddings).sort()).toEqual([LEGACY, LAW].sort());
    expect(law.documents).toBeGreaterThan(0);
  });

  it('drops the law profile when its provider echoes another model', async () => {
    const swapped = fakeVoyage('voyage-law-2', 'voyage-4-large');
    const { result, embeddings } = await uploadWith(swapped.provider);
    expect(result.status).toBe('ready');
    expect(Object.keys(embeddings)).toEqual([LEGACY]);
  });
});

describe('the re-embed run resolves the run model', () => {
  function reembedDb(): { db: RpcClient; writes: Row[] } {
    const writes: Row[] = [];
    let served = false;
    const runRow = {
      run_id: 'run-law',
      profile_id: LAW,
      tenant_key: null,
      cursor_chunk_id: null,
      chunks_total: 1,
      chunks_done: 0,
      tokens: 0,
      status: 'running',
      derived_from: null,
      provider: 'voyage',
      model: 'voyage-law-2',
      dims: DIMS,
      storage: 'halfvec',
      profile_status: 'backfilling',
    };
    const chunk = {
      id: '00000000-0000-4000-8000-000000000001',
      document_id: '00000000-0000-4000-8000-000000000002',
      tenant_key: 'single',
      content: 'A neutral sample sentence.',
      section_path: [],
      chunk_kind: 'text',
      doc_type: null,
      template_row: {},
      has_gap: false,
    };
    const answer = (fn: string, args: Row): Row[] => {
      switch (fn) {
        case 'rag_reembed_start_run':
          return [{ run_id: 'run-law' }];
        case 'rag_reembed_get_run':
          return [runRow];
        case 'rag_reembed_next_batch':
          if (served) return [];
          served = true;
          return [chunk];
        case 'rag_reembed_write_batch':
          writes.push(args);
          return [{ chunks_written: 1, chunks_done: 1, cursor_chunk_id: chunk.id }];
        case 'rag_reembed_remaining':
          return [{ chunks_missing: 0 }];
        case 'rag_reembed_finish_run':
          return [{ status: args.p_status, chunks_missing: 0 }];
        default:
          return [];
      }
    };
    const db: RpcClient = { rpc: (fn, args) => request({ data: answer(fn, (args ?? {}) as Row), error: null }) };
    return { db, writes };
  }

  beforeEach(() => {
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }) });
    installRegistry([LEGACY_ROW, profileRow(LAW, { status: 'backfilling' })]);
  });

  it('embeds a voyage-law-2 run with the law provider', async () => {
    const law = fakeVoyage('voyage-law-2');
    setEmbeddingProvidersForTests({ voyage: guardDefault().provider, 'voyage:voyage-law-2': law.provider });
    const { db, writes } = reembedDb();
    const report = await runReembed({ db, profileId: LAW });
    expect(report.reason).toBeNull();
    expect(report.status).toBe('completed');
    expect(law.documents).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it('fails a voyage-law-2 run whose provider echoes another model', async () => {
    const swapped = fakeVoyage('voyage-law-2', 'voyage-4-large');
    setEmbeddingProvidersForTests({ voyage: guardDefault().provider, 'voyage:voyage-law-2': swapped.provider });
    const { db, writes } = reembedDb();
    const report = await runReembed({ db, profileId: LAW });
    expect(report.status).toBe('failed');
    expect(report.reason).toBe('embedding_profile_mismatch');
    expect(writes).toHaveLength(0);
  });
});
