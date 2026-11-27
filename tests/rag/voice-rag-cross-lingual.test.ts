import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { InProcessEval } from '../../eval/harness/run-eval.mts';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
// Placeholder secret for the signed scope token; never a real key.
const VOICE_SECRET = 'voice-token-placeholder-secret-'.padEnd(48, 'x');

/** Phase 6.2 D-16: one fixture cross_lingual item per question -> evidence language pair. */
const ITEM_PER_PAIR: Readonly<Record<string, string>> = {
  'en->it': 'xl-en-it-01',
  'en->zh': 'xl-en-zh-01',
  'it->en': 'xl-it-en-01',
  'it->zh': 'xl-it-zh-01',
  'zh->en': 'xl-zh-en-01',
  'zh->it': 'xl-zh-it-02',
};

interface GoldenRow {
  id: string;
  category: string;
  question: string;
  language: string;
  evidence_language: string | null;
  gold_evidence: Array<{ document: string }>;
}

const golden = new Map(
  fs
    .readFileSync(GOLDEN, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenRow)
    .map((row) => [row.id, row] as const),
);

describe('the real voice-rag route answers a cross-language question per language pair (Phase 6.2 D-16, XLG-07)', () => {
  let prepared: InProcessEval;
  let POST: (req: NextRequest) => Promise<Response>;
  let token = '';
  let filenames = new Map<string, string>();

  beforeAll(async () => {
    vi.resetModules();
    const harness = await import('../../eval/harness/run-eval.mts');
    prepared = await harness.prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      appEnv: { MYRAG_INTERNAL_API_KEY: INTERNAL_API_KEY, RAG_VOICE_TOKEN_SECRET: VOICE_SECRET },
      // Today's voice default: the legacy pipeline; the languages are pinned explicitly, never the shipped default.
      envOverrides: { RAG_PIPELINE: 'legacy', RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' },
    });
    const { mintVoiceToken } = await import('../../src/lib/rag/tenant/voice-token.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    token = minted.token;
    POST = ((await import('../../src/app/api/internal/voice-rag/route.ts')) as unknown as { POST: typeof POST }).POST;
    const docs = await prepared.fixtureDb.query<{ id: string; filename: string | null }>('select id, filename from public.documents');
    filenames = new Map(docs.rows.map((row) => [row.id, row.filename ?? '']));
  }, 300_000);

  afterAll(async () => {
    await prepared?.close();
  });

  function voiceRequest(query: string, scopeToken: string | null): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY };
    if (scopeToken !== null) headers['x-rag-scope-token'] = scopeToken;
    return new NextRequest('http://localhost/api/internal/voice-rag', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, matchCount: 5 }),
    });
  }

  it('rejects the question without a signed scope token', async () => {
    const row = golden.get(ITEM_PER_PAIR['en->it']!)!;
    expect((await POST(voiceRequest(row.question, null))).status).toBe(401);
  });

  for (const [pair, itemId] of Object.entries(ITEM_PER_PAIR)) {
    it(`${pair}: ${itemId} returns its gold document`, async () => {
      const row = golden.get(itemId);
      expect(row?.category).toBe('cross_lingual');
      expect(`${row!.language}->${row!.evidence_language}`).toBe(pair);
      const response = await POST(voiceRequest(row!.question, token));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { results?: Array<{ document_id: string }>; traceId?: string };
      const names = (body.results ?? []).map((result) => filenames.get(result.document_id));
      const gold = row!.gold_evidence.map((evidence) => evidence.document);
      expect(names.some((name) => name !== undefined && gold.includes(name)), `${itemId} got ${names.join(', ')}`).toBe(true);
    });
  }
});
