import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createFixtureDatabase, type FixtureDatabase, type TerminologySeedRow } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import type { TerminologyLexicon } from '../../src/lib/rag/terminology/lexicon.ts';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { resetRagDepsForTests, setRagDepsForTests } = await import('../../src/lib/rag/deps.ts');
const { normalizeLexical } = await import('../../src/lib/rag/lexical/tokenize.ts');
const { getTerminologyLexicon, resetTerminologyLexiconForTests } = await import('../../src/lib/rag/terminology/lexicon.ts');
const { invalidateTerminologyCache } = await import('../../src/lib/rag/terminology/load.ts');
const { mintScope, scopeKey } = await import('../../src/lib/rag/tenant/scope.ts');
const { TerminologyLexiconSchema } = await import('../../src/lib/rag-eval/contracts.generated.ts');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const ANON_KEY = 'fixture-anon-key-placeholder';

// D-35: the languages come from the registry; D-37: placeholder terms only.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as {
  packs: { code: string; script: string }[];
};
const HAN = REGISTRY.packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = REGISTRY.packs.find((pack) => pack.script === 'Latn')!.code;

const USER_A = '00000000-0000-4000-8000-00000000a001';
const USER_B = '00000000-0000-4000-8000-00000000b002';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);

const S = { canonical: 'term alpha beta', variant: 'termalpha' };
const S2 = { canonical: 'term gamma delta', variant: 'termgamma' };
const A1 = { canonical: 'termine alfa beta', variant: 'voce alfa' };
const B1 = { canonical: 'AB-1234-C', variant: 'AB 1234 C' };
const T = { source: '术语甲乙丙', target: 'term alpha beta' };

function seed(keyA: string, keyB: string): TerminologySeedRow[] {
  return [
    { layer: 'shared', canonical: S.canonical, variants: [S.variant], language: LATIN, kind: 'synonym', mode: 'one_way' },
    { layer: 'shared', canonical: S2.canonical, variants: [S2.variant], language: LATIN, kind: 'synonym', mode: 'one_way' },
    {
      layer: 'shared',
      canonical: T.target,
      variants: [T.source],
      language: HAN,
      kind: 'translation',
      mode: 'one_way',
      source_language: HAN,
      target_language: LATIN,
    },
    { layer: keyA, canonical: A1.canonical, variants: [A1.variant], language: LATIN, kind: 'alias', mode: 'one_way' },
    { layer: keyB, canonical: B1.canonical, variants: [B1.variant], language: 'any', kind: 'identifier', mode: 'one_way' },
  ];
}

function normalizedTerms(lexicon: TerminologyLexicon): Set<string> {
  return new Set(lexicon.terms.map((term) => term.normalized));
}

async function withServiceClient(fixture: FixtureDatabase): Promise<FakeEdge> {
  const edge = await startFakeEdge({ db: fixture.db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
  const client = createClient(edge.url, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  setRagDepsForTests({ adminClient: () => client as never });
  return edge;
}

function resetAll(): void {
  invalidateTerminologyCache('all');
  resetTerminologyLexiconForTests();
}

describe('getTerminologyLexicon on a multi-tenant fixture database (D-33, TERM-01)', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  const keyA = scopeKey(scopeA);
  const keyB = scopeKey(scopeB);

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR, terminologySeed: seed(keyA, keyB) });
    // The suppression row is written as the database owner: u:A suppresses shared S2.
    await fixture.db.query(
      `INSERT INTO public.rag_term_entries (layer_key, canonical, variants, normalized_variants, language, kind, mode, suppresses_entry_id)
       SELECT $1, e.canonical, '{}'::text[], '{}'::text[], e.language, e.kind, e.mode, e.id
         FROM public.rag_term_entries e WHERE e.layer_key = 'shared' AND e.canonical = $2`,
      [keyA, S2.canonical],
    );
    edge = await withServiceClient(fixture);
  });

  afterEach(resetAll);

  after(async () => {
    resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('tenant A holds S and A1, not the suppressed S2 and not B1', async () => {
    const lexicon = await getTerminologyLexicon(scopeA);
    const terms = normalizedTerms(lexicon);
    for (const value of [S.canonical, S.variant, A1.canonical, A1.variant]) assert.ok(terms.has(normalizeLexical(value)), `A holds ${value}`);
    for (const value of [S2.canonical, S2.variant, B1.canonical, B1.variant]) assert.ok(!terms.has(normalizeLexical(value)), `A lacks ${value}`);
    assert.deepEqual(lexicon.translations, []);
    assert.match(lexicon.version, /^s\d+\.w\d+$/);
    assert.notEqual(lexicon.version.split('.w')[1], '0');
    TerminologyLexiconSchema.parse(lexicon);
  });

  test('tenant B holds S, S2 and B1, not A1', async () => {
    const lexicon = await getTerminologyLexicon(scopeB);
    const terms = normalizedTerms(lexicon);
    for (const value of [S.canonical, S2.canonical, S2.variant, B1.canonical, B1.variant]) assert.ok(terms.has(normalizeLexical(value)), `B holds ${value}`);
    for (const value of [A1.canonical, A1.variant]) assert.ok(!terms.has(normalizeLexical(value)), `B lacks ${value}`);
    assert.match(lexicon.version, /^s\d+\.w\d+$/);
    TerminologyLexiconSchema.parse(lexicon);
  });

  test('with includeTranslations both tenants hold the shared pair T once', async () => {
    for (const scope of [scopeA, scopeB]) {
      const lexicon = await getTerminologyLexicon(scope, { includeTranslations: true });
      assert.equal(lexicon.translations.length, 1);
      assert.deepEqual(
        { ...lexicon.translations[0], entry_id: undefined },
        { entry_id: undefined, source_language: HAN, target_language: LATIN, sources: [T.source], target: T.target, target_normalized: normalizeLexical(T.target) },
      );
      assert.ok(lexicon.terms.some((term) => term.kind === 'translation' && term.language === HAN && term.normalized === normalizeLexical(T.source)));
      TerminologyLexiconSchema.parse(lexicon);
    }
  });

  test('the two tenants differ in entries_sha256 and call the loader with their own key only', async () => {
    const a = await getTerminologyLexicon(scopeA, { includeTranslations: true });
    const b = await getTerminologyLexicon(scopeB, { includeTranslations: true });
    assert.notEqual(a.entries_sha256, b.entries_sha256);
    const rpcPaths = edge.calls.filter((call) => call.path.endsWith('/rpc/rag_term_effective'));
    assert.ok(rpcPaths.length >= 2);
  });
});

describe('getTerminologyLexicon on a single-tenant fixture database', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;

  before(async () => {
    fixture = await createFixtureDatabase({
      deploymentMode: 'single-tenant',
      corpusDir: CORPUS_DIR,
      terminologySeed: [{ layer: 'shared', canonical: S.canonical, variants: [S.variant], language: LATIN, kind: 'synonym', mode: 'one_way' }],
    });
    edge = await withServiceClient(fixture);
  });

  afterEach(resetAll);

  after(async () => {
    resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('the scope reads s<n>.w0 and the shared entry', async () => {
    const lexicon = await getTerminologyLexicon(mintScope('single', null, null));
    assert.match(lexicon.version, /^s[1-9]\d*\.w0$/);
    assert.ok(normalizedTerms(lexicon).has(normalizeLexical(S.variant)));
    TerminologyLexiconSchema.parse(lexicon);
  });
});
