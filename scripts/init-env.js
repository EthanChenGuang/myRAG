const fs = require('fs');
const path = require('path');

// Resolve project root (one level up from scripts directory); MYRAG_CONFIG_ROOT points it elsewhere, as for config-server.js
const REPO_ROOT = process.env.MYRAG_CONFIG_ROOT
  ? path.resolve(process.env.MYRAG_CONFIG_ROOT)
  : path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env.local');

// Default model configurations
const DEFAULT_OPENAI_MODELS = '[{"id":"gpt-4.1-mini","displayName":"GPT-4.1 Mini"},{"id":"gpt-4.1","displayName":"GPT-4.1"},{"id":"o3","displayName":"o3"},{"id":"o4-mini","displayName":"o4 Mini"}]';

const DEFAULT_OPENROUTER_MODELS = '[{"id":"anthropic/claude-sonnet-4.5","displayName":"Claude Sonnet 4.5","isDefault":true},{"id":"openai/gpt-5.2-chat","displayName":"GPT-5.2"},{"id":"openai/gpt-4.1-mini","displayName":"GPT-4.1 Mini"},{"id":"openai/gpt-4.1","displayName":"GPT-4.1"},{"id":"anthropic/claude-opus-4.1","displayName":"Claude Opus 4.1"},{"id":"anthropic/claude-opus-5.5","displayName":"Claude Opus 5.5","anthropicId":"claude-opus-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"anthropic/claude-sonnet-5.5","displayName":"Claude Sonnet 5.5","anthropicId":"claude-sonnet-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"anthropic/claude-haiku-5.5","displayName":"Claude Haiku 5.5","anthropicId":"claude-haiku-5-5","supportsReasoning":true,"reasoningMethod":"effort","contextLength":1000000},{"id":"google/gemini-2.5-flash-lite","displayName":"Gemini 2.5 Flash Lite"},{"id":"google/gemini-2.5-flash","displayName":"Gemini 2.5 Flash"},{"id":"meta-llama/llama-4-maverick","displayName":"Llama 4 Maverick","isOpenSource":true},{"id":"cognitivecomputations/dolphin-mistral-24b-venice-edition:free","displayName":"Venice: Uncensored","isFree":true,"isOpenSource":true,"isUncensored":true}]';

// Groq free tier has strict rate limits - only Llama 3.3 70B works reliably with RAG contexts
// Users with paid Groq tiers can add more models: llama-3.1-8b-instant, mixtral-8x7b-32768, gemma2-9b-it
const DEFAULT_GROQ_MODELS = '[{"id":"llama-3.3-70b-versatile","displayName":"Llama 3.3 70B"}]';

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
# RAG BEHAVIOR MODE
# -----------------------------
# Controls how strictly the AI follows your knowledge base
# strict: Only use knowledge base, refuse if info not found (default)
# balanced: Prioritize KB, supplement with general knowledge when helpful
# flexible: Use KB as one source among many, blend naturally
# bypass: Ignore knowledge base entirely, pure ChatGPT-like behavior
RAG_BEHAVIOR_MODE=strict

# -----------------------------
# RAG EVALUATION & SIDECAR
# -----------------------------
# Eval endpoint exposes document content; keep it off in production
RAG_EVAL_ENDPOINT_ENABLED=false
# Shared secret for the eval endpoint (at least 32 characters)
RAG_EVAL_SECRET=
# Multi-tenant scopes the eval endpoint may read, comma-separated org:<uuid> or user:<uuid> (empty denies all)
RAG_EVAL_ALLOWED_SCOPES=
# Base URL of the Python sidecar service
RAG_SIDECAR_URL=
# Shared secret for the sidecar (at least 32 characters)
RAG_SIDECAR_SECRET=

# -----------------------------
# RETRIEVAL PIPELINE
# -----------------------------
# legacy keeps today's retrieval path; unified switches to the staged pipeline
RAG_PIPELINE=legacy
# Stages to skip, comma-separated (empty runs every stage)
RAG_DISABLED_STAGES=
# Per-stage time budgets as stage=ms,stage=ms (empty uses the built-in budgets)
RAG_STAGE_TIMEOUTS=

