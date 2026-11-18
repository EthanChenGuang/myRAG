# Technical Research: AI-Native & Modern SaaS Payment Platforms

## Strategic Summary

The SaaS payments landscape has bifurcated into two tiers: **traditional processors with AI bolted on** (Stripe leading with its Agent Toolkit + Metronome acquisition) and **agent-native protocols** (x402, AP2) purpose-built for autonomous commerce. For cost-optimized SaaS subscriptions, **Polar.sh** offers the best value as a Merchant of Record (4% + $0.40 all-in vs Paddle's 5% + $0.50), while **Lago (self-hosted) + Stripe** gives the absolute lowest cost if you handle tax compliance yourself. For future-proofing with AI-agent capabilities, **Stripe's Agentic Commerce Suite** is the clear ecosystem winner.

**Recommendation for ChatRAG:** You already run Stripe + Polar -- this is near-optimal. Polar for MoR simplicity at the lowest fees; Stripe for its unmatched agentic commerce roadmap. The main decision is whether to consolidate onto one or keep both.

---

## Requirements (Derived from Context)
- SaaS subscription billing (recurring revenue)
- Cost efficiency as top priority
- AI-native/agent-friendly APIs preferred
- Already using Stripe + Polar (migration cost matters)
- Next.js 16 / React 19 stack (JS/TS SDK quality matters)

---

## Approach 1: Polar.sh (Cheapest MoR)

**How it works:** Polar acts as Merchant of Record -- you sell through them, they handle global tax collection/remittance, compliance, and disputes. You get payouts minus their fee. 6-line integration with native Next.js adapter.

**Libraries/tools:**
- `@polar-sh/nextjs` - Next.js adapter
- `@polar-sh/sdk` - TypeScript SDK
- Webhooks for subscription lifecycle events
- Built-in license key delivery, file downloads, benefits system

**Fees:**
| Component | Cost |
|---|---|
| Transaction fee | 4% + $0.40 |
| International cards | +1.5% (Stripe pass-through) |
| Sales tax/VAT | Included |
| Disputes | $15 per dispute |
| Monthly fees | $0 |

**Cost at scale:**
| MRR | Monthly cost |
|---|---|
| $1K | ~$76 |
| $10K | ~$760 |
| $100K | ~$7,600 |

**Pros:**
- Cheapest MoR by ~20% vs Paddle/Lemon Squeezy
- Full tax compliance included (EU VAT, US sales tax)
- Developer-first: 6-line integration, great docs
- Open-source ethos, GitHub-native community
- Product/license key management built-in
- No lock-in, no monthly fees

**Cons:**
- Card payments only (no PayPal, BNPL, regional methods)
- Younger platform, smaller ecosystem than Stripe/Paddle
- No AI agent toolkit or MCP server
- Limited checkout customization vs Stripe
- 120%+ MoM growth is promising but still early

**Best when:** You want the simplest, cheapest path to compliant global SaaS billing without worrying about tax filings.

**Complexity:** S (Small) -- minimal integration effort

---

## Approach 2: Stripe + Stripe Billing (Most AI-Native)

**How it works:** Stripe processes payments, Stripe Billing manages subscriptions/invoices/dunning, and the Agentic Commerce Suite enables AI agents to discover products and initiate payments programmatically.

**Libraries/tools:**
- `stripe` - Node.js SDK
- `@stripe/agent-toolkit` - AI agent SDK (works with Vercel AI SDK, LangChain, OpenAI Agents SDK, CrewAI)
- Stripe MCP Server - Model Context Protocol integration for Claude/Cursor
- Stripe Tax Complete - automated tax calculation + filing ($90/mo)
- Metronome (acquired Jan 2026) - usage-based metering (for future token/API billing)

**AI-Native Features:**
- **Agent Toolkit:** 15+ tool functions (create_customer, create_payment_link, list_invoices, etc.) callable by LLM agents
- **MCP Server:** Stripe operations as MCP tools for Claude, Cursor, Windsurf
- **Shared Payment Tokens (SPTs):** Agents can initiate payments using buyer permission without exposing credentials
- **Agentic Commerce Suite:** Products discoverable by AI agents, single integration for agentic payments
- **Metronome integration:** Metered billing for AI workloads (used by OpenAI, Anthropic, Nvidia)

**Fees:**
| Component | Cost |
|---|---|
| Card processing | 2.9% + $0.30 |
| International cards | +1.5% cross-border |
| Stripe Billing | +0.7% of recurring revenue |
| Stripe Tax Complete | $90/month + per-filing fees |
| ACH | 0.8% (capped $5) |
| Chargebacks | $15 per dispute |
| Currency conversion | 1% |

**Cost at scale (domestic cards + Billing):**
| MRR | Monthly cost |
|---|---|
| $1K | ~$66 (no tax) / ~$156 (with Tax Complete) |
| $10K | ~$660 / ~$750 |
| $100K | ~$6,600 / ~$6,690 |

**Note:** Stripe is NOT a Merchant of Record by default. The new **Stripe Managed Payments** (from Lemon Squeezy acquisition) adds MoR but is still in private preview and will add ~3.5% on top.

**Pros:**
- Best-in-class AI agent infrastructure (Agent Toolkit, MCP, SPTs)
- Largest payment ecosystem, most integrations
- Best SDK quality across all languages
- Metronome acquisition = best usage-based metering
- Future-proof: leading the agentic commerce standard
- You already have Stripe integrated

**Cons:**
- Not a MoR (you handle tax compliance, or pay $90/mo+ for Tax Complete)
- Total effective rate: 3.6% + $0.30 with Billing (higher than Polar's all-in rate)
- Billing fee increased from 0.5% to 0.7% in 2025
- Support quality drops at scale
- Stacking features (Billing + Tax + Revenue Recognition) gets expensive

**Best when:** You want the most powerful AI-agent payment infrastructure and plan to build agentic features into ChatRAG.

**Complexity:** M (Medium) -- more features to configure, tax is separate

---

## Approach 3: Lago (Self-Hosted) + Stripe Processing (Cheapest Absolute)

**How it works:** Lago is an open-source billing engine you self-host. It handles subscriptions, usage metering, invoicing, coupons, and credits. Stripe (or any processor) handles the actual payment collection. You pay zero platform fees -- only Stripe's processing fee.

**Libraries/tools:**
- `lago-ruby` / REST API - Lago server (Ruby/Rails, Docker-deployable)
- `stripe` - Payment processing only (no Billing addon needed)
- Lago handles: subscription lifecycle, usage events (15K events/sec), invoice generation, credit management, webhooks

**Fees:**
| Component | Cost |
|---|---|
| Lago (self-hosted) | $0 (MIT license) |
| Infrastructure | ~$50-200/month (Docker on any cloud) |
| Stripe processing only | 2.9% + $0.30 |
| Tax compliance | You handle it (or add Stripe Tax) |

**Cost at scale:**
| MRR | Monthly cost |
|---|---|
| $1K | ~$79 + infra ($50) = ~$129 |
| $10K | ~$590 + infra ($100) = ~$690 |
| $100K | ~$5,200 + infra ($200) = ~$5,400 |

**Pros:**
- Lowest total cost at scale (saves $1,200-2,200/month at $100K MRR vs MoR alternatives)
- Full control over billing logic
- Open source (MIT), no vendor lock-in
- Event-based architecture ideal for metering AI token usage
- 15K billing events/second ingestion capacity
- No percentage-of-revenue platform fees

**Cons:**
- You handle tax compliance (significant burden for global SaaS)
- Self-hosting requires DevOps effort
- No MoR protection (you're liable for chargebacks, fraud)
- Smaller community than Stripe Billing
- No AI agent toolkit
- Two systems to maintain (Lago + Stripe)

**Best when:** You have DevOps capacity, sell primarily in one tax jurisdiction, and want maximum cost efficiency at scale.

**Complexity:** L (Large) -- self-hosting, tax compliance, two-system integration

---

## Approach 4: Paddle (Simplest Premium MoR)

**How it works:** Paddle is a mature Merchant of Record. One flat fee covers everything: payment processing, tax, chargebacks, fraud, currency conversion. Zero surprise costs.

**Libraries/tools:**
- `@paddle/paddle-node-sdk` - Node.js SDK
- `paddle.js` - Client-side checkout overlay
- Paddle Retain - churn reduction / smart dunning
- ProfitWell (acquired) - subscription analytics

**Fees:**
| Component | Cost |
|---|---|
| All transactions | 5% + $0.50 |
| International cards | Included |
| Tax handling | Included |
| Chargebacks | Included |
| Currency conversion | Included |
| Monthly fees | $0 |

**Cost at scale:**
| MRR | Monthly cost |
|---|---|
| $1K | ~$100 |
| $10K | ~$1,000 |
| $100K | ~$10,000 |

**Pros:**
- Truly all-inclusive pricing -- no hidden costs
- Most mature MoR for SaaS
- Zero tax compliance burden
- ProfitWell analytics included
- Enterprise custom rates available for high volume

**Cons:**
- Most expensive option (5% + $0.50)
- No AI agent features whatsoever
- Opinionated checkout overlay (less customizable)
- At $100K MRR, costs $2,400/month more than Polar
- Less developer-focused than Stripe or Polar

**Best when:** You want zero operational overhead on payments/tax and don't mind paying a premium for total simplicity.

**Complexity:** S (Small) -- easiest integration, everything handled

---

## Approach 5: Stripe + Nevermined/x402 (Agent-to-Agent Future)

**How it works:** Use Stripe for human-facing SaaS subscriptions, and layer Nevermined's x402 protocol for AI-agent-to-agent micropayments. x402 uses HTTP 402 status codes for instant stablecoin settlements on Base L2.

**Libraries/tools:**
- `stripe` + `@stripe/agent-toolkit` - Human-facing payments + AI agent toolkit
- x402 protocol SDK - Agent-to-agent payments via HTTP headers
- Coinbase CDP Wallets - Non-custodial agent wallets
- ERC-4337 smart accounts - Subscriptions, credits, delegated payments for agents
- Google AP2 protocol - Open standard (Apache 2.0) with 60+ partners

**Fees:**
| Component | Cost |
|---|---|
| Stripe (human payments) | 2.9% + $0.30 |
| x402 protocol fee | ~$0.0001 per transaction |
| Base L2 gas | Near-zero |
| Coinbase CDP | Free tier available |

**Emerging Ecosystem:**
- **Google AP2:** Open payment protocol for agents with Verifiable Digital Credentials (60+ partners: PayPal, Coinbase, Mastercard, Amex)
- **Mastercard Agent Pay:** Agent payment verification
- **Coinbase Agentic Wallets:** Agents hold funds, trade, earn yield autonomously
- **PayPal ACP:** Agent Checkout Protocol for ChatGPT
- **InFlow:** "PayPal for AI agents" (launched Dec 2025)
- **Sapiom:** $15M seed for agent financial infrastructure

**Pros:**
- Near-zero fees for agent-to-agent transactions
- Future-proof for agentic commerce explosion ($1.7T market by 2030)
- Open protocols (x402, AP2) avoid vendor lock-in
- Coinbase wallets handle security (keys never exposed to LLM)
- Could monetize ChatRAG's AI capabilities to other agents

**Cons:**
- Bleeding edge -- protocols still maturing
- Crypto/stablecoin complexity
- Regulatory uncertainty
- Small user base currently
- Two separate payment systems to maintain
- Not needed unless building agent-to-agent features

**Best when:** You're building features where AI agents pay for services autonomously, or want to make ChatRAG's capabilities purchasable by other AI agents.

**Complexity:** L (Large) -- emerging tech, crypto integration, dual payment systems

---

## Comparison

| Aspect | Polar.sh | Stripe + Billing | Lago + Stripe | Paddle | x402/Agent-Native |
|--------|----------|-----------------|--------------|--------|------------------|
| **Monthly cost @ $10K MRR** | $760 | $660-750 | $590-690 | $1,000 | $590 + setup |
| **Tax/MoR included** | Yes | No (+$90/mo) | No | Yes | No |
| **AI agent features** | None | Best-in-class | None | None | Agent-native |
| **Integration complexity** | Simple (6 lines) | Medium | Large | Simple | Large |
| **Checkout customization** | Limited | Full | Full | Opinionated | N/A |
| **Future-proofing** | Good | Excellent | Good | OK | Cutting-edge |
| **DevOps burden** | None | Low | High | None | High |
| **TypeScript SDK quality** | Good | Excellent | REST API | Good | Emerging |

### Cost at Scale (Domestic, Monthly)

| MRR | Polar | Stripe+Billing+Tax | Lago+Stripe | Paddle |
|-----|-------|-------------------|-------------|--------|
| $1K | $76 | $156 | $129 | $100 |
| $10K | $760 | $750 | $690 | $1,000 |
| $100K | $7,600 | $6,690 | $5,400 | $10,000 |

---

## Recommendation

**For ChatRAG's current state: Keep Stripe + Polar (your existing setup is near-optimal).**

Here's why:

1. **Polar** handles MoR/tax at the lowest available fee (4% + $0.40), saving you ~$2,400/month vs Paddle at $100K MRR
2. **Stripe** gives you the best AI-agent infrastructure (Agent Toolkit, MCP Server, SPTs) as you build agentic features into ChatRAG
3. **No migration cost** -- you already have both integrated

**Optimization path:**
- **Now:** Use Polar for subscription checkout (lower fees, tax handled)
- **Now:** Add Stripe Agent Toolkit to expose ChatRAG billing to AI agents
- **Soon:** Watch Stripe Managed Payments (MoR) -- when it exits preview, evaluate consolidating from Polar
- **Future:** Monitor x402/AP2 protocols if you want ChatRAG's RAG capabilities purchasable by other AI agents

**If starting fresh and had to pick one:** Polar for simplicity + cost, or Stripe for ecosystem + AI features. The combo of both is ideal.

---

## Implementation Context

<claude_context>
<chosen_approach>
- name: Optimized Stripe + Polar (existing stack)
- libraries:
  - @polar-sh/nextjs (latest) - checkout, webhooks
  - @polar-sh/sdk (latest) - subscription management
  - stripe (latest) - payment processing
  - @stripe/agent-toolkit (latest) - AI agent integration
- install: npm install @stripe/agent-toolkit @polar-sh/nextjs @polar-sh/sdk
</chosen_approach>
<architecture>
- pattern: Dual-provider with MoR primary (Polar) + Agent layer (Stripe)
- components:
  - Polar checkout for human subscriptions (tax-compliant)
  - Stripe Agent Toolkit for programmatic/agentic billing
  - Webhook handlers for both providers
  - Unified subscription state in Supabase
- data_flow: User -> Polar Checkout -> Polar Webhook -> Supabase subscription record; AI Agent -> Stripe Agent Toolkit -> Stripe API -> Supabase billing record
</architecture>
<files>
- create:
  - src/lib/payments/agent-toolkit.ts (Stripe Agent Toolkit setup)
  - src/app/api/agents/billing/route.ts (agent-facing billing endpoint)
- modify:
  - src/app/api/webhooks/route.ts (ensure Polar webhook handling)
  - src/app/api/webhooks/stripe/route.ts (agent billing events)
- reference:
  - src/app/api/create-checkout/route.ts (existing Polar integration)
  - src/app/api/create-stripe-checkout/route.ts (existing Stripe integration)
  - src/app/pricing/page.tsx (existing pricing page)
  - src/app/pricing-stripe/page.tsx (existing Stripe pricing)
</files>
<implementation>
- start_with: Add @stripe/agent-toolkit to expose billing operations to AI agents
- order:
  1. Install @stripe/agent-toolkit
  2. Create agent toolkit configuration with scoped permissions
  3. Expose agent-facing billing endpoint
  4. Add MCP server configuration for Stripe
  5. Test agent-initiated subscription flows
- gotchas:
  - Stripe Agent Toolkit requires restricted API keys (rk_*), not secret keys
  - Polar webhooks need signature verification (different from Stripe's)
  - Keep subscription state synchronized between both providers in Supabase
  - Stripe Billing's 0.7% fee only applies if you use Stripe for subscriptions (not needed if Polar handles subs)
- testing:
  - Use Stripe test mode + Polar sandbox
  - Test agent toolkit with mock LLM calls
  - Verify webhook idempotency
  - Test subscription lifecycle (create, upgrade, cancel, refund)
</implementation>
</claude_context>

---

## Sources

### Platform Pricing & Features
- [Stripe Pricing](https://stripe.com/pricing) - accessed Mar 2026
- [Stripe Billing Pricing](https://stripe.com/billing/pricing) - accessed Mar 2026
- [Stripe Tax Pricing](https://stripe.com/tax/pricing) - accessed Mar 2026
- [Polar.sh Pricing](https://polar.sh/resources/pricing) - accessed Mar 2026
- [Polar vs Stripe](https://polar.sh/resources/comparison/stripe) - accessed Mar 2026
- [Polar vs Lemon Squeezy](https://polar.sh/resources/comparison/lemon-squeezy) - accessed Mar 2026
- [Paddle Pricing](https://www.paddle.com/pricing) - accessed Mar 2026
- [Lago Pricing](https://getlago.com/pricing) - accessed Mar 2026
- [Orb Pricing](https://www.withorb.com/pricing) - accessed Mar 2026
- [Whop Fees](https://docs.whop.com/fees) - accessed Mar 2026
- [Stigg Pricing](https://www.stigg.io/pricing) - accessed Mar 2026

### AI-Native & Agentic Commerce
- [Stripe Agentic Commerce Suite](https://stripe.com/blog/agentic-commerce-suite) - accessed Mar 2026
- [Stripe Agent Toolkit GitHub](https://github.com/stripe/agent-toolkit) - accessed Mar 2026
- [Stripe MCP Documentation](https://docs.stripe.com/mcp) - accessed Mar 2026
- [Stripe Agents Documentation](https://docs.stripe.com/agents) - accessed Mar 2026
- [Stripe Acquires Metronome](https://stripe.com/blog/metronome-stripe-building-the-future-of-billing) - accessed Mar 2026
- [Google AP2 Protocol](https://ap2-protocol.org/specification/) - accessed Mar 2026
- [Google AP2 GitHub](https://github.com/google-agentic-commerce/AP2) - accessed Mar 2026
- [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets) - accessed Mar 2026
- [x402 Protocol](https://docs.cdp.coinbase.com/x402/welcome) - accessed Mar 2026
- [Mastercard Agent Pay](https://www.mastercard.com/global/en/news-and-trends/press/2025/april/) - accessed Mar 2026
- [PayPal Agentic Commerce](https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services) - accessed Mar 2026

### Cost Comparisons & Reviews
- [Stripe Fees 2026 (WeAreFounders)](https://www.wearefounders.uk/a-guide-to-stripe-fees-in-2025-what-founders-need-to-know/) - accessed Mar 2026
- [Stripe Billing Price Increase (Wingback)](https://www.wingback.com/blog/stripe-billing-price-increase) - accessed Mar 2026
- [Payment Processor Fees Compared (UserJot)](https://userjot.com/blog/stripe-polar-lemon-squeezy-gumroad-transaction-fees) - accessed Mar 2026
- [MoR Comparison 2025 (DevMystify)](https://devmystify.com/blog/choosing-a-merchant-of-record-in-2025-lemon-squeezy-vs-paddle-vs-dodo-payments-my-experience) - accessed Mar 2026
- [Why Stripe Paid $1B for Metronome (Lago)](https://getlago.com/blog/why-stripe-paid-1b-for-metronome-instead-of-fixing-billing) - accessed Mar 2026
- [AI Agent Payment Statistics (Nevermined)](https://nevermined.ai/blog/ai-agent-payment-statistics) - accessed Mar 2026
- [Agentic Payments (AWS)](https://aws.amazon.com/blogs/industries/agentic-payments-the-next-evolution-in-the-payments-value-chain/) - accessed Mar 2026

### Emerging Platforms
- [InFlow AI Agent Payments](https://entrepreneurloop.com/inflow-ai-agent-payments-autonomous-commerce-platform/) - accessed Mar 2026
- [Sapiom $15M Raise](https://www.techbuzz.ai/articles/sapiom-lands-15m-to-build-payment-rails-for-ai-agents) - accessed Mar 2026
- [Dodo Payments](https://dodopayments.com/) - accessed Mar 2026
- [Nevermined x402](https://nevermined.ai/blog/x402-ai-agent-billing) - accessed Mar 2026
- [Lemon Squeezy 2026 Update](https://www.lemonsqueezy.com/blog/2026-update) - accessed Mar 2026
