import { describe, expect, it } from 'vitest';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { rerankText } from '@/lib/rag/rerank/text';

describe('rerankText (A-11)', () => {
  it('exports the shared rerank text version constant', () => {
    expect(RERANK_TEXT_VERSION).toBe(1);
  });

  it('strips the legacy prefix, prepends the section path, and counts prefix codepoints', () => {
    const { text, prefixLength } = rerankText({
      sectionPath: ['Warranty', 'Coverage'],
      content: 'Document: specs.md. Chunk 2 of 5. Content: XR-2000 two-year warranty.',
    });
    expect(text).toBe('Warranty > Coverage\nXR-2000 two-year warranty.');
    expect(prefixLength).toBe(Array.from('Warranty > Coverage\n').length);
  });

  it('returns stripped content only when section path is empty', () => {
    const { text, prefixLength } = rerankText({
      sectionPath: [],
      content: 'Document: a.md. Chunk 1 of 3. Content: body text',
    });
    expect(text).toBe('body text');
    expect(prefixLength).toBe(0);
  });

  it('counts prefix length in codepoints, not UTF-16 units, for CJK and emoji', () => {
    const path = ['第三章', '适用范围😀'];
    const prefix = `${path.join(' > ')}\n`;
    const { prefixLength, text } = rerankText({
      sectionPath: path,
      content: 'plain content without legacy prefix',
    });
    expect(prefixLength).toBe(Array.from(prefix).length);
    expect(prefixLength).toBeLessThan(prefix.length);
    expect(text).toBe(`${prefix}plain content without legacy prefix`);
  });

  it('leaves content unchanged when there is no legacy prefix', () => {
    const { text, prefixLength } = rerankText({
      sectionPath: ['Intro'],
      content: 'Already clean body.',
    });
    expect(text).toBe('Intro\nAlready clean body.');
    expect(prefixLength).toBe(Array.from('Intro\n').length);
  });
});