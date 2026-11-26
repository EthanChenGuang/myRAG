import { jsonNoStore } from '../_tenant-data/lib';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return jsonNoStore({ success: false, error: 'Not implemented' }, 501);
}

export async function PUT(): Promise<Response> {
  return jsonNoStore({ success: false, error: 'Not implemented' }, 501);
}

export async function POST(): Promise<Response> {
  return jsonNoStore({ success: false, error: 'Not implemented' }, 501);
}
