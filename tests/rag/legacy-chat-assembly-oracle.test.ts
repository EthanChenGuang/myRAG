import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readGoldenQuestions, startRouteFixture, type RouteFixture } from '../helpers/route-fixture';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORACLE_PATH = path.join(REPO_ROOT, 'tests/fixtures/legacy-chat-assembly.ts');
const CHAT_SNAPSHOT_PATH = path.join(REPO_ROOT, 'tests/fixtures/characterization/chat.json');
const ROUTE_AT_BASELINE = 'git show 172c2ad:src/app/api/chat/route.ts';

const REGION_START = '// CHANGE 2: Add keyword-based document filtering';
const REGION_END = "context.trim().toLowerCase().startsWith('no relevant context found');";

function extractRegion(text: string): string {
  const source = text.replace(/\r\n/g, '\n');
  const from = source.indexOf(REGION_START);
  expect(from, 'start marker missing').toBeGreaterThan(-1);
  expect(source.indexOf(REGION_START, from + 1), 'start marker is not unique').toBe(-1);
  const to = source.indexOf(REGION_END, from);
  expect(to, 'end marker missing').toBeGreaterThan(-1);
  return source.slice(from, to + REGION_END.length);
}

const normalize = (input: unknown): string => {
  if (typeof input === 'string') return input.toLowerCase();
  if (Array.isArray(input) && input.length > 0) {
    const textPart = input.find((part) => part.type === 'text');
    return textPart && typeof textPart.text === 'string' ? textPart.text.toLowerCase() : '';
  }
  return '';
};

describe('frozen chat assembly oracle', () => {
  it('contains the route region verbatim as of the baseline commit', () => {
    const routeAtBaseline = execSync(ROUTE_AT_BASELINE, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const region = extractRegion(routeAtBaseline);
    expect(region.length).toBeGreaterThan(10_000);
    const oracle = fs.readFileSync(ORACLE_PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(oracle.includes(region)).toBe(true);
    expect(oracle.split(REGION_START)).toHaveLength(2);
  });

  describe('executed against the fixture edge', () => {
    let fixture: RouteFixture;

    beforeAll(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    });

    afterAll(async () => {
      await fixture.close();
      vi.restoreAllMocks();
    });

    it.each(['en-general-001', 'en-compound-001'])('assembles a non-empty context for %s', async (itemId) => {
      vi.resetModules();
      const { legacyChatAssembly } = await import('../fixtures/legacy-chat-assembly');
      const { enhancedRetrieveChunks } = await import('@/lib/enhanced-rag-retrieval');
      const { getSupabaseAdmin } = await import('@/lib/supabase');
      const { formatURLsForContext } = await import('@/lib/url-extractor');
      const { getQueryEmbedding } = await import('@/lib/document-processor');
      const { env } = await import('@/lib/env');

      const question = readGoldenQuestions().find((item) => item.id === itemId)?.question as string;
      expect(question).toBeTruthy();
      const supabase = getSupabaseAdmin();
      expect(supabase).toBeTruthy();

      const enhanced = await enhancedRetrieveChunks(question, {
        maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),
        enableTemporalBoost: true,
        enableFinancialBoost: true,
        requireTemporalMatch: false,
        fallbackToLowerThreshold: true,
        organizationId: null,
        userId: null,
      });
      const similarChunks = enhanced.chunks.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        document_id: chunk.document_id,
        content: chunk.content,
        similarity: chunk.similarity,
        metadata: chunk.metadata as Record<string, any>,
        temporal_score: chunk.temporal_score,
        financial_score: chunk.financial_score,
        final_score: chunk.final_score,
        match_reason: chunk.match_reason,
      }));
      expect(similarChunks.length).toBeGreaterThan(0);

      const result = await legacyChatAssembly({
        supabase: supabase as NonNullable<typeof supabase>,
        queryText: question,
        similarChunks,
        usedDocuments: [],
        context: '',
        model: 'other/non-gpt-model',
        ragMode: 'strict',
        effectiveDisableRAG: false,
        webSearchEnabled: false,
        ragStartTime: Date.now(),
        normalize,
        formatURLsForContext,
        getQueryEmbedding,
      });

      expect(result.context.trim().length).toBeGreaterThan(0);
      expect(result.context.toLowerCase().startsWith('no relevant context found')).toBe(false);
      expect(result.context).toContain('=== RELEVANT INFORMATION FROM DOCUMENTS ===');
      expect(result.usedDocuments.length).toBeGreaterThan(0);
      expect(result.shouldRefuseCandidate).toBe(false);
      expect(fixture.edge.errors).toHaveLength(0);

      const snapshot = JSON.parse(fs.readFileSync(CHAT_SNAPSHOT_PATH, 'utf8')) as Array<{
        id: string;
        model_kind: string;
        system?: string;
      }>;
      const entry = snapshot.find((item) => item.id === itemId && item.model_kind === 'other');
      expect(entry?.system?.includes(result.context)).toBe(true);
    });
  });
});
