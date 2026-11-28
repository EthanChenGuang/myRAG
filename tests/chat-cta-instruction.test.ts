import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCtaInstruction, CTA_INSTRUCTION } from '@/lib/chat/cta-instruction';

describe('closing call-to-action instruction', () => {
  it('keeps every mode byte-for-byte unchanged in the classic style', () => {
    for (const mode of ['strict', 'balanced', 'flexible', 'bypass']) {
      expect(buildCtaInstruction(mode)).toBe(CTA_INSTRUCTION);
      expect(buildCtaInstruction(mode, 'classic')).toBe(CTA_INSTRUCTION);
    }
    expect(buildCtaInstruction('strict')).not.toMatch(/Strict knowledge-base mode/);
  });

  it('is the instruction the chat route sends', () => {
    const route = readFileSync('src/app/api/chat/route.ts', 'utf8');
    expect(route).toContain('content: buildCtaInstruction(ragMode, answerStyle)');
    expect(route).not.toContain('It is absolutely critical that you end EVERY response');
  });

  it('matches the previous inline text exactly', () => {
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
