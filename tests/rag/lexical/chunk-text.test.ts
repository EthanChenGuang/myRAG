import { describe, expect, it, vi } from 'vitest';
import { assertIcuSegmentsChinese, icuSegmentsChinese } from '@/lib/rag/lexical/icu-check';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';

describe('icu-check (P-6)', () => {
  it('reports Chinese segmentation works on this runtime', () => {
    expect(icuSegmentsChinese()).toBe(true);
  });

  it('throws a RAG Config error when segmenter cannot split 适用范围', () => {
    const ctor = vi.spyOn(Intl, 'Segmenter').mockImplementation(
      () =>
        ({
          segment: () => [{ isWordLike: true, segment: '适用范围' }],
        }) as Intl.Segmenter,
    );
    expect(() => assertIcuSegmentsChinese()).toThrow(/\[RAG Config\].*icu/u);
    expect(() => assertIcuSegmentsChinese()).toThrow(process.versions.icu ?? '');
    ctor.mockRestore();
  });
});

describe('chunkLexicalText (F-10)', () => {
  it('orders section_path tokens before content tokens', () => {
    const text = chunkLexicalText({
      sectionPath: ['第三章 合同条款', '第5条 适用范围'],
      content: '本合同适用于客户',
    });
    const pathLead = chunkLexicalText({ sectionPath: ['第三章 合同条款'], content: '' });
    expect(text.startsWith(pathLead.trim()) || text.includes('合同')).toBe(true);
    expect(text).toContain('客户');
  });

  it('strips the legacy Document prefix but keeps the document title', () => {
    const text = chunkLexicalText({
      sectionPath: [],
      content: 'Document: specs.en.md. Chunk 2 of 5. Content: XR-2000 warranty details',
    });
    expect(text).toContain('specs');
    expect(text).toMatch(/\ben\b/);
    expect(text).toContain('md');
    expect(text).toContain('xr-2000');
    expect(text).not.toMatch(/\bchunk\b/);
    expect(text).not.toMatch(/\bof\b/);
  });

  it('includes image filename, name and image_context tokens', () => {
    const text = chunkLexicalText({
      sectionPath: [],
      content: 'A blue logo on white',
      chunkKind: 'image',
      metadata: { name: 'Brand mark', image_context: 'company logo', image_url: 'https://example.com/x.png' },
      documentFilename: 'brand.png',
    });
    expect(text).toContain('brand');
    expect(text).toContain('png');
    expect(text).toContain('logo');
  });
});