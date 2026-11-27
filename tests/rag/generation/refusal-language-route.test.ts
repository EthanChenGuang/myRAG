import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolveAccessScopeInput } from '@/lib/rag/tenant/access';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse } from '../../helpers/chat-route-fakes';
import { fixedText } from '@/lib/rag/lang/texts';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { LEGACY_NO_INFORMATION_EN, LEGACY_NO_INFORMATION_ES, knowledgeBaseUnavailableMessage } from '@/lib/rag/generation/messages';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const ENV_NAMES = [
  'RAG_REGISTRY_TEXTS',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_DOC_ACCESS_GROUPS',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
] as const;
const env = process.env as Record<string, string | undefined>;

// Neutral synthetic questions. The it ones contain words the route's old heuristic counted as Spanish (la, una, con, es).
const QUESTIONS = {
  zh: '列表中第二项的数值是多少？',
  en: 'What is the value of the second item in the list?',
  it: 'Il documento è con la una sezione per il secondo passo?',
} as const;
const ITALIAN_VARIANTS = [
  QUESTIONS.it,
  'Qual è la regola per il modulo di esempio?',
  'Come posso trovare una sezione con il codice?',
  'Quale sezione descrive il secondo passo del processo?',
];
const SPANISH = '¿Cuántos pasos tiene el proceso descrito?';
const UNDETECTABLE = '42?';
const LANGS = ['zh', 'en', 'it'] as const;
const CONFIGURED = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' };

let accessRefusal = false;

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) delete env[name];
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
  Object.assign(env, values);
  resetLanguageSettingsForTests();
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      resolveAccessScope: (input: ResolveAccessScopeInput) =>
        accessRefusal
          ? Promise.resolve({ ok: false, status: 503, reason: 'access_lookup_failed' } as const)
          : actual.resolveAccessScope(input),
    };
  });
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

type Message = { role: 'user' | 'assistant'; content: string };

async function ask(messages: Message[] | string, uiLanguage: string): Promise<string> {
  const { POST } = await loadRoute();
  const list = typeof messages === 'string' ? [{ role: 'user' as const, content: messages }] : messages;
  return readSse(
    await POST(
      chatRequest({
        messages: list,
        data: { ragMode: 'strict', settings: { webSearch: false, language: uiLanguage } },
      }),
    ),
  );
}

function parts(body: string): Array<{ type?: string; delta?: string; errorText?: string }> {
  const out: Array<{ type?: string; delta?: string; errorText?: string }> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      out.push(JSON.parse(line.slice(5).trim()));
    } catch {
      continue;
    }
  }
  return out;
}

function streamedText(body: string): string {
  return parts(body)
    .filter((part) => part.type === 'text-delta' && typeof part.delta === 'string')
    .map((part) => part.delta)
    .join('');
}

function errorText(body: string): string | undefined {
  return parts(body).find((part) => part.type === 'error')?.errorText;
}

function noInformation(code: string): string {
  return fixedText('notices.no_information', code);
}

function unavailable(code: string): string {
  return fixedText('notices.kb_unavailable', code);
}

beforeEach(() => {
  accessRefusal = false;
  h.capture.reset();
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(emptyRetrieval());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('@/lib/rag');
  setEnv({});
  vi.restoreAllMocks();
});

describe.each([
  { name: 'registry texts off', extra: {} },
  { name: 'registry texts on', extra: { RAG_REGISTRY_TEXTS: 'true' } },
])('strict refusals follow the question language among the enabled languages ($name)', ({ extra }) => {
  beforeEach(() => setEnv({ ...CONFIGURED, ...extra }));

  it.each(LANGS)('information not available for a %s question on an en UI', async (code) => {
    const text = streamedText(await ask(QUESTIONS[code], 'en'));
    expect(text).toBe(noInformation(code));
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it.each(LANGS)('the access refusal for a %s question on a zh UI', async (code) => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    accessRefusal = true;
    const body = await ask(QUESTIONS[code], code === 'zh' ? 'en' : 'zh');
    expect(errorText(body)).toBe(unavailable(code));
    expect(streamedText(body)).toBe('');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('the English refusal stays byte-identical to today', async () => {
    expect(streamedText(await ask(QUESTIONS.en, 'it'))).toBe(LEGACY_NO_INFORMATION_EN);
  });

  it.each(ITALIAN_VARIANTS)('an Italian question is never answered in Spanish: %s', async (question) => {
    const text = streamedText(await ask(question, 'en'));
    expect(text).toBe(noInformation('it'));
    expect(text).not.toBe(LEGACY_NO_INFORMATION_ES);
  });
});

describe('a language that is not enabled is never chosen', () => {
  it('a Spanish question with a Spanish UI gets the primary language', async () => {
    setEnv({ RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' });
    const text = streamedText(await ask(SPANISH, 'es'));
    expect(text).toBe(noInformation('zh'));
    expect(text).not.toBe(LEGACY_NO_INFORMATION_ES);
  });

  it('a Spanish question on an en UI gets the enabled UI language, not the Spanish legacy text', async () => {
    setEnv(CONFIGURED);
    expect(streamedText(await ask(SPANISH, 'en'))).toBe(LEGACY_NO_INFORMATION_EN);
  });

  it('an Italian question while it is not enabled falls back to the UI language, then the primary', async () => {
    setEnv({ RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'zh' });
    expect(streamedText(await ask(QUESTIONS.it, 'en'))).toBe(LEGACY_NO_INFORMATION_EN);
    expect(streamedText(await ask(QUESTIONS.it, 'it'))).toBe(noInformation('zh'));
  });

  it('the access refusal for an Italian question while it is not enabled uses the primary language', async () => {
    setEnv({ RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'zh', RAG_DOC_ACCESS_GROUPS: 'on' });
    accessRefusal = true;
    expect(errorText(await ask(QUESTIONS.it, 'it'))).toBe(unavailable('zh'));
  });
});

describe('an undetectable question uses the fallback chain: previous turn, UI language, primary', () => {
  beforeEach(() => setEnv(CONFIGURED));

  it('the previous turn language', async () => {
    const messages: Message[] = [
      { role: 'user', content: QUESTIONS.it },
      { role: 'assistant', content: noInformation('it') },
      { role: 'user', content: UNDETECTABLE },
    ];
    expect(streamedText(await ask(messages, 'zh'))).toBe(noInformation('it'));
  });

  it('the UI language when it is enabled', async () => {
    expect(streamedText(await ask(UNDETECTABLE, 'zh'))).toBe(noInformation('zh'));
  });

  it('the primary language when the UI language is not enabled', async () => {
    setEnv({ RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'it' });
    expect(streamedText(await ask(UNDETECTABLE, 'es'))).toBe(noInformation('it'));
  });
});

describe('languages unset: today\'s legacy texts byte for byte (D-02, D-10)', () => {
  beforeEach(() => setEnv({}));

  it('an en UI gets the English refusal and the Spanish legacy heuristic is unchanged', async () => {
    expect(streamedText(await ask(QUESTIONS.en, 'en'))).toBe(LEGACY_NO_INFORMATION_EN);
    expect(streamedText(await ask(SPANISH, 'en'))).toBe(LEGACY_NO_INFORMATION_ES);
  });

  it('the access refusal keeps the UI-language unavailable message', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'on';
    accessRefusal = true;
    expect(errorText(await ask(QUESTIONS.it, 'zh'))).toBe(knowledgeBaseUnavailableMessage('zh'));
  });
});
