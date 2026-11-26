import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import {
  MAX_CONFIG_VALUE_LENGTH,
  isReadableEnvEntry,
  isWritableEnvName,
} from '@/lib/config-env-allowlist';
import { EnvWriteError, invalidEnvValueReason, parseEnvContent, stringifyJsonForEnv, writeEnvUpdates } from '@/lib/env-file';
import { guardAppEnvWrite } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function envFilePath() {
  return path.resolve(process.cwd(), '.env.local');
}

function normalizeStructuredValue(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? stringifyJsonForEnv(parsed) : text;
  } catch {
    return text;
  }
}

export async function GET(request: Request) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const envPath = envFilePath();
    const parsed = fs.existsSync(envPath) ? parseEnvContent(fs.readFileSync(envPath, 'utf8')) : {};

    const config: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (isReadableEnvEntry(name, value)) config[name] = value;
    }

    return NextResponse.json({ config }, { headers: NO_STORE });
  } catch {
    console.error('[Config API] failed to read configuration');
    return NextResponse.json({ success: false, error: 'Failed to read configuration' }, { status: 500 });
  }
}

async function adminUserId(request: Request): Promise<string | null> {
  const admin = await checkAdmin(request);
  return admin.ok ? admin.userId : null;
}

export async function POST(request: Request) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates = (body as { config?: unknown } | null)?.config;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return NextResponse.json({ success: false, error: 'config must be an object' }, { status: 400 });
  }

  const rejected: string[] = [];
  const invalid: string[] = [];
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(updates)) {
    if (!isWritableEnvName(name)) {
      rejected.push(name);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      invalid.push(name);
      continue;
    }
    const text = normalizeStructuredValue(String(value));
    if (text.length > MAX_CONFIG_VALUE_LENGTH || invalidEnvValueReason(text) !== null) {
      invalid.push(name);
      continue;
    }
    entries.push([name, text]);
  }

  if (rejected.length > 0 || invalid.length > 0) {
    return NextResponse.json(
      {
        success: false,
        error: 'Configuration contains names or values that are not allowed',
        rejected,
        invalid,
      },
      { status: 400 },
    );
  }

  if (entries.length === 0) {
    return NextResponse.json({ success: true, message: 'No valid updates provided' });
  }

  const updatesToWrite = Object.fromEntries(entries);
  const gate = await guardAppEnvWrite({
    updates: updatesToWrite,
    ragGate: (body as { ragGate?: unknown }).ragGate,
    actorUserId: () => adminUserId(request),
    route: 'config',
  });
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status, headers: { 'Cache-Control': 'no-store' } });

  try {
    writeEnvUpdates(updatesToWrite);
    console.log('[Config API] configuration updated', { names: entries.map(([name]) => name) });
    return NextResponse.json({ success: true, message: 'Configuration saved', ...(gate.ragGate ? { ragGate: gate.ragGate } : {}) });
  } catch (error) {
    if (error instanceof EnvWriteError && error.reason !== 'io') {
      return NextResponse.json(
        { success: false, error: 'Configuration contains names or values that are not allowed', rejected: [], invalid: error.names },
        { status: 400 },
      );
    }
    console.error('[Config API] failed to write configuration');
    return NextResponse.json({ success: false, error: 'Failed to write configuration' }, { status: 500 });
  }
}
