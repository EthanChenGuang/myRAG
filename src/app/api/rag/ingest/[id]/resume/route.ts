import type { NextRequest } from 'next/server';
import { handleIngestResume } from '../../_lib/handlers';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleIngestResume(request, params);
}
