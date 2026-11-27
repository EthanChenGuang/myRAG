import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests } from '@/lib/rag/deps';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { ContextBlock, QueryVariant, RunRetrievalInput } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

const scope = mintScope('single', null, null);

interface Spec {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  ranks: Record<string, number>;
}

function fusedList(specs: Spec[]): FusedHit[] {
  return specs.map((spec, index) => {
    const rank = index + 1;
    return {
      hit: hit(spec.chunkId, {
        rank,
        documentId: spec.documentId,
        parentId: null,
        chunkIndex: spec.chunkIndex,
        content: `body of ${spec.chunkId}`,
        similarity: 0.9 - rank * 0.01,
        metadata: {},
        document: { filename: spec.filename, createdAt: null, metadata: {}, contentPreview: '' },
      }),
      score: 1 / (60 + rank),
      ranks: spec.ranks,
    };
  });
}

async function blocks(specs: Spec[], variants?: QueryVariant[]): Promise<ContextBlock[]> {
  resetRagConfigForTests();
  const cfg = loadRagConfig({ RAG_PIPELINE: 'v2' });
  const input: RunRetrievalInput = { scope, query: 'first part and second part', profile: 'chat', signal: new AbortController().signal };
  const out = await runContextStages({
    input,
    config: cfg,
    access: { mode: 'off' },
    profile: 'chat',
    params: { ...effectiveRetrievalParams('chat', cfg, null), final_top_k: 20 },
    fusedHits: fusedList(specs),
    referenced: null,
    signal: new AbortController().signal,
    collector: createTraceCollector({ profile: 'chat', tenantKey: 's:default' }),
    ...(variants ? { variants } : {}),
  });
  return (out.assembly as { blocks: ContextBlock[] } | null)?.blocks ?? [];
}

const original: QueryVariant = { text: 'first part and second part', language: 'en', kind: 'original' };
const sub = (index: number): QueryVariant => ({ text: `part ${index}`, language: 'en', kind: 'sub_question', subQuestionIndex: index });

function byDocument(list: ContextBlock[]): Record<string, number[] | undefined> {
  return Object.fromEntries(list.map((block) => [block.documentId, block.subQuestionIndexes]));
}

describe('block provenance (06.2 D-11)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagDepsForTests();
    resetRagConfigForTests();
  });

  it('gives a block retrieved by the variants of sub-questions 0 and 1 the indexes [0, 1]', async () => {
    const list = await blocks(
      [
        { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, ranks: { 'lexical:2': 1, 'dense:1': 2, 'dense:0': 3 } },
        { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, ranks: { 'dense:2': 1 } },
      ],
      [original, sub(0), sub(1)],
    );
    expect(byDocument(list)).toEqual({ 'doc-a': [0, 1], 'doc-b': [1] });
  });

  it('gives blocks from exact_id, term:0 or translation lists only an empty list', async () => {
    const list = await blocks(
      [
        { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, ranks: { exact_id: 1 } },
        { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, ranks: { 'term:0': 1 } },
        { chunkId: 'c-1', documentId: 'doc-c', filename: 'gamma.pdf', chunkIndex: 1, ranks: { 'translation:dense:0': 1 } },
        { chunkId: 'd-1', documentId: 'doc-d', filename: 'delta.pdf', chunkIndex: 1, ranks: { 'dense:0': 1 } },
      ],
      [original, sub(0)],
    );
    expect(byDocument(list)).toEqual({ 'doc-a': [], 'doc-b': [], 'doc-c': [], 'doc-d': [] });
  });

  it('maps through the searched variant list when a cap dropped a sub-question before search', async () => {
    // The plan had sub-questions 0..3; sub-question 2 was capped away, so variant index 3 is sub-question 3.
    const list = await blocks(
      [
        { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, ranks: { 'dense:3': 1 } },
        { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, ranks: { 'lexical:2': 1 } },
      ],
      [original, sub(0), sub(1), sub(3)],
    );
    expect(byDocument(list)).toEqual({ 'doc-a': [3], 'doc-b': [1] });
  });

  it('sets no indexes and leaves the context unchanged without sub-question variants', async () => {
    const specs: Spec[] = [
      { chunkId: 'a-1', documentId: 'doc-a', filename: 'alpha.pdf', chunkIndex: 1, ranks: { 'dense:0': 1, 'dense:1': 2 } },
      { chunkId: 'b-1', documentId: 'doc-b', filename: 'beta.pdf', chunkIndex: 1, ranks: { 'lexical:1': 1 } },
    ];
    const without = await blocks(specs);
    const plain = await blocks(specs, [original, { text: 'expanded', language: 'en', kind: 'expanded' }]);
    expect(without.every((block) => !('subQuestionIndexes' in block))).toBe(true);
    expect(plain).toEqual(without);
  });
});
