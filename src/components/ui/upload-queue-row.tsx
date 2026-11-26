'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocTypePicker, type DocTypePickerValue } from '@/components/ui/doc-type-picker';
import { ReplacesLine, ReplacesPicker, type ReplaceCandidate } from '@/components/ui/replaces-picker';
import { ScopeTagPicker, type ScopeTagVocabularyEntry } from '@/components/ui/scope-tag-picker';

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

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white dark:hover:bg-[#212121]"
      onClick={onRemove}
    >
      <Trash2 className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
      <span className="sr-only">Remove file</span>
    </Button>
  );
}

/**
 * One file of the knowledge-base upload queue (UI-SPEC 6.12). Without tags and "Replaces…" it renders the row of today; with
 * either, the controls form a group that wraps under the file name.
 */
export function UploadQueueRow({ fileName, fileSize, language, disabled, docType, tags, replaces, onRemove }: UploadQueueRowProps) {
  const sizeLine = <p className="text-xs text-gray-600 dark:text-gray-400">{(fileSize / 1024 / 1024).toFixed(2)} MB</p>;
  const docTypePicker = docType ? (
    <DocTypePicker value={docType.value} language={language} disabled={disabled} onChange={docType.onChange} />
  ) : null;

  if (!tags && !replaces) {
    return (
      <div className="group flex items-center justify-between gap-2 px-4 py-2 hover:bg-white/50 dark:hover:bg-[#212121]">
        <div className="grid gap-0.5 min-w-0 flex-1 mr-2">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{fileName}</p>
          {sizeLine}
        </div>
        {docTypePicker}
        <RemoveButton onRemove={onRemove} />
      </div>
    );
  }

  return (
    <div className="group flex flex-wrap items-center justify-between gap-2 px-4 py-2 hover:bg-white/50 dark:hover:bg-[#212121]">
      <div className="grid gap-0.5 min-w-[12rem] flex-1 mr-2">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate" title={fileName}>
          {fileName}
        </p>
        {sizeLine}
        {replaces?.value ? (
          <ReplacesLine language={language} name={replaces.value.name} disabled={disabled} onRemove={() => replaces.onChange(null)} />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {docTypePicker}
        {tags ? (
          <ScopeTagPicker
            enabled
            vocabulary={tags.vocabulary}
            value={tags.value}
            language={language}
            fileName={fileName}
            disabled={disabled}
            error={tags.error}
            onChange={tags.onChange}
          />
        ) : null}
        {replaces ? (
          <ReplacesPicker
            enabled
            confirmedAtOnce={replaces.confirmedAtOnce}
            fileName={fileName}
            candidates={replaces.candidates}
            language={language}
            value={replaces.value}
            disabled={disabled}
            onChange={replaces.onChange}
          />
        ) : null}
        <RemoveButton onRemove={onRemove} />
      </div>
    </div>
  );
}
