import { afterEach, describe, expect, it, vi } from 'vitest';
import { previousTurnLanguage, resolveAnswerLanguage } from '@/lib/rag/lang/answer-language';
import { createAnswerTurn } from '@/lib/rag/generation/answer-turn';
import { readAnswerConfig } from '@/lib/rag/generation/answer-config';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import * as detect from '@/lib/rag/lang/detect';

const ENABLED = ['zh', 'en', 'it'] as const;
const ZH_QUESTION = '这个流程一共有几个步骤？';
const IT_QUESTION = 'Qual è il passo successivo della procedura descritta?';
const ES_QUESTION = '¿Cuántos pasos tiene el proceso descrito?';
const SHORT_QUESTION = 'OK?';

function withLanguages(supported: string | undefined, primary: string | undefined): void {
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', supported ?? '');
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', primary ?? '');
  resetLanguageSettingsForTests();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLanguageSettingsForTests();
});

describe('resolveAnswerLanguage (D-09)', () => {
  it('takes a confident question language among the enabled ones', () => {
    expect(resolveAnswerLanguage({ question: ZH_QUESTION, previousTurnLanguage: 'it', uiLanguage: 'en', enabled: ENABLED, primary: 'en' })).toEqual({
      language: 'zh',
      source: 'question',
      confident: true,
    });
  });

  it('falls back to the previous turn when the question is not confident', () => {
    expect(resolveAnswerLanguage({ question: SHORT_QUESTION, previousTurnLanguage: 'it', uiLanguage: 'en', enabled: ENABLED, primary: 'en' })).toEqual({
      language: 'it',
      source: 'previous_turn',
      confident: false,
    });
  });

  it('uses an enabled UI language for a question in a language that is not enabled', () => {
    expect(resolveAnswerLanguage({ question: ES_QUESTION, previousTurnLanguage: null, uiLanguage: 'it', enabled: ENABLED, primary: 'en' })).toMatchObject({
      language: 'it',
      source: 'ui',
    });
  });

  it('uses the primary language when the UI language is not enabled either', () => {
    expect(resolveAnswerLanguage({ question: ES_QUESTION, previousTurnLanguage: null, uiLanguage: 'es', enabled: ENABLED, primary: 'zh' })).toMatchObject({
      language: 'zh',
      source: 'primary',
    });
  });

  it('never lets the UI language win over an enabled question language', () => {
    expect(resolveAnswerLanguage({ question: IT_QUESTION, previousTurnLanguage: 'zh', uiLanguage: 'en', enabled: ENABLED, primary: 'en' })).toMatchObject({
      language: 'it',
      source: 'question',
    });
  });

  it('ignores a previous-turn language that is not enabled', () => {
    expect(resolveAnswerLanguage({ question: SHORT_QUESTION, previousTurnLanguage: 'es', uiLanguage: 'zh', enabled: ENABLED, primary: 'en' })).toMatchObject({
      language: 'zh',
      source: 'ui',
    });
  });
});

describe('previousTurnLanguage', () => {
  it('reads the answerLanguage metadata of the last assistant message', () => {
    const messages = [
      { role: 'user', content: ZH_QUESTION },
      { role: 'assistant', content: 'A.', metadata: { answerLanguage: 'it' } },
      { role: 'user', content: SHORT_QUESTION },
    ];
    expect(previousTurnLanguage(messages, ENABLED)).toBe('it');
  });

  it('otherwise detects the previous user message when that detection is confident', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: IT_QUESTION }] },
      { role: 'assistant', content: 'A.' },
      { role: 'user', content: SHORT_QUESTION },
    ];
    expect(previousTurnLanguage(messages, ENABLED)).toBe('it');
  });

  it('is null without an earlier turn', () => {
    expect(previousTurnLanguage([{ role: 'user', content: SHORT_QUESTION }], ENABLED)).toBeNull();
  });
});

describe('createAnswerTurn (D-03, D-10)', () => {
  it('with every switch off runs no detector and uses the legacy texts', () => {
    withLanguages('zh,en,it', 'en');
    const spy = vi.spyOn(detect, 'detectLanguageWithConfidence');
    const turn = createAnswerTurn({
      config: readAnswerConfig({}),
      question: ZH_QUESTION,
      history: [{ role: 'user', content: ZH_QUESTION }],
      uiLanguage: 'en',
      channel: 'web',
      ragMode: 'strict',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(turn.textsSource).toBe('legacy');
    expect(turn.answerLanguage).toBeNull();
    expect(Object.isFrozen(turn)).toBe(true);
  });

  it('stays legacy while the languages are not configured, even with RAG_REGISTRY_TEXTS on', () => {
    withLanguages(undefined, undefined);
    const turn = createAnswerTurn({
      config: readAnswerConfig({ RAG_REGISTRY_TEXTS: 'true' }),
      question: ZH_QUESTION,
      history: [],
      uiLanguage: 'en',
      channel: 'web',
      ragMode: 'strict',
    });
    expect(turn.textsSource).toBe('legacy');
  });

  it('with RAG_REGISTRY_TEXTS on and configured languages reads the registry in the question language', () => {
    withLanguages('zh,en,it', 'en');
    const turn = createAnswerTurn({
      config: readAnswerConfig({ RAG_REGISTRY_TEXTS: 'true' }),
      question: ZH_QUESTION,
      history: [{ role: 'user', content: ZH_QUESTION }],
      uiLanguage: 'it',
      channel: 'whatsapp',
      ragMode: 'strict',
    });
    expect(turn).toMatchObject({ textsSource: 'registry', answerLanguage: 'zh', answerLanguageSource: 'question', channel: 'whatsapp' });
  });

  it('computes the previous turn from the history', () => {
    withLanguages('zh,en,it', 'en');
    const turn = createAnswerTurn({
      config: readAnswerConfig({ RAG_REGISTRY_TEXTS: 'true' }),
      question: SHORT_QUESTION,
      history: [
        { role: 'user', content: IT_QUESTION },
        { role: 'assistant', content: 'A.' },
        { role: 'user', content: SHORT_QUESTION },
      ],
      uiLanguage: 'en',
      channel: 'web',
      ragMode: 'strict',
    });
    expect(turn).toMatchObject({ answerLanguage: 'it', answerLanguageSource: 'previous_turn' });
  });
});
