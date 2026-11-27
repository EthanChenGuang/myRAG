import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from './fixture-embedder.mts';
import { createFixtureDatabase, runFixtureRelex, type DeploymentMode } from './pglite-supabase.mts';
import { clusterLookupCopies, seedLookupRows, type V2LookupOwner } from './two-tenant-v2.mts';

/**
 * Phase 4.3 same-tenant cross-group canary seed (EVAL-21, D-32, RESEARCH section 12). One tenant per database (an organization in
 * multi-tenant mode, s:default in single-tenant mode) with the identities member-a, member-b, outsider and an admin, the groups group-a
 * and group-b, and per language one synthetic neutral document restricted to group-a that carries a marker word for every path (child,
 * parent, exact id, image), plus one document labelled all as the control. Groups, members and labels are written through the real
 * SQL functions (rag_access_group_create, rag_access_member_add, rag_set_document_access_groups). The restricted documents live only in
 * this harness, never in eval/fixtures/corpus, so the golden baseline does not move. All content is synthetic and neutral.
 */

export const ACCESS_LANGUAGES = ['zh', 'en', 'it'] as const;
export type AccessLanguage = (typeof ACCESS_LANGUAGES)[number];

export function accessFixtureId(n: number): string {
  return `00000000-0000-4000-8000-${(0xac0000 + n).toString(16).padStart(12, '0')}`;
}

export const ACCESS_IDS = {
  memberA: accessFixtureId(0x01),
  memberB: accessFixtureId(0x02),
  outsider: accessFixtureId(0x03),
  admin: accessFixtureId(0x04),
  org: accessFixtureId(0x05),
  controlDoc: accessFixtureId(0x10),
  controlChunk: accessFixtureId(0x11),
} as const;

export interface AccessLanguageIds {
  doc: string;
  chunk: string;
  imageChunk: string;
  parent: string;
  idDoc: string;
  idChunk: string;
  overviewChunk: string;
}

const LANGUAGE_BASE: Record<AccessLanguage, number> = { zh: 0x100, en: 0x200, it: 0x300 };

export function accessLanguageIds(language: AccessLanguage): AccessLanguageIds {
  const base = LANGUAGE_BASE[language];
  return {
    doc: accessFixtureId(base + 1),
    chunk: accessFixtureId(base + 2),
    imageChunk: accessFixtureId(base + 3),
    parent: accessFixtureId(base + 4),
    idDoc: accessFixtureId(base + 5),
    idChunk: accessFixtureId(base + 6),
    overviewChunk: accessFixtureId(base + 7),
  };
}

export interface AccessLanguageMarkers {
  child: string;
  parent: string;
  exact: string;
  image: string;
  /** Carried only by the stored translation of the restricted child (Phase 3.2 translation leg). */
  translated: string;
  /** The identifier only the restricted exact-id chunk carries (letters and digits). */
  code: string;
}

export function accessMarkers(language: AccessLanguage): AccessLanguageMarkers {
  return {
    child: `quorvelchild${language}`,
    parent: `quorvelparent${language}`,
    exact: `quorvelexact${language}`,
    image: `quorvelimage${language}`,
    translated: `quorveltrans${language}`,
    code: `QV${LANGUAGE_BASE[language] + 17}${language.toUpperCase()}`,
  };
}

/** The language each restricted child is stored translated into. */
export const TRANSLATION_TARGET: Record<AccessLanguage, AccessLanguage> = { zh: 'en', en: 'it', it: 'zh' };

/** Restricted child text and the question: the question shares every word but the marker, so the marker can only come from content. */
export function childText(language: AccessLanguage, marker = accessMarkers(language).child): string {
  if (language === 'zh') return `中性合成记录：${marker} 条目描述一项普通的样例安排。`;
  if (language === 'it') return `Registro sintetico neutro: la voce ${marker} descrive una disposizione di esempio ordinaria.`;
  return `Neutral synthetic record: the ${marker} entry describes an ordinary sample arrangement.`;
}

export function childQuery(language: AccessLanguage): string {
  return childText(language, '').replace(/\s+/g, ' ').replace('： ', '：').trim();
}

export function exactText(language: AccessLanguage): string {
  const m = accessMarkers(language);
  if (language === 'zh') return `样例目录条目 ${m.code} 记录 ${m.exact} 部件。`;
  if (language === 'it') return `Voce di catalogo ${m.code} registra il componente ${m.exact}.`;
  return `Catalogue entry ${m.code} records the ${m.exact} component.`;
}

