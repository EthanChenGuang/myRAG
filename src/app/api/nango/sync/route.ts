import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getNango, isNangoEnabled } from '@/lib/nango/client';
import { syncDocumentsForConnection } from '@/lib/nango/sync-manager';
import { type SupportedProvider, PROVIDER_CONFIG } from '@/lib/nango/types';
import { isSharePointBlocked, isSharePointProvider, sharePointIntegrationKey } from '@/lib/nango/sharepoint/config';

function integrationIdOf(provider: SupportedProvider): string {
  if (isSharePointProvider(provider)) return sharePointIntegrationKey(provider);
  return PROVIDER_CONFIG[provider]?.integrationId || provider;
}

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for large syncs

/**
 * POST /api/nango/sync
 * Manually trigger a sync for a connection
 */
export async function POST(request: NextRequest) {
  if (!isNangoEnabled()) {
    return NextResponse.json(
      { error: 'Nango integration not enabled' },
      { status: 503 }
    );
  }

  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { connectionId, provider, syncAll } = await request.json() as {
      connectionId?: string;
      provider?: SupportedProvider;
      syncAll?: boolean;
    };

    if (isSharePointBlocked(provider)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const nango = getNango();

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    if (syncAll) {
      // Sync all connected providers for this user
      const { data: connections } = await supabaseAdmin
        .from('nango_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'connected');

      const results = [];
      for (const conn of connections || []) {
        if (isSharePointBlocked(conn.provider)) continue;
        try {
          // Trigger Nango sync first (only if configured)
          const providerConfig = PROVIDER_CONFIG[conn.provider as SupportedProvider];
          const integrationId = integrationIdOf(conn.provider as SupportedProvider);

          if (providerConfig?.syncName) {
            try {
              await nango.triggerSync(integrationId, [conn.connection_id], providerConfig.syncName);
            } catch (e) {
              console.warn(`[Nango] Could not trigger Nango sync for ${conn.provider}:`, e);
            }
          }

          // Process documents
          const stats = await syncDocumentsForConnection(
            conn.connection_id,
            conn.provider
          );
          // UI-SPEC 6.14: how many documents this sync left with the fallback audience (owner and admins).
          results.push({ provider: conn.provider, ...stats, failClosed: stats.failClosed ?? 0 });
        } catch (e) {
          results.push({
            provider: conn.provider,
            error: e instanceof Error ? e.message : 'Sync failed',
          });
        }
      }

      return NextResponse.json({ results });
    }

    if (!connectionId || !provider) {
      return NextResponse.json(
        { error: 'connectionId and provider are required' },
        { status: 400 }
      );
    }

    // Verify user owns this connection
    const { data: connRecord } = await supabaseAdmin
      .from('nango_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('connection_id', connectionId)
      .single();

    if (!connRecord) {
      return NextResponse.json(
        { error: 'Connection not found' },
        { status: 404 }
      );
    }

    if (isSharePointBlocked(connRecord.provider)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Trigger Nango sync first (only if configured)
    const providerConfig = PROVIDER_CONFIG[provider];
    const integrationId = integrationIdOf(provider);

    if (providerConfig?.syncName) {
      try {
        await nango.triggerSync(integrationId, [connectionId], providerConfig.syncName);
      } catch (e) {
        console.warn(`[Nango] Could not trigger Nango sync for ${provider}:`, e);
      }
    }

    // Then process documents
    const stats = await syncDocumentsForConnection(connectionId, provider);

    // Update last sync time
    await supabaseAdmin
      .from('nango_connections')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('connection_id', connectionId);

    // UI-SPEC 6.14: the count of documents this sync left with the fallback audience (owner and admins).
    return NextResponse.json({ ...stats, failClosed: stats.failClosed ?? 0 });

  } catch (error) {
    console.error('[Nango] Sync error:', error);
    return NextResponse.json(
      { error: 'Sync failed' },
      { status: 500 }
    );
  }
}
