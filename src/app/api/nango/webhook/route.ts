import { NextRequest, NextResponse } from 'next/server';
import { isNangoEnabled, verifyWebhookSignature } from '@/lib/nango/client';
import { authOperationOf, handleSyncWebhook } from '@/lib/nango/webhook-deletions';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { NangoWebhookPayload } from '@/lib/nango/types';

export const runtime = 'nodejs';

/** Deletions are applied inside the request and answered before Nango's 20 s webhook timeout (D-05). */
const SYNC_WEBHOOK_DEADLINE_MS = 15_000;

/**
 * POST /api/nango/webhook
 * Receives webhook notifications from Nango
 */
export async function POST(request: NextRequest) {
  if (!isNangoEnabled()) {
    return NextResponse.json({ error: 'Nango not enabled' }, { status: 503 });
  }

  try {
    // HMAC-SHA256 of the raw body, keyed with the webhook signing key (D-32). The legacy X-Nango-Signature is refused.
    const signature = request.headers.get('x-nango-hmac-sha256');
    const body = await request.text();

    const isValid = verifyWebhookSignature(signature, body);

    if (!isValid) {
      console.error('[Nango Webhook] Invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let payload: NangoWebhookPayload;
    try {
      payload = JSON.parse(body) as NangoWebhookPayload;
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    console.log('[Nango Webhook] Received:', {
      type: payload.type,
      connectionId: payload.connectionId,
      provider: payload.providerConfigKey,
      syncName: payload.syncName,
    });

    const supabaseAdmin = getSupabaseAdmin();

    if (!supabaseAdmin) {
      console.error('[Nango Webhook] Supabase admin not available');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    switch (payload.type) {
      case 'sync':
        // Current Nango sync payload: read the deleted records and apply them, bounded; never starts a full sync.
        try {
          await handleSyncWebhook(payload, { deadlineMs: SYNC_WEBHOOK_DEADLINE_MS, signal: request.signal });
        } catch (error) {
          console.error('[Nango Webhook] Sync deletions failed:', { code: (error as { code?: string } | null)?.code ?? null });
        }
        break;

      case 'auth':
        console.log('[Nango Webhook] Auth event:', { operation: authOperationOf(payload), success: payload.success === true });
        break;

      case 'sync.success':
        // Legacy payload type that Nango no longer sends. It does not start a sync (D-32, Pitfall 2).
        console.log('[Nango Webhook] Sync success:', payload.responseResults);

        // Update last sync time
        await supabaseAdmin
          .from('nango_connections')
          .update({ last_sync_at: new Date().toISOString() })
          .eq('connection_id', payload.connectionId);
        break;

      case 'sync.error':
        console.error('[Nango Webhook] Sync error:', payload.error);

        await supabaseAdmin
          .from('nango_connections')
          .update({
            status: 'error',
            metadata: { last_error: payload.error?.message },
          })
          .eq('connection_id', payload.connectionId);
        break;

      case 'auth.token_expired':
        console.warn('[Nango Webhook] Token expired for:', payload.connectionId);

        await supabaseAdmin
          .from('nango_connections')
          .update({ status: 'error', metadata: { error: 'Token expired' } })
          .eq('connection_id', payload.connectionId);
        break;

      default:
        console.log('[Nango Webhook] Unhandled type:', payload.type);
    }

    return NextResponse.json({ received: true });

  } catch (error) {
    console.error('[Nango Webhook] Error:', error);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
