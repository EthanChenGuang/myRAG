<overview>
ChatRAG uses Zustand for global state management. All stores use the `useShallow` selector pattern from `zustand/react/shallow` to prevent unnecessary re-renders. The React Compiler is enabled but Zustand selectors are still important for subscription optimization.
</overview>

<chat_store>

## ChatStore (`src/lib/chat-store.ts`)

The primary store managing all chat data and folder organization.

```typescript
interface ChatStore {
  // State
  chats: Chat[];
  folders: Folder[];
  currentChatId: string | null;
  currentFolderId: string | null;
  isSidebarOpen: boolean;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  filteredChats: Chat[];

  // Chat CRUD
  fetchChats(organizationId?: string | null): Promise<any[] | undefined>;
  createChat(messages: DBMessage[], folderId?: string, organizationId?: string | null): Promise<string | null>;
  updateChat(chatId: string | null, messages: DBMessage[]): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  setCurrentChat(chatId: string | null): void;
  renameChat(chatId: string, newTitle: string): Promise<void>;
  togglePinChat(chatId: string): Promise<void>;
  setSearchQuery(query: string): void;

  // Chat helpers
  getPinnedChats(): Chat[];
  getUnpinnedChats(): Chat[];

  // Folder CRUD
  fetchFolders(): Promise<any[] | undefined>;
  createFolder(input: CreateFolderInput): Promise<string | null>;
  updateFolder(folderId: string, input: UpdateFolderInput): Promise<void>;
  deleteFolder(folderId: string, deleteChats?: boolean): Promise<void>;
  togglePinFolder(folderId: string): Promise<void>;
  moveChatToFolder(chatId: string, folderId: string | null): Promise<void>;
  moveChatsToFolder(chatIds: string[], folderId: string | null): Promise<void>;
  setCurrentFolder(folderId: string | null): void;

  // Folder helpers
  getChatsByFolder(folderId: string | null): Chat[];
  getPinnedFolders(): Folder[];
  getUnpinnedFolders(): Folder[];
}
```

**Key patterns:**
- Deduplication mutex for concurrent chat creation
- Ghost mode support (skips persistence)
- Emits `ChatEvents.CHAT_CREATED` and `ChatEvents.CHAT_UPDATED` custom events
- Title generation callback support (async AI title)
- Persists to Supabase `chats` and `folders` tables

**Usage:**
```typescript
const { currentChatId, chats } = useChatStore(
  useShallow((s) => ({ currentChatId: s.currentChatId, chats: s.chats }))
);
```

</chat_store>

<user_settings_store>

## UserSettingsStore (`src/lib/user-settings-store.ts`)

Persistent user preferences with localStorage.

```typescript
interface UserSettingsState {
  backgroundImage: string | null;
  notificationSoundEnabled: boolean;
  notificationSoundType: 'bell' | 'soft' | 'low' | 'subtle';
  fontSize: string;
  fontFamily: string;
  markdownEnabled: boolean;
  defaultModel: string;
  language: string;
  webSearchEnabled: boolean;
  voiceProvider: 'openai' | 'elevenlabs';
  elevenLabsVoiceId: string | null;
  ttsDisabled: boolean;
  sttDisabled: boolean;
  audioAutoplay: boolean;

  setBackgroundImage(url: string | null): void;
  uploadBackground(file: File): Promise<string | null>;
  setNotificationSoundEnabled(enabled: boolean): void;
  setNotificationSoundType(type: string): void;
  setVoiceProvider(provider: 'openai' | 'elevenlabs'): void;
  setElevenLabsVoiceId(voiceId: string | null): void;
  setTtsDisabled(disabled: boolean): void;
  setSttDisabled(disabled: boolean): void;
  setAudioAutoplay(enabled: boolean): void;
}
```

**Persisted to:** `user-settings-storage` (localStorage with version migration, currently v3)

</user_settings_store>

<reasoning_store>

## ReasoningStore (`src/lib/stores/reasoning-store.ts`)

