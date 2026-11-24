import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { compressChunks } from '@/lib/rag/context/compress';
import { countContextTokens } from '@/lib/rag/context/budget';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import type { RerankSpan } from '@/lib/rag/rerank/types';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages, type ContextStagesInput } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';

vi.mock('@/lib/rag/context/compress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/context/compress')>();
  return { ...actual, compressChunks: vi.fn(actual.compressChunks) };
});

const scope = mintScope('single', null, null);

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...over });
}

interface Spec {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content?: string;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
}

function fusedList(specs: Spec[]): FusedHit[] {
  return specs.map((spec, index) => {
    const rank = index + 1;
    return {
      hit: hit(spec.chunkId, {
        rank,
        documentId: spec.documentId,
        parentId: spec.parentId ?? null,
        chunkIndex: spec.chunkIndex,
        content: spec.content ?? `body of ${spec.chunkId}`,
        similarity: 0.9 - rank * 0.01,
        metadata: spec.metadata ?? {},
        document: { filename: spec.filename, createdAt: null, metadata: {}, contentPreview: '' },
      }),
      score: 1 / (60 + rank),
      ranks: { 'dense:0': rank },
    };
  });
}

const SIX: Spec[] = [
  { chunkId: 'a-3', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 3 },
  { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1 },
  { chunkId: 'a-4', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 4 },
  { chunkId: 'c-1', documentId: 'doc-c', filename: 'gamma.pdf', chunkIndex: 1 },
  { chunkId: 'b-7', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 7 },
  { chunkId: 'd-1', documentId: 'doc-d', filename: 'delta.pdf', chunkIndex: 1 },
];

function run(
  specs: Spec[],
  over: Record<string, string> = {},
  extra: Partial<ContextStagesInput> = {},
  profile: Profile = 'chat',
) {
  const cfg = config(over);
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const params = { ...effectiveRetrievalParams(profile, cfg, null), final_top_k: 20 };
  const promise = runContextStages({
    input: { scope, query: 'alpha beta gamma delta', profile, signal: new AbortController().signal },
    config: cfg,
    profile,
    params,
    fusedHits: fusedList(specs),
    referenced: null,
    signal: new AbortController().signal,
    collector,
    ...extra,
  });
  return { promise, collector };
}

