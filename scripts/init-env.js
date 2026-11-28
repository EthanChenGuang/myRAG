const fs = require('fs');
const path = require('path');

// Resolve project root (one level up from scripts directory); MYRAG_CONFIG_ROOT points it elsewhere, as for config-server.js
const REPO_ROOT = process.env.MYRAG_CONFIG_ROOT
  ? path.resolve(process.env.MYRAG_CONFIG_ROOT)
  : path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env.local');

// Default model configurations
const DEFAULT_OPENAI_MODELS = '[{"id":"gpt-4.1-mini","displayName":"GPT-4.1 Mini","contextLength":1047576},{"id":"gpt-4.1","displayName":"GPT-4.1","contextLength":1047576},{"id":"o3","displayName":"o3","contextLength":200000},{"id":"o4-mini","displayName":"o4 Mini","contextLength":200000}]';

const DEFAULT_OPENROUTER_MODELS = '[{"id":"anthropic/claude-sonnet-4.5","displayName":"Claude Sonnet 4.5","isDefault":true,"contextLength":1000000},{"id":"auto","displayName":"Auto"},{"id":"openai/gpt-5.2-chat","displayName":"GPT-5.2"},{"id":"openai/gpt-4.1-mini","displayName":"GPT-4.1 Mini","contextLength":1047576},{"id":"openai/gpt-4.1","displayName":"GPT-4.1","contextLength":1047576},{"id":"anthropic/claude-opus-4.1","displayName":"Claude Opus 4.1","contextLength":200000},{"id":"anthropic/claude-opus-5.5","displayName":"Claude Opus 5.5","anthropicId":"claude-opus-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"anthropic/claude-sonnet-5.5","displayName":"Claude Sonnet 5.5","anthropicId":"claude-sonnet-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"anthropic/claude-haiku-5.5","displayName":"Claude Haiku 5.5","anthropicId":"claude-haiku-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"google/gemini-2.5-flash-lite","displayName":"Gemini 2.5 Flash Lite","contextLength":1048576},{"id":"google/gemini-2.5-flash","displayName":"Gemini 2.5 Flash","contextLength":1048576},{"id":"meta-llama/llama-4-maverick","displayName":"Llama 4 Maverick","isOpenSource":true,"contextLength":524288},{"id":"cognitivecomputations/dolphin-mistral-24b-venice-edition:free","displayName":"Venice: Uncensored","isFree":true,"isOpenSource":true,"isUncensored":true}]';

// Groq free tier has strict rate limits - only Llama 3.3 70B works reliably with RAG contexts
// Users with paid Groq tiers can add more models: llama-3.1-8b-instant, mixtral-8x7b-32768, gemma2-9b-it
const DEFAULT_GROQ_MODELS = '[{"id":"llama-3.3-70b-versatile","displayName":"Llama 3.3 70B","contextLength":131072}]';

// Default RAG system prompt components (pre and post context)
// The system assembles: PRE_CONTEXT + {{context}} + POST_CONTEXT
const DEFAULT_RAG_PRE_CONTEXT = 'You are a helpful and friendly AI assistant. Your primary goal is to provide accurate, useful information based on the documents and knowledge available to you.\n\nWhen answering questions:\n1. ALWAYS check the context first for relevant information\n2. Use a warm, approachable tone while maintaining professionalism\n3. Cite specific documents or sources when referencing the context\n4. Break down complex topics into easy-to-understand explanations\n5. If information isn\'t in the context, acknowledge this clearly';

const DEFAULT_RAG_POST_CONTEXT = 'Based on the context provided, offer comprehensive and helpful answers. If specific information is missing, suggest how the user might rephrase their question or what additional information would be helpful.';

