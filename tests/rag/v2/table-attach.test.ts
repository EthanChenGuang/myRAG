import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTableRow, renderTableRowLines, type TableRowAttachment } from '@/lib/rag/context/assemble';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages, type ContextStagesInput } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

// D-17: synthetic, neutral table text; invented column names and values.
const ROW: TableRowAttachment = {
  header: ['Brennik', 'Solvane', 'Mirtha'],
  cells: { Brennik: 'drovask', Solvane: 'quilmeno', Mirtha: 'yarrot | lune' },
};
const WITHOUT_HEADER = '| fenwahl | quilmeno | ostric |\n| drovask | quilmeno | yarrot |';
const WITH_HEADER = '|Brennik|  Solvane |Mirtha|\n|---|---|---|\n| drovask | quilmeno | yarrot |';
const PLAIN = 'Plain prose about an invented register.';

const scope = mintScope('single', null, null);

interface Spec {
  chunkId: string;
  content: string;
  ranks: Record<string, number>;
}

function fused(specs: Spec[]): FusedHit[] {
  return specs.map((spec, index) => ({
    hit: hit(spec.chunkId, {
      rank: index + 1,
      documentId: `doc-${spec.chunkId}`,
      chunkIndex: 0,
      content: spec.content,
      similarity: 0.9,
      document: { filename: `${spec.chunkId}.md`, createdAt: null, metadata: {}, contentPreview: '' },
    }),
    score: 1 / (60 + index + 1),
    ranks: spec.ranks,
  }));
}

async function run(specs: Spec[], extra: Partial<ContextStagesInput> = {}, env: Record<string, string> = {}) {
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_TABLE_LOOKUP: 'true', ...env });
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const params = { ...effectiveRetrievalParams('chat', config, null), final_top_k: 20 };
  const output = await runContextStages({
    input: { scope, query: 'drovask quilmeno', profile: 'chat', signal: new AbortController().signal },
    config,
    profile: 'chat',
    params,
    fusedHits: fused(specs),
    referenced: null,
    signal: new AbortController().signal,
    collector,
    ...extra,
  });
  const assemble = collector.stages().find((stage) => stage.name === 'assemble');
  return { output, assemble };
}

describe('table row rendering (D-17)', () => {
  it('renders the header, the separator and the row as Markdown, escaping only the pipe', () => {
    expect(renderTableRowLines(ROW)).toBe('| Brennik | Solvane | Mirtha |\n| --- | --- | --- |\n| drovask | quilmeno | yarrot \\| lune |');
  });

  it('prefixes a chunk without the header and leaves a chunk that carries it after whitespace normalization', () => {
    expect(attachTableRow(WITHOUT_HEADER, ROW)).toBe(`${renderTableRowLines(ROW)}\n\n${WITHOUT_HEADER}`);
    expect(attachTableRow(WITH_HEADER, ROW)).toBeNull();
    expect(attachTableRow(PLAIN, { header: [], cells: {} })).toBeNull();
  });
});

describe('runContextStages header attachment (D-17)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  const specs: Spec[] = [
    { chunkId: 'tbl', content: WITHOUT_HEADER, ranks: { 'table:0': 1, 'dense:0': 2 } },
    { chunkId: 'txt', content: PLAIN, ranks: { 'dense:0': 1 } },
  ];

  it('a table:0 chunk without the header gets the header and matched row before the budget; the stage counts it', async () => {
    const { output, assemble } = await run(specs, { tableRows: new Map([['tbl', ROW]]) });
    const context = output.assembly!.context;
    expect(context).toContain(`${renderTableRowLines(ROW)}\n\n${WITHOUT_HEADER}`);
    expect(context).toContain(PLAIN);
    expect(assemble?.counts?.table_row_attached).toBe(1);
  });

  it('a chunk that already carries the header gets nothing and is not counted', async () => {
    const { output, assemble } = await run([{ ...specs[0]!, content: WITH_HEADER }, specs[1]!], { tableRows: new Map([['tbl', ROW]]) });
    expect(output.assembly!.context).not.toContain('| --- | --- | --- |');
    expect(assemble?.counts).not.toHaveProperty('table_row_attached');
  });

  it('a chunk that did not come through table:0 is unchanged even with a row for it', async () => {
    const { output, assemble } = await run([specs[1]!], { tableRows: new Map([['txt', ROW]]) });
    expect(output.assembly!.context).not.toContain('Brennik');
    expect(assemble?.counts).not.toHaveProperty('table_row_attached');
  });

  it('without table rows the context is byte-identical to a run without the field', async () => {
    const a = await run(specs);
    const b = await run(specs, { tableRows: undefined });
    const off = await run(specs, {}, { RAG_TABLE_LOOKUP: 'false' });
    expect(a.output.assembly!.context).toBe(b.output.assembly!.context);
    expect(a.output.assembly!.context).toBe(off.output.assembly!.context);
    expect(a.assemble?.counts).toEqual(off.assemble?.counts);
  });

  it('the token budget sees the prefixed text', async () => {
    const plain = await run(specs);
    const attached = await run(specs, { tableRows: new Map([['tbl', ROW]]) });
    expect(attached.assemble!.counts!.used_tokens).toBeGreaterThan(plain.assemble!.counts!.used_tokens!);
  });
});
