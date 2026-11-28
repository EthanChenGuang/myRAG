import { tool } from 'ai';
import { z } from 'zod/v3';

/** A document this request's retrieval used (already filtered by the caller's access scope). */
export interface ReferenceToolDocument {
  id: string;
  name?: string | null;
  filename?: string | null;
}

/** The answer for any document that is not one of this request's used documents: the same whether or not such a document exists. */
export const NEUTRAL_REFERENCE_RESULT = Object.freeze({ success: false, message: '', internal: true });

const DESCRIPTION =
  'IMPORTANT: This is a FUNCTION TOOL to track document usage internally. Call this tool when you use information from documents. DO NOT write "useDocument" as text in your response. This tool tracks which documents you referenced to answer the query.';

function nameOf(doc: ReferenceToolDocument): string {
  return doc.name || doc.filename || '';
}

/**
 * D-15, A-12: the useDocument tool for one request. It knows only this request's used documents (matched by id, or by name or filename,
 * since the context carries names), answers with the stored name of the matched document, and answers any other reference with
 * NEUTRAL_REFERENCE_RESULT. It keeps no module-level state, so concurrent requests never see each other's documents.
 */
export function createDocumentReferenceTool(usedDocuments: readonly ReferenceToolDocument[]) {
  const byId = new Map<string, ReferenceToolDocument>();
  const byName = new Map<string, ReferenceToolDocument>();
  for (const doc of usedDocuments) {
    if (typeof doc.id !== 'string' || doc.id.length === 0) continue;
    if (!byId.has(doc.id)) byId.set(doc.id, doc);
    for (const name of [doc.name, doc.filename]) {
      if (typeof name === 'string' && name.length > 0 && !byName.has(name)) byName.set(name, doc);
    }
  }
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      documentId: z.string().describe('The ID of the document that was used'),
      documentName: z.string().describe('The name/filename of the document'),
      relevance: z.number().min(0).max(100).describe('How relevant this document was to the query (0-100)'),
      reason: z.string().describe('Why this document was used to answer the query'),
    }),
    execute: async ({ documentId, documentName, relevance }) => {
      const doc = byId.get(documentId) ?? byName.get(documentName);
      if (!doc) {
        console.log('[Document Reference Tool] Reference outside this answer ignored');
        return { ...NEUTRAL_REFERENCE_RESULT };
      }
      const name = nameOf(doc);
      console.log('[Document Reference Tool] Document referenced:', { documentId: doc.id, relevance });
      return {
        success: true,
        message: `📚 **Source:** ${name} (Relevance: ${relevance}%)`,
        internal: false,
        documentName: name,
        relevance,
      };
    },
  });
}
