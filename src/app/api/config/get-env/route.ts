import { NextRequest, NextResponse } from 'next/server';
import { isReadableEnvEntry } from '@/lib/config-env-allowlist';
import { readEnvFile } from '@/lib/env-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Values the public UI reads without a session. Every name here is non-secret branding or a feature flag;
 * anything else answers 403, whatever its prefix.
 */
const PUBLIC_ENV_NAMES: ReadonlySet<string> = new Set([
  'NEXT_PUBLIC_HEADER_LOGO_TEXT',
  'NEXT_PUBLIC_HEADER_LOGO_TYPE',
  'NEXT_PUBLIC_SHOW_SUGGESTIONS',
  'NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT',
  'NEXT_PUBLIC_SIDEBAR_BUTTON_URL',
  'NEXT_PUBLIC_WHATSAPP_ENABLED',
]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const varName = searchParams.get('var');

  if (!varName) {
    return NextResponse.json({ success: false, error: 'Missing variable name' }, { status: 400 });
  }

  if (!PUBLIC_ENV_NAMES.has(varName)) {
    return NextResponse.json({ success: false, error: 'Variable name not allowed' }, { status: 403 });
  }

  try {
    let value = process.env[varName] || '';

    if (!value && process.env.NODE_ENV === 'development') {
      value = readEnvFile()[varName] ?? '';
    }

    if (!isReadableEnvEntry(varName, value)) value = '';

    return NextResponse.json({ success: true, value }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[Config API] failed to read a public environment variable');
    return NextResponse.json({ success: false, error: 'Error reading environment variable' }, { status: 500 });
  }
}
