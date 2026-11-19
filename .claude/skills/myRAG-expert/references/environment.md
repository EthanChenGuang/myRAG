<overview>
myRAG uses 150+ environment variables grouped by feature area. All are defined in `scripts/init-env.js` (source of truth) and loaded via `src/lib/env.ts` (singleton). Variables prefixed with `NEXT_PUBLIC_` are available client-side.
</overview>

<core_infrastructure>

## Core Infrastructure (Required)

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Required | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Required | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Required | Supabase admin key (server-only) |
| `OPENAI_API_KEY` | Required | OpenAI API (embeddings + fallback AI) |

</core_infrastructure>

<ai_models>

## AI Models & Providers

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_AI_PROVIDER` | `openrouter` | Primary: `openai` or `openrouter` |
| `OPENROUTER_API_KEY` | - | OpenRouter API access |
| `NEXT_PUBLIC_OPENAI_MODELS` | JSON array | OpenAI model definitions |
| `NEXT_PUBLIC_OPENROUTER_MODELS` | JSON array | OpenRouter model definitions |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (1536-dim) |
| `CHAT_TITLE_MODEL` | `anthropic/claude-haiku-4.5` | Title generation model |
| `CHAT_TITLE_TEMPERATURE` | `0.5` | Title generation temp |
| `CHAT_TITLE_MAX_TOKENS` | `100` | Title generation max tokens |

</ai_models>

<rag_config>

## RAG Configuration

**System Prompt:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `RAG_SYSTEM_PROMPT` | Template | MUST contain `{{context}}` placeholder |
| `RAG_PRE_CONTEXT` | Template | Pre-context template |
| `RAG_POST_CONTEXT` | Template | Post-context template |

**LlamaCloud (Document Processing):**
| Variable | Default | Purpose |
|----------|---------|---------|
| `LLAMA_CLOUD_API_KEY` | - | Required for doc parsing |
| `LLAMACLOUD_PARSING_MODE` | `balanced` | Parsing mode |
| `LLAMACLOUD_CHUNK_STRATEGY` | `sentence` | Chunking strategy |
| `LLAMACLOUD_CHUNK_SIZE` | `2500` | Chunk size |
| `LLAMACLOUD_CHUNK_OVERLAP` | `992` | Overlap size |
| `LLAMACLOUD_PARSE_MODE` | `parse_page_with_agent` | Parse mode (10-90 credits/page) |
| `LLAMACLOUD_PARSE_MODEL` | `openai-gpt-4-1-mini` | Parse model |
| `LLAMACLOUD_HIGH_RES_OCR` | `true` | High-res OCR |
| `LLAMACLOUD_ADAPTIVE_LONG_TABLE` | `true` | Table extraction |
| `LLAMACLOUD_MULTIMODAL_PARSING` | `true` | Multimodal support |

**RAG Behavior:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `RAG_BEHAVIOR_MODE` | `strict` | strict/balanced/flexible/bypass |
| `RAG_INITIAL_MATCH_COUNT` | `60` | Initial retrieval count |
| `RAG_SIMILARITY_THRESHOLD` | `0.45` | Minimum similarity |
| `RAG_FINAL_RESULT_COUNT` | `25` | Final results after rerank |
| `RAG_MULTI_PASS` | `true` | Multi-pass retrieval |
| `RAG_ADAPTIVE_RETRIEVAL` | `true` | Adaptive retrieval |
| `RAG_MMR_LAMBDA` | `0.85` | MMR diversity weight |
| `RAG_PERFORMANCE_MODE` | `balanced` | fast/balanced/accurate |
| `RAG_RERANKING` | `true` | Enable reranking |
| `RAG_RERANKING_STRATEGY` | `hybrid` | hybrid/semantic |
| `RAG_ADJACENT_CHUNKS` | `true` | Include neighbors |
| `RAG_ADJACENCY_WINDOW` | `2` | Neighbor window |
| `RAG_CACHE_ENABLED` | `true` | Cache results |

**RAG Thresholds:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `RAG_EXACT_THRESHOLD` | `0.75` | Exact match precision |
| `RAG_HIGH_THRESHOLD` | `0.65` | High precision |
| `RAG_MEDIUM_THRESHOLD` | `0.55` | Medium precision |
| `RAG_LOW_THRESHOLD` | `0.45` | Low precision |

**RAG Frontend:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_RAG_CACHE_ENABLED` | `true` | Frontend cache |
| `NEXT_PUBLIC_RAG_CACHE_TTL` | `3600` | Cache TTL (seconds) |
| `NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED` | `false` | Query enhancement |
| `NEXT_PUBLIC_RAG_RERANKING_ENABLED` | `false` | Frontend reranking |
| `NEXT_PUBLIC_RAG_RERANKING_STRATEGY` | `hybrid` | Reranking strategy |

</rag_config>

<media_generation>

## Media Generation

**Image:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `IMAGE_GENERATION_PROVIDER` | `fal` | fal/replicate/openai |
| `FAL_API_KEY` | - | Fal.ai API key |
| `FAL_IMAGE_MODEL` | `fal-ai/bytedance/seedream/v4/text-to-image` | Text-to-image |
| `FAL_IMAGE_TO_IMAGE_MODEL` | `fal-ai/bytedance/seedream/v4/edit` | Image-to-image |
| `REPLICATE_API_TOKEN` | - | Replicate API |
| `NEXT_PUBLIC_IMAGE_GENERATION_ENABLED` | `false` | Enable UI |

