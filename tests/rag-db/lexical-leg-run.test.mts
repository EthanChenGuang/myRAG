import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { serviceRoleRpc } from '../../eval/harness/two-tenant-v2.mts';
import {
  LEGS_FILE,
  LexicalLegError,
  MANIFEST_FILE,
  assertGitIgnored,
  lexicalLegArms,
  lexicalOnlyHybridArgs,
  main,
  parseLexicalLegArgs,
  runLexicalLegs,
  writeLexicalLegs,
  type LexicalLegItem,
} from '../../eval/harness/lexical-leg-run.mts';
import { queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize.ts';

/**
 * D-37, R-13: the lexical-leg harness command on a single-tenant PGlite fixture. Text is generated neutral tokens (w0..wN) only (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = 's:default';
const PROFILE = 'openai-3-small-1536';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Zipf-like draws over w0..w39, so common and rare tokens both occur. */
function sentence(rng: () => number, length: number): string {
  const words: string[] = [];
  for (let i = 0; i < length; i += 1) words.push(`w${Math.floor(40 * rng() * rng())}`);
  return words.join(' ');
}

async function seed(db: PGlite): Promise<void> {
  const rng = lcg(7);
  for (let d = 0; d < 6; d += 1) {
    const docId = crypto.randomUUID();
    await db.query(
      `INSERT INTO public.documents (id, filename, content, metadata, doc_type, language, is_current, status)
       VALUES ($1, $2, 'neutral sample', '{}'::jsonb, 'general', 'en', true, 'ready')`,
      [docId, `legs-${d}.txt`],
    );
    for (let c = 0; c < 8; c += 1) {
      const text = sentence(rng, 6 + Math.floor(rng() * 20));
      await db.query(
        `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
           chunking_profile_id, status, is_current)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $3, 'en', 'general', 'text', 'legacy', 'ready', true)`,
        [crypto.randomUUID(), docId, text, c],
      );
    }
  }
}

const ITEMS: LexicalLegItem[] = [
  { id: 'syn-legs-001', question: 'w1 w3 w7', language: 'en' },
  { id: 'syn-legs-002', question: 'w0 w12', language: 'en' },
  { id: 'syn-legs-003', question: 'w25 w2 w2 w9', language: 'en' },
  { id: 'syn-legs-004', question: '?? !!', language: 'en' },
];

describe('lexical-leg harness command (D-37)', () => {
  let db: PGlite;
  const tmp: string[] = [];

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await seed(db);
  });

  after(async () => {
    await db?.close().catch(() => undefined);
    for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a tenant without ready statistics exits with lexical_stats_not_ready and returns no partial output', async () => {
    await assert.rejects(
      runLexicalLegs({ rpc: serviceRoleRpc(db), tenantKey: TENANT, items: ITEMS, arms: lexicalLegArms() }),
      (error: unknown) => error instanceof LexicalLegError && error.code === 'lexical_stats_not_ready',
    );
  });

  test('with ready statistics every item has a ts_rank_cd and a bm25 arm of at most 50 hits, ts_rank_cd equal to a direct lexical leg', async () => {
    await db.query("SELECT public.rag_lexstats_enable('s:default')");
    await db.query("SELECT public.rag_lexstats_rebuild('s:default')");
    const rpc = serviceRoleRpc(db);
    const result = await runLexicalLegs({ rpc, tenantKey: TENANT, items: ITEMS, arms: lexicalLegArms() });
    assert.equal(result.items.length, ITEMS.length);
    for (const [index, item] of result.items.entries()) {
      const question = ITEMS[index]!.question;
      const tokens = queryLexicalTokens(question);
      assert.equal(item.item_id, ITEMS[index]!.id);
      assert.equal(item.token_count, tokens.length);
      assert.deepEqual(Object.keys(item.arms).sort(), ['bm25', 'ts_rank_cd']);
      for (const hits of Object.values(item.arms)) assert.ok(hits.length <= 50);
      if (tokens.length === 0) {
        assert.deepEqual(item.arms.ts_rank_cd, []);
        assert.deepEqual(item.arms.bm25, []);
        continue;
      }
      const direct = await rpc.rpc('hybrid_search_chunks', lexicalOnlyHybridArgs(TENANT, PROFILE, tokens, 50));
      assert.equal(direct.error, null);
      const expected = (direct.data as Array<Record<string, unknown>>)
        .filter((row) => row.leg === 'lexical')
        .sort((a, b) => Number(a.rank) - Number(b.rank))
        .map((row) => String(row.chunk_id));
      assert.ok(expected.length > 0, `question ${index} matches chunks`);
      assert.deepEqual(
        item.arms.ts_rank_cd!.map((hit) => hit.chunk_id),
        expected,
      );
      assert.ok(item.arms.bm25!.length > 0);
      assert.ok(item.arms.bm25!.every((hit) => hit.document_name?.startsWith('legs-') && hit.content.length > 0));
      assert.deepEqual(new Set(item.arms.bm25!.map((hit) => hit.chunk_id)), new Set(expected), 'both arms rank the same matches');
    }
  });

  test('the tokens come from the application tokenizer with the options the search stage would use', async () => {
    const seen: string[] = [];
    const result = await runLexicalLegs({
      rpc: serviceRoleRpc(db),
      tenantKey: TENANT,
      items: ITEMS.slice(0, 1),
      arms: lexicalLegArms(),
      lexicalOptionsFor: async (question) => {
        seen.push(question);
        return { stemIt: true, language: 'it' };
      },
    });
    assert.deepEqual(seen, [ITEMS[0]!.question]);
    assert.equal(result.items[0]!.token_count, queryLexicalTokens(ITEMS[0]!.question, { stemIt: true, language: 'it' }).length);
    assert.equal(result.options.stem_it, true);
  });

  test('k1 and b lists give one labelled bm25 arm per combination, capped at 9', async () => {
    const arms = lexicalLegArms([0.9, 1.2], [0.5, 0.75]);
    assert.deepEqual(
      arms.map((arm) => arm.label),
      ['ts_rank_cd', 'bm25:k1=0.9,b=0.5', 'bm25:k1=0.9,b=0.75', 'bm25:k1=1.2,b=0.5', 'bm25:k1=1.2,b=0.75'],
    );
    const result = await runLexicalLegs({ rpc: serviceRoleRpc(db), tenantKey: TENANT, items: ITEMS.slice(0, 1), arms });
    assert.deepEqual(Object.keys(result.items[0]!.arms).sort(), arms.map((arm) => arm.label).sort());
    assert.notDeepEqual(
      result.items[0]!.arms['bm25:k1=0.9,b=0.5']!.map((hit) => hit.chunk_id).join(),
      '',
    );
    assert.throws(() => lexicalLegArms([0.5, 0.9, 1.2, 1.5], [0.25, 0.75, 1]), (error: unknown) => error instanceof LexicalLegError && error.code === 'bad_arguments');
  });

  test('the output holds ids, names and content per arm, and the manifest holds the eval-set hash and the lexical options', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-legs-'));
    tmp.push(out);
    const result = await runLexicalLegs({ rpc: serviceRoleRpc(db), tenantKey: TENANT, items: ITEMS, arms: lexicalLegArms() });
    const manifest = writeLexicalLegs(out, result, {
      schema_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      eval_set_sha256: 'a'.repeat(64),
      tenant_hash: 'b'.repeat(12),
      profile_id: PROFILE,
      limit: 50,
      arms: lexicalLegArms(),
    });
    assert.equal(manifest.item_count, ITEMS.length);
    assert.equal(manifest.empty_token_items, 1);
    const written = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8'));
    assert.equal(written.eval_set_sha256, 'a'.repeat(64));
    assert.deepEqual(written.lexical_options, { stem_it: false, dictionary_version: null, identifier_patterns: 0, quantity: false });
    assert.equal(JSON.stringify(written).includes('w1'), false, 'the manifest holds no question or token text');
    const lines = fs.readFileSync(path.join(out, LEGS_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, ITEMS.length);
    assert.equal(Object.hasOwn(lines[0], 'question'), false);
  });

  test('the command refuses without the environment, refuses an output that is not git-ignored, and prints counts only', async () => {
    const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    try {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      assert.equal(await main(['--golden', 'eval/fixtures/golden.jsonl', '--tenant', TENANT, '--out', 'eval/out/legs'], io), 1);
      assert.equal(await main(['--golden', 'x', '--tenant', 'not-a-key', '--out', 'eval/out/legs'], io), 2);
    } finally {
      if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
    assert.ok(lines.every((line) => !line.includes('w1') && !line.includes('w3')));
    assert.throws(() => assertGitIgnored('eval/config/legs', REPO_ROOT), (error: unknown) => error instanceof LexicalLegError && error.code === 'out_not_ignored');
    assert.throws(() => assertGitIgnored('../outside', REPO_ROOT), (error: unknown) => error instanceof LexicalLegError && error.code === 'out_not_ignored');
    assert.doesNotThrow(() => assertGitIgnored('eval/out/legs', REPO_ROOT));
    assert.doesNotThrow(() => assertGitIgnored('eval/reports/phase-04.4/private/legs', REPO_ROOT));
    assert.deepEqual(parseLexicalLegArgs(['--golden', 'g', '--tenant', TENANT, '--out', 'o', '--k1', '0.9,1.2']).k1, [0.9, 1.2]);
  });
});