function getStandardTemplate() {
  return `# myRAG Configuration
# Generated automatically on first run
# Visit http://localhost:3333 (npm run config) to configure visually

# -----------------------------
# GENERAL
# -----------------------------
NEXT_PUBLIC_DEFAULT_LANGUAGE=en
# Default Theme (Options: system, dark, light)
NEXT_PUBLIC_DEFAULT_THEME=system
NEXT_PUBLIC_DEFAULT_BACKGROUND_IMAGE=

# -----------------------------
# FEATURES
# -----------------------------
NEXT_PUBLIC_AUTH_ENABLED=true
NEXT_PUBLIC_WEB_SEARCH_ENABLED=true
NEXT_PUBLIC_IMAGE_GENERATION_ENABLED=true
NEXT_PUBLIC_VIDEO_GENERATION_ENABLED=true
NEXT_PUBLIC_3D_GENERATION_ENABLED=true
NEXT_PUBLIC_MCP_TOOLS_LIST_ENABLED=true
NEXT_PUBLIC_MCP_SYSTEM_ENABLED=true
NEXT_PUBLIC_SHOW_SOURCES_ENABLED=true

# -----------------------------
# WHATSAPP INTEGRATION
# -----------------------------
NEXT_PUBLIC_WHATSAPP_ENABLED=true

# WhatsApp Provider Configuration
WHATSAPP_PROVIDER=flyio
FLYIO_BAILEYS_URL=
FLYIO_API_KEY=
KOYEB_BAILEYS_URL=
KOYEB_API_KEY=
WHATSAPP_WEBHOOK_URL=
# Required in production (webhook returns 503 without it). Must match WEBHOOK_SECRET in the Baileys service.
WHATSAPP_WEBHOOK_SECRET=
# Development only: accept unsigned webhooks when no secret is set. Ignored in production.
WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=
WHATSAPP_ENABLE_MCP=false
WHATSAPP_ENABLE_WEB_SEARCH=false
WHATSAPP_DEFAULT_MODEL=openai/gpt-4o-mini
WHATSAPP_MAX_TOKENS=2048
WHATSAPP_MAX_SESSIONS_PER_USER=5
WHATSAPP_MESSAGE_QUEUE_SIZE=10

# -----------------------------
# AI MODELS
# -----------------------------
# OpenAI - Required for embeddings
OPENAI_API_KEY=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# OpenAI Image Generation (legacy)
OPENAI_IMAGE_MODEL=gpt-image-1

# OpenRouter - Used for various AI models
OPENROUTER_API_KEY=

# Groq - Used for fast inference
GROQ_API_KEY=

# AI Provider Selection
# Options: 'openai' | 'openrouter' | 'groq'
NEXT_PUBLIC_AI_PROVIDER=openrouter

# Available Models Configuration (JSON format)
NEXT_PUBLIC_OPENAI_MODELS=${DEFAULT_OPENAI_MODELS}
NEXT_PUBLIC_OPENROUTER_MODELS=${DEFAULT_OPENROUTER_MODELS}
NEXT_PUBLIC_GROQ_MODELS=${DEFAULT_GROQ_MODELS}

# LlamaCloud - Used for document processing
LLAMA_CLOUD_API_KEY=

# Image Generation
IMAGE_GENERATION_PROVIDER=fal
VIDEO_GENERATION_PROVIDER=fal
REPLICATE_API_TOKEN=
FAL_API_KEY=
USE_REPLICATE_PROVIDER=false

# Fal.ai Model Configuration
FAL_IMAGE_MODEL=fal-ai/bytedance/seedream/v4/text-to-image
FAL_IMAGE_TO_IMAGE_MODEL=fal-ai/bytedance/seedream/v4/edit

# Video Models - Text to Video
FAL_VIDEO_MODEL=fal-ai/veo3/fast
FAL_VIDEO_TEXT_MODEL=fal-ai/veo3/fast
FAL_VIDEO_TEXT_FAST_MODEL=fal-ai/veo3/fast

# Video Models - Image to Video
FAL_VIDEO_IMAGE_MODEL=fal-ai/veo3/image-to-video
FAL_VIDEO_IMAGE_FAST_MODEL=fal-ai/veo3/fast/image-to-video

# Other Models
FAL_3D_MODEL=fal-ai/trellis

# Replicate Model Configuration (Fallback)
REPLICATE_3D_MODEL=firtoz/trellis:4876f2a8da1c544772dffa32e8889da4a1bab3a1f5c1937bfcfccb99ae347251

# Web Search
EXA_API_KEY=

# -----------------------------
# WEB SCRAPING (FIRECRAWL)
# -----------------------------
NEXT_PUBLIC_FIRECRAWL_ENABLED=false
NEXT_PUBLIC_WEB_SCRAPER_SHOW_ON_DASHBOARD=true
FIRECRAWL_API_KEY=

FIRECRAWL_ONLY_MAIN_CONTENT=true
FIRECRAWL_WAIT_FOR_JS=2000

# -----------------------------
# AUDIO
# -----------------------------
NEXT_PUBLIC_TTS_DISABLED=false
NEXT_PUBLIC_VOICE_PROVIDER=openai
NEXT_PUBLIC_STT_DISABLED=false
NEXT_PUBLIC_AUDIO_AUTOPLAY=false

# ElevenLabs Configuration (optional)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_SIMILARITY_BOOST=0.5
ELEVENLABS_SPEAKER_BOOST=true
ELEVENLABS_VOICE_SPEED=1.0

# -----------------------------
# DATABASE (REQUIRED)
# -----------------------------
# Get these from your Supabase project settings
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# -----------------------------
# DEPLOYMENT MODE
# -----------------------------
# Choose deployment mode: single-tenant or multi-tenant
# single-tenant: Shared knowledge base with user-isolated chats (simpler setup)
# multi-tenant: Organization-based isolation with team features (advanced)
# See DEPLOYMENT_MODES.md for complete documentation
NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=single-tenant

# Multi-tenant features (only used when NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant)
ENABLE_ORGANIZATIONS=true
ENABLE_TEAM_INVITES=true
ENABLE_STORAGE_QUOTAS=true
ENABLE_USAGE_ANALYTICS=true

# -----------------------------
# AUTHENTICATION
# -----------------------------
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Config UI proxy target for the main myRAG app.
# Set this when the Config UI runs behind a reverse proxy or different host.
MYRAG_APP_URL=http://localhost:3000

# GitHub OAuth (optional)
NEXT_PUBLIC_GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# -----------------------------
# EMAIL
# -----------------------------
RESEND_API_KEY=

# Custom SMTP Settings (optional)
NEXT_PUBLIC_CUSTOM_SMTP_ENABLED=false
NEXT_PUBLIC_SMTP_FROM_NAME=myRAG Support
NEXT_PUBLIC_SMTP_FROM_EMAIL=support@example.com

# -----------------------------
# PAYMENTS - STRIPE
# -----------------------------
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PRICE_ID_PRO=
NEXT_PUBLIC_STRIPE_PRICE_ID_ENTERPRISE=

# -----------------------------
# PAYMENTS - POLAR
# -----------------------------
POLAR_ACCESS_TOKEN=
POLAR_ORGANIZATION_ID=
POLAR_WEBHOOK_SECRET=
POLAR_ORGANIZATION_SLUG=
NEXT_PUBLIC_POLAR_PRICE_ID_PRO=
NEXT_PUBLIC_POLAR_PRICE_ID_ENTERPRISE=
NEXT_PUBLIC_POLAR_CHECKOUT_PRO=
NEXT_PUBLIC_POLAR_CHECKOUT_ENTERPRISE=

# -----------------------------
# BRANDING
# -----------------------------
NEXT_PUBLIC_APP_NAME=myRAG
NEXT_PUBLIC_SITE_TITLE=
NEXT_PUBLIC_FAVICON_URL=/favicon.svg
NEXT_PUBLIC_HEADER_LOGO_TYPE=text
NEXT_PUBLIC_HEADER_LOGO_TEXT=myRAG
NEXT_PUBLIC_HEADER_LOGO_URL=
NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT=
NEXT_PUBLIC_SIDEBAR_BUTTON_URL=
NEXT_PUBLIC_AI_RESPONSE_LOGO_URL=
NEXT_PUBLIC_AI_RESPONSE_LOGO_BORDER=true
NEXT_PUBLIC_AI_RESPONSE_LOGO_SIZE=3
NEXT_PUBLIC_AI_LOGO_TYPE=none
NEXT_PUBLIC_USE_DEFAULT_AI_LOGO=false

# -----------------------------
# SUGGESTIONS
# -----------------------------
NEXT_PUBLIC_SHOW_SUGGESTIONS=true

# -----------------------------
# WELCOME TEXT & PERSONALIZATION
# -----------------------------
NEXT_PUBLIC_WELCOME_TEXT=What can I help with?
NEXT_PUBLIC_WELCOME_TEXT_MODE=custom
NEXT_PUBLIC_WELCOME_TEXT_GRADIENT=none
NEXT_PUBLIC_WELCOME_TEXT_TRANSLATIONS={}
NEXT_PUBLIC_WELCOME_MESSAGES=["Hey, {Username}! What can I help you with today?","Ready when you are.","Good to see you, {Username}.","What's on your mind?","Hi there, {Username}. How can I assist?","Let's get started!","Welcome back, {Username}!","How can I help?","Hey! Ready to dive in?","Hi, {Username}. What would you like to explore today?"]
NEXT_PUBLIC_WELCOME_MESSAGES_TRANSLATIONS={}
NEXT_PUBLIC_MANUAL_USERNAME=

# -----------------------------
# NAME EXTRACTION
# -----------------------------
NEXT_PUBLIC_NAME_EXTRACTION_ENABLED=true
NEXT_PUBLIC_NAME_EXTRACTION_MODEL=gpt-4o-mini

# -----------------------------
# UI CUSTOMIZATION
# -----------------------------
NEXT_PUBLIC_CHAT_INPUT_TEXT_SIZE=18
NEXT_PUBLIC_SUGGESTION_GROUPS=

# Chat Input Border Animation
NEXT_PUBLIC_CHAT_BORDER_WIDTH=2.5
NEXT_PUBLIC_CHAT_BORDER_COLOR=#FF6417
NEXT_PUBLIC_CHAT_BORDER_GRADIENT_ENABLED=false
NEXT_PUBLIC_CHAT_BORDER_GRADIENT_COLOR_1=#FF6417
NEXT_PUBLIC_CHAT_BORDER_GRADIENT_COLOR_2=#FF1744
NEXT_PUBLIC_CHAT_BORDER_ANIMATION_SPEED=14
NEXT_PUBLIC_CHAT_BORDER_ENABLED=true
NEXT_PUBLIC_CHAT_BORDER_LENGTH=220

# -----------------------------
# EMBED WIDGET
# -----------------------------
NEXT_PUBLIC_EMBED_ENABLED=false
NEXT_PUBLIC_EMBED_TITLE=AI Assistant
NEXT_PUBLIC_EMBED_PRIMARY_COLOR=
NEXT_PUBLIC_EMBED_POSITION=bottom-right
NEXT_PUBLIC_EMBED_AUTO_OPEN=false
NEXT_PUBLIC_EMBED_GREETING=Hello! How can I help you today?
NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS=*
NEXT_PUBLIC_EMBED_MODEL=
EMBED_REQUIRE_AUTH=false

# Embed Widget Suggested Prompts
NEXT_PUBLIC_EMBED_SUGGESTIONS_ENABLED=true
NEXT_PUBLIC_EMBED_SUGGESTIONS=["What can you help me with?","How does this work?","Tell me about your features","Get started guide"]

# -----------------------------
# DOCUMENT PROCESSING
# -----------------------------
NEXT_PUBLIC_READ_ONLY_DOCUMENTS_ENABLED=true
NEXT_PUBLIC_HIDE_DOCUMENT_DASHBOARD=false

# -----------------------------
# RAG SYSTEM PROMPT
# -----------------------------
# The system assembles the prompt as: PRE_CONTEXT + {{context}} + POST_CONTEXT
# Use \\n for newlines within the values
RAG_PRE_CONTEXT=${DEFAULT_RAG_PRE_CONTEXT}
RAG_POST_CONTEXT=${DEFAULT_RAG_POST_CONTEXT}

# -----------------------------
# RAG CONFIGURATION
# -----------------------------
# Number of documents to retrieve (optimized for accuracy)
RAG_INITIAL_MATCH_COUNT=60
# Minimum similarity threshold (optimized for accuracy)
RAG_SIMILARITY_THRESHOLD=0.45

# -----------------------------
# RAG: Documents and ingestion
# -----------------------------
# Store normalized identifiers per passage (needs the identifier backfill)
# Identifier index
RAG_IDENTIFIER_INDEX=false
# legacy keeps today's document writers; unified switches to the single ingest pipeline
# Ingest pipeline
RAG_INGEST_PIPELINE=legacy
# Document parser: llamaparse | docling
# Document parser
RAG_PARSER=llamaparse
# Time one request may wait for a sidecar parse job, in milliseconds (1000 to 55000)
# Parse wait budget (ms)
RAG_PARSE_POLL_BUDGET_MS=45000
# Ask a model to detect the document type when rules are unsure: true | false
# Model-assisted document type detection
RAG_DOC_TYPE_LLM_DETECT=false
# Ask a model to extract invoice fields when rules find none: true | false
# Model-assisted invoice extraction
RAG_INVOICE_LLM_EXTRACT=false
# Source sync: full reconcile interval and age limit (days), and the share of a connection's documents above which a full listing pauses for confirmation (0.05 to 1)
# Full reconcile interval (days)
RAG_SOURCE_RECONCILE_INTERVAL_DAYS=7
# Reconcile age limit (days)
RAG_SOURCE_RECONCILE_MAX_AGE_DAYS=7
# Pause above this share of documents
RAG_SOURCE_RECONCILE_MAX_DELETE_SHARE=0.3
# Source sync: files one Purge-mode connection may purge per UTC day from its change feed; the rest wait for confirmation (0 = off)
# Daily purge limit per connection
RAG_SOURCE_PURGE_DAILY_CAP=0
# Create image chunks from PDF pages: true | false
# PDF image chunks
RAG_PDF_IMAGE_CHUNKS=false
# Embedding profile registry: off | on (off keeps the single configured embedding model)
# Embedding profile registry
RAG_EMBEDDING_PROFILES=off
# Domain embedding leg for document types with an active binding: off | on (needs RAG_EMBEDDING_PROFILES=on)
# Domain embeddings
RAG_DOMAIN_EMBEDDINGS=off
# Maximum domain embedding legs per query (0..5; 0 keeps bindings without extra legs)
# Domain embedding legs per query
RAG_DOMAIN_EMBEDDING_MAX_LEGS=2
# Timeout for one domain embedding leg in milliseconds (100..5000)
# Domain embedding leg timeout (ms)
RAG_DOMAIN_EMBEDDING_TIMEOUT_MS=800
# Tenant or traffic-share rollouts of embedding profiles: true | false (false keeps the globally active profiles for every tenant)
# Tenant or traffic-share rollouts
RAG_ROLLOUTS=false
# Fallback host when the Qwen embedding provider is unavailable: openrouter | none
# Qwen embedding fallback host
RAG_QWEN_EMBED_FALLBACK=openrouter
# Primary host for the Qwen embedding provider: deepinfra | openrouter (openrouter needs only OPENROUTER_API_KEY; the fallback then goes to DeepInfra when a key is set)
# Qwen embedding primary host
RAG_QWEN_EMBED_PRIMARY=deepinfra
# Fine-tuned embedding slots: off | on (any other value is off). Bind, consent and activation are CLI-only (npm run rag:embedding)
# Fine-tuned embeddings
RAG_FINETUNE=off
# Shared key for the fine-tuned slot endpoints (may stay empty on a private network)
# Slot endpoint API key
RAG_FT_EMBED_API_KEY=
# Slot A: OpenAI-compatible base URL (POST {base}/embeddings), model version id, query and document prompts
# Slot A base URL
RAG_FT_SLOT_A_BASE_URL=
# Slot A model version
RAG_FT_SLOT_A_MODEL=
# Slot A query prompt
RAG_FT_SLOT_A_QUERY_PROMPT=
# Slot A document prompt
RAG_FT_SLOT_A_DOCUMENT_PROMPT=
# Slot B: same settings as slot A
# Slot B base URL
RAG_FT_SLOT_B_BASE_URL=
# Slot B model version
RAG_FT_SLOT_B_MODEL=
# Slot B query prompt
RAG_FT_SLOT_B_QUERY_PROMPT=
# Slot B document prompt
RAG_FT_SLOT_B_DOCUMENT_PROMPT=
# Host for the OpenAI embedding model: openai | openrouter (openrouter sends embedding requests to OpenRouter with OPENROUTER_API_KEY, same model and vectors; the OpenAI Batch API is then unavailable and backfills embed in sync)
# OpenAI embedding host
RAG_OPENAI_EMBEDDINGS_VIA=openai
# Parse routing: fixed | tiered (tiered needs unified pipeline and async ingest)
# Parse routing
RAG_PARSE_ROUTING=fixed
# Allow cloud parsers (LlamaParse and premium): true | false
# Allow cloud parsers
RAG_PARSER_ALLOW_CLOUD=true
# Premium page budget per month for tiered routing (0 = unlimited reporting only)
# Premium page budget per month
RAG_PARSE_PREMIUM_PAGE_BUDGET=0
# Maximum premium pages per document under tiered routing
# Premium pages per document
RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC=200
# Escalate failing page ranges one tier: on | off
# Parse escalation
RAG_PARSE_ESCALATION=on
# Vision-model page detection under tiered routing: true | false
# Vision-model page detection
RAG_PARSE_VLM_DETECT=false
# Vision model override (empty = image captioning model)
# Vision model
RAG_PARSE_VLM_MODEL=
# Queue ingestion jobs instead of inline processing: off | on (on needs unified pipeline)
# Queued ingestion
RAG_INGEST_ASYNC=off
# Publish chunks incrementally while parsing: true | false
# Progressive publishing
RAG_PARSE_PROGRESSIVE=false
# Embedding batch mode for backfill: sync | batch_api
# Embedding batch mode
RAG_EMBED_BATCH_MODE=sync
# Browser realtime job updates (Supabase broadcast): true | false
# Realtime job updates
NEXT_PUBLIC_RAG_INGEST_REALTIME=false
# Ledger workers and the app must use the Supabase project HTTPS URL (PostgREST), never a direct Postgres DSN.

# Supported languages, comma-separated registry codes (e.g. zh,en,it). Empty = not configured; set them in the Languages panel
# Supported languages
RAG_SUPPORTED_LANGUAGES=
# Primary language: one of RAG_SUPPORTED_LANGUAGES (empty = not configured)
# Primary language
RAG_PRIMARY_LANGUAGE=
# Language-aware chunking, sentence splitting and OCR: off | on
# Language-aware ingestion
RAG_LANGUAGE_AWARE_INGEST=off
# Query language confidence: mapped | calibrated (mapped keeps the three values 1, 0.5 and empty)
# Language confidence
RAG_LANG_CONFIDENCE=mapped
# Repeat table headers in split table chunks: profile | always
# Table header repeat
RAG_TABLE_HEADER_REPEAT=always
# Add "column = value" lines per table row to the search text: true | false
# Table row serialization
RAG_TABLE_ROW_SERIALIZATION=false
# Image caption language: en | document
# Image caption language
RAG_CAPTION_LANGUAGE=en
# BGE-M3 serving (Phase 3.2.1): hosted | sidecar
# BGE-M3 serving
RAG_BGE_M3_SERVING=hosted
# Host for hosted BGE-M3 calls: deepinfra | openrouter (openrouter uses OPENROUTER_API_KEY, pins the DeepInfra upstream and records host openrouter; verify with npm run rag:embedding -- verify-route bge-m3)
# BGE-M3 hosted route
RAG_BGE_M3_VIA=deepinfra
# Search-only translations of document chunks: off | on
# Document translation
RAG_DOC_TRANSLATION=off
# Translation model override (empty = RAG_QUERY_LLM_MODEL)
# Translation model
RAG_DOC_TRANSLATION_MODEL=
# Suggest scope tags for new documents: true | false
# Scope tag suggestions
RAG_SCOPE_TAG_SUGGEST=false
# Detect possible older versions of new documents: off | on
# Supersession detection
RAG_SUPERSESSION_DETECT=off
# Read effective dates with a model when rules find none: true | false
# Model-assisted effective dates
RAG_EFFECTIVE_DATE_LLM_EXTRACT=false
# Templated collections (Phase 3.3)
# Split documents at the headings of the workspace's section rule set (needs the unified ingest pipeline): off | on
# Section rules
RAG_SECTION_RULES=off
# Remove repeated page lines before chunking (needs the unified ingest pipeline): off | detect | rules | both
# Page boilerplate removal
RAG_PAGE_BOILERPLATE=off
# Store schema-checked attributes with documents and chunks (needs the unified ingest pipeline): true | false
# Document attributes
RAG_DOC_ATTRIBUTES=false
# Add the rendered attribute header line to embedding and keyword text (needs RAG_DOC_ATTRIBUTES=true): true | false
# Attribute header in search text
RAG_ATTRIBUTE_HEADER=false
# Voyage embeddings
# Voyage API key
VOYAGE_API_KEY=
# Voyage base URL
VOYAGE_BASE_URL=https://api.voyageai.com/v1
# DeepInfra embeddings (OpenAI-compatible)
# DeepInfra API key
DEEPINFRA_API_KEY=
# DeepInfra base URL
DEEPINFRA_BASE_URL=https://api.deepinfra.com/v1/openai
# SharePoint Online and OneDrive for Business connectors (empty keys use the Nango ids sharepoint-online and one-drive)
# Enable SharePoint and OneDrive
NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED=false
# SharePoint integration key
NANGO_SHAREPOINT_INTEGRATION_KEY=
# OneDrive integration key
NANGO_ONEDRIVE_INTEGRATION_KEY=

# -----------------------------
# RAG: Query
# -----------------------------
# Terminology dictionary (v2 only): query expansion, dense variant, missed-query mining
# Terminology query expansion
RAG_TERMINOLOGY=false
# Terminology dense variant
RAG_TERMINOLOGY_DENSE=false
# Terminology mining
RAG_TERMINOLOGY_MINING=false
# Query rewriting before retrieval; false keeps today's behaviour and every switch below is inert while it is false
# Query layer
RAG_QUERY_LAYER=false
# Query-layer framework
RAG_QUERY_FRAMEWORK=llamaindex
# Query model
RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano
# Condense follow-up questions
RAG_QUERY_CONDENSE=true
# Expand with paraphrases
RAG_QUERY_EXPAND=true
# Decompose compound questions
RAG_QUERY_DECOMPOSE=true
# Translate for cross-language search
RAG_QUERY_TRANSLATE=true
# Normalize relative dates
RAG_QUERY_DATE_NORMALIZE=true
# Hypothetical answer (HyDE) variant
RAG_QUERY_HYDE=false
# Profiles without translation
RAG_QUERY_TRANSLATE_DISABLED_PROFILES=
# Voice transforms
RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates
# Phase 6.2 query-layer additions; inert while RAG_QUERY_LAYER=false except RAG_WHATSAPP_HISTORY, which applies to the WhatsApp channel
# History fallback variant
RAG_QUERY_HISTORY_FALLBACK=true
# Sub-question completeness check
RAG_QUERY_DECOMPOSE_COMPLETENESS=true
# Sub-question filters
RAG_QUERY_SUBQ_FILTERS=false
# Answer per sub-question
RAG_DECOMPOSED_ANSWER=true
# WhatsApp conversation history
RAG_WHATSAPP_HISTORY=false
# Translation glossary
RAG_TRANSLATION_GLOSSARY=false
# Sidecar language detector
RAG_LANGID_SIDECAR=false
# Speculative retrieval
RAG_SPECULATIVE_RETRIEVAL=false
# Auto model routing
RAG_MODEL_ROUTING=off
# Routing fast model
RAG_ROUTING_FAST_MODEL=anthropic/claude-haiku-5.5
# Routing quality model
RAG_ROUTING_QUALITY_MODEL=anthropic/claude-sonnet-5.5
# Scope gate
RAG_SCOPE_GATE=false
# Answer cache backend: off | pgvector | redisvl (REDIS_URL is read by the sidecar for redisvl only)
# Semantic cache backend
RAG_SEMANTIC_CACHE=off
# Cached answer lifetime (seconds)
RAG_SEMANTIC_CACHE_TTL=3600
# Cached refusal lifetime (seconds)
RAG_SEMANTIC_CACHE_REFUSAL_TTL=600
# Cache hit max distance
RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05
# Store embed widget answers
RAG_SEMANTIC_CACHE_EMBED_STORE=false

# -----------------------------
# RAG: Retrieval
# -----------------------------
# legacy keeps today's retrieval path; unified switches to the staged pipeline
# Retrieval pipeline
RAG_PIPELINE=legacy
# Stages to skip, comma-separated (empty runs every stage)
# Disabled stages
RAG_DISABLED_STAGES=
# Per-stage time budgets as stage=ms,stage=ms (empty uses the built-in budgets)
# Stage timeouts
RAG_STAGE_TIMEOUTS=
# Lexical hybrid search leg
# Lexical search leg
RAG_LEXICAL_SEARCH=false
# Parent chunks and pgvector scan
# Parent-child expansion
RAG_PARENT_CHILD=false
# HNSW iterative scan
RAG_HNSW_ITERATIVE_SCAN=off
# Document access groups: off | on (off: every member sees every document)
# Document access groups
RAG_DOC_ACCESS_GROUPS=off
# Exact-scan row cutoff
RAG_EXACT_SCAN_CUTOFF=0
# Query translation before lexical tokenization
# Lexical query translation
RAG_LEXICAL_TRANSLATION=false
# Dictionary terms match as single lexical tokens (needs relex)
# Dictionary terms as single search terms
RAG_LEXICAL_DICTIONARY=false
# Italian stemming in lexical text (needs relex)
# Italian stemming
RAG_LEXICAL_STEM_IT=false
# Lexical leg scoring: ts_rank_cd or bm25 (bm25 needs RAG_PIPELINE=v2, RAG_LEXICAL_SEARCH=true and npm run rag:lexstats)
# Lexical scoring
RAG_LEXICAL_SCORING=ts_rank_cd
# BM25 term-frequency saturation, 0.5 to 3
# BM25 k1
RAG_LEXICAL_BM25_K1=1.2
# BM25 length normalisation, 0 to 1
# BM25 b
RAG_LEXICAL_BM25_B=0.75
# BM25 document frequency: raw, or cluster to count a duplicate cluster once (needs bm25 and RAG_DUP_CLUSTERS=true)
# BM25 document frequency
RAG_LEXICAL_DF_MODE=raw
# Requests may ask for earlier document versions (needs RAG_LEXICAL_SEARCH=true)
# Version scope filter
RAG_VERSION_SCOPE=false
# Embedded chat may request earlier versions only while this and RAG_VERSION_SCOPE are on
# Version scope in embedded chat
RAG_EMBED_VERSION_SCOPE=false
# Structured table row lookup (needs the table-rows backfill)
# Table row lookup
RAG_TABLE_LOOKUP=false
# Limit retrieval to passages carrying a named identifier (needs RAG_IDENTIFIER_INDEX=true)
# Identifier filter
RAG_IDENTIFIER_FILTER=false
# Emergency override for pool/cap/topk (operator only)
# Retrieval params override (emergency)
RAG_RETRIEVAL_PARAMS_OVERRIDE=
# Tenant for embedded chat: s:default | o:<uuid> | u:<uuid> (empty means s:default in single-tenant, fails closed in multi-tenant)
# Embedded chat tenant
RAG_EMBED_TENANT=
# Access-group key embedded chat and WhatsApp answer for (empty: documents visible to everyone only)
# Embedded chat access group
RAG_EMBED_ACCESS_GROUP=
# Look up exact identifiers (invoice numbers, contract ids) before vector search: true | false
# Exact identifier lookup
RAG_EXACT_ID_LOOKUP=false
# Recheck before rerank that each candidate's document still exists and is current: true | false
# Source recheck before rerank
RAG_SOURCE_RECHECK=false
# Document scope tags at upload and in retrieval filters: true | false
# Scope tags
RAG_SCOPE_TAGS=false
# Exclude documents outside their effective dates from answers: true | false
# Effective dates
RAG_EFFECTIVE_DATES=false
# Limit or rank retrieval by matched attributes (needs RAG_DOC_ATTRIBUTES=true and RAG_PIPELINE=v2): off | hard | soft
# Attribute filter
RAG_ATTRIBUTE_FILTER=off
# Numbers with unit symbols match as single lexical tokens (needs relex): true | false
# Numbers with units as single search terms
RAG_LEXICAL_QUANTITY=false

# -----------------------------
# RAG: Reranking and context
# -----------------------------
# Reranker: none | auto | cohere | voyage | local_bm25
# auto uses Cohere when COHERE_API_KEY is set and a local fallback otherwise
# With auto and COHERE_API_KEY set, query and candidate text are sent to Cohere (chat, embed, eval; voice stays local)
# Reranker
RAG_RERANKER=none
# Chat rerank tier
RAG_RERANK_TIER_CHAT=quality
# Voice rerank tier
RAG_RERANK_TIER_VOICE=fast
# Per-language Voyage rerank model, e.g. zh=rerank-2.5
# Voyage rerank model by language
RAG_RERANK_VOYAGE_MODEL_BY_LANG=
# Cohere API key
COHERE_API_KEY=
# Cohere base URL
COHERE_BASE_URL=
# Refusal and context assembly
# Threshold refusal
RAG_REFUSAL_THRESHOLD=false
# Fallback refusal floor when no calibrated rerank cell applies: similarity | legacy_rule
# Refusal floor
RAG_REFUSAL_FLOOR=similarity
# Context edge order
RAG_CONTEXT_EDGE_ORDER=false
# Context compression
RAG_CONTEXT_COMPRESSION=false
# Context token budget
RAG_CONTEXT_TOKEN_BUDGET=6000
# Group near-duplicate passages across documents (needs the dup-cluster backfill)
# Duplicate clusters
RAG_DUP_CLUSTERS=false
# Result diversity: off | collapse | mmr
# Result diversity
RAG_RESULT_DIVERSITY=off

# -----------------------------
# RAG: Answers and citations
# -----------------------------
# Chat answer style
# classic: headed markdown answer with a closing paragraph of follow-up offers (default)
# concise: one-line answer, short fact bullets, then --- and up to 3 "↳ " follow-up questions
# Answer style
RAG_ANSWER_STYLE=classic
# Earlier assistant answers are not evidence: on knowledge-base turns, tell the model to take facts only
# from this turn's context and tool results and to correct an earlier unsupported answer (default false)
# Earlier answers are not evidence
RAG_HISTORY_NOT_EVIDENCE=false
# Inline citations on knowledge-base answers
# Inline citations
RAG_CITATIONS=false
# Route Claude models to the Anthropic API with Claude Citations
# Claude Citations
RAG_CLAUDE_CITATIONS=false
# Anthropic API key for Claude Citations (never logged)
# Anthropic API key
ANTHROPIC_API_KEY=
# Anthropic API base URL; empty uses https://api.anthropic.com/v1 (set only for tests and recorded streams)
# Anthropic base URL
ANTHROPIC_BASE_URL=
# Score answers for groundedness after the stream (sidecar)
# Groundedness scoring
RAG_GROUNDEDNESS=false
# Allow the Vectara hosted groundedness scorer
# Vectara hosted scorer
RAG_GROUNDEDNESS_VECTARA_OPT_IN=false
# Groundedness scoring timeout in milliseconds
# Groundedness timeout (ms)
RAG_GROUNDEDNESS_TIMEOUT_MS=20000
# Premise sent to the scorer, in cl100k tokens
# Groundedness premise cap (tokens)
RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000
# Multi-tenant only: set after the Vectara data-retention terms were recorded in live verification
# Multi-tenant Vectara acknowledgement
RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false
# Refusal, notice and badge texts from the language registry (needs supported languages)
# Language registry texts
RAG_REGISTRY_TEXTS=false
# Answer the covered part and name what the documents do not cover
# Partial answer rule
RAG_PARTIAL_ANSWER_RULE=false
# Do not answer from documents on a neighbouring subject
# Context relevance rule
RAG_CONTEXT_RELEVANCE_RULE=false
# One citation per factual sentence and marks on uncited sentences (needs RAG_CITATIONS or RAG_CLAUDE_CITATIONS)
# Citation per sentence
RAG_CITATION_PER_SENTENCE=false
# Check each sentence against the documents after the answer (needs RAG_GROUNDEDNESS)
# Claim check
RAG_CLAIM_CHECK=false
# Judge model for languages the groundedness scorer does not cover (needs RAG_GROUNDEDNESS_JUDGE_MODEL)
# Judge model for uncovered languages
RAG_GROUNDEDNESS_LLM_JUDGE=false
# Judge model id; answer sentences and their document passages go to this model's provider
# Judge model
RAG_GROUNDEDNESS_JUDGE_MODEL=
# Output-length cap for knowledge-base answers: off | auto | a positive integer of at least 256
# Answer length limit
RAG_MAX_OUTPUT_TOKENS=off
# Label each document's version and effective date, and answer from the latest
# Version labels
RAG_VERSION_LABELS=false
# Calculator tool for arithmetic over document numbers
# Calculation tool
RAG_CALC_TOOL=false
# Recompute arithmetic written in answers and mark results that do not match
# Calculation check
RAG_CALC_CHECK=false
# Fit the prompt to the model's context window before sending it
# Prompt budget
RAG_PROMPT_BUDGET=false
# When documents do not fit the window: truncate | refine (refine needs RAG_PROMPT_BUDGET)
# Context overflow
RAG_CONTEXT_OVERFLOW=truncate

# -----------------------------
# RAG: Evaluation
# -----------------------------
# Eval endpoint exposes document content; keep it off in production
# Evaluation endpoint
RAG_EVAL_ENDPOINT_ENABLED=false
# Shared secret for the eval endpoint (at least 32 characters)
# Evaluation endpoint secret
RAG_EVAL_SECRET=
# Multi-tenant scopes the eval endpoint may read, comma-separated org:<uuid> or user:<uuid> (empty denies all)
# Evaluation allowed scopes
RAG_EVAL_ALLOWED_SCOPES=
# Expert review queue and weekly mining (off answers 404)
# Expert review queue
RAG_DOMAIN_EXPERT_REVIEW=false
# Check RAG-affecting settings before a Config UI save: off | warn | enforce (off saves at once, as before)
# Setting check before save
RAG_CONFIG_GATE=off
# Add a live chat-model layer to the setting check (uses model credit; no effect while RAG_CONFIG_GATE=off)
# Live layer of the setting check
RAG_CONFIG_GATE_LIVE=false
# Weekly representative sample into the review queue (needs RAG_RETRIEVAL_LOG=masked_query and RAG_DOMAIN_EXPERT_REVIEW=true)
# Representative sample
RAG_REPRESENTATIVE_SAMPLE=false

# -----------------------------
# RAG: Vector backends
# -----------------------------
# Where chat retrieval runs: pgvector | weaviate | qdrant (external backends apply only with RAG_PIPELINE=v2)
# Chat retrieval backend
RAG_RETRIEVAL_BACKEND=pgvector
# Where voice retrieval runs: pgvector | weaviate | qdrant (set separately from chat)
# Voice retrieval backend
RAG_RETRIEVAL_BACKEND_VOICE=pgvector
# Shared secret for the vector sync drain and reconcile calls (at least 32 characters)
# Vector sync secret
RAG_VECTOR_SYNC_SECRET=
# Largest sync lag in seconds before an external index counts as not ready
# Max sync lag (seconds)
RAG_VECTOR_SYNC_MAX_LAG_SECONDS=300
# Weaviate endpoint URL
# Weaviate URL
WEAVIATE_URL=
# Weaviate write API key (sync only, never logged)
# Weaviate write API key
WEAVIATE_API_KEY=
# Weaviate read-only API key used by retrieval
# Weaviate read API key
WEAVIATE_READ_API_KEY=
# Qdrant endpoint URL
# Qdrant URL
QDRANT_URL=
# Qdrant write API key (sync only, never logged)
# Qdrant write API key
QDRANT_API_KEY=
# Qdrant read-only API key used by retrieval
# Qdrant read API key
QDRANT_READ_API_KEY=

# -----------------------------
# RAG: Security
# -----------------------------
# Signing secret for voice retrieval tokens (at least 32 characters)
# Voice token secret
RAG_VOICE_TOKEN_SECRET=
# Lifetime of a voice retrieval token in seconds
# Voice token lifetime (seconds)
RAG_VOICE_TOKEN_TTL_SECONDS=3600
# Wrap retrieved chunks in tagged <doc> blocks with an untrusted-content notice
# Context tagging
RAG_CONTEXT_TAGGING=false
# Retrieval-time injection check: off | flag | drop | downweight (drop is recommended; downweight is weaker than drop)
# Retrieval-time injection check
RAG_INJECTION_CHECK=off
# Prompt Guard 2 detector in the sidecar (optional; en and it only)
# Prompt Guard detector
RAG_INJECTION_PROMPT_GUARD=false
# Lakera Guard hosted detector (sends chunk text to Lakera, a third party)
# Lakera Guard hosted detector
RAG_INJECTION_LAKERA=false
# Lakera Guard API key (never logged)
# Lakera Guard API key
LAKERA_GUARD_API_KEY=
# Lakera Guard base URL; empty uses the default Lakera host (regional hosts such as the EU one are allowed)
# Lakera Guard base URL
LAKERA_GUARD_BASE_URL=
# Multi-tenant only: set after the Lakera data-retention terms were recorded in live verification
# Multi-tenant Lakera acknowledgement
RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=false
# Tool results (web search, MCP) in the model context: off | tag | tag_and_flag
# Tool result guard
RAG_TOOL_RESULT_GUARD=off
# Render markdown images in answers only from allowed hosts (inlined at build time; needs a rebuild)
# Answer image allowlist
NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST=false
# Links and sign-in requests in answers: off | flag | enforce
# Answer guard
RAG_OUTPUT_GUARD=off
# Record security events with the document's uploader (ids only)
# Security events
RAG_SECURITY_EVENTS=false
# Open an alert above this many events from one uploader; 0 means no alerts
# Uploader alert threshold
RAG_UPLOADER_ALERT_THRESHOLD=0
# Alert window in hours (1 to 720)
# Uploader alert window (hours)
RAG_UPLOADER_ALERT_WINDOW_HOURS=24
# Hold uploads of an alerted uploader: off | manual | auto
# Hold uploads of alerted uploaders
RAG_UPLOADER_HOLD=off
# Prompt injection scan on ingested text: off | quarantine
# Prompt injection scan
RAG_INJECTION_SCAN=off
# Hidden text check at ingestion: off | flag | quarantine
# Hidden text check
RAG_HIDDEN_TEXT_CHECK=off
# Link check at ingestion against the allowlist: off | flag | quarantine
# Link check at ingestion
RAG_INGEST_LINK_CHECK=off
# Allowed link domains, comma-separated (subdomains included)
# Allowed link domains
RAG_OUTPUT_LINK_ALLOWLIST=
# Uploads that need admin approval: off | members | all (needs the unified pipeline)
# Upload approval
RAG_UPLOAD_APPROVAL=off

# -----------------------------
# RAG: Tracing and monitoring
# -----------------------------
# Langfuse tracing
LANGFUSE_ENABLED=false
# Langfuse public key
LANGFUSE_PUBLIC_KEY=
# Secret key (at least 32 characters)
# Langfuse secret key
LANGFUSE_SECRET_KEY=
# Langfuse base URL
LANGFUSE_BASE_URL=https://cloud.langfuse.com
# Share of requests traced, 0 to 1
# Trace sample rate
LANGFUSE_SAMPLE_RATE=0.1
# Send prompt and answer text to Langfuse (off keeps only metadata)
# Send prompt and answer text to Langfuse
LANGFUSE_CAPTURE_CONTENT=false
# Share of traces queued for human review, 0 to 1
# Review sample rate
LANGFUSE_REVIEW_SAMPLE_RATE=0
# Thumbs up/down feedback on answers
# Answer feedback
RAG_ANSWER_FEEDBACK=false
# Retrieval log: off | ids | masked_query (masked_query is needed for weekly mining)
# Retrieval log
RAG_RETRIEVAL_LOG=off
# Days a retrieval log row is kept, 1 to 365 (other values are read as 30)
# Log retention (days)
RAG_RETRIEVAL_LOG_RETENTION_DAYS=30
# Feedback control under refusals in web chat (needs the retrieval log)
# Refusal feedback
RAG_REFUSAL_FEEDBACK=false
# Answer rating in the embed widget and window (needs the secret below and the retrieval log)
# Embed answer rating
RAG_EMBED_FEEDBACK=false
# Signing secret for embed feedback tokens, at least 32 characters (never logged)
# Embed feedback secret
RAG_EMBED_FEEDBACK_SECRET=
# Count opened sources and citations as a weak signal (needs the retrieval log)
# Count opened sources
RAG_SOURCE_OPEN_SIGNAL=false
# Daily monitor of the retrieval log (needs RAG_RETRIEVAL_LOG at ids or masked_query; off runs nothing and stores nothing)
# Daily monitor
RAG_MONITOR=false
# Optional admin webhook for monitor alerts, https:// only (treated as a secret, never shown or logged)
# Monitor webhook URL
RAG_MONITOR_WEBHOOK_URL=
# Optional HMAC-SHA256 signing secret for webhook deliveries, at least 32 characters (never logged)
# Monitor webhook signing secret
RAG_MONITOR_WEBHOOK_SECRET=

# -----------------------------
# RAG: Sidecar
# -----------------------------
# Base URL of the Python sidecar service
# Sidecar URL
RAG_SIDECAR_URL=
# Shared secret for the sidecar (at least 32 characters)
# Sidecar secret
RAG_SIDECAR_SECRET=
# Concurrent voice rooms the app allows (409 voice_busy beyond it); must equal VOICE_AGENT_MAX_SESSIONS on the voice agent
# Max concurrent voice rooms
VOICE_MAX_ACTIVE_ROOMS=4
# Redis URL
REDIS_URL=
# Concurrent worker jobs (sidecar)
# Worker concurrency
RAG_INGEST_WORKER_CONCURRENCY=2
# Terminal ingestion jobs older than this many days are archived and purged (maintenance task)
# Job retention (days)
RAG_INGEST_JOB_RETENTION_DAYS=90
# Sidecar maintenance loop interval (seconds); off via RAG_INGEST_MAINTENANCE=off
# Maintenance interval (seconds)
RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS=3600
# Ingestion maintenance
RAG_INGEST_MAINTENANCE=on

# -----------------------------
# RAG BEHAVIOR MODE
# -----------------------------
# Controls how strictly the AI follows your knowledge base
# strict: Only use knowledge base, refuse if info not found (default)
# balanced: Prioritize KB, supplement with general knowledge when helpful
# flexible: Use KB as one source among many, blend naturally
# bypass: Ignore knowledge base entirely, pure ChatGPT-like behavior
RAG_BEHAVIOR_MODE=strict

# -----------------------------
# RAG CONFIGURATION (Unified Optimized System)
# -----------------------------
# Unified RAG Settings - All features can be toggled individually
RAG_MULTI_PASS=true
RAG_ADAPTIVE_RETRIEVAL=true
RAG_QUERY_ENHANCEMENT=false
RAG_ADJACENT_CHUNKS=true
RAG_CACHE_ENABLED=true
RAG_ADJACENCY_WINDOW=2
RAG_MATCH_MULTIPLIER=3

# RAG Optimization Parameters  
# Optimized for finding specific information with high accuracy
RAG_MMR_LAMBDA=0.85
RAG_MIN_CONFIDENCE=0.7
RAG_FINAL_RESULT_COUNT=25
RAG_DIVERSITY_WEIGHT=0.15

# RAG Advanced Settings
RAG_ENABLE_ADJACENT_CHUNKS=true
RAG_ENABLE_HYBRID_SEARCH=false
RAG_MAX_RETRIEVAL_PASSES=2
RAG_COMPLETENESS_CONFIDENCE=0.7
RAG_PERFORMANCE_MODE=balanced
RAG_RERANKING=true
RAG_RERANKING_STRATEGY=hybrid

# RAG Frontend Settings (used by optimized-search.ts)
NEXT_PUBLIC_RAG_CACHE_ENABLED=true
NEXT_PUBLIC_RAG_CACHE_TTL=3600
NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED=false
NEXT_PUBLIC_RAG_RERANKING_ENABLED=false
NEXT_PUBLIC_RAG_RERANKING_STRATEGY=hybrid
NEXT_PUBLIC_RAG_PERFORMANCE_MODE=balanced
NEXT_PUBLIC_RAG_ENHANCEMENT_CONFIDENCE_THRESHOLD=0.7

# Temporal and Financial Intelligence (Unified RAG)
RAG_TEMPORAL_BOOST=true
RAG_FINANCIAL_BOOST=true
RAG_TEMPORAL_MATCHING=false
RAG_FALLBACK_LOWER_THRESHOLD=true
RAG_TEMPORAL_CONFIDENCE_MIN=0.6
RAG_FINANCIAL_CONFIDENCE_MIN=0.7
RAG_EXTRACT_KEY_TERMS=true
RAG_MAX_KEY_TERMS=10
RAG_SEMANTIC_CLASSIFICATION=true

# Query Analysis Thresholds (Temporal/Financial Intelligence)
RAG_EXACT_THRESHOLD=0.75
RAG_HIGH_THRESHOLD=0.65
RAG_MEDIUM_THRESHOLD=0.55
RAG_LOW_THRESHOLD=0.45

# -----------------------------
# DEBUGGING
# -----------------------------
DEBUG_RAG=false

# -----------------------------
# TITLE GENERATION SYSTEM
# -----------------------------
# AI-powered title generation using Claude Haiku 4.5
CHAT_TITLE_MODEL=anthropic/claude-haiku-4.5
CHAT_TITLE_MAX_TOKENS=100
CHAT_TITLE_TEMPERATURE=0.5

# -----------------------------
# LLAMACLOUD DOCUMENT PARSING
# -----------------------------
# Basic parsing configuration
LLAMACLOUD_PARSING_MODE=balanced
LLAMACLOUD_CHUNK_STRATEGY=sentence
LLAMACLOUD_CHUNK_SIZE=2500
LLAMACLOUD_CHUNK_OVERLAP=992
LLAMACLOUD_MULTIMODAL_PARSING=true

# Advanced LlamaParse configuration
# Parse mode: parse_page_with_agent uses AI for intelligent parsing (10-90 credits/page)
LLAMACLOUD_PARSE_MODE=parse_page_with_agent
# Model for parsing: openai-gpt-4-1-mini is the most economical (10 credits/page)
LLAMACLOUD_PARSE_MODEL=openai-gpt-4-1-mini
# High resolution OCR for scanned documents (slower but more accurate)
LLAMACLOUD_HIGH_RES_OCR=true
# Adaptive long table detection and handling
LLAMACLOUD_ADAPTIVE_LONG_TABLE=true
# Extract outlined tables from documents
LLAMACLOUD_OUTLINED_TABLE_EXTRACTION=true
# Output tables as HTML for better formatting
LLAMACLOUD_OUTPUT_TABLES_AS_HTML=true

# -----------------------------
# MCP CONFIGURATION
# -----------------------------
MCP_ZAPIER_ENDPOINT=
MCP_CUSTOM_SERVERS=[]

# -----------------------------
# REASONING/THINKING MODELS
# -----------------------------
NEXT_PUBLIC_REASONING_ENABLED=true
NEXT_PUBLIC_DEFAULT_REASONING_EFFORT=medium
NEXT_PUBLIC_MAX_REASONING_TOKENS=8000
NEXT_PUBLIC_SHOW_REASONING_BY_DEFAULT=false
NEXT_PUBLIC_RAG_REASONING_ENABLED=false
REASONING_COST_MULTIPLIER=1.5

# -----------------------------
# NANGO INTEGRATION (Document Connectors)
# -----------------------------
# Enable/disable third-party document connectors (Google Drive, Notion, Dropbox, etc.)
NEXT_PUBLIC_NANGO_ENABLED=false

# Nango Secret Key - for backend SDK (get from https://app.nango.dev/dev/environment-settings)
NANGO_SECRET_KEY=

# Webhook signature verification secret (optional - set this in Nango dashboard)
NANGO_WEBHOOK_SECRET=

# Nango host (change for self-hosted deployments)
NANGO_HOST=https://api.nango.dev

# Sync configuration
NANGO_SUPPORTED_FILE_TYPES=pdf,doc,docx,txt,md,html,pptx,xlsx
NANGO_MAX_FILES_PER_SYNC=100
NANGO_SYNC_INTERVAL_HOURS=1

# -----------------------------
# CONNECTORS MANAGEMENT
# -----------------------------
# Enable/disable entire connectors feature
NEXT_PUBLIC_CONNECTORS_ENABLED=true
# Show connectors section on Document Dashboard
CONNECTORS_SHOW_ON_DASHBOARD=true

`;
}

