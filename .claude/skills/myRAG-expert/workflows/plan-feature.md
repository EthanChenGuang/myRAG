# Workflow: Plan New Features

<required_reading>
**Always read:** `references/architecture.md`

Then based on feature area:
- UI feature → `references/components.md`, `references/stores.md`
- API feature → `references/api-endpoints.md`
- RAG feature → `references/rag-pipeline.md`
- Database feature → `references/database.md`
- Integration → `references/integrations.md`
- Config feature → `references/environment.md`, `references/ai-models.md`
</required_reading>

<process>

## Step 1: Understand the Feature

Clarify with the user:
- What should the feature do?
- Who is it for? (all users, admins, specific deployment mode)
- Does it touch existing systems or is it greenfield?

## Step 2: Map Affected Layers

Using architecture knowledge, identify which layers are affected:

```
Frontend changes needed?
  → New component in src/components/ui/
  → New/modified store in src/lib/
  → New provider needed?
  → Which existing components need updates?

API changes needed?
  → New route in src/app/api/
  → Auth requirements (session, admin, public?)
  → Streaming response needed?

Library changes needed?
  → New module in src/lib/
  → Modify existing processor/retrieval?
  → New integration client?

Database changes needed?
  → New table or columns?
  → New RLS policies?
  → New indexes?
  → Migration strategy?

Configuration changes needed?
  → New env vars? (add to init-env.js + env.ts)
  → 5-file model sync update?
  → Config dashboard update?
```

## Step 3: Design with Existing Patterns

Recommend patterns based on codebase conventions:

**New API route:**
- Create `src/app/api/{name}/route.ts`
- Follow existing auth patterns: Supabase session check for multi-tenant, public for single-tenant
- Return structured JSON errors: `{ error: string, details?: string }`
- Use streaming for AI responses: `streamText()` from AI SDK
- Validate inputs with Zod

**New Zustand store:**
- Create in `src/lib/` or `src/lib/stores/`
- Use `create()` from zustand
- Always use `useShallow` in components
- Persist to localStorage if user preference
- Persist to Supabase if cross-session data

**New UI component:**
- Create in `src/components/ui/`
- Functional component, TypeScript
- Tailwind CSS for styling
- Radix UI for accessible primitives
- Framer Motion for animations
- Use `cn()` from `src/lib/utils.ts` for class merging

**New database table:**
- Add to both SQL files: `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`
- Include RLS policies
- Add appropriate indexes
- Include `organization_id` for multi-tenant support

**New env variable:**
- Add to `scripts/init-env.js` (with default)
- Add to `src/lib/env.ts` (with fallback)
- Prefix with `NEXT_PUBLIC_` if needed client-side

## Step 4: Identify Dependencies & Risks

Flag potential issues:
- Will this affect the 5-file model sync?
- Does it touch the RAG `{{context}}` pipeline?
- Does it need multi-tenant support?
- Will it affect existing streaming behavior?
- Does it change store shapes (breaking localStorage)?

## Step 5: Propose Implementation Plan

Provide ordered implementation steps:
1. Database changes (if any)
2. Library module (new or modified)
3. API route
4. Store (if new state needed)
5. UI components
6. Environment variables
7. Testing/verification

</process>

<conventions_checklist>

## Conventions to Follow

- [ ] Functional React, strict TypeScript
- [ ] Tailwind classes (not CSS modules)
- [ ] Zustand with `useShallow` selectors
- [ ] Structured JSON error responses from API
- [ ] Streaming for AI responses
- [ ] RLS policies on any new tables
- [ ] `organization_id` support for multi-tenant
- [ ] Env vars in `init-env.js` + `env.ts`
- [ ] Minimal comments, only when non-obvious
- [ ] No secrets in code (env vars only)

</conventions_checklist>

<success_criteria>
- All affected layers identified
- Implementation uses existing patterns
- Dependencies and risks flagged
- Ordered implementation plan provided
- Convention checklist reviewed
</success_criteria>
