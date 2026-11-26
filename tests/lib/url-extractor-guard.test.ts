import { afterEach, describe, expect, it } from 'vitest';
import { createLinkUsageInstructions, formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';

const URLS: ExtractedURL[] = [
  { url: 'https://allowed.test/plan', context: 'a', category: 'product', description: 'Plan page' },
  { url: 'https://other.test/pay', context: 'b', category: 'payment', description: 'Payment page' },
  { url: 'https://docs.allowed.test/guide', context: 'c', category: 'documentation' },
  { url: 'https://user:pw@allowed.test/x', context: 'd', category: 'other', description: 'Credentials link' },
  { url: 'https://app.test/help', context: 'e', category: 'other', description: 'Own site' },
];

/** Today's output for URLS (guard off), written out by hand from the function body before 05.2-13. */
const TODAY_LINKS =
  '\n=== RELEVANT LINKS ===\nPayment Links:\n  - Payment page: https://other.test/pay\n\nProduct Links:\n  - Plan page: https://allowed.test/plan\n\n' +
  'Documentation Links:\n  - Link: https://docs.allowed.test/guide\n\nOther Links:\n  - Credentials link: https://user:pw@allowed.test/x\n' +
  '  - Own site: https://app.test/help\n\n=== END LINKS ===\n';

const ENV = ['RAG_OUTPUT_GUARD', 'RAG_OUTPUT_LINK_ALLOWLIST', 'NEXT_PUBLIC_SITE_URL'] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

function setGuard(mode: string | undefined) {
  for (const name of ENV) delete process.env[name];
  if (mode !== undefined) process.env.RAG_OUTPUT_GUARD = mode;
  process.env.RAG_OUTPUT_LINK_ALLOWLIST = 'allowed.test';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.test';
}

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('links section and link instructions with the output guard (05.2-13, D-06)', () => {
  it.each([undefined, 'off'])('guard %s: both outputs are byte-identical to today', (mode) => {
    setGuard(mode);
    const instructions = createLinkUsageInstructions();
    expect(formatURLsForContext(URLS)).toBe(TODAY_LINKS);
    expect(formatURLsForContext([])).toBe('');
    expect(instructions).toContain('Include clickable links naturally in your response');
    expect(instructions).toContain('Examples of good link usage:');
  });

  for (const mode of ['flag', 'enforce']) {
    it(`guard ${mode}: only targets that pass allow rule 1 are listed`, () => {
      setGuard(mode);
      const section = formatURLsForContext(URLS);
      expect(section).toContain('https://allowed.test/plan');
      expect(section).toContain('https://docs.allowed.test/guide');
      expect(section).toContain('https://app.test/help');
      expect(section).not.toContain('other.test');
      expect(section).not.toContain('user:pw@');
      expect(section).not.toContain('Payment Links:');
    });

    it(`guard ${mode}: no allowlisted target leaves the empty string`, () => {
      setGuard(mode);
      expect(formatURLsForContext([URLS[1]!])).toBe('');
    });

    it(`guard ${mode}: the instructions refer only to the listed targets`, () => {
      setGuard(mode);
      const instructions = createLinkUsageInstructions();
      expect(instructions).toContain('RELEVANT LINKS');
      expect(instructions).toMatch(/only links listed in the "RELEVANT LINKS" section/i);
      expect(instructions).not.toContain('Include clickable links naturally');
      expect(instructions).not.toMatch(/https?:\/\//);
    });
  }
});
