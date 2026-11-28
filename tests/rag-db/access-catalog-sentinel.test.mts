import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * Phase 4.3 catalog sentinel (SEC-12; A-11, RESEARCH Pitfalls 1 and 2). Every public function whose source reads a content table and whose
 * result can carry content (a set, a row, text or JSON) must be classified below:
 *   FILTERED: takes p_access_keys and p_access_all, has exactly one overload, its source names access_groups, and it raises
 *             access_scope_required when called without keys while enforcement is on.
 *   GUARDED:  a legacy content function no pipeline calls; it raises access_scope_required while enforcement is on.
 *   PENDING:  a query-time leg whose file runs after the 0920 block; rag_access_readiness() names it until it filters.
 *   EXEMPT:   cannot return content to a retrieval caller, with the reason.
 * If this test names your new or redefined function: give it the access parameters, the guard and the predicate (see 0930 and 0933) and add
 * it to FILTERED, or add it to EXEMPT with a short reason a reviewer can check. Lists hold function names; a name that is absent in a mode
 * is skipped.
 */

const CONTENT_TABLES = [
  'documents',
  'document_chunks',
  'document_parents',
  'chunk_embeddings',
  'chunk_translations',
  'chunk_translation_embeddings',
  'rag_table_rows',
  'rag_dup_clusters',
];

const FILTERED_COMMON = [
  'hybrid_search_chunks',
  'rag_bm25_search_chunks',
  'rag_fetch_parents',
  'rag_exact_id_documents',
  'match_chunks_by_profile',
  'rag_find_invoices',
  'hybrid_search_translations',
  'rag_table_lookup',
  'rag_identifier_resolve',
  'rag_identifier_candidates',
  'rag_dup_cluster_sources',
  'rag_cache_check',
  'rag_attribute_filter_values',
  'rag_attribute_documents',
  'rag_tenant_doc_types',
];

const FILTERED: Record<DeploymentMode, string[]> = {
  'single-tenant': [...FILTERED_COMMON, 'match_document_chunks'],
  'multi-tenant': [...FILTERED_COMMON, 'match_documents_by_workspace'],
};

const GUARDED: Record<DeploymentMode, string[]> = {
  'single-tenant': ['match_documents', 'match_document_chunks_optimized', 'search_chunks_by_keywords', 'get_document_chunks'],
  'multi-tenant': [
    'match_document_chunks',
    'match_document_chunks_by_org',
    'match_documents_by_organization',
    'get_documents_by_type_slug',
    'get_documents_by_type_slug_workspace',
  ],
};

/**
 * Query-time legs that are on trunk but cannot be filtered by the 0920 block, because their file runs after it. Until a later file gives
 * each the access parameters, rag_access_readiness() must name it, so the switch cannot turn on; once it has them, move it to FILTERED.
 * The 1008 attribute resolver moved to FILTERED with migration 1010.
 */
const PENDING: string[] = [];

