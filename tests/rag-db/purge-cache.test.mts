import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { MODES, adminActor, count, createWorld, purge, rows, seedLineage, type PurgeWorld } from '../helpers/purge-fixture.mts';

async function insertEntry(db: PGlite, tenantKey: string, sources: unknown[]): Promise<string> {
  const keyHash = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{"text":"cached"}'::jsonb, $3::jsonb, false, now() + interval '1 hour')`,
    [tenantKey, keyHash, JSON.stringify(sources)],
  );
  return keyHash;
}

async function check(db: PGlite, tenantKey: string, keyHash: string): Promise<boolean> {
  const result = await rows(db, "SELECT hit FROM public.rag_cache_check($1, $2, 'p1', '[1,0,0,0]'::halfvec, 0.5)", [tenantKey, keyHash]);
  return result[0]?.hit === true;
}

for (const mode of MODES) {
  describe(`purge and the semantic cache (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    test('no semantic-cache row references the purged versions afterwards', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      const sources = [{ document_id: seeded.versionIds[1], version: 2 }];
      const keyHash = await insertEntry(world.db, world.tenantA.key, sources);
      assert.equal(await check(world.db, world.tenantA.key, keyHash), true, 'served before the purge');
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.equal(result.counts.semantic_cache, 2);
      const referencing = await count(
        world.db,
        `SELECT count(*) AS n FROM rag_semantic_cache c, jsonb_array_elements(c.source_versions) e(v)
          WHERE (e.v ->> 'document_id') = ANY ($1::text[])`,
        [seeded.versionIds],
      );
      assert.equal(referencing, 0);
    });

    test('a row stored again with the purged source versions is not served and is removed on the check', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      const sources = seeded.versionIds.map((id, index) => ({ document_id: id, version: index + 1 }));
      const current = await rows(world.db, 'SELECT public.rag_cache_sources_current($1, $2::jsonb) AS ok', [world.tenantA.key, JSON.stringify(sources)]);
      assert.equal(current[0]?.ok, false);
      const keyHash = await insertEntry(world.db, world.tenantA.key, sources);
      assert.equal(await check(world.db, world.tenantA.key, keyHash), false);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_semantic_cache WHERE key_hash = $1', [keyHash]), 0);
    });

    test('the other tenant keeps its cache entries', async (t) => {
      if (!world.tenantB) {
        t.skip('single-tenant has one tenant');
        return;
      }
      const foreign = await seedLineage(world, world.tenantB);
      const foreignHash = await insertEntry(world.db, world.tenantB.key, [{ document_id: foreign.versionIds[1], version: 2 }]);
      const seeded = await seedLineage(world, world.tenantA);
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_semantic_cache WHERE key_hash = $1', [foreignHash]), 1);
      assert.equal(await check(world.db, world.tenantB.key, foreignHash), true);
    });
  });
}
