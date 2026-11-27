import { describe, expect, it } from 'vitest';
import { countContextTokens, type RenderEstimate } from '@/lib/rag/context/budget';
import { buildContext, filterCandidates, IMAGE_EXTENSIONS, type AssembleInput } from '@/lib/rag/context/assemble';
import { documentBudgetOf, packAndBuild, packByRank, packFiltered, type PackCandidate } from '@/lib/rag/context/pack';
import { assembleVoiceResults, untaggedVoiceContext } from '@/lib/rag/context/voice';
import { createCitationLabeler } from '@/lib/rag/generation/citations/blocks';

const BODY = 'neutral sample sentence for packing checks. '.repeat(8);
const UNIT = countContextTokens(BODY);
const render: RenderEstimate<PackCandidate & { rank: number }> = (candidate) => candidate.content;
const options = { imageExtensions: ['.png'] };

function block(id: string, scores: Partial<PackCandidate> = {}): PackCandidate {
  return { chunk_id: id, document_id: `doc-${id}`, document_filename: `${id}.txt`, content: BODY, similarity: 0.5, ...scores };
}

const FIVE: PackCandidate[] = [
  block('a', { rerank_score: 0.9, fused_score: 0.1, similarity: 0.1 }),
  block('b', { rerank_score: 0.2, fused_score: 0.9, similarity: 0.9 }),
  block('c', { rerank_score: 0.7 }),
  block('d', { rerank_score: null, fused_score: 0.8, similarity: 0.95 }),
  block('e', { rerank_score: 0.5 }),
];

describe('packByRank', () => {
  it('orders by rerank score, then fused score for unscored items, then similarity', () => {
    const tail = [block('f', { similarity: 0.99 }), block('g', { fused_score: 0.05, similarity: 0.01 })];
    const result = packByRank([...FIVE, ...tail], UNIT * 100, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'c', 'e', 'b', 'd', 'g', 'f']);
    expect(result.selected.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.droppedDocuments).toBe(0);
    expect(result.keptParents).toBe(7);
  });

  it('keeps the three highest-ranked blocks when the budget fits three', () => {
    const result = packByRank(FIVE, UNIT * 3, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'c', 'e']);
    expect(result.droppedDocuments).toBe(2);
    expect(result.keptParents).toBe(3);
    expect(result.documentBudget).toBe(UNIT * 3);
  });

  it('counts two children of one parent once, represented by the higher-ranked child', () => {
    const children = [
      block('low', { parent_id: 'p1', document_id: 'doc-p', rerank_score: 0.3 }),
      block('high', { parent_id: 'p1', document_id: 'doc-p', rerank_score: 0.8 }),
      block('other', { rerank_score: 0.6 }),
    ];
    const result = packByRank(children, UNIT * 100, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['high', 'other']);
    expect(result.keptParents).toBe(2);
    expect(result.droppedDocuments).toBe(0);
  });

  it('keeps the input order with order "input"', () => {
    const result = packByRank(FIVE, UNIT * 2, render, { ...options, order: 'input' });
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'b']);
    expect(result.droppedDocuments).toBe(3);
  });

  it('keeps the first-ranked block truncated when nothing fits', () => {
    const result = packByRank(FIVE, 4, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a']);
    expect(result.contentOverrides.has('a')).toBe(true);
    expect(result.droppedDocuments).toBe(4);
  });
});

