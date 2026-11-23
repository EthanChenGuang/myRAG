import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { formatImageContext, formatVideoContext, type MediaContextRow } from '@/lib/rag/context/media';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';
import { fakeEmbedder, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

function row(document_id: string, content: string, similarity: number, chunk = `${document_id}-${similarity}`) {
  return { chunk_id: chunk, document_id, content, similarity, metadata: null };
}

const SEEDS: Record<string, ReturnType<typeof row>[]> = {
  single: [
    row('d1', 'alpha', 0.4),
    row('d1', 'beta', 0.9),
    row('d1', 'gamma', 0.7),
    row('d1', 'delta', 0.5),
    row('d1', 'epsilon', 0.8),
  ],
  several: [
    row('d1', '  Plan A costs 10  ', 0.9),
    row('d2', '', 0.8),
    row('d2', '   ', 0.7),
    row('d3', 'Plan C costs 30', 0.6),
    row('d1', 'Plan B costs 20', 0.5),
    row('d3', '', 0.4),
  ],
  long: [
    row('d1', 'x'.repeat(2500), 0.9),
    row('d1', 'y'.repeat(2500), 0.8),
    row('d2', 'z'.repeat(2500), 0.7),
  ],
  numericIds: [row('2', 'two', 0.5), row('1', 'one', 0.6), row('b', 'bee', 0.7), row('a', 'ay', 0.8)],
};

// Oracle: the inline loops of the old image route, copied verbatim.
function oldImageContext(similarChunks: any[]): string {
  let contextText = '';
  const chunksByDocument = similarChunks.reduce((acc: any, chunk: any) => {
    if (!acc[chunk.document_id]) {
      acc[chunk.document_id] = [];
    }
    acc[chunk.document_id].push(chunk);
    return acc;
  }, {});
  for (const chunks of Object.values(chunksByDocument)) {
    const sortedChunks = (chunks as any[])
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);
    contextText += sortedChunks
      .map((chunk) => chunk.content.trim())
      .filter((content) => content.length > 0)
      .join('\n---\n');
    contextText += '\n\n';
  }
  return contextText.slice(0, 4000);
}

