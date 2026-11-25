import type { NextRequest } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { validateRequest } from '@/lib/api-middleware';
import { validateChunkingProfile } from '@/lib/rag';
import { CreateChunkingProfileBodySchema, chunkingUnavailable, jsonNoStore, noStore } from '../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The findings POST /api/rag/admin/chunking-profiles would give for the same body, without writing anything (D-21). */
export async function POST(request: NextRequest): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const parsed = await validateRequest(request, CreateChunkingProfileBodySchema);
  if (!parsed.success) return noStore(parsed.response);

  try {
    const findings = await validateChunkingProfile({ ...parsed.data, status: 'building' });
    return jsonNoStore({ success: true, valid: findings.errors.length === 0, errors: findings.errors, warnings: findings.warnings });
  } catch (error) {
    return chunkingUnavailable('validate', parsed.data.id, error);
  }
}
