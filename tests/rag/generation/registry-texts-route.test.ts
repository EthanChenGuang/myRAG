import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, emptyRetrieval, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';
import { systemTextOf } from '../../helpers/route-fixture';
import { fixedText } from '@/lib/rag/lang/texts';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import {
  knowledgeBaseUnavailableMessage,
  noKnowledgeBaseResponse,
  LEGACY_NO_INFORMATION_EN,
  LEGACY_NO_INFORMATION_ES,
} from '@/lib/rag/generation/messages';
import { citationInstruction } from '@/lib/rag/generation/citations/instructions';

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

const SWITCH_NAMES = ['RAG_REGISTRY_TEXTS', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'RAG_CITATIONS'] as const;

// Neutral synthetic questions, one per language; the Spanish one carries no en or it detection stopword.
const QUESTIONS = {
  en: 'What is the value of the second item in the list?',
  zh: '列表中第二项的数值是多少？',
  it: 'Qual è il valore del secondo elemento della lista?',
  es: '¿Cuántos pasos tiene el proceso descrito?',
} as const;

function setEnv(values: Partial<Record<(typeof SWITCH_NAMES)[number], string>>): void {
  for (const name of SWITCH_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  resetLanguageSettingsForTests();
}

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
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

async function ask(question: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const { POST } = await loadRoute();
  return readSse(
    await POST(
      chatRequest({
        messages: [{ role: 'user', content: question }],
        data: { ragMode: 'strict', settings: { webSearch: false, ...settings }, ...extra },
      }),
    ),
  );
}

beforeEach(() => {
  h.capture.reset();
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(emptyRetrieval());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setEnv({});
  h.supabase.store.documents = [];
  h.supabase.store.document_chunks = [];
  vi.restoreAllMocks();
});

describe('RAG_REGISTRY_TEXTS off: today\'s texts byte for byte (D-10, Pitfall 6)', () => {
  it.each([
    { name: 'English UI', question: QUESTIONS.en, language: 'en', expected: () => LEGACY_NO_INFORMATION_EN },
    { name: 'Spanish heuristic on an English UI', question: QUESTIONS.es, language: 'en', expected: () => LEGACY_NO_INFORMATION_ES },
    { name: 'zh UI', question: QUESTIONS.zh, language: 'zh', expected: () => LEGACY_NO_INFORMATION_EN },
  ])('the refusal for $name', async ({ question, language, expected }) => {
    for (const env of [{}, { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' }, { RAG_REGISTRY_TEXTS: 'true' }]) {
      setEnv(env);
      const text = streamedText(await ask(question, { language }));
      expect(text).toBe(expected());
      expect(text).toBe(noKnowledgeBaseResponse(language === 'en' && question === QUESTIONS.es ? 'es' : language));
    }
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('the unavailable message for a zh UI', async () => {
    setEnv({ RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' });
    h.retrieval.mockRejectedValue(new Error('backend down'));
    expect(errorText(await ask(QUESTIONS.it, { language: 'zh' }))).toBe(knowledgeBaseUnavailableMessage('zh'));
  });
});

describe('RAG_REGISTRY_TEXTS on with zh, en and it enabled (D-09, D-10)', () => {
  beforeEach(() => setEnv({ RAG_REGISTRY_TEXTS: 'true', RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' }));

  it.each(['zh', 'it'] as const)('a %s question gets the registry refusal in its language whatever the UI language', async (code) => {
    const text = streamedText(await ask(QUESTIONS[code], { language: 'en' }));
    expect(text).toBe(fixedText('notices.no_information', code));
    expect(text).not.toBe(LEGACY_NO_INFORMATION_EN);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('an en question gets exactly today\'s English refusal', async () => {
    expect(streamedText(await ask(QUESTIONS.en, { language: 'zh' }))).toBe(LEGACY_NO_INFORMATION_EN);
  });

  it('a Spanish question follows the fallback chain: an enabled UI language', async () => {
    expect(streamedText(await ask(QUESTIONS.es, { language: 'it' }))).toBe(fixedText('notices.no_information', 'it'));
  });

  it('a Spanish question with a UI language that is not enabled gets the primary language, never the legacy Spanish', async () => {
    setEnv({ RAG_REGISTRY_TEXTS: 'true', RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' });
    const text = streamedText(await ask(QUESTIONS.es, { language: 'es' }));
    expect(text).toBe(fixedText('notices.no_information', 'zh'));
    expect(text).not.toBe(LEGACY_NO_INFORMATION_ES);
  });

  it('the unavailable message follows the answer language', async () => {
    h.retrieval.mockRejectedValue(new Error('backend down'));
    expect(errorText(await ask(QUESTIONS.it, { language: 'zh' }))).toBe(fixedText('notices.kb_unavailable', 'it'));
  });

  it('the citation instruction comes from the registry in the answer language', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.supabase.store.documents = [{ id: 'doc-1', filename: 'notes.md', created_at: '2026-01-01T00:00:00.000Z', content: null, metadata: {} }];
    h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
    h.retrieval.mockResolvedValue(
      retrievalWith([
        {
          chunk_id: 'chunk-1',
          document_id: 'doc-1',
          content: 'Il secondo elemento della lista ha il valore B.',
          similarity: 0.9,
          metadata: null,
          temporal_score: 0,
          financial_score: 0,
          final_score: 0.9,
          match_reason: 'similarity',
        },
      ]),
    );
    await ask(QUESTIONS.it, { language: 'en' }, { capabilities: { citations: true } });
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain(fixedText('instructions.citation', 'it'));
    expect(system).not.toContain(citationInstruction('en'));
  });
});
