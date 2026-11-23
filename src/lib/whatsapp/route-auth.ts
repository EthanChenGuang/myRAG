import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSessionManager } from '@/lib/whatsapp/session-manager';
import { logger } from '@/lib/logger';

type AuthResult = { user: { id: string } } | { response: NextResponse };

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export async function requireUser(tag: string): Promise<AuthResult> {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }

    return { user };
  } catch (error) {
    logger.error(tag, 'Auth lookup failed:', error);
    return { response: NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 }) };
  }
}

export async function requireOwnedSession(
  tag: string,
  userId: string,
  sessionId: unknown
): Promise<{ response: NextResponse } | null> {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { response: NextResponse.json({ error: 'sessionId is required' }, { status: 400 }) };
  }

  const session = await getSessionManager().getSessionById(sessionId);

  if (!session) {
    return { response: NextResponse.json({ error: 'Session not found' }, { status: 404 }) };
  }

  if (session.userId !== userId) {
    logger.warn(tag, 'Session ownership mismatch');
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return null;
}
