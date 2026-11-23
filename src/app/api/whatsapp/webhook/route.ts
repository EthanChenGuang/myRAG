import { NextRequest, NextResponse } from 'next/server';
import { getWebhookHandler } from '@/lib/whatsapp/webhook-handler';
import { getWhatsAppClient } from '@/lib/whatsapp/client-factory';
import { KoyebWebhookPayload } from '@/lib/whatsapp/types';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { isWebhookTimestampFresh, rememberWebhookSignature } from '@/lib/whatsapp/webhook-replay';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const secretConfigured = !!env.WHATSAPP_WEBHOOK_SECRET;
    const unsignedAllowed =
      !secretConfigured && process.env.NODE_ENV !== 'production' && env.WHATSAPP_WEBHOOK_ALLOW_UNSIGNED === 'true';

    if (!secretConfigured && !unsignedAllowed) {
      logger.error('WhatsApp Webhook', 'WHATSAPP_WEBHOOK_SECRET is not configured; rejecting webhook');
      return NextResponse.json(
        { error: 'Webhook verification is not configured' },
        { status: 503 }
      );
    }

    const signature = request.headers.get('x-webhook-signature');
    const rawBody = await request.text();

    if (unsignedAllowed) {
      logger.warn('WhatsApp Webhook', 'WHATSAPP_WEBHOOK_ALLOW_UNSIGNED is set; accepting unverified webhook (development only)');
    } else {
      const whatsappClient = getWhatsAppClient();
      const isValid = !!signature && whatsappClient.validateWebhookSignature(signature, rawBody);

      if (!isValid) {
        logger.warn('WhatsApp Webhook', 'Invalid webhook signature');
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 401 }
        );
      }
    }

    // Parse payload
    let payload: KoyebWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch (error) {
      logger.error('WhatsApp Webhook', 'Failed to parse webhook payload:', error);
      return NextResponse.json(
        { error: 'Invalid payload' },
        { status: 400 }
      );
    }

    if (!unsignedAllowed) {
      if (!isWebhookTimestampFresh((payload as { timestamp?: unknown }).timestamp)) {
        logger.warn('WhatsApp Webhook', 'Rejected webhook with a missing or out-of-window timestamp');
        return NextResponse.json({ error: 'Stale or missing timestamp' }, { status: 401 });
      }
      if (!rememberWebhookSignature(signature!)) {
        logger.warn('WhatsApp Webhook', 'Ignored replayed webhook');
        return NextResponse.json({ success: true, received: true, duplicate: true });
      }
    }

    logger.info('WhatsApp Webhook', `Received webhook event: ${payload.event}`, {
      messageId: payload.data?.key?.id ?? payload.data?.messageId,
    });

    // Process webhook
    const webhookHandler = getWebhookHandler();
    await webhookHandler.handleWebhook(payload);

    return NextResponse.json({
      success: true,
      received: true
    });
  } catch (error: any) {
    logger.error('WhatsApp Webhook', 'Webhook processing failed:', error);

    // Return success to avoid retries from Koyeb
    return NextResponse.json({
      success: false,
      error: error.message
    });
  }
}

// Handle GET requests for webhook verification
export async function GET(request: NextRequest) {
  // Some webhook systems send a GET request to verify the endpoint
  const { searchParams } = new URL(request.url);
  const challenge = searchParams.get('challenge');

  if (challenge) {
    // Echo back the challenge for verification
    return new Response(challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }

  return NextResponse.json({
    status: 'ok',
    endpoint: 'WhatsApp webhook'
  });
}