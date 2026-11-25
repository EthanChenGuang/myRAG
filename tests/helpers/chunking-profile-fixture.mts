import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

export const LEGACY_EMBEDDING = 'openai-3-small-1536';
export const ACTOR = '00000000-0000-4000-8000-0000000000aa';

export type Row = Record<string, unknown>;

export interface Tenant {
  key: string;
  userId: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

export function decision(profileId: string, docType: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build_run_id: null,
    chosen_on: { recall_at_k: 0.9 },
    decided_by: 'tester',
    doc_type: docType,
    gate_passed: true,
    profile_id: profileId,
    recorded_at: '2026-11-25T00:00:00Z',
    report_hash: 'a'.repeat(64),
    source: 'fixture',
    ...over,
  };
}

export function parentsOf(label: string) {
  return [{ parent_index: 0, section_path: ['Agreement'], content: `Whole section of ${label}. The indemnity applies to both parties of ${label}.`, token_count: 40 }];
}

export function childrenOf(label: string) {
  return [0, 1].map((index) => ({
    chunk_index: index,
    parent_index: 0,
    content: `profile child ${index} of ${label} indemnity clause`,
    section_path: ['Agreement'],
    chunk_kind: 'text',
    embedding_text_version: 1,
    content_hash: `hash-${label}-${index}`,
    lexical_text: `profile child${index} ${label} indemnity clause`,
    metadata: { lexical_version: 1 },
  }));
}

const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chunking-activation-corpus-'));

export async function createFixture(mode: DeploymentMode): Promise<{ fixture: FixtureDatabase; a: Tenant; b: Tenant | null }> {
  if (mode === 'multi-tenant') {
    return {
      fixture: await createTwoTenantDatabase({ corpusDir: emptyCorpus }),
      a: { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA },
      b: { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB },
    };
  }
  return { fixture: await createFixtureDatabase({ deploymentMode: mode, corpusDir: emptyCorpus }), a: { key: 's:default', userId: null }, b: null };
}

export function helpers(fixture: FixtureDatabase, label: string) {
  let sequence = 0;
  const query = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    try {
      return (await fixture.db.query<Row>(sql, params)).rows;
    } catch (error) {
      return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
    }
  };
  const errorOf = async (sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> => {
    try {
      await fixture.db.query(sql, params);
      return null;
    } catch (error) {
      return { message: messageOf(error), code: (error as { code?: string }).code ?? null };
    }
  };

  async function seed(tenant: Tenant, name: string, docType: string, options: { publish?: boolean; sourceKey?: string; extraLegacy?: Array<Record<string, unknown>> } = {}): Promise<string> {
    sequence += 1;
    const sourceKey = options.sourceKey ?? `${label}-${name}.md`;
    const begun = await query(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => $5, p_doc_type_origin => 'fallback', p_profile_id => 'contract_legal@1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${name}:${sequence}`).digest('hex'), docType],
    );
    assert.equal(begun[0]?.outcome, 'created');
    const documentId = String(begun[0]?.document_id);
    await query(`SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => '{"language":"en"}'::jsonb)`, [documentId, tenant.key]);
    const chunk = {
      content: `legacy chunk of ${name} indemnity clause`,
      chunk_index: 0,
      section_path: [],
      chunk_kind: 'text',
      embedding_text_version: 1,
      lexical_text: `legacy chunk ${name} indemnity clause`,
      metadata: {},
    };
    const extras = (options.extraLegacy ?? []).map((extra, index) => ({
      chunk_index: index + 1,
      section_path: [],
      embedding_text_version: 1,
      metadata: {},
      ...extra,
    }));
    await query(
      'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => $5)',
      [
        documentId,
        tenant.key,
        JSON.stringify([chunk, ...extras]),
        JSON.stringify({ [LEGACY_EMBEDDING]: [vector(1536, sequence), ...extras.map((_, index) => vector(1536, sequence + 100 + index))] }),
        1 + extras.length,
      ],
    );
    if (options.publish !== false) {
      await query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);
    }
    return documentId;
  }

  async function fill(documentId: string, tenant: Tenant, profileId: string, name: string): Promise<void> {
    await query(
      `SELECT * FROM rag_write_profile_chunks(
         p_document_id => $1, p_tenant_key => $2, p_profile_id => $3, p_parents => $4::jsonb, p_children => $5::jsonb, p_embeddings => NULL,
         p_final => true, p_total => 2)`,
      [documentId, tenant.key, profileId, JSON.stringify(parentsOf(name)), JSON.stringify(childrenOf(name))],
    );
  }

  const create = (id: string, docType: string, child = 256, mode = 'structure', parent: number | null = 1024, preset = '256/1024') =>
    query('SELECT * FROM rag_create_chunking_profile($1, $2, $3, $4, $5, $6)', [id, docType, child, mode, parent, preset]);

  const insertProfile = (id: string, docType: string, child = 256, mode = 'structure', parent: number | null = 1024, preset = '256/1024') =>
    query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset) VALUES ($1, $2, $3, $4, $5, 'building', $6)`,
      [id, docType, child, mode, parent, preset],
    );

  const record = (profileId: string, payload: unknown) =>
    query('SELECT * FROM rag_record_chunking_decision($1, $2::jsonb)', [profileId, JSON.stringify(payload)]);

  const activateSql = 'SELECT * FROM rag_activate_chunking_profile($1, $2, $3)';
  const activate = (id: string, docType: string | null, actor: string | null = ACTOR) => query(activateSql, [id, actor, docType]);
  const activateError = (id: string, docType: string | null, actor: string | null = ACTOR) => errorOf(activateSql, [id, actor, docType]);
  const rollback = (docType: string, actor: string | null = ACTOR) => query('SELECT * FROM rag_rollback_chunking_profile($1, $2)', [docType, actor]);

  const profileRow = async (id: string, docType: string): Promise<Row | undefined> =>
    (await query('SELECT * FROM chunking_profiles WHERE id = $1 AND doc_type = $2', [id, docType]))[0];

  return { query, errorOf, seed, fill, create, insertProfile, record, activate, activateError, rollback, profileRow };
}