**Video:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `VIDEO_GENERATION_PROVIDER` | `fal` | Provider |
| `FAL_VIDEO_MODEL` | `fal-ai/veo3/fast` | Default video model |
| `FAL_VIDEO_TEXT_MODEL` | `fal-ai/veo3/fast` | Text-to-video |
| `FAL_VIDEO_IMAGE_MODEL` | `fal-ai/veo3/image-to-video` | Image-to-video |
| `NEXT_PUBLIC_VIDEO_GENERATION_ENABLED` | `false` | Enable UI |

**3D:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `FAL_3D_MODEL` | `fal-ai/trellis` | 3D model |
| `NEXT_PUBLIC_3D_GENERATION_ENABLED` | `false` | Enable UI |

</media_generation>

<audio_voice>

## Audio & Voice

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_TTS_DISABLED` | `false` | Disable TTS |
| `NEXT_PUBLIC_STT_DISABLED` | `false` | Disable STT |
| `NEXT_PUBLIC_VOICE_PROVIDER` | `openai` | openai/elevenlabs |
| `NEXT_PUBLIC_AUDIO_AUTOPLAY` | `false` | Autoplay audio |
| `ELEVENLABS_API_KEY` | - | ElevenLabs key |
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | Voice (Sarah) |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | Model |
| `ELEVENLABS_VOICE_STABILITY` | `0.5` | Stability 0-1 |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.5` | Similarity 0-1 |
| `ELEVENLABS_VOICE_SPEED` | `1.0` | Speed 0.7-1.2 |

</audio_voice>

<reasoning>

## Reasoning Models

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_REASONING_ENABLED` | `true` | Enable reasoning UI |
| `NEXT_PUBLIC_DEFAULT_REASONING_EFFORT` | `medium` | low/medium/high |
| `NEXT_PUBLIC_MAX_REASONING_TOKENS` | `8000` | Token limit |
| `NEXT_PUBLIC_SHOW_REASONING_BY_DEFAULT` | `false` | Show expanded |

</reasoning>

<integrations>

## Integrations

**MCP:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_MCP_TOOLS_LIST_ENABLED` | `false` | Show tools list |
| `NEXT_PUBLIC_MCP_SYSTEM_ENABLED` | `false` | Enable MCP system |
| `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED` | `false` | Auto-approve tools |
| `MCP_ZAPIER_ENDPOINT` | - | Zapier endpoint |
| `MCP_CUSTOM_SERVERS` | `[]` | Custom MCP servers JSON |

**WhatsApp:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_WHATSAPP_ENABLED` | `true` | Enable WhatsApp |
| `WHATSAPP_PROVIDER` | `flyio` | flyio/koyeb |
| `FLYIO_BAILEYS_URL` | - | Fly.io URL |
| `FLYIO_API_KEY` | - | Fly.io key |
| `WHATSAPP_DEFAULT_MODEL` | `openai/gpt-4o-mini` | Default model |

**Payments:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | - | Stripe public key |
| `STRIPE_SECRET_KEY` | - | Stripe secret |
| `STRIPE_WEBHOOK_SECRET` | - | Webhook secret |
| `POLAR_ACCESS_TOKEN` | - | Polar API |

**Search & Scraping:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_WEB_SEARCH_ENABLED` | `true` | Web search |
| `EXA_API_KEY` | - | Exa search |
| `NEXT_PUBLIC_FIRECRAWL_ENABLED` | `false` | Firecrawl |
| `FIRECRAWL_API_KEY` | - | Firecrawl key |

**Nango Connectors:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_NANGO_ENABLED` | `false` | Enable connectors |
| `NANGO_SECRET_KEY` | - | Nango API key |

</integrations>

<branding>

## Branding & UI

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_APP_NAME` | `myRAG` | App name |
| `NEXT_PUBLIC_SITE_TITLE` | Falls back to app name | Browser title |
| `NEXT_PUBLIC_FAVICON_URL` | `/favicon.svg` | Favicon |
| `NEXT_PUBLIC_HEADER_LOGO_TYPE` | `text` | text/image |
| `NEXT_PUBLIC_HEADER_LOGO_TEXT` | `myRAG` | Header text |
| `NEXT_PUBLIC_WELCOME_TEXT` | `What can I help with?` | Welcome message |
| `NEXT_PUBLIC_SHOW_SUGGESTIONS` | `true` | Show suggestion buttons |
| `NEXT_PUBLIC_CHAT_INPUT_TEXT_SIZE` | `18` | Input font size |

</branding>

<deployment>

## Deployment

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE` | `single-tenant` | single-tenant/multi-tenant |
| `NEXT_PUBLIC_AUTH_ENABLED` | `true` | Enable auth |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Site URL |
| `NEXT_PUBLIC_EMBED_ENABLED` | `false` | Enable embed widget |
| `DEBUG_RAG` | `false` | RAG debugging |

</deployment>
