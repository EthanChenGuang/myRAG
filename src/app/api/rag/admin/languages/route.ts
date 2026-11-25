import { NextResponse } from 'next/server';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { languageDocumentCounts } from '@/lib/rag';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Deployment-wide number of current ready documents per registry language, for the Languages picker's suggestions (D-08, UI-SPEC 8.1).
 * Deployment admins only; aggregates only, never a document id, name or text.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);
  const result = await languageDocumentCounts({ signal: request.signal });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: 'Language counts are unavailable' }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ success: true, counts: result.counts }, { headers: NO_STORE });
}