function checkAndCreateEnvFile() {
  // Check if .env.local already exists
  if (fs.existsSync(ENV_PATH)) {
    console.log('✅ .env.local file found');
    return false; // File already exists
  }

  console.log('\n📝 No .env.local file found. Creating one for you...');

  try {
    // Create the .env.local file with standard template
    const template = getStandardTemplate();
    fs.writeFileSync(ENV_PATH, template);

    console.log('✅ Created .env.local with default configuration (single-tenant mode)');
    console.log('\n🎯 Next Steps:');
    console.log('   1. Add your Supabase credentials (required)');
    console.log('   2. Run the appropriate SQL setup in Supabase:');
    console.log('      - For single-tenant: supabase/single-tenant-setup.sql');
    console.log('      - For multi-tenant: supabase/multi-tenant-setup.sql');
    console.log('   3. Add your OpenAI API key (required for embeddings)');
    console.log('   4. Add your LlamaCloud API key (required for document processing/RAG)');
    console.log('   5. Add your OpenRouter API key (for AI models)');
    console.log('   6. Add your Groq API key (for fast AI models)');
    console.log('\n💡 Run "npm run config" to configure everything visually at http://localhost:3333');
    console.log('📖 See DEPLOYMENT_MODES.md for deployment mode documentation');
    console.log('');

    return true; // File was created
  } catch (error) {
    console.error('❌ Error creating .env.local:', error);
    process.exit(1);
  }
}