# -----------------------------
# RETRIEVAL V2 (Phase 4 switches — off by default)
# -----------------------------
# Lexical hybrid search leg
RAG_LEXICAL_SEARCH=false
# Reranker: none | auto | cohere | voyage | local_bm25
# auto uses Cohere when COHERE_API_KEY is set and a local fallback otherwise
RAG_RERANKER=none
RAG_RERANK_TIER_CHAT=quality
RAG_RERANK_TIER_VOICE=fast
# Per-language Voyage rerank model, e.g. zh=rerank-2.5
RAG_RERANK_VOYAGE_MODEL_BY_LANG=
COHERE_API_KEY=
COHERE_BASE_URL=
# Refusal and context assembly
RAG_REFUSAL_THRESHOLD=false
# Fallback refusal floor when no calibrated rerank cell applies: similarity | legacy_rule
RAG_REFUSAL_FLOOR=similarity
RAG_CONTEXT_EDGE_ORDER=false
RAG_CONTEXT_COMPRESSION=false
RAG_CONTEXT_TOKEN_BUDGET=6000
# Parent chunks and pgvector scan
RAG_PARENT_CHILD=false
RAG_HNSW_ITERATIVE_SCAN=off
RAG_EXACT_SCAN_CUTOFF=0
# Query translation before lexical tokenization
RAG_LEXICAL_TRANSLATION=false
# Emergency override for pool/cap/topk (operator only)
RAG_RETRIEVAL_PARAMS_OVERRIDE=
# Tenant for embedded chat: s:default | o:<uuid> | u:<uuid> (empty means s:default in single-tenant, fails closed in multi-tenant)
RAG_EMBED_TENANT=
# Signing secret for voice retrieval tokens (at least 32 characters)
RAG_VOICE_TOKEN_SECRET=
# Lifetime of a voice retrieval token in seconds
RAG_VOICE_TOKEN_TTL_SECONDS=3600
# Concurrent voice rooms the app allows (409 voice_busy beyond it); must equal VOICE_AGENT_MAX_SESSIONS on the voice agent
VOICE_MAX_ACTIVE_ROOMS=4

# -----------------------------
# LANGFUSE TRACING
# -----------------------------
LANGFUSE_ENABLED=false
LANGFUSE_PUBLIC_KEY=
# Secret key (at least 32 characters)
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
# Share of requests traced, 0 to 1
LANGFUSE_SAMPLE_RATE=0.1
# Send prompt and answer text to Langfuse (off keeps only metadata)
LANGFUSE_CAPTURE_CONTENT=false
# Share of traces queued for human review, 0 to 1
LANGFUSE_REVIEW_SAMPLE_RATE=0

# -----------------------------
# VERIFIED CITATIONS AND GROUNDEDNESS
# -----------------------------
# Inline citations on knowledge-base answers
RAG_CITATIONS=false
# Route Claude models to the Anthropic API with Claude Citations
RAG_CLAUDE_CITATIONS=false
# Anthropic API key for Claude Citations (never logged)
ANTHROPIC_API_KEY=
# Anthropic API base URL; empty uses https://api.anthropic.com/v1 (set only for tests and recorded streams)
ANTHROPIC_BASE_URL=
# Score answers for groundedness after the stream (sidecar)
RAG_GROUNDEDNESS=false
# Allow the Vectara hosted groundedness scorer
RAG_GROUNDEDNESS_VECTARA_OPT_IN=false
# Groundedness scoring timeout in milliseconds
RAG_GROUNDEDNESS_TIMEOUT_MS=20000
# Premise sent to the scorer, in cl100k tokens
RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS=3000
# Thumbs up/down feedback on answers
RAG_ANSWER_FEEDBACK=false
# Multi-tenant only: set after the Vectara data-retention terms were recorded in live verification
RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=false

# -----------------------------
# RETRIEVAL LOG AND FEEDBACK
# -----------------------------
# Retrieval log: off | ids | masked_query (masked_query is needed for weekly mining)
RAG_RETRIEVAL_LOG=off
# Days a retrieval log row is kept, 1 to 365 (other values are read as 30)
RAG_RETRIEVAL_LOG_RETENTION_DAYS=30
# Feedback control under refusals in web chat (needs the retrieval log)
RAG_REFUSAL_FEEDBACK=false
# Answer rating in the embed widget and window (needs the secret below and the retrieval log)
RAG_EMBED_FEEDBACK=false
# Signing secret for embed feedback tokens, at least 32 characters (never logged)
RAG_EMBED_FEEDBACK_SECRET=
# Count opened sources and citations as a weak signal (needs the retrieval log)
RAG_SOURCE_OPEN_SIGNAL=false
# Expert review queue and weekly mining (off answers 404)
RAG_DOMAIN_EXPERT_REVIEW=false

