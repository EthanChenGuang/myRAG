import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCtaInstruction, CTA_INSTRUCTION } from '@/lib/chat/cta-instruction';

type AnswerStyleModule = typeof import('@/lib/chat/answer-style');

// Loaded by path so that, on code without the module, the suite fails on the assertion below rather than on import.
const moduleUrl = new URL('../src/lib/chat/answer-style.ts', import.meta.url).href;
const loaded = (await import(/* @vite-ignore */ moduleUrl).catch(() => null)) as AnswerStyleModule | null;
const stub = (() => '') as never;
const {
  buildConciseCtaInstruction,
  buildFormattingInstruction,
  CLASSIC_FORMATTING_INSTRUCTION,
  CONCISE_CTA_INSTRUCTION,
  resetAnswerStyleWarningsForTests,
  resolveAnswerStyle,
  STRICT_CONCISE_FOLLOWUP_ADDENDUM,
} = loaded ?? {
  buildConciseCtaInstruction: stub,
  buildFormattingInstruction: stub,
  CLASSIC_FORMATTING_INSTRUCTION: '',
  CONCISE_CTA_INSTRUCTION: '',
  resetAnswerStyleWarningsForTests: () => undefined,
  resolveAnswerStyle: stub,
  STRICT_CONCISE_FOLLOWUP_ADDENDUM: '',
};

describe('answer-style module', () => {
  it('exists', () => {
    expect(loaded).not.toBeNull();
  });
});

const MODES = ['strict', 'balanced', 'flexible', 'bypass'];

function inlineTemplate(source: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const start = source.indexOf('content: `', at);
  if (start < 0) return null;
  const from = start + 'content: `'.length;
  return source.slice(from, source.indexOf('`', from));
}

describe('RAG_ANSWER_STYLE resolution', () => {
  afterEach(() => resetAnswerStyleWarningsForTests());

  it('defaults to classic when unset or empty', () => {
    expect(resolveAnswerStyle(undefined)).toBe('classic');
    expect(resolveAnswerStyle('')).toBe('classic');
  });

  it('accepts classic and concise, ignoring case and whitespace', () => {
    expect(resolveAnswerStyle('classic')).toBe('classic');
    expect(resolveAnswerStyle('concise')).toBe('concise');
    expect(resolveAnswerStyle(' Concise ')).toBe('concise');
  });

  it('warns once for an invalid value and falls back to classic', () => {
    const warn = vi.fn();
    expect(resolveAnswerStyle('verbose', warn)).toBe('classic');
    expect(resolveAnswerStyle('verbose', warn)).toBe('classic');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/RAG_ANSWER_STYLE/);
  });
});

describe('classic answer style', () => {
  it('returns the historical formatting text byte for byte', () => {
    expect(buildFormattingInstruction('classic')).toBe(CLASSIC_FORMATTING_INSTRUCTION);
    expect(CLASSIC_FORMATTING_INSTRUCTION).toMatch(/^Always format your responses using this exact markdown structure:/);
    expect(CLASSIC_FORMATTING_INSTRUCTION).toContain('1. Start with a single clear H1 heading using # (not ##)');
    let previous: string;
    try {
      previous = execFileSync('git', ['show', 'origin/main:src/app/api/chat/route.ts'], { encoding: 'utf8' });
    } catch {
      return;
    }
    const inline = inlineTemplate(previous, "id: 'system-format-instruction',");
    if (inline && inline.startsWith('Always format')) expect(CLASSIC_FORMATTING_INSTRUCTION).toBe(inline);
  });

  it('keeps the CTA text unchanged in every mode, with no strict rule', () => {
    for (const mode of MODES) {
      expect(buildCtaInstruction(mode, 'classic')).toBe(CTA_INSTRUCTION);
      expect(buildCtaInstruction(mode)).toBe(CTA_INSTRUCTION);
      expect(buildCtaInstruction(mode, 'classic')).not.toContain(STRICT_CONCISE_FOLLOWUP_ADDENDUM);
      expect(buildCtaInstruction(mode, 'classic')).not.toMatch(/Strict knowledge-base mode/);
    }
  });

  it('matches the origin/main CTA text exactly', () => {
    let previous: string;
    try {
      previous = execFileSync('git', ['show', 'origin/main:src/app/api/chat/route.ts'], { encoding: 'utf8' });
    } catch {
      return;
    }
    const inline = inlineTemplate(previous, "id: 'system-cta-instruction',");
    if (inline && inline.startsWith('It is absolutely critical')) {
      for (const mode of MODES) expect(buildCtaInstruction(mode, 'classic')).toBe(inline);
    }
  });
});

describe('concise answer style', () => {
  it('replaces the H1 rule with concise format rules', () => {
    const format = buildFormattingInstruction('concise');
    expect(format).not.toContain('H1 heading');
    expect(format).not.toMatch(/^# /m);
    expect(format).toMatch(/one-line direct answer/);
    expect(format).toContain('- Label: **value** — detail');
    expect(format).toMatch(/Never use markdown headings/);
    expect(format).toMatch(/short bold label on its own line/);
    expect(format).toMatch(/same language the user wrote in/);
    expect(format).toContain('**Source:**');
    expect(format).not.toMatch(/encourages the user to continue the conversation/);
  });

  it('ends with a --- separator and ↳ follow-up lines in every mode', () => {
    for (const mode of MODES) {
      const cta = buildCtaInstruction(mode, 'concise');
      expect(cta.startsWith(CONCISE_CTA_INSTRUCTION)).toBe(true);
      expect(cta).toMatch(/^---$/m);
      expect(cta).toContain('↳ A related question?');
      expect(cta).toMatch(/up to 3 follow-up questions/);
      expect(cta).toMatch(/starting with "↳ "/);
      expect(cta).toMatch(/No heading, no intro or outro sentence and no paragraph/);
      expect(cta).not.toContain('It is absolutely critical');
    }
  });

  it('forbids general-knowledge follow-ups in strict mode only', () => {
    const strict = buildCtaInstruction('strict', 'concise');
    expect(strict).toBe(buildConciseCtaInstruction('strict'));
    expect(strict).toContain(STRICT_CONCISE_FOLLOWUP_ADDENDUM);
    expect(strict).toMatch(/answerable from the knowledge-base context/);
    expect(strict).toMatch(/Never suggest or offer general knowledge/);
    for (const mode of ['balanced', 'flexible', 'bypass']) {
      expect(buildCtaInstruction(mode, 'concise')).not.toContain(STRICT_CONCISE_FOLLOWUP_ADDENDUM);
    }
  });
});

describe('chat route wiring', () => {
  const route = readFileSync('src/app/api/chat/route.ts', 'utf8');

  it('resolves the style once and builds both instructions through the helpers', () => {
    expect(route).toContain('const answerStyle = resolveAnswerStyle(env.RAG_ANSWER_STYLE);');
    expect(route).toContain('content: buildFormattingInstruction(answerStyle),');
    expect(route).toContain('content: buildCtaInstruction(ragMode, answerStyle),');
    expect(route).not.toContain('Start with a single clear H1 heading');
  });

  it('feeds the same messages to the claude-citations text and both message assemblies', () => {
    expect(route).toContain('String(formattingSystemMessage.content),');
    expect(route).toContain('String(ctaSystemMessage.content),');
    expect(route.match(/^\s+formattingSystemMessage,$/gm)?.length).toBe(2);
    expect(route.match(/^\s+ctaSystemMessage,$/gm)?.length).toBe(2);
  });
});
