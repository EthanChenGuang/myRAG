import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isSingleTenant } from '@/lib/deployment-mode';
import { verifyUserOrganizationAccess } from '@/lib/auth/organization-handler';
import { isAdminUser, type RagAdminDb } from '@/lib/rag';

export const runtime = 'nodejs';

type Row = Record<string, any>;
type Scope = (query: any) => any;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
const BASE_COLUMNS =
  'id, filename, created_at, organization_id, user_id, metadata, source, source_provider, source_file_id, source_connection_id, lineage_id, version, is_current, status';
const MAX_RULE_IDS = 20;
const MAX_RULE_ID_LENGTH = 64;

function ruleIdsOf(row: Row): string[] {
  const ids = row.metadata?.quarantine?.rule_ids;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((value): value is string => typeof value === 'string')
    .slice(0, MAX_RULE_IDS)
    .map((value) => value.slice(0, MAX_RULE_ID_LENGTH));
}

/**
 * One entry per lineage. The entry is the current version; a quarantined version the caller may see wins when it is newer
 * than the current one; a lineage with no current version (a first upload that is processing, failed or quarantined) is
 * listed by its newest visible version. A quarantined version the caller may not see is never a candidate.
 */
function pickEntries(rows: Row[], canSeeQuarantined: (row: Row) => boolean): Row[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row.lineage_id ?? row.id);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const entries: Row[] = [];
  for (const group of groups.values()) {
    const visible = group.filter((row) => row.status !== 'quarantined' || canSeeQuarantined(row));
    const current = visible.find((row) => row.is_current === true && row.status !== 'quarantined');
    const candidates = current
      ? [current, ...visible.filter((row) => row.status === 'quarantined' && row.version > current.version)]
      : visible;
    if (candidates.length === 0) continue;
    entries.push(candidates.reduce((best, row) => (row.version > best.version ? row : best)));
  }
  return entries;
}

function isImageFilename(filename: unknown): boolean {
  const lower = typeof filename === 'string' ? filename.toLowerCase() : '';
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function listDocuments(input: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  scope: Scope;
  canSeeQuarantined: (row: Row) => boolean;
  exposeOwner: boolean;
  label: string;
}): Promise<Row[]> {
  const { admin, scope, canSeeQuarantined, exposeOwner, label } = input;
  const statusFixEnabled = process.env.CONFIG_UI_STATUS_FIX !== 'false';

  // Current versions, plus the non-current rows a first upload can be in. Superseded ready versions are not read.
  const currentQuery = scope(admin.from('documents').select(BASE_COLUMNS).eq('is_current', true).neq('status', 'deleted'));
  const headQuery = statusFixEnabled
    ? scope(admin.from('documents').select(BASE_COLUMNS).eq('is_current', false).in('status', ['processing', 'quarantined', 'failed']))
    : Promise.resolve({ data: [], error: null });
  const [current, head] = await Promise.all([currentQuery, headQuery]);
  for (const result of [current, head]) {
    if (result.error) {
      console.error('Error fetching documents:', result.error);
      throw new Error(`Error fetching documents: ${result.error.message}`);
    }
  }

  // With the status fix off the list keeps today's shape, which has no status, so only ready rows are listed.
  const rows: Row[] = [...(current.data ?? []), ...(head.data ?? [])].filter((row: Row) => statusFixEnabled || row.status === 'ready');
  const entries = pickEntries(rows, canSeeQuarantined);

  const documents = await Promise.all(
    entries.map(async (row): Promise<Row> => {
      if (row.status === 'quarantined') {
        // Whitelisted fields only: no content, snippet, preview or metadata of a quarantined document leaves the server.
        return {
          id: row.id,
          filename: row.filename,
          created_at: row.created_at,
          ...(exposeOwner && { organization_id: row.organization_id ?? null, user_id: row.user_id }),
          metadata: {},
          source: row.source,
          source_provider: row.source_provider,
          version: row.version,
          chunk_count: 0,
          status: 'quarantined',
          quarantine: { rule_ids: ruleIdsOf(row) },
        };
      }

      const { count, error: countError } = await admin
        .from('document_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', row.id)
        .eq('is_current', true)
        .eq('status', 'ready');

      const { lineage_id: _lineage, is_current: _current, status: _status, ...rest } = row;
      const base: Row = rest;
      if (!exposeOwner) {
        delete base.user_id;
        delete base.organization_id;
      }

      if (countError) {
        console.error(`Error counting chunks for document ${row.id}:`, countError);
        return { ...base, chunk_count: 0, ...(statusFixEnabled && { status: 'unknown' as const }) };
      }

      // The status comes from the column. A ready document with no current ready chunk is still being filled (today's rule);
      // a chunk count never makes a document ready.
      const status = row.status === 'ready' && !(count && count > 0) ? 'processing' : row.status;
      return { ...base, chunk_count: count, ...(statusFixEnabled && { status }) };
    }),
  );

  if (process.env.NODE_ENV === 'development') {
    const totalChunks = documents.reduce((sum, doc) => sum + (doc.chunk_count || 0), 0);
    console.log(`Documents (${label}): ${documents.length} docs, ${totalChunks} total chunks`);
  }

  // Image documents are managed via the Image RAG section
  return documents
    .filter((doc) => !isImageFilename(doc.filename))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function GET(request: NextRequest) {
  try {
    // Use authenticated client for workspace filtering
    const supabase = await createClient();
    const supabaseAdmin = getSupabaseAdmin();

    if (!supabaseAdmin) {
      throw new Error('Supabase admin client not initialized');
    }

    // SINGLE-TENANT MODE: shared knowledge base, no user/org filtering. The list stays open as before; a quarantined
    // document is listed only to a deployment administrator or the user who uploaded it.
    if (isSingleTenant()) {
      let userId: string | null = null;
      let admin = false;
      try {
        const { data } = await supabase.auth.getUser();
        userId = data?.user?.id ?? null;
        if (userId) admin = await isAdminUser(supabaseAdmin as unknown as RagAdminDb, userId, request.signal);
      } catch {
        admin = false;
      }
      const documents = await listDocuments({
        admin: supabaseAdmin,
        scope: (query) => query,
        canSeeQuarantined: (row) => admin || (userId !== null && row.user_id === userId),
        exposeOwner: false,
        label: 'single-tenant',
      });
      return NextResponse.json({ documents });
    }

    // MULTI-TENANT MODE: User/org filtering required
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Get organization_id from query params (null = personal workspace)
    const { searchParams } = new URL(request.url);
    const orgIdParam = searchParams.get('organization_id');

    let scope: Scope;
    if (orgIdParam === 'null' || orgIdParam === null || orgIdParam === undefined) {
      // Personal Workspace (flat): no organization, just user_id
      scope = (query) => query.is('organization_id', null).eq('user_id', user.id);
    } else {
      // Personal Project or Team Workspace: validate access, then filter by organization_id.
      const access = await verifyUserOrganizationAccess(user.id, orgIdParam);

      if (!access.hasAccess) {
        return NextResponse.json(
          { error: 'You are not a member of this organization. Select a workspace that belongs to the signed-in user, or invite this user to the selected workspace before listing documents.' },
          { status: 403 }
        );
      }

      scope = (query) => query.eq('organization_id', orgIdParam);
    }

    const documents = await listDocuments({
      admin: supabaseAdmin,
      scope,
      canSeeQuarantined: (row) => row.user_id === user.id,
      exposeOwner: true,
      label: 'multi-tenant',
    });
    return NextResponse.json({ documents });
  } catch (error) {
    console.error("Error listing documents:", error);
    return NextResponse.json({
      error: "Failed to list documents",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
