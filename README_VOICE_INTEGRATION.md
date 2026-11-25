# Real-Time Voice Integration

**Status:** ✅ **PRODUCTION-READY**  
**Last Updated:** January 8, 2026

---

## Overview

myRAG includes a full-featured real-time voice assistant. Users can have natural conversations with the AI using their microphone, with responses spoken back via text-to-speech and displayed with word-level synchronization.

### Technology Stack

| Component | Technology |
|-----------|------------|
| Audio Transport | [LiveKit](https://docs.livekit.io/) |
| Speech-to-Text | [AssemblyAI Streaming V3](https://assemblyai.com/docs) |
| RAG Query | Internal API + Reranking |
| LLM | Configurable (OpenAI / Groq / OpenRouter) |
| Text-to-Speech | [Resemble.ai (Chatterbox)](https://docs.app.resemble.ai/) |
| Voice Activity Detection | Silero VAD (local) |
| Frontend Orb | OGL WebGL Shader |

---

## Features

### Voice Pipeline
- **Full Conversation Loop:** User speaks → Transcribed → RAG Query → LLM Response → TTS → Audio Playback
- **Proactive Greeting:** Agent welcomes users when they join
- **Query Rewriting:** Follow-up questions resolved using conversation context (e.g., "How much is it?" → "How much is myRAG's pricing?")
- **Sentence Streaming:** Parallel TTS generation with ordered playback queue
- **Word-Level Text Sync:** Text overlay reveals word-by-word synchronized with audio using Resemble.ai timestamps
- **Barge-In:** Local Silero VAD detects user speech instantly, with 1.5s cooldown after interruption
- **Multilingual:** Universal STT model supports English, Spanish, French, German, etc.
- **Image RAG:** Retrieve and display images from knowledge base via voice queries ("Show me the logo")

### Voice Mode UI
- **OGL Orb Visualizer:** Iridescent, audio-reactive WebGL sphere with myRAG brand gradient
- **Dynamic Animations:** Concentric wave ripples, edge glow, scale pulsing (15% max)
- **"End" Button Waveform:** 4-bar animation reacts to user's microphone
- **Bouncing Dots:** Three-dot animation indicates "thinking" state
- **Auto-Refresh:** Sidebar automatically updates 4s after session ends
- **Rich Chat History:** Saved chats include expandable source citations and markdown formatting

### Session Management
- **Persistence:** Chats are saved to Supabase (Postgres) upon user disconnection
- **Memory Management:** `VoicePipeline.reset()` called on Connect/Disconnect events
- **Session Isolation:** History strictly cleared between connections to prevent context leakage

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js)                       │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ voice-mode-     │  │ VoiceEndButton   │  │ OglOrb         │  │
│  │ overlay.tsx     │  │ (user mic react) │  │ (WebGL shader) │  │
│  │ (LiveKit hooks) │  │                  │  │                │  │
│  └────────┬────────┘  └──────────────────┘  └────────────────┘  │
│           │                                                      │
│           │ WebSocket (LiveKit)                                  │
└───────────┼──────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Voice Agent (Node.js Worker)                  │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ LiveKit   │  │AssemblyAI │  │ LLM       │  │ Resemble TTS │  │
│  │ Audio I/O │→ │ STT       │→ │ + RAG     │→ │              │  │
│  └───────────┘  └───────────┘  └───────────┘  └──────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Silero VAD (local) - Barge-in detection                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- LiveKit Cloud account (or self-hosted LiveKit server)
- AssemblyAI API key (for STT)
- Resemble.ai API key (for TTS)
- One LLM provider: OpenAI, Groq (recommended for speed), or OpenRouter

### Environment Variables

```bash
# voice-agent/.env

# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# STT & TTS
ASSEMBLYAI_API_KEY=your_assemblyai_key
RESEMBLE_API_KEY=your_resemble_key
RESEMBLE_VOICE_ID=your_voice_uuid
RESEMBLE_STREAM_URL=https://f.cluster.resemble.ai/stream

# RAG Connection
MYRAG_INTERNAL_API_URL=http://localhost:3000/api/internal/voice-rag
MYRAG_INTERNAL_API_KEY=your_internal_api_key

# LLM Provider (choose one)
VOICE_AGENT_LLM_PROVIDER=groq   # openai | groq | openrouter
VOICE_AGENT_MODEL=llama-3.3-70b-versatile

# Provider API Keys (based on provider choice)
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...            # Recommended for speed
OPENROUTER_API_KEY=sk-or-...

# Optional
ASSEMBLYAI_LANGUAGE=en          # es, fr, de, etc.
```

### Running Locally

```bash
# Terminal 1: Start Next.js frontend
npm run dev

# Terminal 2: Start voice agent
cd voice-agent && npm run dev

# Terminal 3 (Optional): Visual configuration dashboard
cd voice-agent && npm run config
# Opens at http://localhost:3334

# Click the voice mode button in the myRAG UI
```

---

## File Structure

```
voice-agent/
├── src/
│   ├── agent.ts           # Main agent: LiveKit, VAD, audio mutex
│   ├── voice_agent.ts     # Pipeline: query rewriting, greeting, cooldown
│   ├── rag_client.ts      # Internal RAG API client
│   └── providers/
│       ├── assemblyai.ts  # STT (48kHz, multilingual)
│       ├── resemble.ts    # TTS with WAV header stripping
│       └── types.ts       # Provider interfaces
└── .env                   # API keys & model settings

src/
├── components/
│   ├── ui/
│   │   ├── chat-input.tsx         # Voice mode trigger button
│   │   └── voice-end-button.tsx   # "End" button with waveform
│   └── voice/
│       ├── voice-mode-overlay.tsx # LiveKit connection, audio analysis
│       └── ogl-orb.tsx            # WebGL orb shader
├── lib/
│   ├── hooks/use-voice-mode.ts    # Voice mode state hook
│   └── stores/voice-store.ts      # Zustand store for user amplitude
└── app/api/internal/
    └── voice-rag/route.ts         # RAG endpoint for voice queries
```

---

## Mobile Support

Voice mode works fully on mobile devices (iOS/Android) with some architectural considerations:

### Mobile-Specific Features

| Feature | Implementation |
|---------|----------------|
| **Transport** | Custom ngrok tunnel for HTTPS + LiveKit Cloud |
| **Audio** | Full two-way audio with permission handling |
| **Orb Visual** | Centered via JS-based responsive offset (45% up on mobile) |
| **Text Overlay** | Visible on all breakpoints, layered behind inputs |
| **Scroll Sync** | Active auto-scroll syncs with typing animation |

### Stacking Context Solution

The voice overlay uses a unified stacking context to ensure proper layering:

1. **Unified Context:** `<VoiceModeOverlay>` is a direct child of `.chat-input-container`
2. **Strict Layering:** `z-index: -1` on overlay wrapper
   - Header (`z-200`) > Input Form (`z-20`) > Overlay (`z-[-1]`)
3. **Breakout Styling:** `position: absolute` with full viewport dimensions
4. **Auto-Scroll Padding:** `padding-bottom: 250px` creates cushion for text
5. **Active Scroll Sync:** `onContentUpdate` callback triggers `scrollToBottom()` on every animation frame

---

## Image RAG with Voice

Users can retrieve images from the knowledge base using voice queries:

```
User: "Show me the myRAG logo"
→ System retrieves image + generates spoken response
→ Image displays in overlay with text
```

### How It Works

1. Voice query is transcribed and rewritten for better retrieval
2. RAG endpoint searches `document_chunks` for image metadata
3. Matching images (`metadata.image_url`) returned as `source_images`
4. Frontend renders images above the spoken response text
5. Images persist in saved chat history

### Key Files

| File | Purpose |
|------|---------|
| `voice-agent/src/voice_agent.ts` | Query rewriting, LLM interaction |
| `src/app/api/internal/voice-rag/route.ts` | RAG retrieval with image support |
| `src/components/voice/voice-mode-overlay.tsx` | Image rendering in overlay |

---

## Deployment

The voice agent runs as a separate Node.js service. See the main [deployment documentation](https://myrag.laoxiang.app/docs/voice-integration) or the local [Fly.io Deployment Guide](./README_VOICE_AGENT_FLYIO.md) for detailed instructions.

- **[Fly.io](https://fly.io/docs/)** deployment with volumes (Recommended)
- **[Railway](https://docs.railway.com/)** deployment configuration
- **[Render](https://render.com/docs)** deployment setup

### Production Checklist

- [ ] LiveKit Cloud project configured with TURN servers
- [ ] AssemblyAI and Resemble.ai API keys set
- [ ] `MYRAG_INTERNAL_API_KEY` matches between main app and voice-agent
- [ ] Voice agent deployed on same network or with public endpoint
- [ ] Environment variables set for chosen LLM provider
- [ ] `RAG_VOICE_TOKEN_SECRET` set on the main app (see "Voice RAG token" below)

### Voice RAG token

Voice retrieval is tenant-scoped by a signed token instead of a bare user id.

- **What it is:** each voice session gets its own LiveKit room, `myrag-voice-<32 hex characters>`, created by `/api/livekit/token`. The room metadata carries the owner identity and the signed scope token (`{"v":1,"participant_identity":"user-...","rag_scope_token":"..."}`). The browser's join token is valid for 10 minutes and only for that room. The agent polls LiveKit every second for `myrag-voice-*` rooms, joins each new room, serves only the identity named in the metadata, and removes any other participant. It forwards the scope token as the `x-rag-scope-token` header, next to `x-api-key`, to `/api/internal/voice-rag` and `/api/internal/voice-chat`. A room allows two participants (the user and the agent).
- **Configuration (main app):** `RAG_VOICE_TOKEN_SECRET` (32 or more characters; never give it to the voice agent), `RAG_VOICE_TOKEN_TTL_SECONDS` (default 3600) and `VOICE_MAX_ACTIVE_ROOMS` (default 4).
- **Configuration (voice agent):** `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (the agent now lists and deletes rooms and removes participants) and `VOICE_AGENT_MAX_SESSIONS` (default 4).
- **Concurrency limit:** the app answers 409 `voice_busy` when `VOICE_MAX_ACTIVE_ROOMS` `myrag-voice-*` rooms already exist. The agent serves at most `VOICE_AGENT_MAX_SESSIONS` rooms at once. Keep the two values equal: if the app limit is higher, the extra rooms are never served; if it is lower, the agent has idle capacity.
- **Deploy order:** the app and the voice agent ship together, in either order, and expect a short voice outage while they differ. The two versions are not compatible in either direction: the new agent ignores the old fixed room `myrag-voice` (a room name needs a suffix after `myrag-voice-`), and the old agent never joins per-session rooms.
- **Rollback:** roll back the app and the agent together, for the same reason.
- **Expiry:** tokens last `RAG_VOICE_TOKEN_TTL_SECONDS` and are not refreshed. A session longer than that loses knowledge-base access: the agent says "I can't reach the knowledge base right now. Please try again in a moment." instead of answering without context. Token refresh is deferred.
- **Failures are spoken:** a 401/403 (token rejected), 503 (knowledge base unavailable) or network error from the app makes the agent speak that line for the turn rather than answering from general knowledge.
- **Tests:** `cd voice-agent && npm test` (also run by the `voice-agent` job in `pr-smoke`).

---

## UI Components

### OglOrb (WebGL Shader)

The decorative orb uses a custom GLSL fragment shader:
- **Brand Gradient:** Blue (#4080FF) → Yellow (#FFB001) → Red (#F44335) at 135°
- **Concentric Ripples:** Outward-moving sine waves triggered by audio amplitude
- **Edge Glow:** Fresnel rim lighting intensifies when loud
- **Dynamic Scale:** Orb expands up to 15% with `pow(amplitude, 0.3)` curve

### VoiceEndButton

Pill-shaped button with 4 animated bars:
- Subscribes to `useVoiceStore` for user microphone amplitude
- Real-time height changes based on speech volume

### Audio Analysis

In `voice-mode-overlay.tsx`:
- Uses `AnalyserNode` with `smoothingTimeConstant: 0.1`
- Separate analysis for local (user) and remote (agent) tracks
- Attack: 0.9 (instant), Release: 0.4 (fast drop)

---

## Known Limitations

1. **First Sentence Latency:** ~1-2s from user speech to first audio (LLM + TTS)
2. **Groq Rate Limits:** Free tier limited to 100k tokens/day
3. **WebGL Fallback:** No CSS fallback if WebGL unavailable
4. **TTS Retries:** Failed sentences are logged but not retried

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| AssemblyAI 48kHz mismatch | Changed sample_rate to 48000 |
| WAV header pops | Strip 44-byte header in resemble.ts |
| LiveKit InvalidState | Buffer all TTS, send in 50ms chunks |
| False VAD triggers | Tune activation threshold to 0.8 |
| Orb not bouncing | Reduce smoothingTimeConstant to 0.1 |
| Sidebar not refreshing | Implement global event bus (`myrag:voice-session-ended`) |
| Text-Audio Drift | Word-level sync using Resemble.ai timestamps |
| Text on top of input (mobile) | Use `z-index: -1` on overlay wrapper |
| Text disappears during typing | Implement Active Scroll Sync |

### Debug Commands

```bash
# Check LiveKit room status
npx tsx scripts/close-room.ts

# Test RAG API directly
curl -X POST "http://localhost:3000/api/internal/voice-rag" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_MYRAG_INTERNAL_API_KEY" \
  -d '{"query": "What is myRAG?", "userId": "test-user"}'
```

---

## Related Documentation

- [Image RAG Implementation Guide](./IMAGE_RAG_IMPLEMENTATION_GUIDE.md) - How images are processed and retrieved
- [Voice Integration Docs (Web)](https://myrag.laoxiang.app/docs/voice-integration) - User-facing deployment guide

---

**🎉 Voice Integration Complete!**