function docOrder(context: string, names: string[]): string[] {
  return names
    .map((name) => ({ name, at: context.indexOf(`--- Document: ${name}`) }))
    .filter((row) => row.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((row) => row.name);
}

function stageCounts(collector: ReturnType<typeof createTraceCollector>, name: string) {
  return collector.stages().find((row) => row.name === name);
}

describe('runContextStages assemble (D-15)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  it('orders document groups best-at-edges when RAG_CONTEXT_EDGE_ORDER is on', async () => {
    const { promise } = run(SIX, { RAG_CONTEXT_EDGE_ORDER: 'true' });
    const { assembly } = await promise;
    expect(docOrder(assembly!.context, ['alpha.pdf', 'beta.pdf', 'gamma.pdf', 'delta.pdf'])).toEqual([
      'alpha.pdf',
      'gamma.pdf',
      'delta.pdf',
      'beta.pdf',
    ]);
  });

  it('orders document groups by rank when the switch is off', async () => {
    const { promise } = run(SIX);
    const { assembly } = await promise;
    expect(docOrder(assembly!.context, ['alpha.pdf', 'beta.pdf', 'gamma.pdf', 'delta.pdf'])).toEqual([
      'alpha.pdf',
      'beta.pdf',
      'gamma.pdf',
      'delta.pdf',
    ]);
  });

  it('renders adjacent chunks of one document under one header that counts both', async () => {
    const { promise } = run(SIX);
    const { assembly } = await promise;
    const context = assembly!.context;
    expect(context.match(/--- Document: alpha\.pdf/g)).toHaveLength(1);
    expect(context).toContain('--- Document: alpha.pdf (2 relevant chunks) ---');
    expect(context).toContain('body of a-3');
    expect(context).toContain('body of a-4');
  });

  it('drops the lowest-ranked chunks first under a small budget and keeps rank 1', async () => {
    const words = (label: string) => `${label} ${'filler '.repeat(110)}`.trim();
    const specs: Spec[] = SIX.map((spec) => ({ ...spec, content: words(spec.chunkId) }));
    const { promise, collector } = run(specs, { RAG_CONTEXT_TOKEN_BUDGET: '300' });
    const { assembly } = await promise;
    const keptIds = assembly!.kept.map((row) => row.chunk_id);
    expect(keptIds).toContain('a-3');
    expect(keptIds).not.toContain('d-1');
    expect(keptIds.length).toBeLessThan(SIX.length);
    const record = stageCounts(collector, 'assemble');
    expect(record?.counts?.budget_tokens).toBe(300);
    expect(record?.counts?.selected).toBe(keptIds.length);
    expect(record?.counts?.used_tokens).toBeLessThanOrEqual(300);
    expect(record?.counts?.used_tokens).toBeGreaterThan(0);
  });

  it('keeps the true candidate rank in kept after the budget drops a chunk', async () => {
    const words = (label: string) => `${label} ${'filler '.repeat(110)}`.trim();
    const specs: Spec[] = SIX.map((spec) => ({ ...spec, content: words(spec.chunkId) }));
    const { promise } = run(specs, { RAG_CONTEXT_TOKEN_BUDGET: '300' });
    const { assembly } = await promise;
    for (const row of assembly!.kept) {
      const index = SIX.findIndex((spec) => spec.chunkId === row.chunk_id);
      expect(row.rank).toBe(index + 1);
    }
  });

  it('truncates rank 1 when it alone is over budget', async () => {
    const specs: Spec[] = [{ ...SIX[0]!, content: `lead ${'filler '.repeat(400)}`.trim() }, SIX[1]!];
    const { promise } = run(specs, { RAG_CONTEXT_TOKEN_BUDGET: '120' });
    const { assembly } = await promise;
    expect(assembly!.kept.map((row) => row.chunk_id)).toEqual(['a-3']);
    expect(countContextTokens(assembly!.context)).toBeLessThanOrEqual(160);
  });

  it('lists an image document without spending budget', async () => {
    const words = (label: string) => `${label} ${'filler '.repeat(110)}`.trim();
    const specs: Spec[] = [
      { chunkId: 'img-1', documentId: 'doc-img', filename: 'chart.png', chunkIndex: 0, content: 'a chart', metadata: { image_url: 'https://example.test/chart.png' } },
      { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, content: words('a-1') },
      { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, content: words('b-1') },
    ];
    const { promise, collector } = run(specs, { RAG_CONTEXT_TOKEN_BUDGET: '150' });
    const { assembly } = await promise;
    expect(assembly!.usedDocuments.map((doc) => doc.id)).toContain('doc-img');
    expect(assembly!.sourceImages.map((image) => image.url)).toContain('https://example.test/chart.png');
    expect(assembly!.kept.map((row) => row.chunk_id)).toContain('a-1');
    const withoutImage = run(specs.slice(1), { RAG_CONTEXT_TOKEN_BUDGET: '150' });
    await withoutImage.promise;
    expect(stageCounts(collector, 'assemble')?.counts?.used_tokens).toBe(
      stageCounts(withoutImage.collector, 'assemble')?.counts?.used_tokens,
    );
  });

  it('marks kept_by rerank when the rerank stage ran and fused otherwise', async () => {
    const fusedOnly = await run(SIX).promise;
    expect(new Set(fusedOnly.assembly!.kept.map((row) => row.kept_by))).toEqual(new Set(['fused']));
    const reranked = await run(SIX, {}, { rerank: { ran: true } }).promise;
    expect(new Set(reranked.assembly!.kept.map((row) => row.kept_by))).toEqual(new Set(['rerank']));
  });

  it('records groups on the assemble stage', async () => {
    const { promise, collector } = run(SIX);
    await promise;
    const counts = stageCounts(collector, 'assemble')?.counts;
    expect(counts?.groups).toBe(4);
    expect(counts?.selected).toBe(6);
    expect(counts?.budget_tokens).toBe(6000);
  });

  it('uses the voice budget of 2000 tokens', async () => {
    const { promise, collector } = run(SIX, {}, {}, 'voice');
    await promise;
    expect(stageCounts(collector, 'assemble')?.counts?.budget_tokens).toBe(2000);
  });

  it('equals the rank-order rendering of the tracer with every v2 switch off', async () => {
    const specs = fusedList(SIX);
    const documents = new Map<string, AssemblyDocumentRow>();
    for (const row of specs) {
      documents.set(row.hit.documentId, {
        id: row.hit.documentId,
        filename: row.hit.document.filename,
        created_at: row.hit.document.createdAt,
        content: null,
        metadata: row.hit.document.metadata,
      });
    }
    const candidates = specs.map((row) => ({
      chunk_id: row.hit.chunkId,
      document_id: row.hit.documentId,
      content: row.hit.content,
      similarity: row.hit.similarity ?? 0,
      metadata: row.hit.metadata,
    }));
    const baseline: AssembleInput = {
      queryText: 'alpha beta gamma delta',
      candidates,
      documents,
      chunkMetadata: new Map(specs.map((row) => [row.hit.chunkId, row.hit.metadata])),
      referenced: null,
      isGPTModel: false,
      ragMode: 'strict',
      webSearchEnabled: false,
      applyRelevanceFilter: false,
      keptByOverride: 'fused',
    };
    const expected = assembleContext(baseline);
    const { assembly } = await run(SIX).promise;
    expect(assembly!.context).toBe(expected.context);
    expect(assembly!.usedDocuments).toEqual(expected.usedDocuments);
    expect(assembly!.kept).toEqual(expected.kept);
  });
});