# -----------------------------
# PROMPT-INJECTION DEFENSE
# -----------------------------
# Wrap retrieved chunks in tagged <doc> blocks with an untrusted-content notice
RAG_CONTEXT_TAGGING=false
# Retrieval-time injection check: off | flag | drop | downweight (drop is recommended; downweight is weaker than drop)
RAG_INJECTION_CHECK=off
# Prompt Guard 2 detector in the sidecar (optional; en and it only)
RAG_INJECTION_PROMPT_GUARD=false
# Lakera Guard hosted detector (sends chunk text to Lakera, a third party)
RAG_INJECTION_LAKERA=false
# Lakera Guard API key (never logged)
LAKERA_GUARD_API_KEY=
# Lakera Guard base URL; empty uses the default Lakera host (regional hosts such as the EU one are allowed)
LAKERA_GUARD_BASE_URL=
# Multi-tenant only: set after the Lakera data-retention terms were recorded in live verification
RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=false
# Tool results (web search, MCP) in the model context: off | tag | tag_and_flag
RAG_TOOL_RESULT_GUARD=off
# Render markdown images in answers only from allowed hosts (inlined at build time; needs a rebuild)
NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST=false

# -----------------------------
# QUERY LAYER
# -----------------------------
# Query rewriting before retrieval; false keeps today's behaviour and every switch below is inert while it is false
RAG_QUERY_LAYER=false
RAG_QUERY_FRAMEWORK=llamaindex
RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano
RAG_QUERY_CONDENSE=true
RAG_QUERY_EXPAND=true
RAG_QUERY_DECOMPOSE=true
RAG_QUERY_TRANSLATE=true
RAG_QUERY_DATE_NORMALIZE=true
RAG_QUERY_HYDE=false
RAG_QUERY_TRANSLATE_DISABLED_PROFILES=
RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates

# -----------------------------
# SEMANTIC CACHE
# -----------------------------
# Answer cache backend: off | pgvector | redisvl (REDIS_URL is read by the sidecar for redisvl only)
RAG_SEMANTIC_CACHE=off
RAG_SEMANTIC_CACHE_TTL=3600
RAG_SEMANTIC_CACHE_REFUSAL_TTL=600
RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05
RAG_SEMANTIC_CACHE_EMBED_STORE=false
REDIS_URL=

# -----------------------------
# INGESTION AND EMBEDDING PROFILES
# -----------------------------
# legacy keeps today's document writers; unified switches to the single ingest pipeline
RAG_INGEST_PIPELINE=legacy
# Document parser: llamaparse | docling
RAG_PARSER=llamaparse
# Time one request may wait for a sidecar parse job, in milliseconds (1000 to 55000)
RAG_PARSE_POLL_BUDGET_MS=45000
# Ask a model to detect the document type when rules are unsure: true | false
RAG_DOC_TYPE_LLM_DETECT=false
# Ask a model to extract invoice fields when rules find none: true | false
RAG_INVOICE_LLM_EXTRACT=false
# Look up exact identifiers (invoice numbers, contract ids) before vector search: true | false
RAG_EXACT_ID_LOOKUP=false
# Create image chunks from PDF pages: true | false
RAG_PDF_IMAGE_CHUNKS=false
# Prompt injection scan on ingested text: off | quarantine
RAG_INJECTION_SCAN=off
# Embedding profile registry: off | on (off keeps the single configured embedding model)
RAG_EMBEDDING_PROFILES=off
# Domain embedding leg for document types with an active binding: off | on (needs RAG_EMBEDDING_PROFILES=on)
RAG_DOMAIN_EMBEDDINGS=off
# Maximum domain embedding legs per query (0..5; 0 keeps bindings without extra legs)
RAG_DOMAIN_EMBEDDING_MAX_LEGS=2
# Timeout for one domain embedding leg in milliseconds (100..5000)
RAG_DOMAIN_EMBEDDING_TIMEOUT_MS=800
# Fallback host when the Qwen embedding provider is unavailable: openrouter | none
RAG_QWEN_EMBED_FALLBACK=openrouter
# Primary host for the Qwen embedding provider: deepinfra | openrouter (openrouter needs only OPENROUTER_API_KEY; the fallback then goes to DeepInfra when a key is set)
RAG_QWEN_EMBED_PRIMARY=deepinfra

