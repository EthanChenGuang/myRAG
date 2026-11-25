import { create } from 'zustand';

export interface CitationFocus {
  chatId: string | null;
  messageId: string;
  n: number;
}

interface CitationFocusState {
  focus: CitationFocus | null;
  chatId: string | null;
  focusCitation: (focus: CitationFocus) => void;
  clear: () => void;
  syncChat: (chatId: string | null) => void;
}

export const useCitationFocusStore = create<CitationFocusState>()((set) => ({
  focus: null,
  chatId: null,
  focusCitation: (focus) => set({ focus, chatId: focus.chatId }),
  clear: () => set((state) => (state.focus === null ? state : { focus: null })),
  syncChat: (chatId) =>
    set((state) => {
      if (state.chatId === chatId) return state;
      return { chatId, focus: state.focus && state.focus.chatId === chatId ? state.focus : null };
    }),
}));
