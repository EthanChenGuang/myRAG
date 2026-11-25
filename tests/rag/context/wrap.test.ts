import { describe, expect, it } from 'vitest';
import { escapeAttr, escapeTags } from '@/lib/rag/context/wrap';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const FW_LT = cp(0xff1c);
const FW_GT = cp(0xff1e);
const SMALL_LT = cp(0xfe64);
const SMALL_GT = cp(0xfe65);
const ZWSP = cp(0x200b);
const tagChars = (ascii: string) => Array.from(ascii, (ch) => cp(0xe0000 + ch.charCodeAt(0))).join('');
const fullWidth = (ascii: string) => Array.from(ascii, (ch) => cp(ch.charCodeAt(0) + 0xfee0)).join('');

describe('escapeTags', () => {
  it.each([
    ['</doc>', '&lt;/doc&gt;'],
    ['< doc id="x">', '&lt; doc id="x"&gt;'],
    ['</DOCUMENTS >', '&lt;/DOCUMENTS &gt;'],
    ['<doc/>', '&lt;doc/&gt;'],
    ['<tool_result source="a">', '&lt;tool_result source="a"&gt;'],
    ['</tool-result>', '&lt;/tool-result&gt;'],
  ])('escapes only the brackets of %s', (input, expected) => {
    expect(escapeTags(`before ${input} after`)).toBe(`before ${expected} after`);
  });

  it('escapes full-width and small look-alike brackets at their original positions', () => {
    expect(escapeTags(`x ${FW_LT}doc${FW_GT} y`)).toBe('x &lt;doc&gt; y');
    expect(escapeTags(`x ${SMALL_LT}/doc${SMALL_GT} y`)).toBe('x &lt;/doc&gt; y');
  });

  it('escapes a tag split by a zero-width character and keeps the invisible character', () => {
    expect(escapeTags(`<d${ZWSP}oc>`)).toBe(`&lt;d${ZWSP}oc&gt;`);
  });

  it('escapes full-width letters spelling the tag name', () => {
    const name = fullWidth('doc');
    expect(escapeTags(`<${name}>`)).toBe(`&lt;${name}&gt;`);
  });

  it('escapes a tag whose name is spelled with Unicode tag characters', () => {
    const name = tagChars('doc');
    expect(escapeTags(`<${name}>`)).toBe(`&lt;${name}&gt;`);
  });

  it('escapes a tag written entirely in Unicode tag characters', () => {
    const smuggled = tagChars('</doc>');
    const out = escapeTags(`a${smuggled}b`);
    expect(out).toBe(`a&lt;${tagChars('/doc')}&gt;b`);
  });

  it('leaves tables, comparisons and unrelated markup verbatim', () => {
    const text = '| a < 5 | b > 3 | <br> <p>keep</p> <docs> <document>';
    expect(escapeTags(text)).toBe(text);
  });

  it('escapes only the opening bracket of an unclosed tag', () => {
    expect(escapeTags('tail </doc')).toBe('tail &lt;/doc');
  });

  it('does not shift later escapes after a combining sequence', () => {
    const text = `<${cp(0x0338)} then </doc> end`;
    expect(escapeTags(text)).toBe(`<${cp(0x0338)} then &lt;/doc&gt; end`);
  });

  it('handles astral characters before the tag without offset drift', () => {
    const emoji = cp(0x1f600);
    expect(escapeTags(`${emoji}${emoji}</doc>${emoji}`)).toBe(`${emoji}${emoji}&lt;/doc&gt;${emoji}`);
  });

  it('returns the identical string when no bracket or tag character is present', () => {
    const text = 'plain text without brackets. '.repeat(110);
    expect(text.length).toBeGreaterThan(3000);
    expect(escapeTags(text)).toBe(text);
    expect(Object.is(escapeTags(text), text)).toBe(true);
  });

  it('skips the view on the fast path', () => {
    const text = 'a > b and c > d '.repeat(200);
    const original = String.prototype.normalize;
    let calls = 0;
    String.prototype.normalize = function patched(this: string, form?: string) {
      calls += 1;
      return original.call(this, form);
    };
    try {
      expect(escapeTags(text)).toBe(text);
    } finally {
      String.prototype.normalize = original;
    }
    expect(calls).toBe(0);
  });
});

describe('escapeAttr', () => {
  it('neutralises an attribute breakout', () => {
    const out = escapeAttr('x"><doc id="evil');
    expect(out).not.toMatch(/["<>]/);
    expect(out).toBe('x&quot;&gt;&lt;doc id=&quot;evil');
  });

  it('escapes ampersands', () => {
    expect(escapeAttr('a & b')).toBe('a &amp; b');
  });

  it('maps the four look-alike brackets', () => {
    expect(escapeAttr(`${FW_LT}${SMALL_LT}doc${FW_GT}${SMALL_GT}`)).toBe('&lt;&lt;doc&gt;&gt;');
  });

  it('replaces control characters with spaces', () => {
    expect(escapeAttr('a\nb\tc\u0000d\u007fe')).toBe('a b c d e');
  });

  it('drops Unicode tag characters', () => {
    expect(escapeAttr(`a${tagChars('<doc>')}b`)).toBe('ab');
  });

  it('caps the value at 200 characters', () => {
    expect(escapeAttr('x'.repeat(500))).toHaveLength(200);
    const out = escapeAttr('x'.repeat(198) + '<<<<');
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/&[a-z]*$/);
  });
});
