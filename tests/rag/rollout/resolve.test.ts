import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import {
  inCandidateArm,
  parseActiveRollout,
  resetRolloutCacheForTests,
  resolveRolloutArm,
  rolloutBucket,
  rolloutChunkingOverride,
  rolloutDetail,
  rolloutEmbeddingProfileId,
  type ActiveRollout,
} from '@/lib/rag/rollout/resolve';
import { hashedChunkingProfiles, requestChunkingOverride } from '@/lib/rag/v2/overrides';
import { mintScope } from '@/lib/rag/tenant/scope';

const MIGRATION = path.join(process.cwd(), 'supabase/migrations/0744_rag_rollouts.sql');

function keys(count: number, seed: string): string[] {
  return Array.from({ length: count }, (_, index) => {
    const hex = crypto.createHash('sha256').update(`${seed}:${index}`).digest('hex');
    return `u:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });
}

function rollout(partial: Partial<ActiveRollout>): ActiveRollout {
  return { id: '00000000-0000-4000-8000-000000000001', kind: 'embedding_profile', mode: 'tenants', sharePercent: null, salt: 'saltsalt01', included: [], excluded: [], embeddingProfileId: 'p2', ...partial };
}

describe('bucket parity', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const bucket = sql.match(/CREATE OR REPLACE FUNCTION public\.rag_rollout_bucket[\s\S]*?\$fn\$;/)?.[0];
    expect(bucket, 'rag_rollout_bucket is defined in 0744').toBeTruthy();
    await db.exec(`CREATE FUNCTION public.rag_assert_tenant_key(p_tenant_key text) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;`);
    await db.exec(bucket!);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('bucket parity: rag_rollout_bucket equals rolloutBucket for 10,000 keys', async () => {
    const salt = 'a1b2c3d4e5f60718';
    const sample = keys(10_000, 'parity');
    const rows = await db.query<{ k: string; b: number }>('SELECT k, public.rag_rollout_bucket($1, k) AS b FROM unnest($2::text[]) AS k', [salt, sample]);
    expect(rows.rows).toHaveLength(sample.length);
    const mismatches = rows.rows.filter((row) => Number(row.b) !== rolloutBucket(salt, row.k));
    expect(mismatches).toEqual([]);
  });

  it('the salt is part of the hash: two salts disagree on many keys', () => {
    const sample = keys(1_000, 'salt');
    const differing = sample.filter((key) => rolloutBucket('saltnumberone', key) !== rolloutBucket('saltnumbertwo', key));
    expect(differing.length).toBeGreaterThan(900);
  });
});

describe('membership', () => {
  const sample = keys(10_000, 'share');

  it('share 10 selects between 7 % and 13 % and the same keys on every call', () => {
    const share = rollout({ mode: 'share', sharePercent: 10 });
    const first = sample.filter((key) => inCandidateArm(share, key));
    expect(first.length).toBeGreaterThanOrEqual(700);
    expect(first.length).toBeLessThanOrEqual(1300);
    expect(sample.filter((key) => inCandidateArm(share, key))).toEqual(first);
  });

  it('an excluded key is never selected and an included key always is', () => {
    const selected = sample.find((key) => inCandidateArm(rollout({ mode: 'share', sharePercent: 50 }), key))!;
    const unselected = sample.find((key) => !inCandidateArm(rollout({ mode: 'share', sharePercent: 50 }), key))!;
    expect(inCandidateArm(rollout({ mode: 'share', sharePercent: 50, excluded: [selected] }), selected)).toBe(false);
    expect(inCandidateArm(rollout({ mode: 'share', sharePercent: 100, excluded: [selected] }), selected)).toBe(false);
    expect(inCandidateArm(rollout({ mode: 'share', sharePercent: 50, included: [unselected] }), unselected)).toBe(true);
    expect(inCandidateArm(rollout({ mode: 'tenants', included: [unselected], excluded: [unselected] }), unselected)).toBe(false);
    expect(inCandidateArm(rollout({ mode: 'tenants' }), selected)).toBe(false);
  });

  it('parses rows defensively: a bad kind, salt or share drops the row', () => {
    const row = { id: 'x', kind: 'embedding_profile', mode: 'tenants', share_percent: null, salt: 'saltsalt01', included_tenants: [], excluded_tenants: [], candidate_ref: { embedding_profile_id: 'p2' } };
    expect(parseActiveRollout(row)?.embeddingProfileId).toBe('p2');
    expect(parseActiveRollout({ ...row, kind: 'other' })).toBeNull();
    expect(parseActiveRollout({ ...row, salt: 'x' })).toBeNull();
    expect(parseActiveRollout({ ...row, mode: 'share', share_percent: 101 })).toBeNull();
    expect(parseActiveRollout({ ...row, included_tenants: ['not-a-key', 's:default'] })?.included).toEqual(['s:default']);
  });
});

describe('resolveRolloutArm', () => {
  const scope = mintScope('personal', '00000000-0000-4000-8000-0000000000a1', null);
  const key = 'u:00000000-0000-4000-8000-0000000000a1';
  let calls = 0;

  afterEach(() => {
    resetRolloutCacheForTests();
    resetRagDepsForTests();
    calls = 0;
  });

  function withRows(rows: unknown[]): void {
    setRagDepsForTests({
      now: () => 1_000,
      adminClient: () =>
        ({
          rpc: (fn: string) => {
            calls += 1;
            expect(fn).toBe('rag_rollout_active');
            const response = Promise.resolve({ data: rows, error: null });
            return Object.assign(response, { abortSignal: () => response });
          },
        }) as never,
    });
  }

  const embeddingRow = (included: string[]) => ({
    id: '00000000-0000-4000-8000-0000000000e1',
    kind: 'embedding_profile',
    mode: 'tenants',
    share_percent: null,
    salt: 'saltsalt01',
    included_tenants: included,
    excluded_tenants: [],
    candidate_ref: { embedding_profile_id: 'p2' },
  });

  it('reads nothing while RAG_ROLLOUTS is off', async () => {
    withRows([embeddingRow([key])]);
    expect(await resolveRolloutArm(scope, { rollouts: { enabled: false } })).toBeNull();
    expect(calls).toBe(0);
  });

  it('puts a listed tenant on the candidate arm and caches the read', async () => {
    withRows([
      embeddingRow([key]),
      { ...embeddingRow([]), id: '00000000-0000-4000-8000-0000000000c1', kind: 'chunking_profile', candidate_ref: { chunking_profile_ids: ['general:cp'] }, chunking_map: { general: 'cp' }, included_tenants: [key] },
    ]);
    const resolved = await resolveRolloutArm(scope, { rollouts: { enabled: true } });
    expect(rolloutEmbeddingProfileId(resolved)).toBe('p2');
    expect(rolloutChunkingOverride(resolved)).toEqual({ general: 'cp' });
    expect(rolloutDetail(resolved)).toBe('rollout=00000000-0000-4000-8000-0000000000e1:candidate rollout=00000000-0000-4000-8000-0000000000c1:candidate');
    await resolveRolloutArm(scope, { rollouts: { enabled: true } });
    expect(calls).toBe(1);
  });

  it('keeps an unlisted tenant on the incumbent arm with no query-side field', async () => {
    withRows([embeddingRow(['u:00000000-0000-4000-8000-0000000000b2'])]);
    const resolved = await resolveRolloutArm(scope, { rollouts: { enabled: true } });
    expect(resolved).toEqual([{ rolloutId: '00000000-0000-4000-8000-0000000000e1', kind: 'embedding_profile', arm: 'incumbent' }]);
    expect(rolloutEmbeddingProfileId(resolved)).toBeUndefined();
  });

  it('a failed read serves the incumbent', async () => {
    setRagDepsForTests({ now: () => 1_000, adminClient: () => ({ rpc: () => { throw new Error('down'); } }) as never });
    expect(await resolveRolloutArm(scope, { rollouts: { enabled: true } })).toBeNull();
  });
});

describe('the server-side chunking override', () => {
  const evalOverrides = { chunkingProfileByDocType: { general: 'eval-cp' } };

  it('eval overrides win over a rollout; other profiles take the rollout map', () => {
    expect(requestChunkingOverride('eval', evalOverrides, { general: 'rollout-cp' })).toEqual({ general: 'eval-cp' });
    expect(requestChunkingOverride('eval', undefined, { general: 'rollout-cp' })).toBeUndefined();
    expect(requestChunkingOverride('chat', evalOverrides, { general: 'rollout-cp' })).toEqual({ general: 'rollout-cp' });
    expect(requestChunkingOverride('chat', evalOverrides)).toBeUndefined();
    expect(requestChunkingOverride('voice', undefined, {})).toBeUndefined();
  });

  it('the hashed chunking profiles name the rollout candidate on top of the active pointers', () => {
    const active = { general: 'legacy', contract_legal: 'legacy' };
    expect(hashedChunkingProfiles('chat', active)).toBe(active);
    expect(hashedChunkingProfiles('chat', active, undefined, { general: 'rollout-cp' })).toEqual({ general: 'rollout-cp', contract_legal: 'legacy' });
  });
});
