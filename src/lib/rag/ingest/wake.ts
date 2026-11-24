import { after } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { SIDECAR_SECRET_HEADER } from './callbacks/internal-auth';

const WAKE_TIMEOUT_MS = 1_000;

async function wakeSidecar(): Promise<void> {
  const baseUrl = (env.RAG_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
  const secret = env.RAG_SIDECAR_SECRET ?? '';
  if (!baseUrl || !secret) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/ingest/wake`, {
      method: 'POST',
      headers: { [SIDECAR_SECRET_HEADER]: secret },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.debug('[RAG Ingest] sidecar wake answered', { status: response.status });
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    logger.debug('[RAG Ingest] sidecar wake failed', { error: name });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort wake of the ingestion worker after enqueue; never delays or fails the caller (D-23). */
export function scheduleIngestWake(): void {
  const baseUrl = (env.RAG_SIDECAR_URL ?? '').trim();
  if (!baseUrl) return;

  const task = async (): Promise<void> => {
    try {
      await wakeSidecar();
    } catch {
      // the wake must never surface to upload handlers
    }
  };

  try {
    after(task);
  } catch {
    // outside a Next.js request scope there is nothing to extend
  }
}