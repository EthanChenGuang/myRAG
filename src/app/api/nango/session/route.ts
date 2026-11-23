import { NextRequest, NextResponse } from 'next/server';
import { getNango, isNangoEnabled } from '@/lib/nango/client';
import { type SupportedProvider, PROVIDER_CONFIG } from '@/lib/nango/types';
import { requireSessionUser } from '../_lib/session-user';

export const runtime = 'nodejs';

/**
 * POST /api/nango/session
 * Creates a Nango Connect Session for frontend OAuth flow
 */
export async function POST(request: NextRequest) {
  if (!isNangoEnabled()) {
    return NextResponse.json(
      { error: 'Nango integration not enabled' },
      { status: 503 }
    );
  }

  try {
    const auth = await requireSessionUser();
    if (!auth.ok) return auth.response;
    const userId = auth.user.id;
    const userEmail = auth.user.email;
    const userDisplayName = auth.user.displayName || auth.user.email || 'User';

    const { provider } = await request.json() as { provider: SupportedProvider };

    if (!provider) {
      return NextResponse.json({ error: 'Provider is required' }, { status: 400 });
    }

    const nango = getNango();
    const integrationId = PROVIDER_CONFIG[provider]?.integrationId || provider;

    // Create a connect session for the frontend
    // This returns a token the frontend SDK uses to initiate OAuth
    const session = await nango.createConnectSession({
      end_user: {
        id: userId,
        email: userEmail,
        display_name: userDisplayName,
      },
      allowed_integrations: [integrationId],
    });

    return NextResponse.json({
      connectSessionToken: session.data.token,
      provider,
    });

  } catch (error) {
    console.error('[Nango] Error creating connect session:', error);

    // Provide more detailed error information for debugging
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isConfigError = errorMessage.includes('not initialized') ||
      errorMessage.includes('NANGO_SECRET_KEY') ||
      errorMessage.includes('401') ||
      errorMessage.includes('Unauthorized');

    return NextResponse.json(
      {
        error: isConfigError
          ? 'Nango configuration error - check NANGO_SECRET_KEY'
          : 'Failed to create connect session',
        details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
      },
      { status: 500 }
    );
  }
}
