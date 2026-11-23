import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdminRequest } from '@/lib/admin-session';

const MESSAGES: Record<number, string> = {
  401: 'Admin authentication required',
  403: 'Admin authentication required',
  503: 'Admin verification is unavailable',
};

async function authorize(request: Request) {
  const admin = getSupabaseAdmin();
  const result = await requireAdminRequest({ headers: request.headers, signal: request.signal, admin });
  if (!result.ok || !admin) {
    const status = result.ok ? 503 : result.status;
    return { ok: false as const, response: NextResponse.json({ error: { message: MESSAGES[status] } }, { status }) };
  }
  return { ok: true as const, admin, adminUserId: result.userId };
}

export async function GET(request: Request) {
  try {
    const auth = await authorize(request);
    if (!auth.ok) return auth.response;

    const { data, error } = await auth.admin
      .from('admin_settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return NextResponse.json(data || { read_only_doc_dashboard: false });
  } catch {
    console.error('[Admin Settings API - GET] failed');
    return NextResponse.json({ error: { message: 'Internal server error fetching settings' } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorize(request);
    if (!auth.ok) return auth.response;

    let settings: unknown;
    try {
      settings = await request.json();
    } catch {
      return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }
    const value = (settings as { read_only_doc_dashboard?: unknown } | null)?.read_only_doc_dashboard;
    if (typeof value !== 'boolean') {
      return NextResponse.json(
        { error: { message: 'Invalid setting value for read_only_doc_dashboard' } },
        { status: 400 },
      );
    }

    const { data: existingSettings, error: fetchError } = await auth.admin
      .from('admin_settings')
      .select('id')
      .limit(1)
      .maybeSingle();
    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    const payload = {
      read_only_doc_dashboard: value,
      updated_by: auth.adminUserId,
      updated_at: new Date().toISOString(),
    };

    const query = existingSettings?.id
      ? auth.admin.from('admin_settings').update(payload).eq('id', existingSettings.id)
      : auth.admin.from('admin_settings').insert({ ...payload, created_by: auth.adminUserId });
    const { data, error } = await query.select().single();
    if (error) throw error;

    return NextResponse.json({ success: true, settings: data });
  } catch {
    console.error('[Admin Settings API - POST] failed');
    return NextResponse.json({ error: { message: 'Internal server error updating settings' } }, { status: 500 });
  }
}
