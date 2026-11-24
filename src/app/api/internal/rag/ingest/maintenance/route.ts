import { NextRequest, NextResponse } from 'next/server';
import { checkSidecarSecret, SIDECAR_SECRET_HEADER } from '@/lib/rag/ingest/callbacks/internal-auth';
import { IngestLedgerError, runIngestionMaintenance } from '@/lib/rag/ingest/maintenance';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = checkSidecarSecret(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });
  }

  try {
    const result = await runIngestionMaintenance({ signal: request.signal });
    return NextResponse.json({ success: true, ...result }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    console.error('[RAG Ingest] maintenance failed', { error: name, header: SIDECAR_SECRET_HEADER });
    if (error instanceof IngestLedgerError) {
      return NextResponse.json({ success: false, error: 'maintenance_unavailable' }, { status: 503 });
    }
    return NextResponse.json({ success: false, error: 'maintenance_unavailable' }, { status: 503 });
  }
}