const EXEMPT: ReadonlyArray<{ reason: string; functions: readonly string[] }> = [
  {
    reason: 'Writer or ingestion step: writes, versions or flags rows and returns ids, counts or the written row to the server, never another document to a retrieval caller.',
    functions: [
      'rag_write_chunks',
      'rag_write_profile_chunks',
      'rag_write_table_rows',
      'rag_write_chunk_translations',
      'rag_write_chunk_identifiers',
      'rag_write_deferred_vectors',
      'rag_begin_document_version',
      'rag_publish_document_version',
      'rag_save_ingest_state',
      'rag_get_ingest_document',
      'rag_get_ingest_origin',
      'rag_parse_cache_for_document',
      'rag_find_content_duplicate',
      'rag_existing_file_hashes',
      'rag_released_link_targets',
      'rag_advance_ingestion_job',
      'rag_enqueue_ingestion_job',
      'rag_fail_ingestion_job',
      'rag_delete_ingestion_job',
      'rag_defer_ingestion_embed',
      'rag_publish_deferred_ingestion_job',
      'rag_begin_progressive_final',
      'rag_mark_provisional',
      'rag_mark_document_failed',
      'rag_clear_provisional',
      'rag_soft_delete_document',
      'rag_set_document_fields',
      'rag_set_document_scopes',
      'rag_set_upload_scopes',
      'rag_set_document_attributes',
      'rag_set_document_attribute_headers',
      'rag_set_document_effective_dates',
      'rag_set_image_chunk_languages',
      'rag_apply_document_attributes',
      'rag_import_document_attributes',
      'rag_document_attributes_read',
      'rag_attribute_identifier_documents',
      'rag_attribute_header_template_set',
      'rag_index_document_chunks',
      'rag_index_backfill_documents',
      'rag_dup_assign',
      'rag_dup_write_hashes',
      'rag_dup_candidates',
      'rag_dup_backfill_candidates',
      'rag_dup_clusters_recompute',
      'rag_deferred_embed_chunks',
      'rag_record_backfill_gap',
      'rag_record_security_events',
      'rag_record_translation_gaps',
      'rag_translation_eligible_chunks',
      'rag_translation_pending_page',
      'rag_translation_pending_scan',
      'rag_translation_vectors_missing',
      'rag_hold_document_for_review',
      'rag_flag_document_review',
      'rag_enqueue_review_item',
      'rag_propose_document_effective_dates',
      'rag_supersession_raise',
      'rag_supersession_peers',
      'rag_supersession_document_state',
      'rag_fingerprint_backfill_page',
      'rag_fingerprint_backfill_write',
    ],
  },
  {
    reason: 'Operator or admin tool: service_role only, called by a CLI or an admin route (an admin sees every document of the tenant), not by a retrieval leg.',
    functions: [
      'rag_activate_chunking_profile',
      'rag_activate_embedding_binding',
      'rag_activate_embedding_profile',
      'rag_rollback_embedding_binding',
      'rag_rollback_embedding_profile',
      'rag_chunking_profile_state',
      'rag_rebuild_activate',
      'rag_rebuild_candidates',
      'rag_rebuild_rollback',
      'rag_rebuild_start',
      'rag_rollout_rebuild_publish_tenant',
      'rag_rollout_rebuild_restore_tenant',
      'rag_recaption_candidates',
      'rag_recaption_rollback_run',
      'rag_recaption_start_run',
      'rag_recaption_write_chunk',
      'rag_rechunk_documents',
      'rag_rechunk_gaps',
      'rag_rechunk_record_gap',
      'rag_reembed_derive_batch',
      'rag_reembed_legacy_guard',
      'rag_reembed_pick',
      'rag_reembed_rollback_run',
      'rag_reembed_start_run',
      'rag_reembed_write_batch',
      'rag_relex_batch',
      'rag_relex_batch_stamped',
      'rag_relex_candidates',
      'rag_relex_candidates_stamped',
      'rag_relex_table_candidates',
      'rag_rescan_candidates',
      'rag_finetune_bind_scoped_slot',
      'rag_finetune_bind_slot',
      'rag_finetune_clear_slot',
      'rag_finetune_export_vectors',
      'rag_finetune_scope_slot',
      'rag_list_quarantine',
      'rag_list_quarantine_reasons',
      'rag_release_quarantine_reasons',
      'rag_release_publish_hold',
      'rag_delete_quarantined',
      'rag_list_not_checked',
      'rag_list_pending_uploads',
      'rag_approve_upload',
      'rag_reject_upload',
      'rag_upload_approval_keys',
      'rag_admin_tenant_keys',
      'rag_admin_document_scope',
      'rag_list_documents_with_scopes',
      'rag_list_supersession',
      'rag_confirm_supersession',
      'rag_dismiss_supersession',
      'rag_undo_supersession',
      'rag_supersession_replace_target',
      'rag_list_effective_date_proposals',
      'rag_dismiss_effective_date_proposal',
      'rag_attribute_header_pending',
      'rag_attribute_header_stale',
      'rag_attribute_headers',
      'rag_get_document_for_type_change',
      'rag_golden_evidence_register',
      'rag_term_corpus_df',
    ],
  },
  {
    reason:
      'Scope gate (0983, 0987): returns per-kind group and chunk counts only. While access is enforced it averages only chunks whose chunk and document access_groups are {all}, so no restricted document reaches a centroid, group key or count (q62-scope-centroids-access).',
    functions: ['rag_scope_centroids_rebuild'],
  },
  {
    reason: 'Statistics: counts, shares or coverage per tenant, language or profile; no row content and no document id.',
    functions: [
      'get_index_statistics',
      'rag_language_document_counts',
      'rag_tenant_language_shares',
      'rag_translation_query_state',
      'rag_translation_coverage',
      'rag_chunking_coverage',
      'rag_reembed_count',
      'rag_reembed_remaining',
      'rag_fingerprint_groups',
    ],
  },
  {
    reason: 'Phase 4.3 access or visibility helper: it applies or reports the labels itself (0922, 0921).',
    functions: [
      'rag_chunks_visible',
      'rag_documents_visible',
      'rag_resolve_access_scope',
      'rag_access_group_by_key',
      'rag_access_groups_drift',
      'rag_set_document_access_groups',
      'rag_access_readiness',
      'rag_review_access_sets',
    ],
  },
  {
    reason: 'Semantic cache store side: resolves the sources of an answer being stored; the lookup rag_cache_check is FILTERED (0931).',
    functions: ['rag_cache_resolve_sources', 'rag_cache_sources_current'],
  },
  {
    reason: 'Query-time helper: version labels of documents a filtered leg already returned; it takes only those ids and returns no content.',
    functions: ['rag_document_versions'],
  },
  {
    reason:
      'Source recheck (0723, 06.3-07): returns the subset of the chunk ids a filtered leg already returned that are still current and ready; it takes only those ids, returns ids only and cannot widen the result.',
    functions: ['rag_source_recheck'],
  },
  {
    reason:
      'Purge (0726, 0727, 06.3-15): tenant-checked, service_role only, for the admin purge path and source sync (no retrieval leg calls them); returns ids, counts and storage keys, never row content.',
    functions: ['rag_purge_admin_target', 'rag_purge_lineage', 'rag_purge_verify'],
  },
  {
    reason:
      'Purge foreign stores (0728, 06.3-19): tenant-checked with rag_ingest_assert_tenant_key, service_role only, called from the purge path only; the steps delete rows of other phases by tenant and version id and return per-store counts (jsonb, or store and remaining), never row content; the inventory is a fixed list that reads no table.',
    functions: ['rag_purge_foreign_stores', 'rag_purge_foreign_leftovers', 'rag_purge_store_inventory'],
  },
  {
    reason:
      'Source sync admin listing (0721, 06.3-04): service_role only for the admin connections route; limited to the tenants rag_admin_tenant_keys gives the actor; returns connection metadata, statuses and counts (document_count, candidate counts), never document or chunk text.',
    functions: ['rag_source_sync_admin_connections'],
  },
  {
    reason:
      'Purge citation scrub (0724, 06.3-10): rewrites the messages jsonb it is passed (withdrawn citation markers); it reads no table and returns only its input.',
    functions: ['rag_withdrawn_chat_messages'],
  },
  {
    reason:
      'Purge picture-link hashes (0747, quick-63 G4): service_role only, called only inside rag_purge_lineage on the version ids it is purging; returns the SHA-256 hex of each metadata.image_url on those chunks and documents (text[] of hashes), never a URL, chunk, title or document text.',
    functions: ['rag_purge_image_url_hashes'],
  },
  {
    reason: 'Account setup (multi-tenant): creates an organization and returns its row; the word documents appears only in a comment of its body.',
    functions: ['create_organization_safe'],
  },
  {
    reason: 'Phase 4.3 admin console (0924): tenant-checked, service_role only, called only by the admin access routes, never by retrieval.',
    functions: [
      'rag_access_audience_details',
      'rag_access_document_audience',
      'rag_access_documents_counts',
      'rag_access_documents_list',
      'rag_access_group_delete',
      'rag_access_group_impact',
      'rag_access_groups_list',
    ],
  },
  {
    reason: 'Phase 4.3 connector access (0925): writes or lists label mappings and counts for the admin and sync paths; no chunk content.',
    functions: ['rag_connector_apply_access', 'rag_connector_fail_closed_counts', 'rag_connector_map_list', 'rag_connector_rules_list'],
  },
  {
    reason: 'Phase 4.4 lexical statistics maintenance (0902): returns counts, timestamps and the state as jsonb, never a lexeme or chunk text.',
    functions: ['rag_lexstats_check', 'rag_lexstats_rebuild'],
  },
  {
    reason: 'Phase 5.2 security-events admin (0945): returns the tenant keys an actor may administer; no document or chunk content.',
    functions: ['rag_security_admin_keys'],
  },
  {
    reason: 'Owned by Phase 7, access applied through scopeAccessFilter and document_chunks.access_groups (A-14, 07-38, 07-39).',
    functions: [
      'rag_validate_chunks',
      'rag_validate_chunks_for_groups',
      'rag_vector_sync_bucket_rows',
      'rag_vector_sync_chunk_row',
      'rag_vector_sync_document_rows',
      'rag_vector_sync_expand',
      'rag_vector_sync_reconcile_summary',
    ],
  },
];

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

