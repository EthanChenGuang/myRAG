import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MODES,
  adminActor,
  asRole,
  createWorld,
  errorOf,
  purge,
  rows,
  seedLineage,
  verify,
  type PurgeWorld,
  type SeededLineage,
  type Tenant,
} from '../helpers/purge-fixture.mts';

// T-06.3-26 (G4): an image_upload document's picture lives under chat-images/<user>/, not rag/<tenant>/<lineage>/, so the lineage
// pattern alone never matched it. The purge now collects the chunks' metadata.image_url before the delete, scrubs saved chats by those
// URLs, keeps only their SHA-256 in the audit row and counts what is left under the store source_images.

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
type Json = Record<string, unknown>;

function uploadUrl(userId: string): string {
  return `https://storage.example.invalid/storage/v1/object/public/chat-images/${userId}/synthetic-upload-${crypto.randomUUID().slice(0, 8)}.png`;
}

async function markImageUpload(world: PurgeWorld, seeded: SeededLineage, url: string): Promise<void> {
  await world.db.query("UPDATE documents SET source = 'image_upload' WHERE lineage_id = $1", [seeded.lineageId]);
  await world.db.query(
    `UPDATE document_chunks SET metadata = jsonb_build_object('image_url', $2::text, 'is_image', true)
      WHERE id = (SELECT c.id FROM document_chunks c WHERE c.document_id = $1 ORDER BY c.id LIMIT 1)`,
    [seeded.versionIds[1], url],
  );
}

function messagesWith(urls: string[]): Json[] {
  return [
    { id: 'm-user', role: 'user', content: 'A synthetic question.' },
    {
      id: 'm-assistant',
      role: 'assistant',
      content: [
        { type: 'source_images', source_images: urls.map((url, i) => ({ name: `picture ${i}`, size: 0, type: 'image/png', url })) },
        { type: 'text', text: 'A synthetic answer.' },
      ],
    },
  ];
}

async function insertChat(world: PurgeWorld, tenant: Tenant, messages: Json[]): Promise<string> {
  const id = crypto.randomUUID();
  if (world.mode === 'multi-tenant') {
    await world.db.query("INSERT INTO chats (id, user_id, organization_id, title, messages) VALUES ($1, $2, $3, 'Synthetic chat', $4::jsonb)", [
      id,
      tenant.userId,
      tenant.orgId,
      JSON.stringify(messages),
    ]);
  } else {
    await world.db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 'Synthetic chat', $3::jsonb)", [id, tenant.userId, JSON.stringify(messages)]);
  }
  return id;
}

async function pictureUrls(world: PurgeWorld, chatId: string): Promise<string[]> {
  const found = await rows(world.db, 'SELECT messages FROM chats WHERE id = $1', [chatId]);
  const messages = (found[0]?.messages ?? []) as Array<{ content?: unknown }>;
  const content = (messages[1]?.content ?? []) as Json[];
  return ((content[0]?.source_images ?? []) as Json[]).map((image) => String(image.url));
}

for (const mode of MODES) {
  describe(`purge of an image_upload document scrubs its picture links (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    test('a saved chat loses the purged picture, keeps another picture, and verify counts source_images 0', async () => {
      const tenant = world.tenantA;
      const seeded = await seedLineage(world, tenant);
      const purged = uploadUrl(tenant.userId);
      const kept = uploadUrl(tenant.userId);
      await markImageUpload(world, seeded, purged);
      const chatId = await insertChat(world, tenant, messagesWith([purged, kept]));

      const result = await purge(world.db, tenant.key, seeded.lineageId, adminActor(world.adminA));
      assert.ok(Number(result.counts.chat_messages) >= 1, 'the chat was rewritten');
      assert.deepEqual(await pictureUrls(world, chatId), [kept]);

      const remaining = new Map((await verify(world.db, tenant.key, seeded.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(remaining.get('source_images'), 0, 'verify source_images');

      const audit = await rows(world.db, 'SELECT image_url_sha256, to_jsonb(a)::text AS whole FROM rag_purge_audit a WHERE lineage_id = $1', [seeded.lineageId]);
      assert.deepEqual(audit[0]?.image_url_sha256, [sha256(purged)], 'the audit keeps the hash of the picture URL');
      assert.ok(!String(audit[0]?.whole).includes('synthetic-upload'), 'the audit holds no URL');
    });

    test('a chat saved after the purge is counted by verify and cleared by a re-scrub', async () => {
      const tenant = world.tenantA;
      const seeded = await seedLineage(world, tenant);
      const purged = uploadUrl(tenant.userId);
      await markImageUpload(world, seeded, purged);
      await purge(world.db, tenant.key, seeded.lineageId, adminActor(world.adminA));

      const lateChat = await insertChat(world, tenant, messagesWith([purged]));
      const before = new Map((await verify(world.db, tenant.key, seeded.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(before.get('source_images'), 1, 'the late picture link is a leftover');

      const rescrub = await rows(world.db, 'SELECT public.rag_purge_scrub_chats($1, $2::uuid, $3::uuid[], now()) AS n', [tenant.key, seeded.lineageId, seeded.versionIds]);
      assert.equal(Number(rescrub[0]?.n), 1);
      assert.deepEqual(await pictureUrls(world, lateChat), []);
      const after = new Map((await verify(world.db, tenant.key, seeded.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(after.get('source_images'), 0);
    });

    if (mode === 'multi-tenant') {
      test("another tenant's chat with the same picture URL is not touched", async () => {
        const tenantB = world.tenantB;
        assert.ok(tenantB);
        const seeded = await seedLineage(world, world.tenantA);
        const purged = uploadUrl(world.tenantA.userId);
        await markImageUpload(world, seeded, purged);
        const foreign = await insertChat(world, tenantB, messagesWith([purged]));
        await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
        assert.deepEqual(await pictureUrls(world, foreign), [purged]);
      });
    }

    test('anon and authenticated get 42501 on the picture leftover count', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        const refused = await errorOf(() =>
          asRole(world.db, role, world.adminA, () =>
            world.db.query('SELECT public.rag_purge_chat_image_leftovers($1, $2::uuid, $3::text[])', [world.tenantA.key, crypto.randomUUID(), []]),
          ),
        );
        assert.equal(refused.code, '42501', role);
      }
    });
  });
}
