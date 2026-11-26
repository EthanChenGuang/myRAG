import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/output-guard/answers.json';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import {
  createOutputGuard,
  guardWholeText,
  type OutputGuardLinkSummary,
  type OutputGuardPolicy,
} from '@/lib/rag/security/output-guard';

interface FixtureAnswer {
  id: string;
  language: string;
  text: string;
  documentNames: string[];
  allowlist: string;
  webResultUrls: { url: string; flagged: boolean }[];
  userMessage: string;
  expect: { removed: string[]; kept: string[] };
}

const answers = fixture.answers as FixtureAnswer[];
const PAIR_LIMIT = 120;

function policyFor(answer: FixtureAnswer, mode: 'flag' | 'enforce'): OutputGuardPolicy {
  return {
    mode,
    placeholder: fixture.placeholder,
    links: createOutputLinkPolicy({
      allowlistValue: answer.allowlist,
      siteUrl: fixture.siteUrl,
      webResultUrls: answer.webResultUrls,
      userMessage: answer.userMessage,
      documentNames: answer.documentNames,
    }),
  };
}

function snapshot(summary: OutputGuardLinkSummary) {
  return { ...summary, removedTargets: [...summary.removedTargets] };
}

function feed(pieces: string[], policy: OutputGuardPolicy) {
  const guard = createOutputGuard(policy);
  let text = '';
  for (const piece of pieces) text += guard.push('answer', piece);
  text += guard.flush('answer');
  return { text, summary: snapshot(guard.summary()) };
}

describe('output guard fixture answers', () => {
  it('cover zh, en and it with at least four clean answers each', () => {
    for (const language of ['zh', 'en', 'it']) {
      const clean = answers.filter((answer) => answer.language === language && answer.expect.removed.length === 0);
      expect(clean.length, language).toBeGreaterThanOrEqual(4);
    }
  });

  for (const mode of ['enforce', 'flag'] as const) {
    describe(mode, () => {
      for (const answer of answers) {
        it(`${answer.id}: every split point equals the whole text`, () => {
          const policy = policyFor(answer, mode);
          const whole = guardWholeText(answer.text, policy);
          const expected = { text: whole.text, summary: snapshot(whole.summary) };
          const { text } = answer;
          expect(feed(Array.from(text), policy)).toEqual(expected);
          for (let i = 0; i <= text.length; i += 1) {
            expect(feed([text.slice(0, i), text.slice(i)], policy), `split ${i}`).toEqual(expected);
          }
          if (text.length < PAIR_LIMIT) {
            for (let i = 1; i < text.length; i += 1) {
              for (let j = i + 1; j < text.length; j += 1) {
                expect(feed([text.slice(0, i), text.slice(i, j), text.slice(j)], policy), `split ${i},${j}`).toEqual(
                  expected,
                );
              }
            }
          }
        });
      }
    });
  }

  for (const answer of answers) {
    it(`${answer.id}: keeps and removes the expected targets`, () => {
      const enforced = guardWholeText(answer.text, policyFor(answer, 'enforce'));
      const flagged = guardWholeText(answer.text, policyFor(answer, 'flag'));
      expect(flagged.text).toBe(answer.text);
      expect(flagged.summary.links_removed).toBe(enforced.summary.links_removed);
      for (const target of answer.expect.removed) expect(enforced.text).not.toContain(target);
      for (const target of answer.expect.kept) expect(enforced.text).toContain(target);
      if (answer.expect.removed.length === 0) {
        expect(enforced.summary.links_removed).toBe(0);
        expect(enforced.text).toBe(answer.text);
      } else {
        expect(enforced.summary.links_removed).toBeGreaterThan(0);
        expect(enforced.text).toContain(fixture.placeholder);
      }
    });
  }
});
