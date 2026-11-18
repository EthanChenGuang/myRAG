# Workflow: Modify Existing Code

<required_reading>
Read the reference most relevant to the modification area:
- `references/architecture.md` (always useful for context)
- Plus the specific area reference (api-endpoints, stores, components, etc.)
</required_reading>

<process>

## Step 1: Understand the Modification

Clarify:
- What needs to change?
- Which file(s) are affected?
- Is this a bug fix, enhancement, or refactor?

## Step 2: Map Dependencies

Before modifying, identify what depends on the target:

**If modifying a store:**
- Which components subscribe to it? (search for store import)
- Does the shape change affect localStorage persistence?
- Are there any store migration concerns?

**If modifying an API route:**
- What frontend code calls this route?
- Does the request/response shape change?
- Are there webhook consumers?

**If modifying a lib module:**
- Which API routes import it?
- Which other lib modules depend on it?
- Is it a singleton that other code references?

**If modifying a component:**
- What parent components render it?
- What props does it receive?
- What stores/providers does it use?

**If modifying env/config:**
- Is this part of the 5-file model sync?
- Does `init-env.js` need updating?
- Does `env.ts` need updating?

## Step 3: Check Cross-Cutting Concerns

| Concern | Check |
|---------|-------|
| Multi-tenant | Does the change respect org isolation? |
| RLS | Will Supabase policies still work? |
| Streaming | Does the change affect streaming responses? |
| 5-file sync | Are model definitions still synchronized? |
| RAG prompt | Is `{{context}}` placeholder preserved? |
| Ghost mode | Does the change work without persistence? |
| Mobile | Does the UI work on mobile? |

## Step 4: Make the Change

Follow these principles:
1. **Minimal diff** - Change only what's necessary
2. **Match existing patterns** - Don't introduce new conventions
3. **Type safety** - Update TypeScript interfaces if shapes change
4. **Error handling** - Follow existing patterns in the file
5. **No log spam** - Use SmartLogger with deduplication

## Step 5: Verify

After making changes:
1. Check TypeScript: no type errors in modified files
2. Check related files: imports still valid
3. Check env: if env vars changed, update init-env.js + env.ts
4. Check stores: if store shape changed, consider localStorage migration
5. Suggest testing approach based on what changed

</process>

<high_risk_modifications>

## High-Risk Areas (Extra Caution)

| Area | Risk | Why |
|------|------|-----|
| `src/app/api/chat/route.ts` | Breaks all chat | Core streaming endpoint |
| `src/lib/env.ts` | Breaks environment | All config depends on this |
| `src/lib/supabase.ts` | Breaks data layer | All CRUD through this |
| `src/lib/chat-store.ts` | Breaks UI state | Primary store, many subscribers |
| `RAG_SYSTEM_PROMPT` | Breaks RAG | Must keep `{{context}}` placeholder |
| `scripts/init-env.js` | Breaks new installs | Source of truth for defaults |
| Model definitions | Breaks model selector | 5-file sync required |
| RLS policies | Data leaks or blocks | Security critical |
| `src/app/page.tsx` | Breaks main interface | Core chat page |

</high_risk_modifications>

<success_criteria>
- Dependencies mapped before making changes
- Cross-cutting concerns checked
- Change follows existing patterns
- Related files updated (env, types, etc.)
- Verification steps completed
</success_criteria>
