import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { findCitationMarkers } from '@/lib/citations/marker-grammar';
import { resolveEvalPromptTemplate } from '@/lib/rag-eval/answer';
import { hasRefusalDirective, loadPromptDirectives } from '../eval/harness/prompt-directives.mts';
import {
  FAKE_UNSUPPORTED_ANSWERS,
  fakeCitationAnswer,
  installFakeCitationGenerator,
} from '../eval/harness/fake-citation-generator.mts';

const REFUSAL_TEXTS = JSON.parse(fs.readFileSync(path.resolve('eval/fixtures/refusal-texts.json'), 'utf8')) as Record<string, string[]>;
const LANGUAGES = ['zh', 'en', 'it'] as const;

const DIRECTIVE_SENTENCES: Record<(typeof LANGUAGES)[number], string> = {
  en: 'If the documents do not answer the question, say that you do not know.',
  it: "Se i documenti non rispondono alla domanda, di' che non lo sai.",
  zh: '如果文档没有回答这个问题，请说明你不知道。',
};

const NEGATED_SENTENCES: Record<(typeof LANGUAGES)[number], string> = {
  en: 'Always answer, even when the documents say nothing about the question.',
  it: 'Rispondi sempre, anche quando i documenti non dicono nulla sulla domanda.',
  zh: '总是回答问题，即使文档中没有相关内容。',
};

const CONCISE_PROMPT = 'You are a helpful assistant. Answer concisely and use short sentences.\n\nContext:\n{{context}}';

function labelledSystem(preamble: string): string {
  return `${preamble}\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===\n[S1] doc-1.md\nThe first block states one fact.\n\n[S2] doc-2.md\nThe second block states another fact.\n`;
}

function isAnyRefusal(text: string): boolean {
  return Object.values(REFUSAL_TEXTS).some((entries) => entries.some((entry) => entry.trim() === text.trim()));
}