// -----------------------------
// D-08 first-run language picker
// -----------------------------
const MAX_LANGUAGE_ATTEMPTS = 3;
const SUGGESTION_TIMEOUT_MS = 3000;
const SUGGESTION_ROW_LIMIT = 10000;

function languageContext() {
  return require('./rag/language-settings-context');
}

function isSetValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** D-08: prompt only on an interactive terminal, outside CI, while RAG_SUPPORTED_LANGUAGES has no value. */
function shouldPromptForLanguages({ input, output, env = {}, envValues = {} } = {}) {
  if (!input || !output || input.isTTY !== true || output.isTTY !== true) return false;
  if (isSetValue(env.CI)) return false;
  return !isSetValue(env.RAG_SUPPORTED_LANGUAGES) && !isSetValue(envValues.RAG_SUPPORTED_LANGUAGES);
}

/** D-07 for the init-env entry point; the picker and the entry-point parity test call it. */
function validateLanguageChoice(candidate, { root = REPO_ROOT, env = {}, registry, rerankerOverrides } = {}) {
  const ctx = languageContext();
  const context = ctx.buildValidationContext({ root, env, registry, rerankerOverrides });
  return ctx.validateForScript(candidate, context);
}

/**
 * Per-language document counts from one PostgREST request, only when .env.local already holds the Supabase URL and
 * service-role key. Any failure means no suggestion. The key is sent only to that URL and never printed.
 */
