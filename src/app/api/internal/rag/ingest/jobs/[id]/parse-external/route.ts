import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/api-middleware';
import { checkSidecarSecret, handleParseExternal } from '@/lib/rag';
import { ParseExternalRequestSchema, ParseExternalResponseSchema } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Internal callback of the ingestion sidecar worker. The shared secret is checked before anything else; the tenant is minted from
 * the job row inside the handler and is not a field of the body (the schema is strict).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = checkSidecarSecret(req.headers);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid_job_id' }, { status: 400 });

  const parsed = await validateRequest(req, ParseExternalRequestSchema);
  if (!parsed.success) return parsed.response;

  const result = await handleParseExternal(id.toLowerCase(), parsed.data, { signal: req.signal });
  if (result.status === 200) {
    const checked = ParseExternalResponseSchema.safeParse(result.body);
    if (!checked.success) {
      console.error('[RAG Ingest] parse-external produced an invalid response');
      return NextResponse.json({ error: 'invalid_response' }, { status: 500 });
    }
    return NextResponse.json(checked.data);
  }
  return NextResponse.json(result.body, { status: result.status });
}
