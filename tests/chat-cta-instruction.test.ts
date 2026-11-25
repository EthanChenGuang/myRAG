import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCtaInstruction, CTA_INSTRUCTION, STRICT_CTA_ADDENDUM } from '@/lib/chat/cta-instruction';

describe('closing call-to-action instruction', () => {
  it('keeps balanced, flexible and bypass byte-for-byte unchanged', () => {
    for (const mode of ['balanced', 'flexible', 'bypass']) {
      expect(buildCtaInstruction(mode)).toBe(CTA_INSTRUCTION);
    }
  });

  it('adds the knowledge-base-only rule in strict mode', () => {
    const strict = buildCtaInstruction('strict');
    expect(strict.startsWith(CTA_INSTRUCTION)).toBe(true);
    expect(strict).toContain(STRICT_CTA_ADDENDUM);
    expect(strict).toMatch(/Never offer to share general knowledge/);
  });

  it('is the instruction the chat route sends', () => {
    const route = readFileSync('src/app/api/chat/route.ts', 'utf8');
    expect(route).toContain('content: buildCtaInstruction(ragMode)');
    expect(route).not.toContain('It is absolutely critical that you end EVERY response');
  });

  it('matches the previous inline text exactly for non-strict modes', () => {
    let previous: string;
    try {
      previous = execFileSync('git', ['show', 'origin/main:src/app/api/chat/route.ts'], { encoding: 'utf8' });
    } catch {
      return;
    }
    const marker = "id: 'system-cta-instruction',";
    if (!previous.includes(marker) || !previous.includes('It is absolutely critical')) return;
    const start = previous.indexOf('content: `', previous.indexOf(marker)) + 'content: `'.length;
    const end = previous.indexOf('`', start);
    expect(CTA_INSTRUCTION).toBe(previous.slice(start, end));
  });
});
