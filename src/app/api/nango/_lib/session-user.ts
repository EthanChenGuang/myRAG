import { NextResponse } from 'next/server';

export interface NangoSessionUser {
  id: string;
  email?: string;
  displayName?: string;
}

export type SessionUserResult =
  | { ok: true; user: NangoSessionUser }
  | { ok: false; response: NextResponse };

export async function requireSessionUser(): Promise<SessionUserResult> {
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const user = data?.user;
    if (!user?.id) {
      return { ok: false, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
    }
    const fullName = user.user_metadata?.full_name;
    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: typeof fullName === 'string' && fullName ? fullName : undefined,
      },
    };
  } catch {
    console.error('[Nango] Session lookup failed');
    return { ok: false, response: NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 }) };
  }
}
