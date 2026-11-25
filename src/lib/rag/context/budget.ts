import { countTokens, truncateToTokens } from '@/lib/rag/ingest/text/tokens';

export interface BudgetCandidate {
  rank: number;
  chunk_id: string;
  document_id: string;
  document_filename: string;
  content: string;
}

export interface BudgetRenderContext {
  addsDocumentHeader: boolean;
}

export type RenderEstimate<C extends BudgetCandidate = BudgetCandidate> = (
  candidate: C,
  ctx: BudgetRenderContext,
) => string;

export interface BudgetOptions {
  imageExtensions: string[];
}

export interface BudgetResult<C extends BudgetCandidate = BudgetCandidate> {
  selected: C[];
  contentOverrides: Map<string, string>;
  usedTokens: number;
}

export function countContextTokens(text: string): number {
  return countTokens(text);
}

function isImageDocument(filename: string, imageExtensions: string[]): boolean {
  const lower = filename.toLowerCase();
  return imageExtensions.some((ext) => lower.endsWith(ext));
}

export function selectWithinBudget<C extends BudgetCandidate>(
  candidates: BudgetCandidate[],
  budget: number,
  renderEstimate: RenderEstimate<C>,
  options: BudgetOptions,
): BudgetResult<C> {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank);
  const selected: C[] = [];
  const contentOverrides = new Map<string, string>();
  const seenDocuments = new Set<string>();
  let usedTokens = 0;

  for (const candidate of sorted) {
    const isImage = isImageDocument(candidate.document_filename, options.imageExtensions);
    const addsDocumentHeader = !seenDocuments.has(candidate.document_id);
    const rendered = renderEstimate(candidate as C, { addsDocumentHeader });
    const tokens = countContextTokens(rendered);

    if (isImage) {
      selected.push(candidate as C);
      seenDocuments.add(candidate.document_id);
      continue;
    }

    if (selected.length === 0 && candidate.rank === 1) {
      if (tokens > budget) {
        const headerOnly = addsDocumentHeader
          ? renderEstimate({ ...candidate, content: '' } as C, { addsDocumentHeader: true })
          : '';
        const headerTokens = countContextTokens(headerOnly);
        const bodyBudget = Math.max(budget - headerTokens, 1);
        const truncated = truncateToTokens(candidate.content, bodyBudget);
        contentOverrides.set(candidate.chunk_id, truncated);
        usedTokens = countContextTokens(
          renderEstimate({ ...candidate, content: truncated } as C, { addsDocumentHeader }),
        );
        selected.push(candidate as C);
        seenDocuments.add(candidate.document_id);
        continue;
      }
    }

    if (usedTokens + tokens > budget) {
      if (candidate.rank === 1 && selected.length === 0) {
        const headerOnly = addsDocumentHeader
          ? renderEstimate({ ...candidate, content: '' } as C, { addsDocumentHeader: true })
          : '';
        const headerTokens = countContextTokens(headerOnly);
        const bodyBudget = Math.max(budget - headerTokens, 1);
        const truncated = truncateToTokens(candidate.content, bodyBudget);
        contentOverrides.set(candidate.chunk_id, truncated);
        usedTokens = countContextTokens(
          renderEstimate({ ...candidate, content: truncated } as C, { addsDocumentHeader }),
        );
        selected.push(candidate as C);
        seenDocuments.add(candidate.document_id);
      }
      continue;
    }

    selected.push(candidate as C);
    usedTokens += tokens;
    seenDocuments.add(candidate.document_id);
  }

  return { selected: selected as C[], contentOverrides, usedTokens };
}