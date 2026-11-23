import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';

export const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
export const USER_ID = '00000000-0000-4000-8000-0000000000b1';

export interface AdminGuardState {
  session: { id: string } | null;
  authThrows: boolean;
  lookupFails: boolean;
  admins: string[];
}

export function newGuardState(): AdminGuardState {
  return { session: null, authThrows: false, lookupFails: false, admins: [ADMIN_ID] };
}

function fakeAdminClient(state: AdminGuardState) {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from() {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          const hit = state.admins.includes(filters.id as string);
          return Promise.resolve({ data: hit ? { id: filters.id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

/** Mocks the cookie session and the admin_users lookup. Call after vi.resetModules() and before importing a route. */
export function mockAdminGuard(state: AdminGuardState) {
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => fakeAdminClient(state),
    getSupabase: () => ({}),
  }));
}

export function asAdmin(state: AdminGuardState) {
  state.session = { id: ADMIN_ID };
}

export function asPlainUser(state: AdminGuardState) {
  state.session = { id: USER_ID };
}

export function makeEnvDir(content: string): { dir: string; envPath: string; read: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-admin-routes-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, content);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return { dir, envPath, read: () => fs.readFileSync(envPath, 'utf8') };
}

export function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

export function silenceConsole() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}
