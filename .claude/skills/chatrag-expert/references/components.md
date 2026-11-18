<overview>
ChatRAG has 74+ React components in `src/components/ui/` plus provider components in `src/components/providers/`. The app uses a deep provider stack wrapping the main chat interface. All components are functional React with hooks, using Radix UI primitives, Tailwind CSS, and Framer Motion animations.
</overview>

<provider_stack>

## Provider Stack (Context-Based State)

Root layout wraps children in this provider hierarchy:

```
ThemeProviderWrapper
  └── AuthProvider (Supabase session)
    └── ModelProvider (AI model selection)
      └── TextSizeProvider (font size)
        └── FontProvider (font family)
          └── LanguageProvider (i18n, t() function)
            └── ArtifactProvider (code preview sidebar)
              └── SourcesProvider (RAG sources display)
                └── MobileToolsProvider (mobile tool visibility)
                  ├── DynamicTitle
                  ├── NotificationSoundListener
                  ├── Toaster
                  ├── SidebarWrapper → Sidebar
                  ├── main.main-content (page route)
                  └── SourcesSidebarRenderer
```

| Provider | File | Key State |
|----------|------|-----------|
| AuthProvider | `providers/auth-provider.tsx` | Supabase session, `signOut()`, `signInWithGitHub()` |
| ModelProvider | `providers/model-provider.tsx` | Selected model, available models, reasoning detection |
| TextSizeProvider | `providers/text-size-provider.tsx` | fontSize value + setter |
| FontProvider | `providers/font-provider.tsx` | fontFamily + setter |
| LanguageProvider | `providers/language-provider.tsx` | Language enum, `t(key)` translation |
| ArtifactProvider | `providers/artifact-provider.tsx` | Artifact data, `openArtifact()`, `closeArtifact()` |
| SourcesProvider | `providers/sources-provider.tsx` | Sources array, sidebar visibility |
| MobileToolsProvider | `providers/mobile-tools-provider.tsx` | Active tool state for mobile |

</provider_stack>

<component_hierarchy>

## Main Page Component Tree

```
Page (src/app/page.tsx) - uses useChat() hook
├── Sidebar
│   ├── Chat list (virtualized via @tanstack/react-virtual)
│   ├── Folder management
│   ├── Search & filtering
│   ├── ChatItem (React.memo)
│   ├── CreateFolderModal
│   ├── OrganizationSwitcher (multi-tenant)
│   └── UserMenu
│
├── Header
│   ├── Model selector dropdown
│   ├── MCP provider selector
│   ├── New chat button
│   ├── Theme toggle
│   ├── Text size slider
│   ├── ShareChatButton
│   ├── PermanentDocUploadButton
│   ├── WhatsAppConnectionButton
│   └── GhostModeIndicator
│
├── Main Chat Area
│   ├── SuggestionButtons (AI-generated prompts)
│   │   ├── SuggestionButtonsServer (SSR)
│   │   └── SuggestionButtonsClient (interactive)
│   │
│   ├── Chat Message Container (scrollable)
│   │   └── ChatMessage (per message)
│   │       ├── StreamingMarkdown (animated text render)
│   │       ├── McpToolBox (tool call display + approval)
│   │       ├── SourceImagesGrid (RAG source images)
│   │       ├── CodeBlock (syntax highlighting + copy)
│   │       ├── Audio playback controls
│   │       └── Copy/interaction buttons
│   │
│   └── ChatInput (fixed bottom)
│       ├── Textarea (auto-expand)
│       ├── UnifiedUploadButton + DocumentSelector
│       ├── WebSearchButton
│       ├── ImageGenerationButton
│       ├── VideoGenerationButton
│       ├── ThreeDGenerationButton
│       ├── MCPToolsButton
│       ├── ReasoningButton
│       ├── MobileToolsButton
│       └── Send button
│
└── Artifact Sidebar (right, optional)
    ├── ArtifactSidebar (code preview)
    ├── Preview panel
    ├── Download modal
    └── Resize handle (draggable)
```

</component_hierarchy>

<modals>

## Modal/Dialog Components