describe('hasRefusalDirective', () => {
  it('detects the default assembled template of the eval route', () => {
    expect(hasRefusalDirective(resolveEvalPromptTemplate({}))).toBe(true);
  });

  it.each(LANGUAGES)('detects a synthetic refusal directive in %s', (language) => {
    expect(hasRefusalDirective(DIRECTIVE_SENTENCES[language])).toBe(true);
    expect(hasRefusalDirective(`${CONCISE_PROMPT}\n\n${DIRECTIVE_SENTENCES[language]}`)).toBe(true);
  });

  it('is false for a prompt that only asks for concise answers and for the empty string', () => {
    expect(hasRefusalDirective(CONCISE_PROMPT)).toBe(false);
    expect(hasRefusalDirective('')).toBe(false);
  });

  it.each(LANGUAGES)('does not detect a negated directive in %s', (language) => {
    expect(hasRefusalDirective(NEGATED_SENTENCES[language])).toBe(false);
  });

  it('drops the directive when the overlay prompt variables carry none (research F-5)', () => {
    const template = resolveEvalPromptTemplate({ RAG_PRE_CONTEXT: 'You are a helpful assistant.', RAG_POST_CONTEXT: 'Answer concisely.' });
    expect(hasRefusalDirective(template)).toBe(false);
    const withDirective = resolveEvalPromptTemplate({ RAG_PRE_CONTEXT: 'You are a helpful assistant.', RAG_POST_CONTEXT: DIRECTIVE_SENTENCES.en });
    expect(hasRefusalDirective(withDirective)).toBe(true);
  });

  it('loads patterns for zh, en and it, each with a negation list', () => {
    const directives = loadPromptDirectives();
    for (const language of LANGUAGES) {
      expect(directives.languages[language]?.directives.length ?? 0).toBeGreaterThan(0);
      expect(directives.languages[language]?.negations.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('runs every pattern against 20,000-character prompts within a time limit', () => {
    const directives = loadPromptDirectives();
    const shapes = [
      'a'.repeat(20_000),
      'if '.repeat(6_700),
      'if not available '.repeat(1_200),
      '如果没有'.repeat(5_000),
      'se non è '.repeat(2_300),
      'always answer even '.repeat(1_100),
    ];
    for (const entry of Object.values(directives.languages)) {
      for (const pattern of [...entry.directives, ...entry.negations]) {
        for (const shape of shapes) {
          const started = performance.now();
          pattern.test(shape);
          expect(performance.now() - started).toBeLessThan(250);
        }
      }
    }
  });
});

describe('instruction-sensitive fake generator (D-13)', () => {
  const directiveSystem = labelledSystem(`You answer from documents. ${DIRECTIVE_SENTENCES.en}`);
  const plainSystem = labelledSystem('You answer from documents. Answer concisely.');

  it.each(LANGUAGES)('refuses a no-answer question in %s only when the prompt carries the directive', (language) => {
    const question = `Synthetic no-answer question in ${language}`;
    const noAnswerQuestions = new Map([[question, language]]);
    const refusal = fakeCitationAnswer({ system: directiveSystem, question, noAnswerQuestions });
    expect(refusal).toBe(REFUSAL_TEXTS[language][0]);

    const unsupported = fakeCitationAnswer({ system: plainSystem, question, noAnswerQuestions });
    expect(unsupported).toBe(FAKE_UNSUPPORTED_ANSWERS[language]);
    expect(isAnyRefusal(unsupported)).toBe(false);
    expect(findCitationMarkers(unsupported)).toEqual([]);
  });

  it('keeps the no-context answer for a no-answer question without context', () => {
    const question = 'Synthetic question without context';
    const noAnswerQuestions = new Map([[question, 'it']]);
    expect(fakeCitationAnswer({ system: DIRECTIVE_SENTENCES.en, question, noAnswerQuestions })).toBe(
      fakeCitationAnswer({ system: DIRECTIVE_SENTENCES.en, question }),
    );
  });

  it('answers a question outside the no-answer set exactly as before, whatever the prompt', () => {
    const noAnswerQuestions = new Map([['Another question', 'en']]);
    for (const system of [directiveSystem, plainSystem, DIRECTIVE_SENTENCES.zh]) {
      for (const question of ['Synthetic answerable question one', 'Synthetic answerable question two']) {
        expect(fakeCitationAnswer({ system, question, noAnswerQuestions })).toBe(fakeCitationAnswer({ system, question }));
      }
    }
  });

  it('detects the directive on the assembled template, not on the wrapped system prompt (research F-5)', () => {
    const question = 'Synthetic no-answer question';
    const noAnswerQuestions = new Map([[question, 'en']]);
    const withoutDirective = resolveEvalPromptTemplate({ RAG_PRE_CONTEXT: 'You answer from documents.', RAG_POST_CONTEXT: 'Answer concisely.' });
    // The wrapper around the template carries its own directive; the template the operator edited does not.
    expect(fakeCitationAnswer({ system: directiveSystem, question, noAnswerQuestions, promptTemplate: withoutDirective })).toBe(
      FAKE_UNSUPPORTED_ANSWERS.en,
    );
    const withDirective = resolveEvalPromptTemplate({});
    expect(fakeCitationAnswer({ system: plainSystem, question, noAnswerQuestions, promptTemplate: withDirective })).toBe(
      REFUSAL_TEXTS.en[0],
    );
  });

  it('sees context in an unlabelled system prompt when the template is known, and none in the empty injection', () => {
    const question = 'Synthetic no-answer question';
    const noAnswerQuestions = new Map([[question, 'zh']]);
    const template = resolveEvalPromptTemplate({});
    const empty = template.replace('{{context}}', '');
    expect(fakeCitationAnswer({ system: empty, question, noAnswerQuestions, promptTemplate: template })).toBe(
      fakeCitationAnswer({ system: empty, question }),
    );
    const unlabelled = `${template.replace('{{context}}', '')}\nOne retrieved passage without a label.`;
    expect(fakeCitationAnswer({ system: unlabelled, question, noAnswerQuestions, promptTemplate: template })).toBe(REFUSAL_TEXTS.zh[0]);
  });

  it('is byte-identical to today when no no-answer set is installed', async () => {
    const question = 'Synthetic no-answer question';
    const legacy = await generateText({ model: installFakeCitationGenerator()('fake'), system: plainSystem, prompt: question });
    const withEmpty = await generateText({
      model: installFakeCitationGenerator(undefined, {})('fake'),
      system: plainSystem,
      prompt: question,
    });
    expect(withEmpty.text).toBe(legacy.text);
    expect(legacy.text).toBe(fakeCitationAnswer({ system: plainSystem, question }));
  });

  it('answers through the installed model in instruction-sensitive mode', async () => {
    const question = 'Synthetic no-answer question';
    const model = installFakeCitationGenerator(undefined, { noAnswerQuestions: new Map([[question, 'it']]) })('fake');
    const refused = await generateText({ model, system: directiveSystem, prompt: question });
    expect(refused.text).toBe(REFUSAL_TEXTS.it[0]);
    const answered = await generateText({ model, system: plainSystem, prompt: question });
    expect(answered.text).toBe(FAKE_UNSUPPORTED_ANSWERS.it);
  });

  it('refuses to install a no-answer language without a refusal text', () => {
    expect(() => installFakeCitationGenerator(undefined, { noAnswerQuestions: new Map([['q', 'xx']]) })).toThrow(/xx/);
  });
});
