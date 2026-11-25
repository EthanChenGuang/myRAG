import { NextResponse } from 'next/server';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';

/** D-56: the legacy writers insert ready rows directly and cannot hold a document, so they refuse while upload approval is on. */
export const UPLOAD_APPROVAL_REQUIRES_UNIFIED = 'upload_approval_requires_unified_pipeline';

/** True when upload approval is on and the ingest pipeline is legacy: knowledge-base writes must refuse. */
export function approvalRequiresUnified(config: Pick<IngestConfig, 'pipeline' | 'uploadApproval'>): boolean {
  return config.uploadApproval !== 'off' && config.pipeline === 'legacy';
}

/**
 * For a caller already on a legacy write branch: true when upload approval is on. A configuration that cannot be read falls
 * back to the raw switch, so a set RAG_UPLOAD_APPROVAL still refuses.
 */
export function legacyWriteRefused(): boolean {
  try {
    return currentIngestConfig().uploadApproval !== 'off';
  } catch {
    const raw = (process.env.RAG_UPLOAD_APPROVAL ?? '').trim().toLowerCase();
    return raw === 'members' || raw === 'all';
  }
}

/** The structured 503 every knowledge-base write route answers instead of running a legacy writer. */
export function legacyApprovalRefusal(): NextResponse {
  console.warn('[Ingest] legacy knowledge-base write refused: upload approval needs the unified pipeline');
  return NextResponse.json({ error: UPLOAD_APPROVAL_REQUIRES_UNIFIED }, { status: 503 });
}

/** Thrown by legacy writers called outside a route (connector sync, scrapers, background image processing). */
export class UploadApprovalRequiresUnifiedError extends Error {
  readonly code = UPLOAD_APPROVAL_REQUIRES_UNIFIED;
  readonly reason = UPLOAD_APPROVAL_REQUIRES_UNIFIED;
  readonly status = 503;

  constructor() {
    super(`[Ingest] ${UPLOAD_APPROVAL_REQUIRES_UNIFIED}`);
    this.name = 'UploadApprovalRequiresUnifiedError';
  }
}

/** Throws before a legacy writer runs while upload approval is on. */
export function assertLegacyWriteAllowed(): void {
  if (legacyWriteRefused()) throw new UploadApprovalRequiresUnifiedError();
}
