<objective>
Create a Claude Code skill called "yt-idea-mining" using the skill-creator skill (/skill-creator:skill-creator). This skill implements a YouTube Video Idea Mining pipeline that generates high-confidence video ideas by running parallel research agents, cross-referencing their signals, and producing a ranked Idea Mining Brief.

The skill must orchestrate a multi-agent pipeline with 4 distinct phases as described below. Go beyond basics — this should feel like a professional content strategist's research workflow, not a simple brainstorm list.
</objective>

<context>
This skill will be installed as a Claude Code skill (SKILL.md file) that users invoke when they need fresh YouTube video ideas grounded in real audience demand, competitor gaps, and trending topics.

The user provides their YouTube channel niche/topic area (e.g., "AI coding tools", "web development", "machine learning tutorials"). The skill then mines ideas from three signal sources using two parallel agents, scores and ranks them, and outputs a structured brief.

Use the skill-creator skill to build this. Invoke it with: /skill-creator:skill-creator
</context>

<pipeline_architecture>
The skill must implement this exact 4-phase pipeline:

## Phase 1: Input Gathering
Collect the user's channel context:
- Channel niche/topic area (required)
- Target audience description (optional, infer if not provided)
- Content style preferences (optional — tutorials, reviews, news, deep-dives, etc.)
- Any specific competitors to analyze (optional)
- Any topics to avoid (optional)

If the user provides minimal input (just a niche), infer reasonable defaults and proceed. Do NOT over-ask — get moving quickly.

## Phase 2: Parallel Agent Execution
Launch TWO sub-agents simultaneously using the Agent tool. These MUST run in parallel (not sequential):

### YT Agent (Sub-agent 1)
Purpose: Mine YouTube-specific signals from audience comments and competitor content.
Tools needed: WebSearch, WebFetch

Research tasks:
1. **Audience Comments Mining**: Search for YouTube comments on popular videos in the niche. Look for:
   - Questions viewers are asking ("How do I...", "Can you explain...", "What about...")
   - Frustrations and pain points ("I wish someone would...", "Nobody covers...")
   - Feature requests and suggestions ("You should make a video on...")
   - Debates and controversies in comments

2. **Competitor Video Analysis**: Search for recent videos from top creators in the niche. Identify:
   - What topics are getting high view counts relative to channel size
   - Content gaps — topics competitors haven't covered yet
   - Videos with high engagement (comments) vs views ratio (indicating strong audience interest)
   - Recurring series or formats that perform well
   - Titles and thumbnails patterns that drive clicks

Output: Structured list of signals with source attribution.

### Research Agent (Sub-agent 2)
Purpose: Mine broader trend signals from the web and social media.
Tools needed: WebSearch, WebFetch

Research tasks:
1. **Web Trend Signals**: Search for trending topics, news, and developments in the niche:
   - Recent product launches, updates, or announcements
   - Industry news and developments
   - New tools, frameworks, or technologies gaining traction
   - Upcoming events, conferences, or releases

2. **X/Twitter Trend Signals**: Search for what's being discussed on X/Twitter in the niche:
   - Viral posts and threads
   - Hot takes and debates
   - Memes and cultural moments related to the niche
   - Emerging hashtags and conversations

3. **Search Trend Signals**: Look for rising search queries and topics:
   - "How to" searches gaining volume
   - Comparison queries (X vs Y)
   - New terminology or concepts people are searching for

Output: Structured list of trend signals with recency and strength indicators.

## Phase 3: Scoring & Ranking
After both agents complete, cross-reference ALL signals to generate scored video ideas:

For each potential video idea, calculate a confidence score based on:
- **Demand signal strength** (1-5): How many independent sources suggest this topic? Comments + trends + competitor gaps all pointing to the same topic = high score
- **Timeliness** (1-5): Is this trending NOW or evergreen? Timely topics get a boost
- **Competition gap** (1-5): Are competitors NOT covering this yet? Bigger gap = higher score
- **Audience fit** (1-5): Does this match the user's channel niche and audience?
- **Content potential** (1-5): Can this be a compelling video? Is there enough depth?

**Overall confidence** = weighted average: Demand(30%) + Timeliness(20%) + Gap(20%) + Fit(15%) + Potential(15%)

Rank all ideas by overall confidence score, highest first.

## Phase 4: Idea Mining Brief Output
Produce a structured document saved to `./video-ideas-[date].md` containing:

### Brief Header
- Channel niche
- Date generated
- Number of ideas generated
- Research summary (what sources were mined)

### Top Ideas (ranked by confidence)
For each idea (aim for 8-15 ideas):
- **Title suggestion** (click-worthy but honest)
- **Confidence score** (overall + breakdown of 5 dimensions)
- **One-paragraph pitch**: What the video covers, why NOW, why the audience wants it
- **Evidence**: Which specific signals support this idea (with source references)
- **Content angle**: Suggested format (tutorial, review, comparison, news breakdown, etc.)
- **Thumbnail concept**: One-line thumbnail idea
- **Estimated competition level**: Low/Medium/High based on existing content

### Signal Appendix
Raw signals from both agents, organized by source, for the user to review if they want deeper context.
</pipeline_architecture>

<skill_requirements>
1. The skill MUST use the Agent tool to launch YT Agent and Research Agent in PARALLEL — this is the core architectural requirement from the diagram
2. The skill should use WebSearch and WebFetch for real-time research — no hallucinated data
3. Scoring must be transparent — show the breakdown, not just a final number
4. Output must be saved as a markdown file, not just printed to console
5. The skill should work for ANY YouTube niche, not just tech/AI
6. Keep the user informed with brief status updates at each phase transition
7. The skill should be invocable as a slash command (e.g., /yt-idea-mining)
8. Handle gracefully if web searches return limited results — note gaps honestly rather than fabricating signals
9. The entire pipeline should complete in a single skill invocation — no multi-step user interaction after initial input
</skill_requirements>

<implementation_notes>
When creating the skill with skill-creator:
- The skill file should go in `.claude/skills/yt-idea-mining.md`
- Use proper SKILL.md YAML frontmatter and XML structure
- The skill should specify Agent, WebSearch, WebFetch, Write as required tools
- Include clear instructions for the parallel agent orchestration pattern
- Make the scoring algorithm explicit and reproducible in the skill instructions
- The skill should produce output that's immediately actionable — a creator should be able to pick an idea and start scripting
</implementation_notes>

<success_criteria>
- Skill file created at `.claude/skills/yt-idea-mining.md`
- Skill correctly defines the 4-phase pipeline
- Parallel agent execution is explicitly specified (not sequential)
- Scoring algorithm is clearly defined with weights
- Output format is comprehensive and actionable
- Works for any YouTube niche provided by the user
- The skill can be invoked and tested end-to-end
</success_criteria>