export function exactQuery(language: AccessLanguage): string {
  const m = accessMarkers(language);
  if (language === 'zh') return `样例目录条目 ${m.code} 记录什么部件？`;
  if (language === 'it') return `Quale componente registra la voce di catalogo ${m.code}?`;
  return `Which component does catalogue entry ${m.code} record?`;
}

function imageText(language: AccessLanguage): string {
  return `${childQuery(language)} ${accessMarkers(language).image}`;
}

function parentText(language: AccessLanguage): string {
  return `Parent section ${accessMarkers(language).parent}: ${childText(language)}`;
}

export const CONTROL_TEXT = 'Open notice for everyone: the shared calendar lists a plain weekly slot.';

export interface AccessGroupsSeed {
  mode: DeploymentMode;
  tenantKey: string;
  groupA: string;
  groupB: string;
  groupAKey: string;
  groupBKey: string;
  languages: Record<AccessLanguage, { ids: AccessLanguageIds; markers: AccessLanguageMarkers; filename: string; idFilename: string }>;
  /** The Phase 4.2 lookup owner (table rows, identifiers, versions, duplicate clusters), set by seedAccessLookups. */
  lookup: V2LookupOwner | null;
}

export interface AccessGroupsDatabase {
  db: PGlite;
  seed: AccessGroupsSeed;
  close(): Promise<void>;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

async function asService<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

/** rag_set_document_access_groups as service_role with the admin as actor; throws when a document is not updated. */
export async function setDocumentAccess(db: PGlite, seed: AccessGroupsSeed, documentIds: string[], keys: string[]): Promise<void> {
  const rows = await asService(db, () =>
    db.query<{ document_id: string; outcome: string }>('SELECT * FROM public.rag_set_document_access_groups($1, $2::uuid[], $3::text[], $4, $5, $6)', [
      seed.tenantKey,
      documentIds,
      keys,
      ACCESS_IDS.admin,
      'admin',
      'canary_seed',
    ]),
  );
  const bad = rows.rows.filter((row) => row.outcome === 'not_found' || row.outcome === 'skipped_connector');
  if (bad.length > 0) throw new Error(`[Access canary] label not applied: ${bad.map((row) => row.outcome).join(',')}`);
}

export async function addMember(db: PGlite, seed: AccessGroupsSeed, groupId: string, userId: string): Promise<void> {
  await asService(db, () => db.query('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [seed.tenantKey, groupId, userId, ACCESS_IDS.admin]));
}

export async function removeMember(db: PGlite, seed: AccessGroupsSeed, groupId: string, userId: string): Promise<void> {
  await asService(db, () => db.query('SELECT * FROM public.rag_access_member_remove($1, $2, $3, $4)', [seed.tenantKey, groupId, userId, ACCESS_IDS.admin]));
}

/** Seeds one database for the mode: identities, groups, memberships, the restricted documents per language and the all control. */
export async function seedAccessGroups(db: PGlite, mode: DeploymentMode): Promise<AccessGroupsSeed> {
  const multi = mode === 'multi-tenant';
  const tenantKey = multi ? `o:${ACCESS_IDS.org}` : 's:default';
  const users: Array<[string, string]> = [
    [ACCESS_IDS.memberA, 'member-a@example.invalid'],
    [ACCESS_IDS.memberB, 'member-b@example.invalid'],
    [ACCESS_IDS.outsider, 'outsider@example.invalid'],
    [ACCESS_IDS.admin, 'admin@example.invalid'],
  ];
  for (const [id, email] of users) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, email]);
  if (multi) {
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      ACCESS_IDS.org,
      'Neutral canary workspace',
      'neutral-canary-workspace',
      ACCESS_IDS.admin,
    ]);
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'admin')`,
      [ACCESS_IDS.org, ACCESS_IDS.memberA, ACCESS_IDS.memberB, ACCESS_IDS.outsider, ACCESS_IDS.admin],
    );
  } else {
    await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [ACCESS_IDS.admin]);
  }

  const created = async (key: string, name: string): Promise<string> =>
    (
      await asService(db, () =>
        db.query<{ id: string }>('SELECT id FROM public.rag_access_group_create($1, $2, $3, $4)', [tenantKey, key, name, ACCESS_IDS.admin]),
      )
    ).rows[0]!.id;
  const groupA = await created('group-a', 'Group A');
  const groupB = await created('group-b', 'Group B');

  const seed: AccessGroupsSeed = {
    mode,
    tenantKey,
    groupA,
    groupB,
    groupAKey: `g:${groupA}`,
    groupBKey: `g:${groupB}`,
    languages: {} as AccessGroupsSeed['languages'],
    lookup: null,
  };
  await addMember(db, seed, groupA, ACCESS_IDS.memberA);
  await addMember(db, seed, groupB, ACCESS_IDS.memberB);

  const orgColumn = multi ? ', organization_id' : '';
  const withOrg = (values: unknown[]) => (multi ? [...values, ACCESS_IDS.org] : values);
  const orgSlot = (index: number) => (multi ? `, $${index}` : '');
  const insertDoc = (id: string, filename: string, content: string, language: string) =>
    db.query(
      `INSERT INTO documents (id, filename, content, metadata, user_id${orgColumn}, language, lineage_id, version, is_current, status)
       VALUES ($1, $2, $3, '{}'::jsonb, $4${orgSlot(6)}, $5, $1, 1, true, 'ready')`,
      withOrg([id, filename, content, ACCESS_IDS.memberA, language]),
    );
  const insertChunk = (id: string, docId: string, content: string, index: number, metadata: Record<string, unknown>, kind: string, embedFrom = content) =>
    db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, chunk_kind${orgColumn})
       VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb, $7${orgSlot(8)})`,
      withOrg([id, docId, content, vec(embedFrom), index, JSON.stringify(metadata), kind]),
    );

  const restrictedDocs: string[] = [];
  for (const language of ACCESS_LANGUAGES) {
    const ids = accessLanguageIds(language);
    const markers = accessMarkers(language);
    const filename = `quorvel-restricted-${language}.md`;
    const idFilename = `quorvel-catalogue-${language}.md`;
    await insertDoc(ids.doc, filename, childText(language), language);
    await insertChunk(ids.chunk, ids.doc, childText(language), 0, { name: filename }, 'text');
    await insertChunk(
      ids.imageChunk,
      ids.doc,
      imageText(language),
      1,
      { name: `quorvel-figure-${language}.png`, image_context: markers.image, image_url: `https://example.invalid/${markers.image}.png` },
      'image',
    );
    await insertChunk(ids.overviewChunk, ids.doc, `General information overview: ${markers.child} summary.`, 2, { name: filename }, 'text');
    await db.query(
      `INSERT INTO document_parents (id, document_id, tenant_key, chunking_profile_id, content, token_count, parent_index)
       VALUES ($1, $2, $3, 'legacy', $4, 16, 0)`,
      [ids.parent, ids.doc, tenantKey, parentText(language)],
    );
    await db.query(
      `INSERT INTO public.chunk_translations (chunk_id, document_id, tenant_key, language, content, lexical_text, source_content_hash, model)
       VALUES ($1, $2, $3, $4, $5, $5, 'canary-hash', 'canary-model')`,
      [ids.chunk, ids.doc, tenantKey, TRANSLATION_TARGET[language], `${markers.translated} ${childQuery(TRANSLATION_TARGET[language])}`],
    );
    await insertDoc(ids.idDoc, idFilename, exactText(language), language);
    await insertChunk(ids.idChunk, ids.idDoc, exactText(language), 0, { name: idFilename }, 'text');
    restrictedDocs.push(ids.doc, ids.idDoc);
    seed.languages[language] = { ids, markers, filename, idFilename };
  }
  await insertDoc(ACCESS_IDS.controlDoc, 'open-calendar.md', CONTROL_TEXT, 'en');
  await insertChunk(ACCESS_IDS.controlChunk, ACCESS_IDS.controlDoc, CONTROL_TEXT, 0, { name: 'open-calendar.md' }, 'text');
  await runFixtureRelex(db);
  await setDocumentAccess(db, seed, restrictedDocs, [seed.groupAKey]);
  return seed;
}