Controls extended thinking / reasoning model settings.

```typescript
interface ReasoningStore {
  enabled: boolean;
  effort: 'high' | 'medium' | 'low';
  maxOutputTokens: number;
  exclude?: boolean;

  setConfig(config: Partial<ReasoningConfig>): void;
  setEnabled(enabled: boolean): void;
  setEffort(effort: 'high' | 'medium' | 'low'): void;
  setMaxTokens(maxTokens: number): void;
  setExclude(exclude: boolean): void;
  getConfig(): ReasoningConfig | null; // null if disabled
  reset(): void;
}
```

**Defaults:** `{ enabled: false, effort: 'medium', maxOutputTokens: 8000 }`

</reasoning_store>

<organization_store>

## OrganizationStore (`src/lib/stores/organization-store.ts`)

Three-tier workspace architecture for multi-tenant mode.

**Tiers:**
1. Personal Workspace (flat, no org, user_id isolation)
2. Personal Projects (`is_personal: true`, owner only, convertible)
3. Collaborative Projects (`is_personal: false`, multi-member)

```typescript
interface OrganizationState {
  isPersonalMode: boolean;
  currentOrganization: Organization | null;
  personalOrganizations: Organization[];
  teamOrganizations: Organization[];
  allOrganizations: Organization[];
  isLoading: boolean;
  isLoadingMembers: boolean;
  isLoadingInvites: boolean;
  members: OrganizationMember[];
  invitations: TeamInvitation[];
  error: string | null;

  fetchOrganizations(): Promise<void>;
  setCurrentOrganization(orgId: string | null): Promise<void>;
  switchToPersonalWorkspace(): void;
  createPersonalOrganization(name: string): Promise<Organization | null>;
  shareOrganization(orgId: string): Promise<boolean>; // personal → collaborative
  updateOrganization(orgId: string, updates: Partial<Organization>): Promise<boolean>;
  deleteOrganization(orgId: string): Promise<boolean>;
  fetchMembers(orgId: string): Promise<void>;
  addMember(orgId: string, userId: string, role: string): Promise<boolean>;
  updateMemberRole(orgId: string, userId: string, role: string): Promise<boolean>;
  removeMember(orgId: string, userId: string): Promise<boolean>;
  fetchInvitations(orgId: string): Promise<void>;
  createInvitation(orgId: string, email: string, role: string): Promise<TeamInvitation | null>;
  revokeInvitation(orgId: string, email: string): Promise<boolean>;
  reset(): void;
}
```

**Persisted fields:** `isPersonalMode`, `currentOrganization`, `personalOrganizations`, `teamOrganizations`, `allOrganizations`

</organization_store>

<other_stores>

## Other Stores

**AdminStore** (`src/lib/admin-store.ts`)
```typescript
{ isAdmin: boolean; isCheckingAdmin: boolean; checkAdminStatus(): Promise<void>; logoutAdmin(): Promise<void> }
```
Hook: `useAdmin()` - auto-initializes on mount

**WebSearchStore** (`src/lib/web-search-store.ts`)
```typescript
{ isEnabled: boolean; isAvailable: boolean; toggleWebSearch(): void }
```

**FileUploadStore** (`src/lib/file-upload-store.ts`)
```typescript
{ file: File | null; fileUrl: string | null; fileType: 'image' | 'document' | null; isEnabled: boolean; isUploading: boolean; uploadError: string | null; downloadableUrl: string | null; setFile(f): void; clearFile(): void; toggleFileUpload(): void }
```

**MultiFileUploadStore** (`src/lib/multi-file-upload-store.ts`)
- Batch file uploads with per-file progress tracking

**GhostModeStore** (`src/lib/ghost-mode-store.ts`)
```typescript
{ isInGhostMode: boolean; hasUnsavedMessages: boolean }
```
- Temporary chat mode (no persistence to Supabase)

**DocumentMentionStore** (`src/lib/document-mention-store.ts`)
- Tracks which documents are referenced/mentioned in chat for source attribution

</other_stores>
