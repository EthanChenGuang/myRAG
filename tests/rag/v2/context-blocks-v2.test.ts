import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { CitationLabeler, ContextBlock, RunRetrievalInput } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

const scope = mintScope('single', null, null);
const SINGLE_KEY = 's:default';

interface Spec {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content?: string;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
}

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...over });
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

function run(specs: Spec[], over: Record<string, string> = {}, labeler?: CitationLabeler) {
  const cfg = config(over);
  const collector = createTraceCollector({ profile: 'chat', tenantKey: SINGLE_KEY });
  const params = { ...effectiveRetrievalParams('chat', cfg, null), final_top_k: 20 };
  const input: RunRetrievalInput = {
    scope,
    query: 'alpha beta gamma delta',
    profile: 'chat',
    signal: new AbortController().signal,
    ...(labeler ? { citationLabeler: labeler } : {}),
  };
  const promise = runContextStages({
    input,
    config: cfg,
    profile: 'chat',
    params,
    fusedHits: fusedList(specs),
    referenced: null,
    signal: new AbortController().signal,
    collector,
  });
  return { promise, collector };
}

function blocksOf(assembly: unknown): ContextBlock[] {
  const blocks = (assembly as { blocks?: ContextBlock[] } | null)?.blocks;
  expect(Array.isArray(blocks)).toBe(true);
  return blocks ?? [];
}

