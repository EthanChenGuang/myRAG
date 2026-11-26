import type { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import type { EffectiveDatesFailure, EffectiveDatesItem } from '@/lib/rag';
import { jsonNoStore } from '../upload-approvals/_lib';

export { IdSchema, OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, refuseBody } from '../upload-approvals/_lib';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** An ISO calendar date (YYYY-MM-DD) or null for an unbounded side. */
export const EffectiveDateSchema = z
  .string()
  .regex(ISO_DATE, 'Expected a date as YYYY-MM-DD')
  .refine(realDate, 'Not a calendar date')
  .nullable();

/** Fixed answers for the reason words of the service; an unknown and a foreign document id get the same 404. */
export function datesFailure(reason: EffectiveDatesFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: 'Document not found' }, 404);
    case 'invalid_window':
      return jsonNoStore({ success: false, error: 'invalid_window' }, 400);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    case 'no_proposal':
      return jsonNoStore({ success: false, error: 'no_proposal' }, 409);
    default:
      return jsonNoStore({ success: false, error: 'Effective date administration is unavailable' }, 503);
  }
}

export function projectDates(item: EffectiveDatesItem) {
  return {
    id: item.documentId,
    lineage_id: item.lineageId,
    file_name: item.filename,
    version: item.version,
    status: item.status,
    effective_from: item.effectiveFrom,
    effective_to: item.effectiveTo,
    origin: item.origin,
    confidence: item.confidence,
    proposal: item.proposal
      ? {
          from: item.proposal.from,
          to: item.proposal.to,
          confidence: item.proposal.confidence,
          evidence_quote: item.proposal.evidenceQuote,
          awaiting: item.proposal.awaiting,
          proposed_at: item.proposal.proposedAt,
        }
      : null,
  };
}
