import { NextResponse } from 'next/server';
import { startGlobalMonitoring, stopGlobalMonitoring, getConnectionMonitor } from '@/lib/whatsapp/connection-monitor';
import { requireUser, requireOwnedSession } from '@/lib/whatsapp/route-auth';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';

/**
 * API endpoint to control WhatsApp connection monitoring
 */

export async function GET() {
  try {
    const auth = await requireUser('WhatsAppMonitor');
    if ('response' in auth) return auth.response;

    // Check if WhatsApp is enabled
    if (env.NEXT_PUBLIC_WHATSAPP_ENABLED !== 'true') {
      return NextResponse.json({
        enabled: false,
        message: 'WhatsApp integration is disabled'
      });
    }

    getConnectionMonitor();
    return NextResponse.json({
      enabled: true,
      status: 'running',
      message: 'WhatsApp connection monitor is active'
    });
  } catch (error) {
    logger.error('WhatsAppMonitor', 'Failed to get monitor status:', error);
    return NextResponse.json(
      { error: 'Failed to get monitor status' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser('WhatsAppMonitor');
    if ('response' in auth) return auth.response;

    let body: Record<string, any>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { action } = body;

    // Check if WhatsApp is enabled
    if (env.NEXT_PUBLIC_WHATSAPP_ENABLED !== 'true') {
      return NextResponse.json(
        { error: 'WhatsApp integration is disabled' },
        { status: 400 }
      );
    }

    if (action !== 'start' && action !== 'stop' && action !== 'force_reconnect') {
      return NextResponse.json(
        { error: 'Invalid action. Use "start", "stop", or "force_reconnect"' },
        { status: 400 }
      );
    }

    const denied = await requireOwnedSession('WhatsAppMonitor', auth.user.id, body.sessionId);
    if (denied) return denied.response;

    if (action === 'start') {
      startGlobalMonitoring();
      logger.info('WhatsAppMonitor', 'Started global monitoring');
      return NextResponse.json({
        status: 'started',
        message: 'WhatsApp connection monitoring started'
      });
    }

    if (action === 'stop') {
      stopGlobalMonitoring();
      logger.info('WhatsAppMonitor', 'Stopped global monitoring');
      return NextResponse.json({
        status: 'stopped',
        message: 'WhatsApp connection monitoring stopped'
      });
    }

    await getConnectionMonitor().forceReconnect(body.sessionId);
    return NextResponse.json({
      status: 'reconnecting',
      message: `Force reconnecting session: ${body.sessionId}`
    });
  } catch (error) {
    logger.error('WhatsAppMonitor', 'Monitor control error:', error);
    return NextResponse.json(
      { error: 'Failed to control monitor' },
      { status: 500 }
    );
  }
}
