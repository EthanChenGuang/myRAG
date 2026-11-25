import { describe, expect, it } from 'vitest';
import type { RerankSpan } from '@/lib/rag/rerank/types';
import { compressChunks, MIN_COMPRESS_TOKENS, type CompressibleChunk } from '@/lib/rag/context/compress';

function sliceCodepoints(text: string, start: number, end: number): string {
  const units = [...text];
  return units.slice(start, end).join('');
}
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const PAD = 'padding sentence with neutral words. '.repeat(30);
const BASE: CompressibleChunk = {
  chunk_id: 'c1',
  content: `${PAD}First sentence about widgets. Second sentence about pricing. Third about refunds.`,
  chunk_kind: 'text',
  language: 'en',
};

function compressOne(
  chunk: CompressibleChunk,
  extra: Partial<Parameters<typeof compressChunks>[1]> = {},
) {
  const [out] = compressChunks([chunk], {
    query: 'widgets pricing',
    enabled: true,
    keepRatio: 0.5,
    ...extra,
  });
  return out!;
}

describe('compressChunks', () => {
  it('returns the same array contents when compression is disabled', () => {
    const chunks = [BASE];
    const result = compressChunks(chunks, { query: 'x', enabled: false });
    expect(result).toBe(chunks);
    expect(result[0]).toBe(chunks[0]);
  });

  it('slices provider spans after subtracting rerank prefix length', () => {
    const prefix = 'Section: intro.\n';
    const body = `${PAD}Widgets cost ten dollars. Pricing varies by region.`;
    const chunk: CompressibleChunk = { ...BASE, content: prefix + body };
    const prefixLen = [...prefix].length;
    const widgetOffset = [...body].findIndex((_, idx) => [...body].slice(idx, idx + 7).join('') === 'Widgets');
    const spans: RerankSpan[] = [
      { start: prefixLen + widgetOffset, end: prefixLen + widgetOffset + 20, score: 0.9 },
    ];
    const out = compressOne(chunk, {
      spansByChunk: new Map([[chunk.chunk_id, spans]]),
      prefixLengthByChunk: new Map([[chunk.chunk_id, prefixLen]]),
    });
    const expected = sliceCodepoints(body, widgetOffset, widgetOffset + 20);
    expect(out.content).toBe(expected);
    expect(body.includes(out.content)).toBe(true);
  });

  it('drops spans that fall inside the prefix', () => {
    const prefix = 'Header only.';
    const body = 'Real content here.';
    const chunk: CompressibleChunk = { ...BASE, content: prefix + body };
    const spans: RerankSpan[] = [{ start: 2, end: 6, score: 0.5 }];
    const out = compressOne(chunk, {
      spansByChunk: new Map([[chunk.chunk_id, spans]]),
      prefixLengthByChunk: new Map([[chunk.chunk_id, prefix.length]]),
    });
    expect(out.content).toBe(chunk.content);
  });

  it('slices astral characters by codepoint offsets', () => {
    const text = `${PAD}𠮷野家 menu is tasty.`;
    const chunk: CompressibleChunk = { ...BASE, content: text, chunk_id: 'jp' };
    const start = [...text].findIndex((ch) => ch === '𠮷');
    const spans: RerankSpan[] = [{ start, end: start + 3, score: 1 }];
    const out = compressOne(chunk, {
      spansByChunk: new Map([[chunk.chunk_id, spans]]),
      prefixLengthByChunk: new Map([[chunk.chunk_id, 0]]),
    });
    expect(out.content).toBe('𠮷野家');
    expect([...text].slice(start, start + 3).join('')).toBe(out.content);
  });

  it('keeps top query-overlap sentences in original order when spans are absent', () => {
    const chunk: CompressibleChunk = {
      ...BASE,
      content: `${'neutral filler '.repeat(120)}Unrelated intro. Widgets are modular. Pricing includes tax. Refunds take 30 days.`,
    };
    const out = compressOne(chunk, { keepRatio: 0.34 });
    expect(out.content).toContain('Widgets');
    expect(out.content).toContain('Pricing');
    expect(out.content).not.toContain('Refunds');
    expect(chunk.content.includes(out.content)).toBe(true);
  });

  it('never compresses table, image, short, or merged-parent chunks', () => {
    const long = 'word '.repeat(80);
    const cases: CompressibleChunk[] = [
      { ...BASE, chunk_kind: 'table', content: long },
      { ...BASE, chunk_kind: 'image', content: long },
      { ...BASE, metadata: { image_url: 'https://x/y.png' }, content: long },
      { ...BASE, content: 'short text only' },
      { ...BASE, mergedParent: true, content: long },
    ];
    for (const chunk of cases) {
      if (chunk.content === 'short text only') {
        expect(countTokens(chunk.content)).toBeLessThan(MIN_COMPRESS_TOKENS);
      }
      const out = compressOne(chunk);
      expect(out.content).toBe(chunk.content);
    }
  });

  it('keeps only verbatim substrings of the input', () => {
    const chunk: CompressibleChunk = {
      ...BASE,
      content: `${PAD}Alpha sentence. Beta mentions widgets and pricing. Gamma sentence.`,
    };
    const out = compressOne(chunk);
    for (const part of out.content.split(/(?<=[.!?])\s+/).filter(Boolean)) {
      expect(chunk.content.includes(part.trim())).toBe(true);
    }
  });
});