# -----------------------------
# INGESTION (Phase 3.1 queue)
# -----------------------------
# Parse routing: fixed | tiered (tiered needs unified pipeline and async ingest)
RAG_PARSE_ROUTING=fixed
# Allow cloud parsers (LlamaParse and premium): true | false
RAG_PARSER_ALLOW_CLOUD=true
# Premium page budget per month for tiered routing (0 = unlimited reporting only)
RAG_PARSE_PREMIUM_PAGE_BUDGET=0
# Maximum premium pages per document under tiered routing
RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC=200
# Escalate failing page ranges one tier: on | off
RAG_PARSE_ESCALATION=on
# Vision-model page detection under tiered routing: true | false
RAG_PARSE_VLM_DETECT=false
# Vision model override (empty = image captioning model)
RAG_PARSE_VLM_MODEL=
# Queue ingestion jobs instead of inline processing: off | on (on needs unified pipeline)
RAG_INGEST_ASYNC=off
# Concurrent worker jobs (sidecar)
RAG_INGEST_WORKER_CONCURRENCY=2
# Terminal ingestion jobs older than this many days are archived and purged (maintenance task)
RAG_INGEST_JOB_RETENTION_DAYS=90
# Sidecar maintenance loop interval (seconds); off via RAG_INGEST_MAINTENANCE=off
RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS=3600
RAG_INGEST_MAINTENANCE=on
# Publish chunks incrementally while parsing: true | false
RAG_PARSE_PROGRESSIVE=false
# Embedding batch mode for backfill: sync | batch_api
RAG_EMBED_BATCH_MODE=sync
# Browser realtime job updates (Supabase broadcast): true | false
NEXT_PUBLIC_RAG_INGEST_REALTIME=false
# Ledger workers and the app must use the Supabase project HTTPS URL (PostgREST), never a direct Postgres DSN.

# -----------------------------
# LANGUAGES AND INGESTION HARDENING (Phase 3.2)
# -----------------------------
# Supported languages, comma-separated registry codes (e.g. zh,en,it). Empty = not configured; set them in the Languages panel
RAG_SUPPORTED_LANGUAGES=
# Primary language: one of RAG_SUPPORTED_LANGUAGES (empty = not configured)
RAG_PRIMARY_LANGUAGE=
# Language-aware chunking, sentence splitting and OCR: off | on
RAG_LANGUAGE_AWARE_INGEST=off
# Repeat table headers in split table chunks: profile | always
RAG_TABLE_HEADER_REPEAT=profile
# Add "column = value" lines per table row to the search text: true | false
RAG_TABLE_ROW_SERIALIZATION=false
# Image caption language: en | document
RAG_CAPTION_LANGUAGE=en
# BGE-M3 serving (Phase 3.2.1): hosted | sidecar
RAG_BGE_M3_SERVING=hosted
# Search-only translations of document chunks: off | on
RAG_DOC_TRANSLATION=off
# Translation model override (empty = RAG_QUERY_LLM_MODEL)
RAG_DOC_TRANSLATION_MODEL=
# Hidden text check at ingestion: off | flag | quarantine
RAG_HIDDEN_TEXT_CHECK=off
# Link check at ingestion against the allowlist: off | flag | quarantine
RAG_INGEST_LINK_CHECK=off
# Allowed link domains, comma-separated (subdomains included)
RAG_OUTPUT_LINK_ALLOWLIST=
# Uploads that need admin approval: off | members | all (needs the unified pipeline)
RAG_UPLOAD_APPROVAL=off
# Document scope tags at upload and in retrieval filters: true | false
RAG_SCOPE_TAGS=false
# Suggest scope tags for new documents: true | false
RAG_SCOPE_TAG_SUGGEST=false
# Detect possible older versions of new documents: off | on
RAG_SUPERSESSION_DETECT=off
# Exclude documents outside their effective dates from answers: true | false
RAG_EFFECTIVE_DATES=false
# Read effective dates with a model when rules find none: true | false
RAG_EFFECTIVE_DATE_LLM_EXTRACT=false

# Voyage embeddings
VOYAGE_API_KEY=
VOYAGE_BASE_URL=https://api.voyageai.com/v1
# DeepInfra embeddings (OpenAI-compatible)
DEEPINFRA_API_KEY=
DEEPINFRA_BASE_URL=https://api.deepinfra.com/v1/openai

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
