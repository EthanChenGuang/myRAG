import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleContext, type AssembleInput, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import { REFERENCE_NOTICE } from '@/lib/rag/context/wrap';
import { buildAliasMap, createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import { buildCitationRecords } from '@/lib/rag/generation/citations/record';
import { buildPremise } from '@/lib/rag/generation/groundedness';

/** Synthetic test text only. */
const RAW_TEXT = 'The blorvex gauge note lists </doc> and <documents> as literal markers in the gauge manual.';
const CLEAN_TEXT = 'The blorvex gauge reads in tenths of a unit on the gauge manual scale.';

const documents = new Map<string, AssemblyDocumentRow>([
  ['doc-a', { id: 'doc-a', filename: 'blorvex-gauge.md', content: null }],
  ['doc-b', { id: 'doc-b', filename: 'blorvex-scale.md', content: null }],
]);

function input(extra: Partial<AssembleInput> = {}): AssembleInput {
  return {
    queryText: 'blorvex gauge manual markers',
    candidates: [
      { chunk_id: 'a1', document_id: 'doc-a', content: RAW_TEXT, similarity: 0.95 },
      { chunk_id: 'b1', document_id: 'doc-b', content: CLEAN_TEXT, similarity: 0.9 },
    ],
    documents,
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
    citationLabeler: createCitationLabeler(),
    contextTagging: true,
    ...extra,
  };
}

function rawBlock(result: ReturnType<typeof assembleContext>) {
  const map = buildAliasMap(result.blocks);
  const block = map.ordered.find((entry) => entry.chunkIds.includes('a1'));
  expect(block, 'the block holding the literal tags is aliased').toBeTruthy();
  return { map, block: block! };
}

describe('tagging and citations together: escaping exists only in the prompt (D-03, A4, A5, R4, R5)', () => {
  it('every <doc id="S<k>"> body starts with the Phase 5 label line', () => {
    const result = assembleContext(input());
    expect(result.context).toContain(REFERENCE_NOTICE);
    const map = buildAliasMap(result.blocks);
    expect(map.ordered.length).toBe(2);
    for (const block of map.ordered) {
      const open = new RegExp(`<doc id="${block.alias}"[^>\\n]*>\\n([^\\n]*)\\n`);
      const match = result.context.match(open);
      expect(match, `a <doc> element for ${block.alias}`).toBeTruthy();
      expect(match![1]).toBe(`[${block.alias}] ${block.title}`);
    }
  });

  it('the prompt shows the literal tags escaped while the alias map keeps the raw text', () => {
    const result = assembleContext(input());
    const { block } = rawBlock(result);
    expect(block.text).toContain('</doc>');
    expect(block.text).toContain('<documents>');
    expect(result.context).toContain('lists &lt;/doc&gt; and &lt;documents&gt; as literal markers');
    expect(result.context.split('<documents>')).toHaveLength(2);
    expect(result.context).not.toContain(block.text);
  });

  it('CitationRecord.quote is the raw block text and quoteHash is the sha256 of that raw text', () => {
    const result = assembleContext(input());
    const { map, block } = rawBlock(result);
    const [record] = buildCitationRecords([block.alias], map, 'chunk-alias');
    expect(record.quote).toBe(block.text);
    expect(record.quote).toContain('</doc>');
    expect(record.quote).not.toContain('&lt;');
    expect(record.quoteHash).toBe(createHash('sha256').update(block.text).digest('hex'));
  });

  it('the groundedness premise carries the raw text', () => {
    const result = assembleContext(input());
    const { map, block } = rawBlock(result);
    const premise = buildPremise({
      blocks: map.ordered.map((entry) => ({ alias: entry.alias, text: entry.text })),
      citedAliases: [block.alias],
      webSearchTexts: [],
      maxTokens: 4000,
    });
    expect(premise.status).toBe('ok');
    if (premise.status !== 'ok') return;
    expect(premise.premiseTexts).toContain(block.text);
    expect(premise.premiseTexts.join('\n')).toContain('lists </doc> and <documents>');
    expect(premise.premiseTexts.join('\n')).not.toContain('&lt;');
  });

  it('the alias map, quotes and premise are identical with tagging off', () => {
    const tagged = rawBlock(assembleContext(input()));
    const plain = rawBlock(assembleContext(input({ contextTagging: false })));
    expect(tagged.map.ordered.map((entry) => [entry.alias, entry.text])).toEqual(plain.map.ordered.map((entry) => [entry.alias, entry.text]));
    expect(buildCitationRecords([tagged.block.alias], tagged.map, 'chunk-alias')).toEqual(
      buildCitationRecords([plain.block.alias], plain.map, 'chunk-alias'),
    );
  });
});
