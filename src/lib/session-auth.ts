import { NextResponse } from 'next/server';

export type SessionUser = { id: string };
export type SessionAuthResult =
  | { user: SessionUser; getUser: () => Promise<SessionUser | null> }
  | { response: NextResponse };

/** Verifies the cookie session with auth.getUser(): 401 without one, 503 when the lookup fails. */
export async function requireSessionUser(tag: string): Promise<SessionAuthResult> {
  let lookup: Promise<SessionUser | null> | null = null;
  const getUser = () => {
    lookup ??= (async () => {
      const { createClient } = await import('@/lib/supabase/server');
      const supabase = await createClient();
      const { data, error } = await supabase.auth.getUser();
      if (!data?.user?.id && error?.name === 'AuthRetryableFetchError') throw error;
      return data?.user?.id ? { id: data.user.id } : null;
    })();
    return lookup;
  };

  let user: SessionUser | null;
  try {
    user = await getUser();
  } catch {
    console.error(`${tag} Session lookup failed`);
    return { response: NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 }) };
  }
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  return { user, getUser };
}