interface CatalogFunction {
  name: string;
  signature: string;
  arg_names: string[] | null;
  arg_types: string[];
  source: string;
}

/** Functions of schema public whose source names a content table and whose result can carry content (triggers and scalars excluded). */
const CANDIDATES_SQL = `
  SELECT p.proname AS name, p.oid::regprocedure::text AS signature,
         (p.proargnames)[1:p.pronargs] AS arg_names,
         ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, o) ORDER BY o) AS arg_types,
         p.prosrc AS source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_type rt ON rt.oid = p.prorettype
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
    AND p.prosrc ~ $1
    AND (p.proretset OR rt.typtype = 'c' OR p.prorettype IN ('record'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text'::regtype, 'text[]'::regtype))
  ORDER BY p.proname, signature`;

const TABLE_PATTERN = `(^|[^a-z0-9_])(${CONTENT_TABLES.join('|')})([^a-z0-9_]|$)`;

for (const mode of MODES) {
  describe(`access catalog sentinel (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;
    const tenantKey = mode === 'multi-tenant' ? 'o:00000000-0000-4000-8000-000094110001' : 's:default';
    const exempt = new Map<string, string>(EXEMPT.flatMap((group) => group.functions.map((fn) => [fn, group.reason] as const)));

    async function candidates(): Promise<CatalogFunction[]> {
      return (await db.query<CatalogFunction>(CANDIDATES_SQL, [TABLE_PATTERN])).rows;
    }

    function unclassified(found: CatalogFunction[]): string[] {
      const known = new Set([...FILTERED[mode], ...GUARDED[mode], ...PENDING, ...exempt.keys()]);
      return [...new Set(found.map((fn) => fn.name).filter((name) => !known.has(name)))].sort();
    }

    /** All arguments positional: the tenant key where named so, NULL of the declared type otherwise (so p_access_keys is NULL). */
    function nullCall(fn: CatalogFunction): string {
      const args = fn.arg_types.map((type, i) => (fn.arg_names?.[i] === 'p_tenant_key' ? `'${tenantKey}'::text` : `NULL::${type}`));
      return `SELECT * FROM public.${fn.name}(${args.join(', ')})`;
    }

    async function underEnforcement(sql: string): Promise<string> {
      await db.exec('BEGIN');
      try {
        await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
        await db.exec('SET LOCAL ROLE service_role');
        await db.query(sql);
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-sentinel-corpus-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('every content-returning function is classified', async () => {
      const found = await candidates();
      assert.ok(found.length > 50, `the catalog query found only ${found.length} functions`);
      assert.deepEqual(
        unclassified(found),
        [],
        'classify each function above in tests/rag-db/access-catalog-sentinel.test.mts: FILTERED (access parameters, guard, predicate) or EXEMPT with a reason',
      );
    });

    test('no name is in two lists, and every EXEMPT group has a reason', () => {
      const seen = new Map<string, string>();
      for (const [list, names] of [
        ['FILTERED', FILTERED[mode]],
        ['GUARDED', GUARDED[mode]],
        ['PENDING', PENDING],
        ['EXEMPT', EXEMPT.flatMap((group) => group.functions)],
      ] as const) {
        for (const name of names) {
          assert.equal(seen.get(name), undefined, `${name} is in ${seen.get(name)} and ${list}`);
          seen.set(name, list);
        }
      }
      for (const group of EXEMPT) assert.ok(group.reason.length > 20 && group.functions.length > 0);
    });

    test('each FILTERED function has one overload, the access parameters and access_groups in its source', async () => {
      const found = await candidates();
      for (const name of FILTERED[mode]) {
        const overloads = found.filter((fn) => fn.name === name);
        if (overloads.length === 0) continue;
        assert.equal(overloads.length, 1, `${name}: ${overloads.map((fn) => fn.signature).join(' | ')}`);
        const fn = overloads[0]!;
        assert.ok(fn.arg_names?.includes('p_access_keys') && fn.arg_names.includes('p_access_all'), `${fn.signature} lacks the access parameters`);
        assert.match(fn.source, /access_groups/, `${name} source does not name access_groups`);
      }
    });

    test('each FILTERED and GUARDED function raises access_scope_required without keys while enforcement is on', async () => {
      const found = await candidates();
      const checked: string[] = [];
      for (const name of [...FILTERED[mode], ...GUARDED[mode]]) {
        for (const fn of found.filter((entry) => entry.name === name)) {
          assert.match(await underEnforcement(nullCall(fn)), /access_scope_required/, fn.signature);
          checked.push(name);
        }
      }
      for (const required of ['hybrid_search_chunks', 'hybrid_search_translations', 'rag_table_lookup', 'rag_dup_cluster_sources', GUARDED[mode][0]!]) {
        assert.ok(checked.includes(required), `${required} was not found in the catalog`);
      }
    });

    test('each PENDING function either passes the FILTERED checks or is named by rag_access_readiness', async () => {
      const found = await candidates();
      await db.exec('SET ROLE service_role');
      let objects: string[];
      try {
        objects = (await db.query<{ objects: string[] }>('SELECT objects FROM public.rag_access_readiness()')).rows[0]!.objects;
      } finally {
        await db.exec('RESET ROLE');
      }
      for (const name of PENDING) {
        const overloads = found.filter((fn) => fn.name === name);
        if (overloads.length === 0) continue;
        const filtered = overloads.length === 1 && overloads[0]!.arg_names?.includes('p_access_keys') === true;
        if (filtered) {
          assert.match(overloads[0]!.source, /access_groups/, name);
          assert.match(await underEnforcement(nullCall(overloads[0]!)), /access_scope_required/, name);
        } else {
          assert.ok(objects.includes(name), `${name} does not filter and rag_access_readiness() does not name it`);
        }
      }
    });

    test('the classification check catches an unclassified function that reads document_chunks (self-check)', async () => {
      await db.exec('BEGIN');
      try {
        await db.exec(`CREATE FUNCTION public.rag_sentinel_self_check(p_tenant_key text)
          RETURNS SETOF text LANGUAGE sql STABLE SET search_path = ''
          AS 'SELECT c.content FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key'`);
        assert.deepEqual(unclassified(await candidates()), ['rag_sentinel_self_check']);
      } finally {
        await db.exec('ROLLBACK');
      }
      assert.deepEqual(unclassified(await candidates()), []);
    });

    test('a FILTERED function redefined without the guard is caught (self-check)', async () => {
      await db.exec('BEGIN');
      try {
        await db.exec(`CREATE OR REPLACE FUNCTION public.rag_identifier_resolve(p_tenant_key text, p_norm text[], p_access_keys text[] DEFAULT NULL, p_access_all boolean DEFAULT false)
          RETURNS TABLE (norm text, raw text) LANGUAGE sql STABLE SET search_path = ''
          AS 'SELECT x, x FROM unnest(p_norm) AS u(x) WHERE EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.access_groups && p_access_keys)'`);
        const fn = (await candidates()).find((entry) => entry.name === 'rag_identifier_resolve')!;
        assert.equal(await underEnforcement(nullCall(fn)), 'accepted');
      } finally {
        await db.exec('ROLLBACK');
      }
    });
  });
}