/**
 * Adds the Phase 4.2 stores (table rows, identifier index, versions, duplicate clusters) for the tenant through the product indexer
 * and dedupe service, then restricts those documents to group-a. The product modules load the app environment, so the caller runs it
 * after setting that (as seedTwoTenantV2Lookups).
 */
export async function seedAccessLookups(fixture: AccessGroupsDatabase): Promise<V2LookupOwner> {
  const { db, seed } = fixture;
  const multi = seed.mode === 'multi-tenant';
  const tag = 'xacg01';
  const id = (n: number) => accessFixtureId(0x400 + n);
  const owner: V2LookupOwner = {
    label: 'acg',
    userId: multi ? ACCESS_IDS.memberA : null,
    organizationId: multi ? ACCESS_IDS.org : null,
    markers: {
      child: `quorvellookchild${tag}`,
      parent: `quorvellookparent${tag}`,
      exact: `quorvellookexact${tag}`,
      image: `quorvellookimage${tag}`,
      translated: `quorvellooktrans${tag}`,
      tableCell: `quorvelcell${tag}`,
      identifier: 'QX-73519',
      identifierSibling: 'QX-73510',
      supersededVersion: `quorvelolder${tag}`,
      currentVersion: `quorvelnewer${tag}`,
      dupCopy: `quorveldup${tag}`,
    },
    lookup: {
      tableDocumentId: id(1),
      tableChunkId: id(2),
      identifierDocumentId: id(3),
      identifierChunkId: id(4),
      siblingDocumentId: id(5),
      siblingChunkId: id(6),
      supersededDocumentId: id(7),
      supersededChunkId: id(8),
      currentDocumentId: id(9),
      currentChunkId: id(10),
      dupDocumentIds: [0, 1, 2, 3].map((copy) => id(0x20 + 2 * copy)),
      dupChunkIds: [0, 1, 2, 3].map((copy) => id(0x21 + 2 * copy)),
      dupClusterId: '',
    },
  };
  await seedLookupRows(db, owner);
  await clusterLookupCopies(db, [owner]);
  const l = owner.lookup;
  await setDocumentAccess(
    db,
    seed,
    [l.tableDocumentId, l.identifierDocumentId, l.siblingDocumentId, l.currentDocumentId, ...l.dupDocumentIds],
    [seed.groupAKey],
  );
  seed.lookup = owner;
  return owner;
}

