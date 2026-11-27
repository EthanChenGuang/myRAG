import { afterEach, describe, expect, it } from 'vitest';
import { countContextTokens } from '@/lib/rag/context/budget';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RetrievalOptions } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

const scope = mintScope('single', null, null);
const BODY = 'neutral filler sentence for the document budget. '.repeat(12);
const IDS = ['k1', 'k2', 'k3', 'k4', 'k5'];

function fused(): FusedHit[] {
  return IDS.map((id, index) => {
    const rank = index + 1;
    return {
      hit: hit(id, {
        rank,
        documentId: `doc-${id}`,
        parentId: null,
        chunkIndex: 0,
        content: `${id} ${BODY}`,
        similarity: 0.9 - rank * 0.01,
        metadata: {},
        document: { filename: `${id}.txt`, createdAt: null, metadata: {}, contentPreview: '' },
      }),
      score: 1 / (60 + rank),
      ranks: { 'dense:0': rank },
    };
  });
}

async function run(options: RetrievalOptions | undefined, labeled = false) {
  resetRagConfigForTests();
  const cfg = loadRagConfig({ RAG_PIPELINE: 'v2' });
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const out = await runContextStages({
    access: { mode: 'off' },
    input: {
      scope,
      query: 'neutral filler',
      profile: 'chat',
      signal: new AbortController().signal,
      ...(options ? { options } : {}),
      ...(labeled ? { citationLabeler: createCitationLabeler() } : {}),
    },
    config: cfg,
    profile: 'chat',
    params: { ...effectiveRetrievalParams('chat', cfg, null), final_top_k: 20 },
    fusedHits: fused(),
    referenced: null,
    signal: new AbortController().signal,
    collector,
  });
  return { out, assemble: collector.stages().find((row) => row.name === 'assemble') };
}

function blockTokens(id: string): number {
  return countContextTokens(`\n--- Document: ${id}.txt (1 relevant chunks) ---\n\n${id} ${BODY}`);
}

afterEach(() => resetRagConfigForTests());

describe('v2 context stage with documentTokenBudget (D-83)', () => {
  it('is unchanged without the option and carries no packing summary', async () => {
    const plain = await run(undefined);
    const empty = await run({});
    expect(empty.out).toEqual(plain.out);
    expect(plain.out.packing).toBeUndefined();
    expect(plain.assemble?.counts?.budget_tokens).toBe(6000);
  });

  it('packs to the smaller of the option and the profile budget, keeping the highest-ranked blocks', async () => {
    // three blocks by the per-block estimate; the rendered framing and labels leave room for two
    const budget = blockTokens('k1') + blockTokens('k2') + blockTokens('k3') + 5;
    const { out, assemble } = await run({ documentTokenBudget: budget }, true);
    const keptIds = out.assembly!.kept.map((row) => row.chunk_id);
    expect(keptIds).toEqual(['k1', 'k2']);
    expect(countContextTokens(out.assembly!.context)).toBeLessThanOrEqual(budget);
    expect(assemble?.counts?.budget_tokens).toBe(budget);
    expect(out.packing).toEqual({ documentBudget: budget, droppedDocuments: 3, keptParents: 2 });

    const aliased = out.assembly!.blocks.filter((block) => block.alias !== null);
    expect(aliased.map((block) => block.alias)).toEqual(['S1', 'S2']);
    const cited = new Set(aliased.flatMap((block) => block.chunkIds));
    for (const dropped of ['k3', 'k4', 'k5']) {
      expect(cited.has(dropped)).toBe(false);
      expect(out.assembly!.context).not.toContain(`${dropped} neutral`);
    }
  });

  for (const labelled of [false, true]) {
    it(`keeps the rendered context within the budget, the truncated first block included (${labelled ? 'labelled' : 'plain'})`, async () => {
      for (const budget of [blockTokens('k1') * 2, blockTokens('k1') + 2, Math.floor(blockTokens('k1') / 2), 40]) {
        const { out } = await run({ documentTokenBudget: budget }, labelled);
        expect(countContextTokens(out.assembly!.context)).toBeLessThanOrEqual(budget);
        expect(out.assembly!.kept.length).toBeGreaterThan(0);
        expect(out.packing?.documentBudget).toBe(budget);
      }
    });
  }

  it('keeps the profile budget when the option is larger', async () => {
    const plain = await run(undefined);
    const { out, assemble } = await run({ documentTokenBudget: 1_000_000 });
    expect(out.assembly!.context).toBe(plain.out.assembly!.context);
    expect(assemble?.counts?.budget_tokens).toBe(6000);
    expect(out.packing).toEqual({ documentBudget: 6000, droppedDocuments: 0, keptParents: 5 });
  });
});
