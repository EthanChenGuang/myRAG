import type { NextRequest } from 'next/server';
import { adminDenied, checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import { validateRequest } from '@/lib/api-middleware';
import { RetrievalBackendError, createChunkingProfile, getChunkingCoverage, listChunkingProfiles, validateChunkingProfile } from '@/lib/rag';
import type { ChunkingCoverageRow, ChunkingProfileRecord } from '@/lib/rag';
import { CreateChunkingProfileBodySchema, DocTypeSchema, chunkingUnavailable, invalidProfile, jsonNoStore, noStore } from './_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CoverageEntry = { current_ready_documents: number; documents_with_children: number; missing_documents: number };

function coverageKey(docType: string, profileId: string): string {
  return `${docType}\u0000${profileId}`;
}

function profileBody(profile: ChunkingProfileRecord, coverage: Map<string, CoverageEntry>): Record<string, unknown> {
  return {
    id: profile.id,
    doc_type: profile.docType,
    child_tokens: profile.childTokens,
    parent_mode: profile.parentMode,
    parent_tokens: profile.parentTokens,
    status: profile.status,
    preset: profile.preset,
    is_active: profile.isActive,
    previous_active_id: profile.previousActiveId,
    created_at: profile.createdAt,
    activated_at: profile.activatedAt,
    activated_by: profile.activatedBy,
    completeness: coverage.get(coverageKey(profile.docType, profile.id)) ?? null,
  };
}

/**
 * Every chunking profile with its status, sizes and completeness, the active profile per doc type and, per doc type, how many current ready
 * documents have no chunks in the active profile (zero on legacy, null when the coverage has no row for it). Counts only: no document id,
 * name or tenant key.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  let profiles: ChunkingProfileRecord[];
  let rows: ChunkingCoverageRow[];
  try {
    [profiles, rows] = await Promise.all([listChunkingProfiles({ signal: request.signal }), getChunkingCoverage({ signal: request.signal })]);
  } catch (error) {
    return chunkingUnavailable('list', null, error);
  }

  const coverage = new Map<string, CoverageEntry>();
  for (const row of rows) {
    coverage.set(coverageKey(row.docType, row.profileId), {
      current_ready_documents: row.currentReadyDocuments,
      documents_with_children: row.documentsWithChildren,
      missing_documents: row.missingDocuments,
    });
  }

  const active: Record<string, string> = {};
  const missingFromActive: Record<string, number | null> = {};
  for (const docType of DocTypeSchema.options) {
    active[docType] = 'legacy';
    missingFromActive[docType] = 0;
  }
  for (const profile of profiles) {
    if (!profile.isActive || !profile.docType) continue;
    active[profile.docType] = profile.id;
    missingFromActive[profile.docType] =
      profile.id === 'legacy' ? 0 : (coverage.get(coverageKey(profile.docType, profile.id))?.missing_documents ?? null);
  }

  console.log('[RAG Admin] chunking profile action', { action: 'list', count: profiles.length });
  return jsonNoStore({
    success: true,
    active,
    missing_from_active: missingFromActive,
    profiles: profiles.map((profile) => profileBody(profile, coverage)),
  });
}

/** Creates a building profile after the shape and the D-21 rules pass; hard errors are 400 with details, warnings are returned. */
export async function POST(request: NextRequest): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = await validateRequest(request, CreateChunkingProfileBodySchema);
  if (!parsed.success) return noStore(parsed.response);
  const body = parsed.data;

  let findings;
  try {
    findings = await validateChunkingProfile({ ...body, status: 'building' });
  } catch (error) {
    return chunkingUnavailable('create', body.id, error);
  }
  if (findings.errors.length > 0) return invalidProfile(findings.errors, findings.warnings);

  try {
    const created = await createChunkingProfile(
      {
        id: body.id,
        docType: body.doc_type,
        childTokens: body.child_tokens,
        parentMode: body.parent_mode,
        parentTokens: body.parent_tokens,
        preset: body.preset,
      },
      { signal: request.signal },
    );
    console.log('[RAG Admin] chunking profile action', { action: 'create', profileId: created.profileId, actor: admin.userId });
    return jsonNoStore(
      { success: true, profile_id: created.profileId, doc_type: created.docType, status: created.status, warnings: findings.warnings },
      201,
    );
  } catch (error) {
    if (error instanceof RetrievalBackendError && error.code === '23505') {
      console.warn('[RAG Admin] chunking profile action refused', { action: 'create', profileId: body.id, reason: 'profile_exists' });
      return jsonNoStore({ success: false, error: 'profile_exists' }, 409);
    }
    if (error instanceof RetrievalBackendError && error.code === '22023') {
      console.warn('[RAG Admin] chunking profile action refused', { action: 'create', profileId: body.id, reason: 'rejected_by_database' });
      return jsonNoStore({ success: false, error: 'invalid_chunking_profile', details: [{ path: '', message: 'rejected_by_database' }] }, 400);
    }
    return chunkingUnavailable('create', body.id, error);
  }
}
