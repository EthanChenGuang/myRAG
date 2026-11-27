import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { checkAdmin } from '@/lib/admin-route-auth';
import {
  accessGroupsEnabled,
  checkItemDetails,
  checkReasonOf,
  getReviewItemWithSource,
  isReviewItemId,
  openReviewSession,
  REVIEW_NO_STORE,
  reviewNotFound,
  reviewUnavailable,
  type ReviewSnapshotReader,
  type SecurityAdminDb,
} from '@/lib/rag';

export const runtime = 'nodejs';

/**
 * D-16: one review item read through RLS, with the masked answer of its own linked chat for chat items. An item raised by output_guard or
 * version_conflict (Phase 5.2 D-55) also gets check_details: the check, its documents by id and file name and their uploaders, the
 * e-mail only for a deployment admin (D-47). Every item carries its strata source.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = await openReviewSession();
  if (!session.ok) return session.response;

  const { id } = await context.params;
  if (!isReviewItemId(id)) return reviewNotFound();

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return reviewUnavailable();
    const result = await getReviewItemWithSource(session.ssr, admin, id, accessGroupsEnabled() ? { admin, userId: session.userId } : undefined);
    if (!result.ok) {
      if (result.reason === 'not_found') return reviewNotFound();
      return NextResponse.json({ error: 'Review item unavailable' }, { status: 500, headers: REVIEW_NO_STORE });
    }
    if (checkReasonOf(result.item) === null) return NextResponse.json(result.item, { headers: REVIEW_NO_STORE });
    const deploymentAdmin = (await checkAdmin(request)).ok;
    const details = await checkItemDetails(session.ssr as unknown as ReviewSnapshotReader, admin as unknown as SecurityAdminDb, result.item, { deploymentAdmin });
    return NextResponse.json(details ? { ...result.item, check_details: details } : result.item, { headers: REVIEW_NO_STORE });
  } catch {
    console.error('[Review] item read failed');
    return reviewUnavailable();
  }
}