async function fetchLanguageSuggestions({ envValues = {}, codes, fetchImpl }) {
  const url = envValues.NEXT_PUBLIC_SUPABASE_URL;
  const key = envValues.SUPABASE_SERVICE_ROLE_KEY;
  if (!isSetValue(url) || !isSetValue(key) || typeof fetchImpl !== 'function' || codes.length === 0) return null;
  let base;
  try {
    base = new URL(url.trim());
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  const query = new URLSearchParams({
    select: 'language',
    is_current: 'eq.true',
    status: 'eq.ready',
    language: `in.(${codes.join(',')})`,
    limit: String(SUGGESTION_ROW_LIMIT),
  });
  const target = `${base.origin}${base.pathname.replace(/\/+$/, '')}/rest/v1/documents?${query.toString()}`;
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { apikey: key.trim(), Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(SUGGESTION_TIMEOUT_MS) : undefined,
    });
    if (!response || !response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows)) return null;
    const counts = {};
    for (const row of rows) {
      const code = row && typeof row.language === 'string' ? row.language : null;
      if (code && codes.includes(code)) counts[code] = (counts[code] || 0) + 1;
    }
    return counts;
  } catch {
    return null;
  }
}

function languageErrorText(error) {
  switch (error.code) {
    case 'empty_set':
      return 'Choose at least one language.';
    case 'unknown_language':
      return `"${error.language}" is not a language this deployment can support.`;
    case 'primary_not_in_set':
      return error.language
        ? `The primary language "${error.language}" must be one of the chosen languages.`
        : 'Choose a primary language from the chosen languages.';
    case 'incomplete_pack':
      return `${error.language}: its language pack is not complete.`;
    case 'embedding_profile_unsupported':
      return `${error.language}: the embedding profile ${error.id} does not declare this language.`;
    case 'reranker_unsupported':
      return `${error.language}: the reranker ${error.id} does not declare this language.`;
    default:
      return `${error.code}${error.language ? ` (${error.language})` : ''}`;
  }
}

