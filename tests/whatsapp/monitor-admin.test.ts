import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ID,
  USER_ID,
  asAdmin,
  asPlainUser,
  mockAdminGuard,
  newGuardState,
  silenceConsole,
  type AdminGuardState,
} from '../helpers/admin-guard-fixture';

const monitor = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  forceReconnect: vi.fn(async () => undefined),
}));

let guard: AdminGuardState;

async function loadRoute() {
  vi.resetModules();
  mockAdminGuard(guard);
  vi.doMock('@/lib/env', () => ({ env: { NEXT_PUBLIC_WHATSAPP_ENABLED: 'true' } }));
  vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
  vi.doMock('@/lib/whatsapp/connection-monitor', () => ({
    startGlobalMonitoring: monitor.start,
    stopGlobalMonitoring: monitor.stop,
    getConnectionMonitor: () => ({ forceReconnect: monitor.forceReconnect }),
  }));
  vi.doMock('@/lib/whatsapp/session-manager', () => ({
    getSessionManager: () => ({
      getSessionById: async (sessionId: string) =>
        sessionId === 'session-own' ? { sessionId, userId: USER_ID } : sessionId === 'session-admin' ? { sessionId, userId: ADMIN_ID } : null,
    }),
  }));
  return import('@/app/api/whatsapp/monitor/route');
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/whatsapp/monitor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  guard = newGuardState();
  monitor.start.mockReset();
  monitor.stop.mockReset();
  monitor.forceReconnect.mockClear();
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('whatsapp monitor global start/stop is admin only (ME-05)', () => {
  for (const action of ['start', 'stop'] as const) {
    it(`a non-admin who owns a session gets 403 for ${action} and the global monitor is untouched`, async () => {
      asPlainUser(guard);
      const { POST } = await loadRoute();

      const response = await POST(post({ action, sessionId: 'session-own' }));

      expect(response.status).toBe(403);
      expect(monitor.start).not.toHaveBeenCalled();
      expect(monitor.stop).not.toHaveBeenCalled();
    });

    it(`${action} without a session gets 401 and the global monitor is untouched`, async () => {
      const { POST } = await loadRoute();

      const response = await POST(post({ action, sessionId: 'session-own' }));

      expect(response.status).toBe(401);
      expect(monitor.start).not.toHaveBeenCalled();
      expect(monitor.stop).not.toHaveBeenCalled();
    });

    it(`${action} answers 503 when the admin lookup fails`, async () => {
      asAdmin(guard);
      guard.lookupFails = true;
      const { POST } = await loadRoute();

      const response = await POST(post({ action }));

      expect(response.status).toBe(503);
      expect(monitor.start).not.toHaveBeenCalled();
      expect(monitor.stop).not.toHaveBeenCalled();
    });
  }

  it('an admin can start and stop the global monitor without naming a session', async () => {
    asAdmin(guard);
    const { POST } = await loadRoute();

    expect((await POST(post({ action: 'start' }))).status).toBe(200);
    expect((await POST(post({ action: 'stop' }))).status).toBe(200);
    expect(monitor.start).toHaveBeenCalledTimes(1);
    expect(monitor.stop).toHaveBeenCalledTimes(1);
  });

  it('force_reconnect stays owner-scoped for a non-admin', async () => {
    asPlainUser(guard);
    const { POST } = await loadRoute();

    expect((await POST(post({ action: 'force_reconnect', sessionId: 'session-own' }))).status).toBe(200);
    expect(monitor.forceReconnect).toHaveBeenCalledWith('session-own');
    expect((await POST(post({ action: 'force_reconnect', sessionId: 'session-admin' }))).status).toBe(403);
    expect(monitor.forceReconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown action with 400', async () => {
    asPlainUser(guard);
    const { POST } = await loadRoute();

    expect((await POST(post({ action: 'restart', sessionId: 'session-own' }))).status).toBe(400);
  });
});
