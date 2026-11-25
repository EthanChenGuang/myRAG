import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { chatRequest } from '../helpers/chat-route-fakes';
import {
  expectCharacterization,
  startRouteFixture,
  systemTextOf,
  type RouteFixture,
} from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const GPT_PATTERN = /gpt-4|o1|chatgpt/;

function configuredModelIds(): string[] {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id);
}

function readSseText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
}

const OVERVIEW_QUERY = 'general information overview';
const OVERVIEW_DOCUMENT_ID = '00000000-0000-4000-8000-0000000000a9';
const EXTRA_DOCUMENT_ID = '00000000-0000-4000-8000-0000000000aa';

interface SeedChunk {
  id: string;
  index: number;
  total: number;
  embedded: string;
}

async function seedOverviewDocument(db: PGlite, documentId: string, filename: string, chunks: SeedChunk[]): Promise<void> {
  await db.query('INSERT INTO documents (id, filename, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
    documentId,
    filename,
    `${filename} overview body`,
    JSON.stringify({ relpath: `overview/${filename}` }),
    '2025-02-01T00:00:00.000Z',
  ]);
  for (const chunk of chunks) {
    await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)', [
      chunk.id,
      documentId,
      `Document: ${filename}. Chunk ${chunk.index} of ${chunk.total}. Content: ${chunk.embedded}`,
      `[${embedText(chunk.embedded).join(',')}]`,
      JSON.stringify({ chunk_index: chunk.index - 1, total_chunks: chunk.total }),
      '2025-02-01T00:00:00.000Z',
    ]);
  }
}

async function seedOverview(db: PGlite): Promise<void> {
  await seedOverviewDocument(db, OVERVIEW_DOCUMENT_ID, 'overview-notes.md', [
    { id: '00000000-0000-4000-8000-0000000000b9', index: 2, total: 2, embedded: `${OVERVIEW_QUERY} second part` },
    { id: '00000000-0000-4000-8000-0000000000b8', index: 1, total: 2, embedded: OVERVIEW_QUERY },
  ]);
  await seedOverviewDocument(db, EXTRA_DOCUMENT_ID, 'overview-extra.md', [
    { id: '00000000-0000-4000-8000-0000000000ba', index: 1, total: 1, embedded: 'general information shipping rates carriers' },
  ]);
}

describe('chat route characterization (general overview fallback, single tenant)', () => {
  let fixture: RouteFixture;
  const otherModel = configuredModelIds().find((id) => !GPT_PATTERN.test(id) && !id.includes('claude'));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', seed: seedOverview });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('builds the same system prompt for a message with no text in every rag mode', async () => {
    expect(otherModel).toBeTruthy();
    const { POST } = await fixture.loadRoute('chat');
    const actual: Array<Record<string, unknown>> = [];
    const logSpy = vi.mocked(console.log);
    for (const ragMode of ['strict', 'balanced', 'flexible'] as const) {
      h.capture.reset();
      logSpy.mockClear();
      const response = await POST(
        chatRequest({
          messages: [{ role: 'user', content: '' }],
          data: { ragMode, settings: { webSearch: false, model: otherModel as string } },
        }),
      );
      const body = await response.text();
      if (h.capture.calls.length === 0) {
        actual.push({ rag_mode: ragMode, refused: true, text: readSseText(body) });
      } else {
        expect(h.capture.calls).toHaveLength(1);
        const usedLog = logSpy.mock.calls.filter((call) => call[0] === 'API ROUTE: Used documents for context:').pop();
        actual.push({ rag_mode: ragMode, system: systemTextOf(h.capture.calls[0]), used_documents: usedLog ? usedLog[1] : null });
      }
    }
    expect(actual).toHaveLength(3);
    expect(actual.some((entry) => typeof entry.system === 'string' && entry.system.includes('=== Document:'))).toBe(true);
    expectCharacterization('chat-overview', actual);
  });
});
