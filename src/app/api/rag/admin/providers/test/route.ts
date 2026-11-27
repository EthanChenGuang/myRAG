import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { validateRequest } from '@/lib/api-middleware';
import { PROVIDER_IDS, PROVIDER_PROBE_TIMEOUT_MS, runProviderProbe } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ provider: z.enum(PROVIDER_IDS) }).strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * D-15 (ADM-01): Test connection. Admin only, fail closed. The body names one provider from a fixed list and nothing else; every
 * URL and key comes from the configuration this process loaded. The answer is { provider, ok, latencyMs, code, message } with a
 * fixed message per code, status 200 even when the probe failed.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const parsed = await validateRequest(request, BodySchema);
  if (!parsed.success) return noStore(parsed.response);

  const result = await runProviderProbe(parsed.data.provider, { signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS) });
  console.log('[RAG Admin] provider test', { provider: result.provider, ok: result.ok, code: result.code });
  return noStore(NextResponse.json(result, { status: 200 }));
}