// Oracle: the old video route's getDocumentContext join.
function oldVideoContext(chunks: Array<{ content: string }>): string {
  return chunks.map((chunk: { content: string }) => chunk.content).join(' ');
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('formatImageContext', () => {
  test.each(Object.keys(SEEDS))('matches the old inline result for the %s seed', (name) => {
    const expected = oldImageContext(clone(SEEDS[name]));
    expect(expected.length).toBeGreaterThan(0);
    expect(formatImageContext(clone(SEEDS[name]) as MediaContextRow[])).toBe(expected);
  });

  test('truncates to 4000 characters', () => {
    expect(formatImageContext(clone(SEEDS.long) as MediaContextRow[])).toHaveLength(4000);
  });

  test('no rows gives an empty string', () => {
    expect(formatImageContext([])).toBe('');
  });

  test('rows whose content is all empty still produce the separator text the old code produced', () => {
    const rows = [row('d1', '', 0.5)];
    expect(formatImageContext(clone(rows) as MediaContextRow[])).toBe(oldImageContext(clone(rows)));
    expect(formatImageContext(rows as MediaContextRow[])).not.toBe('');
  });
});

describe('formatVideoContext', () => {
  test.each(Object.keys(SEEDS))('matches the old inline result for the %s seed', (name) => {
    expect(formatVideoContext(clone(SEEDS[name]) as MediaContextRow[])).toBe(oldVideoContext(clone(SEEDS[name])));
  });

  test('no rows gives an empty string', () => {
    expect(formatVideoContext([])).toBe('');
  });
});

interface RecordedCall {
  fn: string;
  args: Record<string, unknown>;
}

function recordingClient(data: unknown[]): { client: RpcClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      calls.push({ fn, args });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) =>
          Promise.resolve<RpcResponse>({ data, error: null }).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

describe('media profile', () => {
  beforeEach(() => {
    uninstallDeps();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallDeps();
  });

  function run(scope: ReturnType<typeof mintScope> | null, mediaKind: 'image' | 'video') {
    return runRetrieval({
      scope,
      query: 'show our pricing',
      profile: 'media',
      options: { mediaKind },
      signal: new AbortController().signal,
    });
  }

  test('a single scope issues the single-tenant RPC with threshold 0.3 and count 10 on the admin client', async () => {
    const admin = recordingClient(SEEDS.several);
    const anon = recordingClient([]);
    installDeps({ adminClient: () => admin.client as never, anonClient: () => anon.client, embedder: fakeEmbedder().embedder });
    const result = await run(mintScope('single', null, null), 'image');
    expect(admin.calls).toEqual([
      { fn: 'match_document_chunks', args: { query_embedding: [0.1, 0.2, 0.3], match_count: 10, similarity_threshold: 0.3 } },
    ]);
    expect(anon.calls).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.context).toBe(oldImageContext(clone(SEEDS.several)));
    expect(result.stages.map((stage) => stage.name)).toEqual(['embed', 'search', 'assemble']);
  });

  test('the video kind uses the video formatter', async () => {
    const admin = recordingClient(SEEDS.several);
    installDeps({ adminClient: () => admin.client as never, embedder: fakeEmbedder().embedder });
    const result = await run(mintScope('single', null, null), 'video');
    expect(result.context).toBe(oldVideoContext(clone(SEEDS.several)));
  });

  test('a personal scope issues the workspace RPC with a null organization and the user id', async () => {
    const admin = recordingClient([]);
    installDeps({ adminClient: () => admin.client as never, embedder: fakeEmbedder().embedder });
    const result = await run(mintScope('personal', USER_A, null), 'image');
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0].fn).toBe('match_documents_by_workspace');
    expect(admin.calls[0].args).toMatchObject({
      p_org_id: null,
      p_user_id: USER_A,
      p_match_count: 10,
      p_min_similarity: 0.3,
    });
    expect(result.status).toBe('empty');
    expect(result.context).toBe('');
  });

  test('an org scope passes the organization to the workspace RPC', async () => {
    const admin = recordingClient([]);
    installDeps({ adminClient: () => admin.client as never, embedder: fakeEmbedder().embedder });
    await run(mintScope('org', USER_A, ORG_O), 'video');
    expect(admin.calls[0].args).toMatchObject({ p_org_id: ORG_O, p_user_id: USER_A });
  });

  test('no scope returns empty with no embedding and no RPC', async () => {
    const admin = recordingClient(SEEDS.single);
    const embed = fakeEmbedder();
    installDeps({ adminClient: () => admin.client as never, embedder: embed.embedder });
    const result = await run(null, 'image');
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_tenant');
    expect(admin.calls).toEqual([]);
    expect(embed.signals).toEqual([]);
  });

  test('per-request stage overrides are ignored for the media profile', async () => {
    const admin = recordingClient(SEEDS.several);
    installDeps({ adminClient: () => admin.client as never, embedder: fakeEmbedder().embedder });
    const result = await runRetrieval({
      scope: mintScope('single', null, null),
      query: 'show our pricing',
      profile: 'media',
      options: { mediaKind: 'image' },
      signal: new AbortController().signal,
      stageOverrides: { disabledStages: ['assemble'], timeouts: { embed: 1 } },
    });
    expect(result.status).toBe('ok');
    expect(result.stages.find((stage) => stage.name === 'assemble')).toMatchObject({ status: 'ok' });
  });

  test('an embedding failure is an error result with empty context', async () => {
    const admin = recordingClient(SEEDS.single);
    installDeps({ adminClient: () => admin.client as never, embedder: fakeEmbedder({ fail: new Error('boom') }).embedder });
    const result = await run(mintScope('single', null, null), 'image');
    expect(result.status).toBe('error');
    expect(result.context).toBe('');
    expect(admin.calls).toEqual([]);
  });
});