function sentenceBlock(label: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${label} sentence ${index + 1} explains the quarterly widget pricing policy in some detail.`,
  ).join(' ');
}

describe('runContextStages compress (D-16)', () => {
  const long = sentenceBlock('First', 40);
  const specs: Spec[] = [
    { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, content: long },
    { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, content: 'short body' },
  ];

  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(compressChunks).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  it('is recorded disabled and leaves the context byte-identical when the switch is off', async () => {
    const off = run(specs);
    const out = await off.promise;
    expect(stageCounts(off.collector, 'compress')?.status).toBe('disabled');
    expect(compressChunks).not.toHaveBeenCalled();
    expect(out.assembly!.context).toContain(long);
  });

  it('replaces a candidate text with its provider spans only', async () => {
    const needle = 'First sentence 7 explains the quarterly widget pricing policy in some detail.';
    const start = [...long].length - [...long.slice(long.indexOf(needle))].length;
    const spans: RerankSpan[] = [{ start, end: start + [...needle].length, score: 0.9 }];
    const { promise, collector } = run(
      specs,
      { RAG_CONTEXT_COMPRESSION: 'true' },
      { rerank: { ran: true, spansByChunk: new Map([['a-1', spans]]), prefixLengthByChunk: new Map([['a-1', 0]]) } },
    );
    const { assembly } = await promise;
    expect(assembly!.context).toContain(needle);
    expect(assembly!.context).not.toContain('First sentence 8 explains');
    expect(assembly!.context).toContain('short body');
    const record = stageCounts(collector, 'compress');
    expect(record?.status).toBe('ok');
    expect(record?.counts?.compressed).toBe(1);
    expect(record?.counts?.saved_tokens).toBeGreaterThan(0);
  });

  it('keeps fewer tokens with local scoring and only verbatim sentences when no spans exist', async () => {
    const { promise } = run(specs, { RAG_CONTEXT_COMPRESSION: 'true' });
    const { assembly } = await promise;
    const rendered = assembly!.context;
    expect(countContextTokens(rendered)).toBeLessThan(countContextTokens(long));
    const sentences = long.match(/First sentence \d+ explains the quarterly widget pricing policy in some detail\./g) ?? [];
    const present = sentences.filter((sentence) => rendered.includes(sentence));
    expect(present.length).toBeGreaterThan(0);
    expect(present.length).toBeLessThan(sentences.length);
    const stripped = rendered.replace(/First sentence \d+ explains the quarterly widget pricing policy in some detail\./g, '');
    expect(stripped).not.toContain('First sentence');
  });

  it('keeps the same document group order after compression', async () => {
    const many: Spec[] = [
      { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, content: long },
      { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, content: sentenceBlock('Second', 40) },
      { chunkId: 'c-1', documentId: 'doc-c', filename: 'gamma.pdf', chunkIndex: 1, content: sentenceBlock('Third', 40) },
      { chunkId: 'd-1', documentId: 'doc-d', filename: 'delta.pdf', chunkIndex: 1, content: 'tiny' },
    ];
    const edge = { RAG_CONTEXT_EDGE_ORDER: 'true' };
    const plain = await run(many, edge).promise;
    const compressed = await run(many, { ...edge, RAG_CONTEXT_COMPRESSION: 'true' }).promise;
    const names = ['alpha.pdf', 'beta.pdf', 'gamma.pdf', 'delta.pdf'];
    expect(docOrder(compressed.assembly!.context, names)).toEqual(docOrder(plain.assembly!.context, names));
  });

  it('does not run for the voice profile and records disabled', async () => {
    const { promise, collector } = run(specs, { RAG_CONTEXT_COMPRESSION: 'true' }, {}, 'voice');
    const { assembly } = await promise;
    expect(stageCounts(collector, 'compress')?.status).toBe('disabled');
    expect(compressChunks).not.toHaveBeenCalled();
    expect(assembly!.context).toContain(long);
  });

  it('skips a failing compression as degraded and uses the uncompressed context', async () => {
    vi.mocked(compressChunks).mockImplementationOnce(() => {
      throw new Error('compression failed');
    });
    const { promise, collector } = run(specs, { RAG_CONTEXT_COMPRESSION: 'true' });
    const { assembly } = await promise;
    expect(stageCounts(collector, 'compress')?.status).toBe('skipped');
    expect(assembly!.context).toContain(long);
  });
});

const SINGLE_KEY = 's:default';

interface ParentFixture {
  id: string;
  documentId: string;
  content: string;
  tenantKey?: string;
}

function parentsAdmin(parents: ParentFixture[], options: { error?: { message: string; code?: string } } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      calls.push({ fn, args });
      const asked = new Set((args.p_parent_ids as string[] | undefined) ?? []);
      const request: RpcRequest = {
        abortSignal: () => request,
        then(onFulfilled, onRejected) {
          const response: RpcResponse = options.error
            ? { data: null, error: options.error }
            : {
                data: parents
                  .filter((parent) => asked.has(parent.id))
                  .map((parent) => ({
                    id: parent.id,
                    document_id: parent.documentId,
                    tenant_key: parent.tenantKey ?? SINGLE_KEY,
                    version: 1,
                    is_current: true,
                    chunking_profile_id: 'legacy',
                    section_path: ['Section'],
                    content: parent.content,
                    token_count: 20,
                    parent_index: 0,
                  })),
                error: null,
              };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('runContextStages expand_parents (D-20)', () => {
  const PARENT_A = 'parent-alpha';
  const PARENT_B = 'parent-beta';
  const parentSpecs: Spec[] = [
    { chunkId: 'a-3', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 3, parentId: PARENT_A },
    { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, parentId: PARENT_B },
    { chunkId: 'a-4', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 4, parentId: PARENT_A },
  ];
  const parents: ParentFixture[] = [
    { id: PARENT_A, documentId: 'doc-a', content: 'ALPHA PARENT: the full alpha section with its surrounding detail.' },
    { id: PARENT_B, documentId: 'doc-b', content: 'BETA PARENT: the full beta section with its surrounding detail.' },
  ];
  const on = { RAG_PARENT_CHILD: 'true' };

  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagDepsForTests();
    resetRagConfigForTests();
  });

  it('is recorded disabled, makes no call and leaves the context byte-identical when the switch is off', async () => {
    const { client, calls } = parentsAdmin(parents);
    setRagDepsForTests({ adminClient: () => client as never });
    const withParentIds = run(parentSpecs);
    const out = await withParentIds.promise;
    const withoutParentIds = await run(parentSpecs.map((spec) => ({ ...spec, parentId: null }))).promise;

    expect(stageCounts(withParentIds.collector, 'expand_parents')?.status).toBe('disabled');
    expect(calls).toHaveLength(0);
    expect(out.assembly!.context).toBe(withoutParentIds.assembly!.context);
    expect(out.assembly!.context).toContain('body of a-3');
  });

  it('renders each parent once under its document header instead of its children', async () => {
    const { client, calls } = parentsAdmin(parents);
    setRagDepsForTests({ adminClient: () => client as never });
    const { promise, collector } = run(parentSpecs, on);
    const { assembly, candidates } = await promise;
    const context = assembly!.context;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('rag_fetch_parents');
    expect(calls[0]?.args).toEqual({ p_tenant_key: SINGLE_KEY, p_parent_ids: [PARENT_A, PARENT_B] });
    expect(occurrences(context, parents[0]!.content)).toBe(1);
    expect(occurrences(context, parents[1]!.content)).toBe(1);
    expect(context).not.toContain('body of a-3');
    expect(context).not.toContain('body of a-4');
    expect(context.indexOf('--- Document: alpha.pdf')).toBeLessThan(context.indexOf(parents[0]!.content));
    expect(context.indexOf('--- Document: beta.pdf')).toBeLessThan(context.indexOf(parents[1]!.content));
    expect(context).toContain('--- Document: alpha.pdf (1 relevant chunks) ---');
    expect(candidates.map((candidate) => candidate.chunk_id)).toEqual(['a-3', 'b-1', 'a-4']);

    const record = stageCounts(collector, 'expand_parents');
    expect(record?.status).toBe('ok');
    expect(record?.candidates_in).toBe(3);
    expect(record?.counts).toMatchObject({ parents_fetched: 2, parents_used: 2 });
    const expandAt = collector.stages().findIndex((row) => row.name === 'expand_parents');
    const assembleAt = collector.stages().findIndex((row) => row.name === 'assemble');
    expect(expandAt).toBeGreaterThanOrEqual(0);
    expect(expandAt).toBeLessThan(assembleAt);
  });

  it('keeps the child where the parent does not fit the token budget', async () => {
    const big = Array.from({ length: 400 }, (_, index) => `bigword${index}`).join(' ');
    const bigParents: ParentFixture[] = [
      { id: PARENT_A, documentId: 'doc-a', content: 'ALPHA PARENT: short section.' },
      { id: PARENT_B, documentId: 'doc-b', content: big },
    ];
    const { client } = parentsAdmin(bigParents);
    setRagDepsForTests({ adminClient: () => client as never });
    const { promise, collector } = run(parentSpecs, { ...on, RAG_CONTEXT_TOKEN_BUDGET: '120' });
    const { assembly } = await promise;
    const context = assembly!.context;

    expect(context).toContain('ALPHA PARENT: short section.');
    expect(context).toContain('body of b-1');
    expect(context).not.toContain('bigword0');
    expect(stageCounts(collector, 'expand_parents')?.counts).toMatchObject({ parents_fetched: 2, parents_used: 1 });
  });

  it('uses the children when the fetch fails and records the stage skipped', async () => {
    const { client } = parentsAdmin(parents, { error: { message: 'down', code: '57014' } });
    setRagDepsForTests({ adminClient: () => client as never });
    const off = await run(parentSpecs).promise;
    const { promise, collector } = run(parentSpecs, on);
    const { assembly } = await promise;

    expect(stageCounts(collector, 'expand_parents')?.status).toBe('skipped');
    expect(assembly!.context).toBe(off.assembly!.context);
  });

  it('uses the children when there is no admin client', async () => {
    setRagDepsForTests({ adminClient: () => null });
    const { promise, collector } = run(parentSpecs, on);
    const { assembly } = await promise;
    expect(stageCounts(collector, 'expand_parents')?.status).toBe('skipped');
    expect(assembly!.context).toContain('body of a-3');
  });

  it('never shows a parent of another tenant: the children stay', async () => {
    const foreign = parents.map((parent) => ({ ...parent, tenantKey: 'u:00000000-0000-4000-8000-0000000000b1' }));
    const { client, calls } = parentsAdmin(foreign);
    setRagDepsForTests({ adminClient: () => client as never });
    const { promise } = run(parentSpecs, on);
    const { assembly } = await promise;
    expect(calls).toHaveLength(1);
    expect(assembly!.context).not.toContain('PARENT:');
    expect(assembly!.context).toContain('body of a-3');
    expect(assembly!.context).toContain('body of b-1');
  });

  it('records candidates_in 0 and makes no call when nothing survived', async () => {
    const { client, calls } = parentsAdmin(parents);
    setRagDepsForTests({ adminClient: () => client as never });
    const { promise, collector } = run([], on);
    await promise;
    const record = stageCounts(collector, 'expand_parents');
    expect(record?.status).toBe('ok');
    expect(record?.candidates_in).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('leaves a parent block uncompressed while an ordinary chunk of the same size is compressed', async () => {
    const longParent = sentenceBlock('Parent', 40);
    const { client } = parentsAdmin([{ id: PARENT_A, documentId: 'doc-a', content: longParent }]);
    setRagDepsForTests({ adminClient: () => client as never });
    const spec: Spec = { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, parentId: PARENT_A, content: 'short child' };

    const expanded = await run([spec], { ...on, RAG_CONTEXT_COMPRESSION: 'true' }).promise;
    expect(expanded.assembly!.context).toContain(longParent);

    const control = await run([{ ...spec, parentId: null, content: longParent }], { RAG_CONTEXT_COMPRESSION: 'true' }).promise;
    expect(control.assembly!.context).not.toContain(longParent);
  });
});
