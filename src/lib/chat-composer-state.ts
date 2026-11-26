export type ComposerState = 'collapsed' | 'expanded';

export interface ComposerStateInput {
  focused: boolean;
  text: string;
  hasAttachment: boolean;
  hasActiveTool: boolean;
  menuOpen: boolean;
  isRecording: boolean;
}

/**
 * Phones show a one-line capsule while the composer is idle and a multi-line card while it is in use.
 * Anything the user is still working with (focus, text, an attachment, an active tool, an open menu,
 * dictation) keeps the card expanded.
 */
export function getComposerState(input: ComposerStateInput): ComposerState {
  const inUse =
    input.focused ||
    input.text.trim().length > 0 ||
    input.hasAttachment ||
    input.hasActiveTool ||
    input.menuOpen ||
    input.isRecording;
  return inUse ? 'expanded' : 'collapsed';
}
