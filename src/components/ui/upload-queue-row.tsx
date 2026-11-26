'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocTypePicker, type DocTypePickerValue } from '@/components/ui/doc-type-picker';
import type { ReplaceCandidate } from '@/components/ui/replaces-picker';
import type { ScopeTagVocabularyEntry } from '@/components/ui/scope-tag-picker';

export interface UploadQueueRowTags {
  vocabulary: ScopeTagVocabularyEntry[];
  value: string[];
  onChange: (value: string[]) => void;
  error: string | null;
}

export interface UploadQueueRowReplaces {
  confirmedAtOnce: boolean;
  candidates: ReplaceCandidate[];
  value: ReplaceCandidate | null;
  onChange: (value: ReplaceCandidate | null) => void;
}

export interface UploadQueueRowProps {
  fileName: string;
  fileSize: number;
  language: string;
  disabled: boolean;
  docType: { value: DocTypePickerValue; onChange: (value: DocTypePickerValue) => void } | null;
  tags?: UploadQueueRowTags | null;
  replaces?: UploadQueueRowReplaces | null;
  onRemove: () => void;
}

/** One file of the knowledge-base upload queue (UI-SPEC 6.12). */
export function UploadQueueRow({ fileName, fileSize, language, disabled, docType, onRemove }: UploadQueueRowProps) {
  return (
    <div className="group flex items-center justify-between gap-2 px-4 py-2 hover:bg-white/50 dark:hover:bg-[#212121]">
      <div className="grid gap-0.5 min-w-0 flex-1 mr-2">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{fileName}</p>
        <p className="text-xs text-gray-600 dark:text-gray-400">{(fileSize / 1024 / 1024).toFixed(2)} MB</p>
      </div>
      {docType ? <DocTypePicker value={docType.value} language={language} disabled={disabled} onChange={docType.onChange} /> : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 flex-shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white dark:hover:bg-[#212121]"
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
        <span className="sr-only">Remove file</span>
      </Button>
    </div>
  );
}
