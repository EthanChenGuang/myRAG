'use client';

import * as React from 'react';
import { docTypeLabel, DOC_TYPE_CHOICES, type DocTypeLabelId } from '@/components/ui/doc-type-labels';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type DocTypePickerValue = DocTypeLabelId;

export interface DocTypePickerOption {
  value: DocTypePickerValue;
  label: string;
  selected: boolean;
}

export function buildDocTypePickerOptions(language: string, value: DocTypePickerValue): DocTypePickerOption[] {
  return DOC_TYPE_CHOICES.map((choice) => ({
    value: choice,
    label: docTypeLabel(choice, language),
    selected: choice === value,
  }));
}

export interface DocTypePickerProps {
  value: DocTypePickerValue;
  language: string;
  onChange: (value: DocTypePickerValue) => void;
  className?: string;
  disabled?: boolean;
}

export function DocTypePicker({ value, language, onChange, className, disabled }: DocTypePickerProps) {
  const options = React.useMemo(() => buildDocTypePickerOptions(language, value), [language, value]);
  return (
    <Select value={value} onValueChange={(next) => onChange(next as DocTypePickerValue)} disabled={disabled}>
      <SelectTrigger className={cn('h-8 w-[11.5rem] text-xs', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface ChatUploadFormDataInput {
  file: File;
  organizationId?: string | null;
  pickerEnabled: boolean;
  docType?: string | null;
  scopes?: readonly string[];
  replacesDocumentId?: string | null;
}

/** Builds the process-document FormData; without a doc type, tags or a replaced document it stays byte-identical to legacy mode. */
export function buildChatUploadFormData(input: ChatUploadFormDataInput): FormData {
  const formData = new FormData();
  formData.append('file', input.file);
  if (input.organizationId) {
    formData.append('organization_id', input.organizationId);
  }
  if (input.pickerEnabled && input.docType) {
    formData.append('doc_type', input.docType);
  }
  for (const tag of input.scopes ?? []) {
    formData.append('scopes', tag);
  }
  if (input.replacesDocumentId) {
    formData.append('replaces_document_id', input.replacesDocumentId);
  }
  return formData;
}

export const INGEST_POLL_INITIAL_MS = 1000;
export const INGEST_POLL_MAX_MS = 8000;
export const INGEST_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const TERMINAL_STATUSES = new Set(['ready', 'quarantined', 'pending_review', 'failed']);

export function ingestPollDelayMs(attempt: number): number {
  const delay = INGEST_POLL_INITIAL_MS * 2 ** attempt;
  return Math.min(delay, INGEST_POLL_MAX_MS);
}

export interface IngestStatusSnapshot {
  status: string;
}

export interface PollIngestOptions {
  fetchStatus: (documentId: string) => Promise<IngestStatusSnapshot>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  startedAt?: number;
}

/** Polls GET /api/rag/ingest/{id} with 1s-doubling backoff (cap 8s) until ready, quarantined, pending_review, failed or timeout. */
export async function pollIngestUntilTerminal(
  documentId: string,
  options: PollIngestOptions,
): Promise<IngestStatusSnapshot> {
  const startedAt = options.startedAt ?? options.now();
  let attempt = 0;
  for (;;) {
    const snapshot = await options.fetchStatus(documentId);
    if (TERMINAL_STATUSES.has(snapshot.status)) {
      return snapshot;
    }
    if (options.now() - startedAt >= INGEST_POLL_TIMEOUT_MS) {
      return { status: 'processing' };
    }
    const delay = ingestPollDelayMs(attempt);
    attempt += 1;
    await options.sleep(delay);
  }
}