describe('documentBudgetOf', () => {
  it('reads a finite budget as a non-negative integer and anything else as absent', () => {
    expect(documentBudgetOf(undefined)).toBeNull();
    expect(documentBudgetOf(Number.NaN)).toBeNull();
    expect(documentBudgetOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(documentBudgetOf('100')).toBeNull();
    expect(documentBudgetOf(-5)).toBe(0);
    expect(documentBudgetOf(120.7)).toBe(120);
  });
});

describe('packFiltered (legacy assembly, D-83 / D-95)', () => {
  const SAMPLE = 'neutral legacy sentence for packing. '.repeat(10);
  const documents = new Map(
    ['x', 'y', 'z'].map((id) => [`doc-${id}`, { id: `doc-${id}`, filename: `${id}.txt`, content: SAMPLE, created_at: null }]),
  );
  const candidates = [
    { chunk_id: 'x1', document_id: 'doc-x', content: `x1 ${SAMPLE}`, similarity: 0.7 },
    { chunk_id: 'y1', document_id: 'doc-y', content: `y1 ${SAMPLE}`, similarity: 0.95 },
    { chunk_id: 'z1', document_id: 'doc-z', content: `z1 ${SAMPLE}`, similarity: 0.8 },
  ];
  const input: AssembleInput<(typeof candidates)[number]> = {
    queryText: 'neutral legacy',
    candidates,
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
    citationLabeler: createCitationLabeler(),
  };
  const one = countContextTokens(`\n--- Document: y.txt (1 relevant chunks) ---\n\ny1 ${SAMPLE}`);

  it('keeps the highest-similarity chunks, drops the rest from sources, and the labeller never sees a dropped block', () => {
    const state = filterCandidates(input);
    expect(state.relevantChunks).toHaveLength(3);
    const packed = packFiltered(state, candidates, documents, one * 2 + 2, { isGPTModel: false, imageExtensions: IMAGE_EXTENSIONS });
    expect(packed.state.relevantChunks.map((chunk) => chunk.chunk_id)).toEqual(['y1', 'z1']);
    expect(packed.state.usedDocuments.map((doc) => doc.id).sort()).toEqual(['doc-y', 'doc-z']);
    expect(packed.summary).toEqual({ documentBudget: one * 2 + 2, droppedDocuments: 1, keptParents: 2 });

    const out = buildContext(packed.state, { ...input, candidates: packed.candidates });
    expect(out.context).not.toContain('x1 neutral');
    const aliased = out.blocks.filter((block) => block.alias !== null);
    expect(aliased.flatMap((block) => block.chunkIds).sort()).toEqual(['y1', 'z1']);
    expect(out.kept.map((row) => row.chunk_id)).toEqual(['y1', 'z1']);
  });

  it('leaves the assembly byte-identical with a budget that fits everything', () => {
    const state = filterCandidates(input);
    const plain = buildContext(state, input);
    const packed = packFiltered(state, candidates, documents, 1_000_000, { isGPTModel: false, imageExtensions: IMAGE_EXTENSIONS });
    expect(buildContext(packed.state, { ...input, candidates: packed.candidates })).toEqual(plain);
    expect(packed.summary.droppedDocuments).toBe(0);
  });
});

describe('packAndBuild (legacy assembly, framing counted)', () => {
  const SAMPLE = 'neutral framing sentence for packing. '.repeat(10);
  const ids = ['p', 'q', 'r', 's'];
  const documents = new Map(ids.map((id) => [`doc-${id}`, { id: `doc-${id}`, filename: `${id}.txt`, content: SAMPLE, created_at: null }]));
  const candidates = ids.map((id, index) => ({ chunk_id: `${id}1`, document_id: `doc-${id}`, content: `${id}1 ${SAMPLE}`, similarity: 0.95 - index * 0.05 }));
  const input = (labelled: boolean): AssembleInput<(typeof candidates)[number]> => ({
    queryText: 'neutral framing',
    candidates,
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
    ...(labelled ? { citationLabeler: createCitationLabeler() } : {}),
  });
  const one = countContextTokens(`\n--- Document: p.txt (1 relevant chunks) ---\n\np1 ${SAMPLE}`);
  const build = (labelled: boolean, budget: number) => {
    const state = filterCandidates(input(labelled));
    return packAndBuild(state, candidates, documents, budget, { isGPTModel: false, imageExtensions: IMAGE_EXTENSIONS }, (packed) =>
      buildContext(packed.state, { ...input(labelled), candidates: packed.candidates }),
    );
  };

  for (const labelled of [false, true]) {
    for (const budget of [one * 2 + 2, one * 3 + 1, Math.floor(one / 2), one + 3]) {
      it(`keeps the built context within the budget (${labelled ? 'labelled' : 'plain'}, budget ${budget})`, () => {
        const { output, summary } = build(labelled, budget);
        expect(countContextTokens(output.context)).toBeLessThanOrEqual(budget);
        expect(summary.documentBudget).toBe(budget);
        expect(output.kept.length).toBeGreaterThan(0);
      });
    }
  }

  it('drops the lowest-ranked block when the framing would overflow the per-block estimate', () => {
    const { output, summary } = build(false, one * 2 + 2);
    expect(output.kept.map((row) => row.chunk_id)).toEqual(['p1']);
    expect(summary).toEqual({ documentBudget: one * 2 + 2, droppedDocuments: 3, keptParents: 1 });
  });

  it('leaves the assembly byte-identical with a budget that fits everything', () => {
    const state = filterCandidates(input(true));
    const plain = buildContext(state, input(true));
    expect(build(true, 1_000_000).output).toEqual(plain);
  });
});

describe('assembleVoiceResults with documentTokenBudget', () => {
  const SAMPLE = 'neutral voice sentence for packing. '.repeat(10);
  const chunks = ['v1', 'v2', 'v3'].map((id, index) => ({
    chunk_id: id,
    document_id: `doc-${id}`,
    content: `${id} ${SAMPLE}`,
    similarity: 0.9 - index * 0.1,
    metadata: {},
  }));
  const one = countContextTokens(untaggedVoiceContext([chunks[0]!]));

  it('is unchanged without a budget', () => {
    const plain = assembleVoiceResults({ query: 'neutral voice', chunks, matchCount: 3 });
    expect(assembleVoiceResults({ query: 'neutral voice', chunks, matchCount: 3, documentTokenBudget: null })).toEqual(plain);
    expect('packing' in plain).toBe(false);
  });

  it('keeps the results in their order up to the budget', () => {
    const out = assembleVoiceResults({ query: 'neutral voice', chunks: [...chunks].reverse(), matchCount: 3, documentTokenBudget: one * 2 + 2 });
    expect(out.results.map((row) => row.chunk_id)).toEqual(['v3', 'v2']);
    expect(out.packing).toEqual({ documentBudget: one * 2 + 2, droppedDocuments: 1, keptParents: 2 });
  });
});
