import type { NextResponse } from 'next/server';
import type { SupersessionAdminFailure, SupersessionDocumentView, SupersessionEntry } from '@/lib/rag';
import { jsonNoStore } from '../upload-approvals/_lib';

export { IdSchema, OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, refuseBody } from '../upload-approvals/_lib';

/**
 * Fixed answers for the reason words of the supersession functions (UI-SPEC 8.2). An unknown id and another workspace's id get the same
 * 404 body, so ids cannot be probed; a refusal of the database is a 409 carrying its word; a candidate without a direction needs the older
 * document (400 direction_required). The database message never leaves the server.
 */
export function supersessionFailure(reason: SupersessionAdminFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: 'Candidate not found' }, 404);
    case 'already_decided':
    case 'stale_candidate':
    case 'not_confirmed':
    case 'direction_conflict':
      return jsonNoStore({ success: false, error: reason }, 409);
    case 'direction_required':
      return jsonNoStore({ success: false, error: reason }, 400);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'Supersession administration is unavailable' }, 503);
  }
}

function projectDocument(view: SupersessionDocumentView | null) {
  if (view === null) return null;
  return {
    id: view.id,
    file_name: view.fileName,
    doc_type: view.docType,
    document_date: view.docDate,
    effective_from: view.effectiveFrom,
    effective_to: view.effectiveTo,
    uploaded_at: view.uploadedAt,
    uploader: view.uploader,
    version_label: view.versionLabel,
  };
}

/** The list item the Versions panel reads: named signal fields only, never the stored signals object. */
export function projectEntry(entry: SupersessionEntry) {
  if (entry.kind === 'link') {
    return {
      kind: 'link' as const,
      id: entry.id,
      link_id: entry.linkId,
      origin: entry.origin,
      older_document: projectDocument(entry.older),
      newer_document: projectDocument(entry.newer),
      decided_at: entry.decidedAt,
      decided_by: entry.decidedBy,
    };
  }
  return {
    kind: 'candidate' as const,
    id: entry.id,
    origin: entry.origin,
    direction: entry.direction,
    stale: entry.stale,
    signals: {
      title_match: entry.signals.title_match,
      content_overlap_percent: entry.signals.content_overlap_percent,
      conflicting_numbers: entry.signals.conflicting_numbers,
    },
    document: projectDocument(entry.document),
    candidate_document: projectDocument(entry.candidateDocument),
    created_at: entry.createdAt,
  };
}