function expectInOrder(context: string, parts: string[]): void {
  let from = 0;
  for (const part of parts) {
    const at = context.indexOf(part, from);
    expect(at, `missing or out of order: ${JSON.stringify(part.slice(0, 40))}`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

function sentenceBlock(label: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${label} sentence ${index + 1} explains the quarterly widget pricing policy in some detail.`,
  ).join(' ');
}

const SIX: Spec[] = [
  { chunkId: 'a-3', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 3 },
  { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1 },
  { chunkId: 'a-4', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 4 },
  { chunkId: 'c-1', documentId: 'doc-c', filename: 'gamma.pdf', chunkIndex: 1 },
  { chunkId: 'b-7', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 7 },
  { chunkId: 'd-1', documentId: 'doc-d', filename: 'delta.pdf', chunkIndex: 1 },
];

const aliasLabeler: CitationLabeler = (block, ordinal) => ({
  alias: `S${ordinal}`,
  header: `[S${ordinal}] ${block.title}`,
  text: block.text,
});

function stage(collector: ReturnType<typeof createTraceCollector>, name: string) {
  const record = collector.stages().find((row) => row.name === name);
  return record ? { status: record.status, counts: record.counts, candidates_in: record.candidates_in, candidates_out: record.candidates_out } : null;
}

describe('v2 context blocks (D-02)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagDepsForTests();
    resetRagConfigForTests();
  });

  it('follows the edge-ordered group order of the rendered context', async () => {
    const { assembly } = await run(SIX, { RAG_CONTEXT_EDGE_ORDER: 'true' }).promise;
    const blocks = blocksOf(assembly);
    expect(blocks.map((block) => block.chunkIds)).toEqual([['a-3', 'a-4'], ['c-1'], ['d-1'], ['b-1'], ['b-7']]);
    expect(blocks.every((block) => block.alias === null)).toBe(true);
    expectInOrder(
      assembly!.context,
      blocks.map((block) => block.text),
    );
  });

  it('gives two adjacent chunks merged into one run one block with both chunk ids', async () => {
    const { assembly } = await run(SIX).promise;
    const merged = blocksOf(assembly).find((block) => block.chunkIds.includes('a-3'));
    expect(merged).toMatchObject({ documentId: 'doc-a', documentName: 'alpha.pdf', chunkIds: ['a-3', 'a-4'], isImage: false });
    expect(merged?.text).toBe('body of a-3\n\nbody of a-4');
    expect(assembly!.context).toContain(merged!.text);
  });

  it('lists the child chunk ids of a parent-expanded block', async () => {
    const parents = [
      { id: 'parent-alpha', documentId: 'doc-a', content: 'ALPHA PARENT: the full alpha section with its surrounding detail.' },
      { id: 'parent-beta', documentId: 'doc-b', content: 'BETA PARENT: the full beta section with its surrounding detail.' },
    ];
    const client: RpcClient = {
      rpc(_fn: string, args: Record<string, unknown>): RpcRequest {
        const asked = new Set((args.p_parent_ids as string[] | undefined) ?? []);
        const request: RpcRequest = {
          abortSignal: () => request,
          then(onFulfilled, onRejected) {
            const response: RpcResponse = {
              data: parents
                .filter((parent) => asked.has(parent.id))
                .map((parent) => ({
                  id: parent.id,
                  document_id: parent.documentId,
                  tenant_key: SINGLE_KEY,
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
    setRagDepsForTests({ adminClient: () => client as never });
    const specs: Spec[] = [
      { chunkId: 'a-3', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 3, parentId: 'parent-alpha' },
      { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, parentId: 'parent-beta' },
      { chunkId: 'a-4', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 4, parentId: 'parent-alpha' },
    ];
    const { assembly } = await run(specs, { RAG_PARENT_CHILD: 'true' }).promise;
    const blocks = blocksOf(assembly);
    expect(blocks.map((block) => [block.chunkIds, block.text])).toEqual([
      [['a-3', 'a-4'], parents[0]!.content],
      [['b-1'], parents[1]!.content],
    ]);
  });

  it('uses the compressed text as rendered when compression is on', async () => {
    const long = sentenceBlock('First', 40);
    const specs: Spec[] = [
      { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, content: long },
      { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, content: 'short body' },
    ];
    const { assembly } = await run(specs, { RAG_CONTEXT_COMPRESSION: 'true' }).promise;
    const first = blocksOf(assembly)[0]!;
    expect(first.chunkIds).toEqual(['a-1']);
    expect(first.text.length).toBeLessThan(long.length);
    expect(assembly!.context).toContain(first.text);

    const seen: string[] = [];
    const labelled = await run(specs, { RAG_CONTEXT_COMPRESSION: 'true' }, (block, ordinal) => {
      seen.push(block.text);
      return aliasLabeler(block, ordinal);
    }).promise;
    expect(seen[0]).toBe(first.text);
    expect(labelled.assembly!.context).toContain(`[S1] alpha.pdf\n${first.text}`);
  });

  it('marks an image chunk as an image block with no alias and never labels it', async () => {
    const specs: Spec[] = [
      { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1 },
      { chunkId: 'a-2', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 2, metadata: { image_url: 'https://cdn.test/fig.png' } },
    ];
    const labelled: number[] = [];
    const { assembly } = await run(specs, {}, (block, ordinal) => {
      labelled.push(ordinal);
      expect(block.isImage).toBe(false);
      return aliasLabeler(block, ordinal);
    }).promise;
    expect(blocksOf(assembly).map((block) => [block.chunkIds, block.isImage, block.alias])).toEqual([
      [['a-1'], false, 'S1'],
      [['a-2'], true, null],
    ]);
    expect(labelled).toEqual([1]);
  });

  it('labels after the last context step in final render order and leaves the stage records unchanged', async () => {
    const over = { RAG_CONTEXT_EDGE_ORDER: 'true', RAG_CONTEXT_COMPRESSION: 'true' };
    const plain = run(SIX, over);
    const plainOut = await plain.promise;
    const labelled = run(SIX, over, aliasLabeler);
    const labelledOut = await labelled.promise;

    for (const name of ['assemble', 'compress', 'expand_parents']) {
      expect(stage(labelled.collector, name)).toEqual(stage(plain.collector, name));
    }
    expect(labelled.collector.stages().map((row) => row.name)).toEqual(plain.collector.stages().map((row) => row.name));

    const blocks = blocksOf(labelledOut.assembly);
    expect(blocks.map((block) => block.alias)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(blocks.map((block) => block.chunkIds)).toEqual(blocksOf(plainOut.assembly).map((block) => block.chunkIds));
    expectInOrder(labelledOut.assembly!.context, [
      '[S1] alpha.pdf\nbody of a-3\n\nbody of a-4',
      '[S2] gamma.pdf\nbody of c-1',
      '[S3] delta.pdf\nbody of d-1',
      '[S4] beta.pdf\nbody of b-1',
      '[S5] beta.pdf\nbody of b-7',
    ]);
    expect(plainOut.assembly!.context).not.toContain('[S1]');
    expect(labelledOut.assembly!.kept).toEqual(plainOut.assembly!.kept);
    expect(labelledOut.assembly!.usedDocuments).toEqual(plainOut.assembly!.usedDocuments);
  });
});
