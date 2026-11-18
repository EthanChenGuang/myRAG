<overview>
ChatRAG supports multiple AI providers via OpenRouter and direct OpenAI integration. Model configuration must be synchronized across 5 files. The system supports reasoning models with different methods (effort, max_tokens, both).
</overview>

<model_schema>

## Model Schema

```typescript
interface Model {
  id: string;            // Provider-prefixed: "openai/gpt-4o" or "anthropic/claude-sonnet-4"
  displayName: string;   // UI display name
  isFree?: boolean;      // 🎁 badge in selector
  isOpenSource?: boolean; // 🔓 badge in selector
  isUncensored?: boolean;
  supportsReasoning?: boolean; // 🧠 badge in selector
  reasoningMethod?: 'effort' | 'max_tokens' | 'both' | 'none';
  maxTokensLimit?: number;
  minTokens?: number;
  defaultEffort?: 'high' | 'medium' | 'low';
  contextLength?: number;
  description?: string;
  isDefault?: boolean;   // Pre-selected model
}
```

</model_schema>

<five_file_sync>

## 5-File Synchronization Requirement

Models MUST match across all 5 files. Mismatch causes missing models, broken icons, or UI errors.

### File 1: `.env.local`
```env
NEXT_PUBLIC_AI_PROVIDER=openrouter
NEXT_PUBLIC_OPENAI_MODELS=[{"id":"openai/gpt-4o","displayName":"GPT-4o",...}]
NEXT_PUBLIC_OPENROUTER_MODELS=[{"id":"anthropic/claude-sonnet-4","displayName":"Claude Sonnet 4",...}]
```

### File 2: `scripts/init-env.js`
```javascript
const DEFAULT_OPENAI_MODELS = '[...]'    // Template defaults
const DEFAULT_OPENROUTER_MODELS = '[...]'
```
**Source of truth** - update this first when changing defaults.

### File 3: `src/lib/env.ts`
```typescript
NEXT_PUBLIC_OPENAI_MODELS: process.env.NEXT_PUBLIC_OPENAI_MODELS || JSON.stringify([...])
NEXT_PUBLIC_OPENROUTER_MODELS: process.env.NEXT_PUBLIC_OPENROUTER_MODELS || JSON.stringify([...])
```
Fallback defaults if env vars missing.

### File 4: `scripts/config-server.js`
```javascript
const DEFAULT_OPENAI_MODELS = '[...]'
const DEFAULT_OPENROUTER_MODELS = '[...]'
```
Config dashboard defaults.

### File 5: `scripts/config-ui/index.html`
```javascript
const FALLBACK_OPENAI_MODELS = [...]
const FALLBACK_OPENROUTER_MODELS = [...]
```
Three fallback arrays embedded in the config UI.

**Update order:** `init-env.js` (source of truth) → remaining 4 files → restart dev server

</five_file_sync>

<reasoning_models>

## Reasoning Model Support

Defined in `src/lib/types.ts` as `REASONING_MODELS`:

```typescript
interface ModelReasoningCapability {
  supported: boolean;
  method: 'effort' | 'max_tokens' | 'both' | 'none';
  defaultEffort?: 'high' | 'medium' | 'low';
  maxTokensLimit?: number;
  minTokens?: number;
}
```

**Reasoning methods:**
- `effort`: Set reasoning effort level (low/medium/high) - OpenAI o-series
- `max_tokens`: Set max reasoning tokens - Anthropic Claude, DeepSeek R1
- `both`: Supports both methods - some models
- `none`: Model reasons but doesn't expose control

**UI:** `ReasoningButton` component toggles reasoning mode. `ReasoningStore` manages state.

**Key reasoning models:**
- OpenAI: o1, o1-mini, o3-mini (effort method)
- Anthropic: Claude 3.7 Sonnet+, Claude 4 (max_tokens method)
- DeepSeek: R1 (max_tokens method)
- Google: Gemini 2.5 Pro/Flash thinking (max_tokens method)

</reasoning_models>

<provider_routing>

## Provider Routing

**Primary selection:** `NEXT_PUBLIC_AI_PROVIDER` env var (`openrouter` or `openai`)

**OpenRouter** (`src/lib/openrouter.ts`):
- Base URL: `https://openrouter.ai/api/v1`
- Compatible with OpenAI SDK
- Supports 200+ models from multiple providers
- Headers: GitHub referer, app name as X-Title

**OpenAI** (via `@ai-sdk/openai`):
- Direct OpenAI API access
- Required for embeddings regardless of primary provider
- Used for title generation, image generation

**Model selector:** `src/components/ui/model-selector.tsx`
- Displays badges: 🧠 reasoning, 🎁 free, 🔓 open source
- Context length display
- Description tooltips

</provider_routing>

<title_generation>

## Title Generation

**Model:** `CHAT_TITLE_MODEL` (default: `anthropic/claude-haiku-4.5`)
**Temp:** `CHAT_TITLE_TEMPERATURE` (default: 0.5)
**Max tokens:** `CHAT_TITLE_MAX_TOKENS` (default: 100)

Modules: `title-generator.ts`, `title-generator-creative.ts`, `title-generator-multimodal.ts`
- AI-based smart title with heuristic fallback
- Creative titles for generation chats: "Image Generation: [prompt]"
- Multimodal titles for mixed content

</title_generation>
