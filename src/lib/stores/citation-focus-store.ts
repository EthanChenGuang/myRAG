import { create } from 'zustand';

export interface CitationFocus {
  chatId: string | null;
  messageId: string;
  n: number;
}

interface CitationFocusState {
  focus: CitationFocus | null;
  focusCitation: (focus: CitationFocus) => void;
  clear: () => void;
  syncChat: (chatId: string | null) => void;
}

export const useCitationFocusStore = create<CitationFocusState>()(() => ({
  focus: null,
  focusCitation: () => {},
  clear: () => {},
  syncChat: () => {},
}));
