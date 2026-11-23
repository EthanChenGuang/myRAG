import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import {
  MAX_CONFIG_VALUE_LENGTH,
  isReadableEnvEntry,
  isWritableEnvName,
} from '@/lib/config-env-allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function envFilePath() {
  return path.resolve(process.cwd(), '.env.local');
}

export async function GET(request: Request) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const envPath = envFilePath();
    const parsed = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};

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
    const text = String(value);
    if (text.length > MAX_CONFIG_VALUE_LENGTH || /[\r\n\0]/.test(text)) {
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

  try {
    const envPath = envFilePath();
    let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];

    for (const [name, value] of entries) {
      let found = false;
      lines = lines.map((line) => {
        const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (match && match[1] === name) {
          found = true;
          return `${name}=${value}`;
        }
        return line;
      });
      if (!found) lines.push(`${name}=${value}`);
    }

    fs.writeFileSync(envPath, lines.join('\n'));
    console.log('[Config API] configuration updated', { names: entries.map(([name]) => name) });
    return NextResponse.json({ success: true, message: 'Configuration saved' });
  } catch {
    console.error('[Config API] failed to write configuration');
    return NextResponse.json({ success: false, error: 'Failed to write configuration' }, { status: 500 });
  }
}