function languageWarningText(warning) {
  if (warning.code === 'groundedness_not_checked') {
    return `${warning.language}: answers in this language are not checked for groundedness.`;
  }
  return `${warning.code}${warning.language ? ` (${warning.language})` : ''}`;
}

function packLabel(pack) {
  const native = pack.native_name || pack.code;
  const english = pack.name || pack.code;
  return native === english ? `${native} (${pack.code})` : `${native} · ${english} (${pack.code})`;
}

/** Numbers pick from the listed options, anything else is taken as a code for the validator to judge. */
function resolveAnswerTokens(answer, options) {
  return answer
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      if (/^\d+$/.test(token)) {
        const index = Number(token) - 1;
        return index >= 0 && index < options.length ? options[index] : token;
      }
      return token;
    });
}

function lineReader(input) {
  const readline = require('readline');
  const rl = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async ask(output, question) {
      output.write(question);
      const next = await iterator.next();
      return next.done ? null : String(next.value);
    },
    close() {
      rl.close();
    },
  };
}

/**
 * D-08 picker for scripts/init-env.js. Asks for the supported languages and the primary language, validates with the
 * shared D-07 validator and writes both variables only after a valid explicit answer. An empty answer, closed input or
 * three invalid answers leave both unset.
 */
async function runLanguagePicker({
  input,
  output,
  env = {},
  root = REPO_ROOT,
  envPath = ENV_PATH,
  fetchImpl = typeof fetch === 'function' ? fetch : undefined,
} = {}) {
  const ctx = languageContext();
  const envValues = ctx.readEnvFileValues(envPath);
  if (!shouldPromptForLanguages({ input, output, env, envValues })) return { prompted: false, saved: false, attempts: 0 };

  const registry = ctx.readRegistry(root);
  const packs = ctx.completePacks(registry);
  const codes = packs.map((pack) => pack.code);
  const validationEnv = { RAG_RERANKER: isSetValue(env.RAG_RERANKER) ? env.RAG_RERANKER : envValues.RAG_RERANKER };
  const suggestions = await fetchLanguageSuggestions({ envValues, codes, fetchImpl });

  output.write('\n[RAG Languages] Choose the languages this deployment supports (RAG_SUPPORTED_LANGUAGES).\n');
  packs.forEach((pack, index) => {
    const count = suggestions && suggestions[pack.code] ? suggestions[pack.code] : 0;
    const suggested = count > 0 ? ` - suggested: ${count} ${count === 1 ? 'document' : 'documents'}` : '';
    output.write(`  ${index + 1}) ${packLabel(pack)}${suggested}\n`);
  });
  output.write('The embedding check is not verified against the active profile here (no database at this step).\n');

  const reader = lineReader(input);
  let attempts = 0;
  try {
    while (attempts < MAX_LANGUAGE_ATTEMPTS) {
      const answer = await reader.ask(output, 'Languages (numbers or codes, comma-separated; empty to skip): ');
      if (answer === null || answer.trim() === '') {
        output.write('No languages chosen; RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE stay unset.\n');
        return { prompted: true, saved: false, attempts };
      }
      const chosen = resolveAnswerTokens(answer, codes);
      const chosenOrdered = codes.filter((code) => chosen.map((token) => token.toLowerCase()).includes(code));
      let primary = chosen.length === 1 ? chosen[0] : '';
      if (chosen.length > 1) {
        const primaryOptions = chosenOrdered.length > 0 ? chosenOrdered : chosen;
        primaryOptions.forEach((code, index) => {
          const pack = packs.find((candidate) => candidate.code === code);
          output.write(`  ${index + 1}) ${pack ? packLabel(pack) : code}\n`);
        });
        const primaryAnswer = await reader.ask(output, 'Primary language (number or code): ');
        if (primaryAnswer === null) {
          output.write('No primary language chosen; both variables stay unset.\n');
          return { prompted: true, saved: false, attempts };
        }
        primary = resolveAnswerTokens(primaryAnswer, primaryOptions)[0] || '';
      }

      const result = validateLanguageChoice({ supported: chosen, primary }, { root, env: validationEnv, registry });
      attempts += 1;
      if (result.ok) {
        ctx.writeLanguageVariables(envPath, result.normalized);
        output.write(
          `Saved RAG_SUPPORTED_LANGUAGES=${result.normalized.supported} and RAG_PRIMARY_LANGUAGE=${result.normalized.primary}.\n`,
        );
        for (const warning of result.warnings) output.write(`Note: ${languageWarningText(warning)}\n`);
        return { prompted: true, saved: true, attempts, result };
      }
      for (const error of result.errors) output.write(`Not saved: ${languageErrorText(error)}\n`);
    }
    output.write('Too many invalid answers; RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE stay unset.\n');
    return { prompted: true, saved: false, attempts };
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  checkAndCreateEnvFile();
  runLanguagePicker({ input: process.stdin, output: process.stdout, env: process.env }).catch((error) => {
    console.error('[RAG Languages] The language picker failed; both variables stay unset:', {
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

// Export for use in other scripts
module.exports = {
  checkAndCreateEnvFile,
  fetchLanguageSuggestions,
  runLanguagePicker,
  shouldPromptForLanguages,
  validateLanguageChoice,
};
