import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/api-middleware';
import { checkSidecarSecret, handleTranslateCallback } from '@/lib/rag';
import { TranslateCallbackRequestSchema, TranslateCallbackResponseSchema } from '@/lib/rag-eval/contracts.generated';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Internal callback of the ingestion sidecar worker for jobs of kind translate (D-29). The shared secret is checked before anything else;
 * the tenant, the document and the target language are read from the job row inside the handler and are not fields of the body.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = checkSidecarSecret(req.headers);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid_job_id' }, { status: 400 });

  const parsed = await validateRequest(req, TranslateCallbackRequestSchema);
  if (!parsed.success) return parsed.response;

  const result = await handleTranslateCallback(id.toLowerCase(), parsed.data, { signal: req.signal });
  if (result.status === 200) {
    const checked = TranslateCallbackResponseSchema.safeParse(result.body);
    if (!checked.success) {
      console.error('[RAG Ingest] translate callback produced an invalid response');
      return NextResponse.json({ error: 'invalid_response' }, { status: 500 });
    }
    return NextResponse.json(checked.data);
  }
  return NextResponse.json(result.body, { status: result.status });
}
