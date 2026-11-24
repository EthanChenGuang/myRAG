import type { NextRequest } from 'next/server';
import { handleIngestStatus } from '../_lib/handlers';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleIngestStatus(request, params);
}
