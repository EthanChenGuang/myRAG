import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { countContextTokens } from '@/lib/rag/context/budget';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages, type ContextStagesInput } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

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
}

function fusedList(specs: Spec[]): FusedHit[] {
  return specs.map((spec, index) => {
    const rank = index + 1;
    return {
      hit: hit(spec.chunkId, {
        rank,
        documentId: spec.documentId,
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
