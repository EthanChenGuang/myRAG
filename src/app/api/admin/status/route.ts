import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdminCookie } from '@/lib/admin-session';

const DEFAULT_SETTINGS = { read_only_doc_dashboard: false };

export async function GET(request: Request) {
  try {
    const admin = getSupabaseAdmin();
    const result = await requireAdminCookie({ headers: request.headers, signal: request.signal, admin });
    if (!result.ok) {
      if (result.status === 503) {
        return NextResponse.json({ isAdmin: false, message: 'Error verifying admin status' }, { status: 503 });
      }
      return NextResponse.json({ isAdmin: false, message: 'No admin session' });
    }

    const { data: settings, error: settingsError } = await admin!
      .from('admin_settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (settingsError || !settings) {
      if (settingsError) console.error('[Admin Status] settings lookup failed');
      return NextResponse.json({
        isAdmin: true,
        settings: DEFAULT_SETTINGS,
        message: 'Admin settings not found, using defaults',
      });
    }

    return NextResponse.json({ isAdmin: true, settings });
  } catch (error) {
    console.error('[Admin Status] unexpected error', { name: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ isAdmin: false, error: { message: 'Error checking admin status' } }, { status: 500 });
  }
}
