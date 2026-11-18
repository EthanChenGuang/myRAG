<objective>
Create a comprehensive Claude Code SKILL.md file called "chatrag-expert" that gives Claude instant, deep expertise about the ChatRAG codebase. This skill eliminates the need to re-analyze the codebase in every new conversation.

The skill must contain pre-baked architectural knowledge - every key file, data flow, pattern, convention, and integration detail embedded directly so Claude can answer questions, diagnose issues, plan features, and debug problems immediately without reading files first.

Go beyond the basics. This should be the most thorough codebase knowledge map possible - covering architecture, data flows, state management patterns, API contracts, database schema, RAG pipeline internals, and integration points.
</objective>

<context>
This is a Next.js 16 + React 19 app called ChatRAG - a production AI chat experience with RAG, multi-model orchestration, and multi-modal generation.

The skill file will be saved to `.claude/skills/chatrag-expert.md` in the local project directory. It will be used as a Claude Code skill that can be activated to give Claude instant expertise about this specific codebase.

Read CLAUDE.md first for project conventions and high-level architecture.
</context>

<research>
Thoroughly analyze the ENTIRE codebase to build comprehensive knowledge. For maximum efficiency, perform multiple independent file reads and searches simultaneously rather than sequentially.

Phase 1 - Map the architecture:
1. Read `CLAUDE.md` for project rules and conventions
2. Read `package.json` for all dependencies and scripts
3. Read `next.config.ts` or `next.config.js` for build configuration
4. Read `tsconfig.json` for TypeScript setup
5. Glob `src/app/**/*.{ts,tsx}` to map all routes and pages
6. Glob `src/app/api/**/*.ts` to map all API endpoints
7. Glob `src/lib/**/*.ts` to map all library modules
8. Glob `src/components/**/*.tsx` to map all components

Phase 2 - Deep dive into each layer (read key files in each area):

**API Routes** - Read every file in `src/app/api/` to understand:
- Request/response contracts
- Authentication patterns
- Error handling conventions
- Streaming implementation details

**Library Layer** - Read every file in `src/lib/` to understand:
- AI provider configuration and model routing
- RAG pipeline (embedding, chunking, retrieval, reranking)
- MCP router and tool execution
- Zustand store definitions and patterns
- Utility functions and shared helpers
- Database client and query patterns

**Components** - Read key component files to understand:
- Chat interface architecture
- State management patterns (Zustand usage, selectors, useShallow)
- UI component library and conventions
- Modal/dialog patterns
- Form handling patterns

**Scripts** - Read files in `scripts/` to understand:
- Environment initialization
- Configuration dashboard
- RAG diagnostic tools
- Database setup

Phase 3 - Map data flows:
- Trace the complete chat message flow: user input → API route → AI provider → streaming response → UI update
- Trace the RAG flow: document upload → chunking → embedding → storage → retrieval → context injection
- Trace authentication flow: login → session → RLS → protected routes
- Map Zustand store interactions: which stores exist, what they hold, how components subscribe

Phase 4 - Identify patterns and conventions:
- Error handling patterns
- TypeScript conventions (interfaces, types, generics)
- API response formats
- Environment variable management
- File naming conventions
- Import patterns

After receiving all research results, carefully reflect on the findings to ensure nothing critical is missed before proceeding to skill creation.
</research>

<requirements>
The SKILL.md file must follow Claude Code skill conventions and contain these sections:

1. **Skill metadata** - Name, description, trigger conditions
2. **Architecture Overview** - High-level system diagram in text, all layers and their relationships
3. **Directory Map** - Every significant directory with its purpose and key files
4. **API Endpoints Reference** - Every API route with its method, purpose, auth requirements, request/response shape
5. **Library Modules Reference** - Every module in src/lib/ with its exports, purpose, and usage patterns
6. **Component Architecture** - Key components, their props, state management, and composition patterns
7. **Data Flows** - Complete traced flows for chat, RAG, auth, and generation pipelines
8. **Database Schema** - Tables, relationships, RLS policies, vector indexes
9. **State Management** - All Zustand stores, their shape, selectors, and which components use them
10. **AI/Model Configuration** - All supported models, providers, routing logic, the 5-file sync requirement
11. **RAG Pipeline Internals** - Chunking strategy, embedding model, vector search params, prompt templates
12. **Integration Points** - WhatsApp, Stripe/Polar, MCP, external AI services
13. **Environment Variables** - All env vars grouped by feature, with descriptions
14. **Common Patterns** - Recurring code patterns with examples (streaming, error handling, auth checks)
15. **Debugging Guide** - Common issues and where to look, diagnostic scripts, log locations
16. **Testing Approach** - How to verify changes, available test scripts

Each section should contain enough detail that Claude can answer specific questions without needing to read the actual files. Include actual type definitions, function signatures, and code snippets where they add clarity.
</requirements>

<implementation>
Structure the skill file as a proper Claude Code SKILL.md with:

```markdown
---
name: chatrag-expert
description: Instant deep expertise on the ChatRAG codebase - architecture, patterns, data flows, debugging
---

# ChatRAG Codebase Expert

[All sections with pre-baked knowledge here]
```

Important conventions to follow:
- Use markdown headers for clear navigation
- Include actual TypeScript interfaces and type definitions from the codebase - because having the real types lets Claude reason about the code without reading files
- Include actual file paths (relative from project root) - because specific paths let Claude point users to exact locations
- Document the WHY behind architectural decisions, not just the WHAT - because understanding intent helps with future modifications
- Include common gotchas and foot-guns - because preventing mistakes is more valuable than documenting happy paths
- Keep the content dense but scannable - use tables, code blocks, and bullet points rather than prose paragraphs
</implementation>

<output>
Create the skill file at:
- `./.claude/skills/chatrag-expert.md` - The complete SKILL.md with all pre-baked codebase knowledge

This single file should be comprehensive enough that when activated, Claude can:
- Answer any architectural question about the codebase
- Know exactly which files to modify for any feature or fix
- Understand all data flows without tracing them
- Debug issues by knowing common failure points
- Plan new features that align with existing patterns
- Understand the full dependency graph between modules
</output>

<verification>
Before declaring complete, verify your work:
1. Every directory under `src/` is documented with its purpose
2. Every API route is listed with its contract
3. Every Zustand store is documented with its shape
4. All environment variables are cataloged
5. The RAG pipeline is fully traced from document upload to context injection
6. The chat flow is fully traced from user input to streamed response
7. Common debugging scenarios are covered
8. The skill file is valid markdown that follows SKILL.md conventions
9. The file is saved to `.claude/skills/chatrag-expert.md`
</verification>

<success_criteria>
- Skill file exists at `.claude/skills/chatrag-expert.md`
- File contains all 16 required sections with substantive content (not placeholders)
- Actual TypeScript types and interfaces from the codebase are embedded
- Actual file paths are accurate and complete
- Data flows are traced end-to-end with specific file references
- A developer asking "how does X work?" for any major feature would get an accurate answer from the skill content alone
- The skill follows Claude Code SKILL.md format conventions
</success_criteria>