| Component | Trigger | Purpose |
|-----------|---------|---------|
| SettingsModal | User menu → Settings | Theme, language, audio, admin settings (tabbed) |
| WorkspaceSettingsModal | Admin settings | Admin workspace configuration |
| CreateFolderModal | Sidebar folder button | Create/rename chat folders |
| ImageModal | Click image in chat | Full-size image viewer |
| WhatsAppQRModal | WhatsApp button | QR code for connection |
| WhatsAppStatusModal | WhatsApp status | Session status display |
| ShareChatDialog | Share button | Public share link generation |
| MobileToolsModal | Mobile tools button | Full modal for tools on small screens |
| MobileToolConfigModal | Tool config | Configure tool settings on mobile |
| MobileMCPToolsModal | MCP tools button | MCP tools list on mobile |

</modals>

<key_components>

## Critical Components by Feature

| Feature | Component | File |
|---------|-----------|------|
| Chat interface | Page | `src/app/page.tsx` |
| Message display | ChatMessage | `src/components/ui/chat-message.tsx` |
| Chat input | ChatInput | `src/components/ui/chat-input.tsx` |
| Sidebar | Sidebar | `src/components/ui/sidebar.tsx` |
| Header/Tools | Header | `src/components/ui/header.tsx` |
| Document upload | UnifiedUploadButton | `src/components/ui/unified-upload-button.tsx` |
| Document dashboard | DocumentDashboard | `src/components/ui/document-dashboard.tsx` |
| Settings | SettingsModal | `src/components/ui/settings-modal.tsx` |
| Code preview | ArtifactSidebar | `src/components/ui/artifact-sidebar/index.tsx` |
| Streaming text | StreamingMarkdown | `src/components/ui/streaming-markdown.tsx` |
| MCP tools | McpToolBox | `src/components/ui/mcp-tool-box.tsx` |
| Sources | SourcesButton/Sidebar | `src/components/providers/sources-provider.tsx` |
| Model selector | ModelSelector | `src/components/ui/model-selector.tsx` |
| 3D viewer | ModelViewer | `src/components/ui/model-viewer.tsx` |

</key_components>

<patterns>

## Key UI Patterns

**State management approach:**
1. Global state → Zustand stores (chat, settings, admin)
2. Context API → Providers (theme, auth, language, artifact)
3. Local state → useState for ephemeral UI state
4. Streaming state → `useChat()` hook from `@ai-sdk/react`

**Performance optimizations:**
- `React.memo()` on list items (ChatItem, etc.)
- `@tanstack/react-virtual` for large chat lists in sidebar
- `useShallow()` from Zustand to prevent unnecessary re-renders
- Event debouncing: Chat update events debounced 50ms
- Next.js `Image` component for lazy loading

**Streaming display:**
- `StreamingMarkdown` component handles char-by-char animation
- `StreamProcessor` handles incremental text rendering
- Content parts: text, tool calls, tool results, source images

**UI library stack:**
- Radix UI: Dialogs, dropdowns, select, switch, tabs, tooltip, accordion, etc.
- Framer Motion: Animations (sidebar, modals, transitions)
- Tailwind CSS: Utility-first with custom color palette
- Lucide React: Icon library
- React Markdown: GFM + math (remark-gfm, remark-math, rehype-katex)

**Styling:**
- Tailwind with CSS custom properties for theming
- Dark mode via `dark:` prefix (class-based)
- Primary color: #FF6417 (orange)
- Light bg: #FFF1E5 / Dark bg: #1A1A1A
- Custom scrollbar via Tailwind plugin

**Mobile responsive:**
- Touch device detection via `src/hooks/use-mobile-detection.ts`
- CSS `dvh` units for viewport handling
- Safe area insets for notched devices
- Collapsible sidebar (drawer on mobile)
- Keyboard detection prevents viewport squeeze

</patterns>

<chat_types>

## Chat Message Types

```typescript
interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  createdAt?: Date;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; imageAspectRatio?: string }
  | { type: 'document'; id: string; name: string; content: string }
  | { type: 'source-image'; imageUrl: string; sourceUrl?: string; sourceTitle?: string };

interface ExtendedMessage extends UIMessage {
  status?: 'sending' | 'error' | 'sent';
  isStreaming?: boolean;
  isThinking?: boolean;
}
```

</chat_types>