/** One database per mode, seeded; the corpus directory is empty, so only this harness's documents exist. */
export async function createAccessGroupsDatabase(options: { mode: DeploymentMode }): Promise<AccessGroupsDatabase> {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-canary-corpus-'));
  const { db } = await createFixtureDatabase({ deploymentMode: options.mode, corpusDir, relex: false });
  try {
    const seed = await seedAccessGroups(db, options.mode);
    return {
      db,
      seed,
      async close() {
        await db.close();
        fs.rmSync(corpusDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await db.close().catch(() => undefined);
    fs.rmSync(corpusDir, { recursive: true, force: true });
    throw error;
  }
}

/** Every string an outsider must never see: marker words, restricted chunk, parent and document ids and filenames, lowercase. */
export function restrictedMarkers(seed: AccessGroupsSeed): string[] {
  const out: string[] = [];
  for (const language of ACCESS_LANGUAGES) {
    const entry = seed.languages[language];
    if (!entry) continue;
    const { ids, markers } = entry;
    // The code and the lookup question words are in the questions themselves, so only content-only words are markers.
    out.push(markers.child, markers.parent, markers.exact, markers.image, markers.translated, entry.filename, entry.idFilename);
    out.push(ids.doc, ids.chunk, ids.imageChunk, ids.parent, ids.idDoc, ids.idChunk, ids.overviewChunk);
  }
  const owner = seed.lookup;
  if (owner) {
    const m = owner.markers;
    const l = owner.lookup;
    out.push(`${m.tableCell}k2`, `${m.tableCell}k5`, m.identifierSibling, m.currentVersion, m.supersededVersion, m.dupCopy);
    out.push(l.tableDocumentId, l.tableChunkId, l.identifierDocumentId, l.identifierChunkId, l.siblingDocumentId, l.siblingChunkId);
    out.push(l.currentDocumentId, l.currentChunkId, l.supersededDocumentId, l.supersededChunkId, ...l.dupDocumentIds, ...l.dupChunkIds);
  }
  return out.map((value) => value.toLowerCase());
}

/** The restricted markers present in a serialised value (empty means no leak). */
export function leakedMarkers(seed: AccessGroupsSeed, value: unknown): string[] {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').toLowerCase();
  return restrictedMarkers(seed).filter((marker) => text.includes(marker));
}
