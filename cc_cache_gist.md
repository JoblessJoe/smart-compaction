# How does Claude Code Prompt Cache & Compact Works

This document describes how Claude Code manages Anthropic's prompt cache, performs context compaction (summarization) without losing user task context, and structures its system prompt for maximum cache efficiency.

### Big-Picture Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         CLAUDE CODE TURN LIFE CYCLE                      │
│                                                                          │
│  ┌──────────────┐    ┌──────────────────┐    ┌─────────────────────────┐ │
│  │ Build System │    │  Place Cache     │    │  Send to Anthropic API  │ │
│  │ Prompt       │───▶│  Markers         │───▶│                         │ │
│  │              │    │  (system+tools+  │    │  ┌───────────────────┐  │ │
│  │ static ─┐    │    │   last message)  │    │  │ Server computes   │  │ │
│  │ dynamic ┘    │    └──────────────────┘    │  │ cache key from:   │  │ │
│  └──────────────┘                            │  │ sys+tools+model+  │  │ │
│                                              │  │ msgs+thinking     │  │ │
│  ┌──────────────┐                            │  └──────┬────────────┘  │ │
│  │ Auto-Compact │◀── token count high?       │         │               │ │
│  │ (if needed)  │                            │    ┌────▼────────────┐  │ │
│  │              │                            │    │ CACHE HIT?      │  │ │
│  │ fork shares  │                            │    │  YES → ~free    │  │ │
│  │ parent cache │                            │    │  NO  → full cost│  │ │
│  └──────┬───────┘                            │    └────┬────────────┘  │ │
│         │                                    │         │               │ │
│         │  summary replaces old messages     │    ┌────▼────────────┐  │ │
│         │  + restores file/plan/skill state  │    │ Return response │  │ │
│         │                                    │    │ + usage stats   │  │ │
│         ▼                                    │    └────┬────────────┘  │ │
│  ┌──────────────┐                            │         │               │ │
│  │ Compact      │                            │    ┌────▼────────────┐  │ │
│  │ Boundary Msg │                            │    │ Detect Cache    │  │ │
│  │ marks split  │                            │    │ Break?          │  │ │
│  └──────────────┘                            │    │ WHY? → log      │  │ │
│                                              │    └─────────────────┘  │ │
│                                              └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [System Prompt Architecture](#1-system-prompt-architecture)
2. [Prompt Cache Design](#2-prompt-cache-design)
3. [Compaction Design](#3-compaction-design)
4. [How Compaction Preserves User Task Context](#4-how-compaction-preserves-user-task-context)
5. [Cache Break Detection](#5-cache-break-detection)

---

## 1. System Prompt Architecture

### 1.1 Static vs Dynamic Split

The system prompt is built as an array of strings in `src/constants/prompts.ts`, divided by a boundary marker:

```
SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

```
                    SYSTEM PROMPT BLOCKS & CACHE SCOPES
                    ===================================

  Block[0]   "x-anthropic-billing-header: ..."                cache: NONE  (varies per req)
  Block[1]   "You are an interactive agent..."                cache: NONE  (CLI prefix)
  ───────────────────────────────────────────────────────────────────────────────────────────
  Block[2]   "# System\n - All text you output..."            cache: GLOBAL *
  Block[3]   "# Doing tasks\n - The user will..."             cache: GLOBAL *
  Block[4]   "# Executing actions with care..."               cache: GLOBAL *   STATIC
  Block[5]   "# Using your tools\n - Do NOT..."               cache: GLOBAL *  (shared
  Block[6]   "# Tone and style\n - Only use..."               cache: GLOBAL *  across orgs)
  Block[7]   "# Output efficiency\n - IMPORTANT..."           cache: GLOBAL *
  ───────────────────────────────────────────────────────────────────────────────────────────
  Block[8]   "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"             cache: N/A  <- MARKER
  ───────────────────────────────────────────────────────────────────────────────────────────
  Block[9]   "# Session-specific guidance\n - If..."          cache: ORG DYNAMIC
  Block[10]  "# Environment\n - Working dir: ..."             cache: ORG  (per-user/
  Block[11]  "# Language\n - Always respond in..."            cache: ORG per-session)
  Block[12]  "<MCP server instructions...>"                   cache: ORG
  ... more dynamic sections ...

  * GLOBAL = all users across all orgs share this cached prefix
    ORG    = only this org's users share this prefix
    NONE   = never cached
```

**Before the boundary (static, globally cacheable):**
1. `getSimpleIntroSection()` — Identity framing: "You are Claude Code, Anthropic's official CLI..."
2. `getSimpleSystemSection()` — System rules: monospace rendering, permission model, hooks, automatic compression
3. `getSimpleDoingTasksSection()` — Task execution guidance: code style, avoiding speculation, verification
4. `getActionsSection()` — Risk assessment for irreversible actions (git push, deletes, PRs)
5. `getUsingYourToolsSection(enabledTools)` — Tool usage guidance: prefer dedicated tools over Bash, parallel calls
6. `getSimpleToneAndStyleSection()` — Tone rules: no emojis, file:line references, GitHub issue format
7. `getOutputEfficiencySection()` — Output conciseness rules

**After the boundary (dynamic, session-specific):**
- `getSessionSpecificGuidanceSection()` — AskUserQuestion usage, agent tool guidance, skill discovery
- `loadMemoryPrompt()` — CLAUDE.md / project memory files
- `computeSimpleEnvInfo()` — Working directory, git status, OS, shell, model info
- `getLanguageSection()` — User's language preference
- `getOutputStyleSection()` — Custom output styles
- `getMcpInstructionsSection()` — MCP server instructions
- `getScratchpadInstructions()` — Scratchpad directory path
- `getFunctionResultClearingSection()` — FRC awareness
- Numeric length anchors, token budget, brief/proactive sections

### 1.2 Section Memoization

Dynamic sections use a registry (`src/constants/systemPromptSections.ts`):

```typescript
// Cached until /clear or /compact
systemPromptSection('memory', () => loadMemoryPrompt())

// Recomputes every turn — WILL break prompt cache when value changes
DANGEROUS_uncachedSystemPromptSection('mcp_instructions', ..., 'MCP servers connect/disconnect between turns')
```

- `systemPromptSection()`: Computed once, cached until `/clear` or `/compact`. These sections are safe — they don't change between turns.
- `DANGEROUS_uncachedSystemPromptSection()`: Recomputes every turn. If the output changes from the previous turn, the system prompt hash changes and the prompt cache is invalidated. The `_reason` parameter forces developers to document why this is necessary.

### 1.3 Global Cache Scope

For first-party (Anthropic) users, the static portion of the system prompt is cached **globally** across organizations:

```typescript
// src/utils/api.ts — splitSysPromptPrefix()
function splitSysPromptPrefix(systemPrompt, options?) {
  // With global cache feature + no MCP:
  // → returns 4 blocks:
  //   [0] Attribution header         → cacheScope: null   (no caching)
  //   [1] CLI system prompt prefix   → cacheScope: null   (no caching)
  //   [2] Static content (pre-boundary) -> cacheScope: 'global'
  //   [3] Dynamic content (post-boundary) → cacheScope: null
}
```

The `cache_control: { type: 'ephemeral', scope: 'global' }` on block [2] means **every user across every org shares the same cached static prefix**. This saves enormous amounts of cache creation tokens fleet-wide.

For third-party providers or when MCP tools are present, org-level caching is used instead.

### 1.4 Custom System Prompt Handling

When an SDK caller provides a custom system prompt, the entire default system prompt is replaced. Custom prompts skip the static/dynamic split entirely — no global caching benefit.

---

## 2. Prompt Cache Design

### 2.1 Anthropic API Cache Key

The Anthropic API computes a cache key from these 5 inputs — all must be byte-identical for a cache hit:

```
              ┌──────────────────────────────────────────────┐
              │         ANTHROPIC API CACHE KEY              │
              │                                              │
              │  ① System Prompt blocks (with cache_control) │
              │  ② Tool schemas       (with cache_control)   │
              │  ③ Model identifier    (e.g. claude-sonnet-4)│
              │  ④ Messages prefix     (up to cache_control) │
              │  ⑤ Thinking config     (adaptive + budget)   │
              │                                              │
              │  All 5 must match byte-for-byte → cache HIT  │
              │  Any 1 differs                 → cache MISS  │
              └──────────────────────────────────────────────┘
```

### 2.2 How Cache Markers Are Placed

#### Visual: Cache Marker Placement on an API Request

```
                       ONE API REQUEST
  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                  │
  │  SYSTEM PROMPT BLOCKS          MESSAGES (role: user/assistant)   │
  │  ┌───────────────────┐        ┌──────┐ ┌──────┐ ┌─────────────┐ │
  │  │ attribution       │ no cc  │ msg1 │ │ msg2 │ │ msgN (LAST) │ │
  │  ├───────────────────┤        │      │ │      │ │             │ │
  │  │ CLI prefix        │ no cc  │      │ │      │ │ cache_cont- │ │
  │  ├───────────────────┤        │      │ │      │ │ rol: ephemer-│ │
  │  │ STATIC content    │ GLOBAL │      │ │      │ │ al {1h}     │ │  ← ONLY
  │  │ (7 blocks merged) │ cc ★   │      │ │      │ │             │ │    ONE
  │  ├───────────────────┤        │      │ │      │ │             │ │    cc PER
  │  │ DYNAMIC content   │ ORG    │      │ │      │ │             │ │    REQUEST
  │  │ (N blocks merged) │ cc     │      │ │      │ │             │ │
  │  └───────────────────┘        └──────┘ └──────┘ └─────────────┘ │
  │                                                                  │
  │  TOOL SCHEMAS                                                   │
  │  ┌────────────┐ ┌──────────┐ ┌─────────┐                       │
  │  │ Read tool  │ │ Bash tool│ │ ...N... │  each has cache_control│
  │  │ cc: eph    │ │ cc: eph  │ │ cc: eph │                       │
  │  └────────────┘ └──────────┘ └─────────┘                       │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘

  cc  = cache_control marker
  ★   = global scope (shared across orgs for first-party users)
  ORG = org scope (shared within org)
```

#### System Prompt Blocks

```typescript
// src/services/api/claude.ts — buildSystemPromptBlocks()
function buildSystemPromptBlocks(systemPrompt, enablePromptCaching, options?) {
  return splitSysPromptPrefix(systemPrompt, options).map(block => ({
    type: 'text',
    text: block.text,
    ...(enablePromptCaching && block.cacheScope !== null && {
      cache_control: getCacheControl({
        scope: block.cacheScope,  // 'global' | 'org' | null
        querySource: options?.querySource,
      }),
    }),
  }))
}
```

Only blocks with `cacheScope !== null` get `cache_control`. The attribution header and CLI prefix block are never cached (they vary per request).

#### Message-Level Cache Markers

```typescript
// src/services/api/claude.ts — addCacheBreakpoints()
// Exactly ONE message-level cache_control marker per request.
// Placed on the LAST message (or second-to-last for skipCacheWrite forks).
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
```

The single marker is critical: Anthropic's inference engine (Mycro) uses the cache_control position to determine which KV-cache pages to retain for future turns. Multiple markers waste local-attention memory.

#### Tool Schema Cache Markers

Tools also get `cache_control` on their schema blocks, allowing the tool definitions to be cached.

### 2.3 Cache TTL

Cache entries are **ephemeral** — they expire after a fixed time-to-live (TTL). Two TTL values exist:

- **5-minute TTL** (`{ type: 'ephemeral' }`): Default. Used for all users. Cache entry lives 5 minutes from last access.
- **1-hour TTL** (`{ type: 'ephemeral', ttl: '1h' }`): Extended lifetime. Only granted to certain users.

```
              WHO GETS 1-HOUR CACHE TTL?
              ───────────────────────────

                     ┌─────────────────────────────┐
                     │ User sends API request      │
                     └─────────────┬───────────────┘
                                   │
                     ┌─────────────▼───────────────┐
                     │ Bedrock + opted in via env? │
                     │ ENABLE_PROMPT_CACHING_1H_   │
                     │ BEDROCK=true                │
                     └──────┬──────────────────────┘
                            │
                  ┌─────────▼─────────┐
                  │ YES               │ NO
                  ▼                   ▼
            ┌──────────┐    ┌───────────────────────────┐
            │ 1h TTL   │    │ Check user eligibility    │
            │ granted  │    │ (latched in session state)│
            └──────────┘    └─────────┬─────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │ Anthropic employee?     │
                         │ (USER_TYPE === 'ant')   │
                         └──────┬──────────────────┘
                                │
                       ┌────────▼────────┐
                       │ YES              │ NO
                       ▼                  ▼
                 ┌──────────┐   ┌─────────────────────────────────┐
                 │ 1h TTL   │   │ Claude.ai subscriber AND        │
                 │ granted  │   │ NOT currently in overage?       │
                 │ (not     │   │                                 │
                 │ billed)  │   │ isClaudeAISubscriber() = true   │
                 └──────────┘   │ currentLimits.isUsingOverage    │
                                │   = false                       │
                                └─────────────┬───────────────────┘
                                              │
                                     ┌────────▼────────┐
                                     │ YES             │ NO
                                     ▼                 ▼
                               ┌──────────┐    ┌──────────────┐
                               │ 1h TTL   │    │ 5m TTL only  │
                               │ granted  │    │ (default)    │
                               └──────────┘    └──────────────┘
                                      │
                         ┌────────────▼──────────────────────────┐
                         │ AND query source must match           │
                         │ GrowthBook allowlist pattern:         │
                         │                                       │
                         │ tengu_prompt_cache_1h_config {        │
                         │   allowlist: ["repl_main_thread*",    │
                         │               "sdk",                  │
                         │               "agent:*"]              │
                         │ }                                     │
                         │                                       │
                         │ e.g. repl_main_thread → 1h ✓          │
                         │      compact         → 1h ✓ (matches  │
                         │                       repl_main_thread│
                         │                       tracking key)   │
                         │      session_memory  → 5m only ✗      │
                         └───────────────────────────────────────┘
```

#### What "eligible subscriber" means

The 1-hour TTL is **more expensive for Anthropic** (cache entries live 12× longer, consuming more server-side KV-cache capacity). It's granted only when the cost is justified:

| Group | 1h TTL? | Why |
|-------|---------|-----|
| Anthropic employees (`USER_TYPE === 'ant'`) | Always | Not billed — used for development and dogfooding |
| Claude.ai **paying subscribers** (Max, Pro, Enterprise, Team) who are **within their plan quota** | Yes | These users pay for the product; 1h TTL improves their experience by avoiding re-computation of the system prompt + tool schemas (~20K tokens) every 5 minutes |
| Claude.ai subscribers who are **in overage** (exceeded plan quota) | No | Overage tokens are charged at a premium rate; the extra cache cost is not justified |
| API customers (non-subscribers) | No | Pay-per-token billing means the cache cost isn't offset by subscription revenue |
| Third-party providers (Bedrock, Vertex) | No (except Bedrock opt-in) | Different billing model; Bedrock users can opt in via `ENABLE_PROMPT_CACHING_1H_BEDROCK` since they manage their own billing |
| Short-lived forked agents (`session_memory`, `speculation`, `prompt_suggestion`) | No | These run 1-3 turns and exit — the cache would never be read a second time, so 1h TTL is pure waste |

#### Why latching matters

Both user eligibility and the allowlist are **latched** (cached in `bootstrap/state.ts`) on first call and never re-evaluated for the rest of the session:

```typescript
// First call: compute and latch
let userEligible = getPromptCache1hEligible()
if (userEligible === null) {
  userEligible =
    process.env.USER_TYPE === 'ant' ||
    (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
  setPromptCache1hEligible(userEligible)  // ← latched forever
}
// Subsequent calls: use latched value
```

Without latching, a mid-session quota-status change (entering/exiting overage) would flip the `cache_control` TTL value → the cache control byte pattern changes → **cache key changes** → 20K tokens of cache creation on the next turn. Latching prevents this.

```typescript
// src/services/api/claude.ts — getCacheControl()
export function getCacheControl({ scope, querySource } = {}) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

### 2.4 Cache Sharing with Forked Agents

Forked agents (compaction summarizer, session memory, prompt suggestions, etc.) inherit the parent's cache by using identical parameters:

```
                  PARENT (main conversation)          FORK (compact summarizer)
                  ──────────────────────────          ────────────────────────────

  CacheSafeParams ──▶ systemPrompt     ────── same ──▶ systemPrompt
                     userContext       ────── same ──▶ userContext
                     systemContext     ────── same ──▶ systemContext
                     toolUseContext    ────── same ──▶ toolUseContext (cloned)
                     forkContextMessages ──── same ──▶ forkContextMessages

  API Request:                                     API Request:
  ┌─────────────────────────────┐                  ┌──────────────────────────────────┐
  │ System: "You are Claude..." │  ←─ CACHE HIT ─▶ │ System: "You are Claude..."      │
  │ Tools: [Read,Bash,Edit...]  │  ←─ CACHE HIT ─▶ │ Tools: [Read,Bash,Edit...]       │
  │ Model: claude-sonnet-4-6    │  ←─ CACHE HIT ─▶ │ Model: claude-sonnet-4-6         │
  │ Messages:                   │  ←─ CACHE HIT ─▶ │ Messages:                        │
  │  [turn1] [turn2] ... [turnN]│                  │  [turn1] [turn2] ... [turnN]     │
  │  [turnN].cache_control ◀────│                  │  [turnN].cache_control ◀─────────│
  └─────────────────────────────┘                  │  [SUMMARIZE PROMPT]  ← NEW ONLY  │
                                                   └──────────────────────────────────┘
                                                                    ↑
                                                          Only this one message
                                                          costs new tokens. Everything
                                                          before it is a cache hit.

  skipCacheWrite=true: marker moves to [turnN-1] instead of [turnN]
  → fork's tail doesn't create a new cache entry (no-op merge)
```

```typescript
// src/utils/forkedAgent.ts — CacheSafeParams
export type CacheSafeParams = {
  systemPrompt: SystemPrompt       // Same system prompt bytes
  userContext: {...}               // Same user context
  systemContext: {...}             // Same system context
  toolUseContext: ToolUseContext   // Same tools, model, thinking config
  forkContextMessages: Message[]   // Same message prefix
}
```

The fork sends `[...forkContextMessages, ...promptMessages]`. Since `forkContextMessages` is the parent's full conversation, and the fork uses the same system prompt, tools, model, and thinking config, the API finds a cache hit on the entire parent prefix. The fork only pays for its own new messages.

### 2.5 Cache-Control on Tool Results

Tool result blocks before the last `cache_control` marker get `cache_reference` fields pointing to the corresponding `tool_use_id`. This enables server-side cached microcompact: the API can delete specific tool results from the cached prefix without invalidating the entire cache.

---

## 3. Compaction Design

### 3.1 What Is Compaction?

Compaction is automatic conversation summarization. When the conversation approaches the context window limit (~180K tokens), older messages are replaced with a detailed summary, freeing space for new turns.

### 3.2 Two Compaction Types

#### Full Compaction (`compactConversation`)
- Summarizes the **entire** conversation
- Replaces all messages with: `[boundary marker] + [summary] + [restored context]`
- Used for auto-compact and manual `/compact`

#### Partial Compaction (`partialCompactConversation`)
- Summarizes messages either **before** or **after** a user-selected pivot point

```
                 PARTIAL COMPACTION: direction='up_to'
                 ─────────────────────────────────────

  ALL MESSAGES:
  ┌────────────────────────────────────────────────────────────────┐
  │ [msg1] [msg2] ... [msg20] │ [msg21] [msg22] ... [msg30]        │
  │         SUMMARIZE         │             KEEP                   │
  │    (sent to compact API)  │     (kept verbatim, untouched)     │
  └────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┘
              ▼
  API Sends:  [msg1...msg20, summarizePrompt]
  Cache Hit?  YES — entire prefix matches parent's prefix byte-for-byte
  Result:     Summary covers msgs 1-20 only

  POST-COMPACT:
  ┌────────────────────────────────────────────────────────────────┐
  │ [boundary] [summary] [msg21] [msg22] ... [msg30]               │
  │                          ↕                                     │
  │                   100% intact — no summarization loss on       │
  │                   the most recent (and most relevant) context  │
  └────────────────────────────────────────────────────────────────┘


                 PARTIAL COMPACTION: direction='from'
                 ───────────────────────────────────

  ALL MESSAGES:
  ┌────────────────────────────────────────────────────────────────┐
  │ [msg1] [msg2] ... [msg20] │ [msg21] [msg22] ... [msg30]        │
  │          KEEP             │          SUMMARIZE                 │
  └────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┘
              ▼
  API Sends:  [msg1...msg30, summarizePrompt]  (all messages)
  Cache Hit?  YES on msgs 1-20 (kept portion is prefix)
  Result:     Summary covers msgs 21-30 only

  POST-COMPACT:
  ┌────────────────────────────────────────────────────────────────┐
  │ [msg1...msg20] [boundary] [summary]                            │
  │                ↕                                               │
  │         cache preserved on this prefix for future turns        │
  └────────────────────────────────────────────────────────────────┘
```

- `direction='up_to'`: Summarizes everything before the pivot, keeps recent messages → **preserves prompt cache** for the summarized prefix
- `direction='from'`: Summarizes everything after the pivot, keeps earlier messages → **preserves prompt cache** for the kept prefix

### 3.3 Compaction Process (Full)

```
                       COMPACTION LIFECYCLE
                       ───────────────────

  TRIGGER: tokenCount >= effectiveContextWindow - 13K
  ─────────────────────────────────────────────────

  BEFORE                                AFTER
  ┌────────────────────────────────┐    ┌────────────────────────────────┐
  │ [system prompt]                │    │ [system prompt]                │
  │ [turn 1: user msg]             │    │                                │
  │ [turn 1: assistant + tools]    │    │ ┌──────────────────────────┐   │
  │ [turn 2: user msg]             │    │ │ COMPACT BOUNDARY MARKER  │   │
  │ [turn 2: assistant + tools]    │    │ │ subtype: compact_boundary│   │
  │ ...                            │    │ └──────────────────────────┘   │
  │ [turn 40: user msg]            │    │                                │
  │ [turn 40: assistant working]   │    │ ┌──────────────────────────┐   │
  │                                │    │ │ USER SUMMARY MESSAGE     │   │
  │  ↑  TOKEN COUNT ~170K  ↑       │    │ │ "Session continued..."   │   │
  │  ↑  OVER THRESHOLD      ↑      │    │ │ + 9-section summary      │   │
  └────────────────────────────────┘    │ └──────────────────────────┘   │
                                        │                                │
  ┌──── STEP 1: SUMMARIZE ──────────┐   │ ┌──────────────────────────┐   │
  │                                 │   │ │ RESTORED ATTACHMENTS     │   │
  │  Fork agent (cache-sharing):    │   │ │ - 5 recently read files  │   │
  │  ┌───────────────────────────┐  │   │ │ - plan file (if exists)  │   │
  │  │ System: same as parent    │  │   │ │ - plan mode instructions │   │
  │  │ Tools: same as parent     │  │   │ │ - invoked skills         │   │
  │  │ Model: same as parent     │  │   │ │ - async agent statuses   │   │
  │  │ Messages:                 │  │   │ │ - tool/MCP/agent deltas  │   │
  │  │  [...all old messages]    │  │   │ └──────────────────────────┘   │
  │  │  [SUMMARIZE PROMPT] ← NEW │  │   │                                │
  │  └───────────────────────────┘  │   │ ┌──────────────────────────┐   │
  │                                 │   │ │ HOOK RESULTS             │   │
  │  Cache: HIT on old messages     │   │ │ (session_start + post_   │   │
  │  Cost: only the summary prompt  │   │ │  compact hooks executed) │   │
  └─────────────────────────────────┘   │ └──────────────────────────┘   │
                                        │                                │
  ┌──── STEP 2: RESTORE STATE ─────┐   │  TOKEN COUNT: ~30-60K           │
  │                                 │   │  (summary + restorations)      │
  │  • Clear readFileState cache    │   │                                │
  │  • Re-read 5 most recent files  │   └────────────────────────────────┘
  │  • Generate plan attachment     │
  │  • Generate skill attachment    │
  │  • Re-announce tools/agents/MCP │
  │  • Run hooks (session + post)   │
  └─────────────────────────────────┘
```

The function `compactConversation()` in `src/services/compact/compact.ts` orchestrates:

1. **Pre-processing**: Strip images (replaced with `[image]` text) and re-injected attachments (skills) from messages — these aren't needed for summarization and waste tokens.

2. **PreCompact hooks**: Execute user-configured hooks; merge any custom instructions.

3. **Generate summary** (the core):
   - Uses a **forked agent** with `runForkedAgent()` to share the parent's prompt cache
   - Sends a detailed summarization prompt (see §3.4)
   - The fork inherits the parent's system prompt, tools, model, thinking config, and message prefix → **cache hit on the entire conversation**
   - Falls back to streaming if cache sharing fails
   - Retries with head truncation if the compact request itself hits prompt-too-long (PTL)
   - `maxTurns: 1` — the fork must produce a text summary in one turn; tool calls are denied

4. **Post-summary restoration**:
   - Clear `readFileState` cache
   - Restore up to 5 most recently read files (within 50K token budget, 5K per file)
   - Restore plan file if one exists
   - Restore plan mode instructions if in plan mode
   - Restore invoked skills (most-recent-first, 5K per skill, 25K total budget)
   - Re-announce deferred tools, agent listings, and MCP instructions as delta attachments
   - Execute SessionStart hooks and PostCompact hooks

5. **Create boundary marker**: A system message of subtype `compact_boundary` that records:
   - `trigger`: 'auto' | 'manual'
   - `preTokens`: Token count before compaction
   - `preservedSegment`: If any messages were kept (partial compact), records head/tail/anchor UUIDs for relinking

6. **Cleanup**: Reset cache break detection baseline, clear system prompt section cache, record analytics.

### 3.4 The Summary Prompt

The summary prompt (`src/services/compact/prompt.ts`) is incredibly detailed — 9 sections:

```text
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (with full code snippets)
4. Errors and Fixes (with user feedback)
5. Problem Solving
6. All User Messages (non-tool-result messages verbatim)
7. Pending Tasks
8. Current Work (precisely what was being done)
9. Optional Next Step (with verbatim quotes from conversation)
```

The prompt also has an `<analysis>` scratchpad section that the model fills before the `<summary>`. The analysis is stripped from the final summary (it's only a drafting aid).

A `NO_TOOLS_PREAMBLE` aggressively instructs: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool calls will be REJECTED and will waste your only turn — you will fail the task."

### 3.5 Auto-Compact Trigger

```
                   AUTO-COMPACT DECISION FLOW
                   ──────────────────────────

  ┌────────────────────────────────────────────────────────────────┐
  │  Every turn, before API call:                                  │
  │                                                                │
  │  tokenCount = estimateTokens(messages)                         │
  │  threshold  = contextWindow - 13K  (e.g. 180K → 167K)          │
  │                                                                │
  │  tokenCount <  threshold  ──▶  normal turn, no compact         │
  │  tokenCount >= threshold  ──▶  AUTO-COMPACT TRIGGERED          │
  │                                  │                             │
  │                   ┌──────────────┘                             │
  │                   ▼                                            │
  │  ┌─────────────────────────────────────┐                       │
  │  │ Try Session Memory compaction first │                       │
  │  │ (cheaper, uses stored memory)       │                       │
  │  │                                     │                       │
  │  │ success? → done, return             │                       │
  │  │ fail?    → fall through             │                       │
  │  └─────────────────────────────────────┘                       │
  │                   │                                            │
  │                   ▼                                            │
  │  ┌─────────────────────────────────────┐                       │
  │  │ Full compactConversation()          │                       │
  │  │ (forked agent summary + restore)    │                       │
  │  │                                     │                       │
  │  │ success? → reset failure counter    │                       │
  │  │ fail?    → increment circuit breaker│                       │
  │  │             after 3 failures: STOP  │                       │
  │  │             (prevents API hammering)│                       │
  │  └─────────────────────────────────────┘                       │
  └────────────────────────────────────────────────────────────────┘
```

```typescript
// src/services/compact/autoCompact.ts
const AUTOCOMPACT_BUFFER_TOKENS = 13_000

function getAutoCompactThreshold(model) {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
  // e.g., 180K window → threshold ≈ 167K tokens
}
```

When `tokenCount >= threshold`, auto-compact fires. It tries **session memory compaction** first (cheaper, uses session memory infrastructure), then falls back to full compaction.

A **circuit breaker** stops retrying after 3 consecutive failures (prevents hammering the API when context is irrecoverably over limit).

### 3.6 Compact Boundary Message

```typescript
// src/utils/messages.ts
type SystemCompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
  content: 'Conversation compacted'
  compactMetadata: {
    trigger: 'manual' | 'auto'
    preTokens: number
    userContext?: string
    messagesSummarized?: number
    preservedSegment?: {
      headUuid: UUID
      anchorUuid: UUID
      tailUuid: UUID
    }
    preCompactDiscoveredTools?: string[]
  }
}
```

The boundary separates pre-compact messages (discarded) from post-compact messages (kept). Functions like `getMessagesAfterCompactBoundary()` use it to slice the conversation.

### 3.7 Microcompact (API-Level)

Separate from summarization-based compaction, **microcompact** uses the API's `cache_edits` mechanism to delete old tool results from the cached prefix without sending new messages:

- `clear_tool_uses_20250919` strategy: Clears tool results and tool uses beyond configured keep thresholds
- `clear_thinking_20251015` strategy: Preserves thinking blocks from previous turns

This is a server-side operation — the client sends `cache_edits` blocks that instruct the API to delete specific cache references. This saves tokens without any summarization overhead.

---

## 4. How Compaction Preserves User Task Context

This is the critical question: how does the model "remember" what it was doing?

```
              CONTEXT PRESERVATION CHAIN
              ──────────────────────────

  ┌─────────────────────────────────────────────────────────────────┐
  │                     PRE-COMPACTION STATE                        │
  │                                                                 │
  │  User: "Fix the login bug and also update the README"           │
  │  Assistant: [reads auth.ts, finds null check issue]             │
  │  User: "Also make sure to add tests"                            │
  │  Assistant: [edits auth.ts, writes auth.test.ts]                │ ↕ ~170K tokens
  │  User: "The test is failing for the edge case"                  │
  │  Assistant: [debugging, reading error output, about to fix...]  │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
                              │
                              ▼  COMPACTION
  ┌─────────────────────────────────────────────────────────────────┐
  │                     POST-COMPACTION STATE                       │
  │                                                                 │
  │  ┌─────────────────────────────────────────────────────────────┐│
  │  │ COMPACT BOUNDARY (system msg, invisible to model)           ││
  │  └─────────────────────────────────────────────────────────────┘│
  │                                                                 │
  │  ┌─────────────────────────────────────────────────────────────┐│
  │  │ SUMMARY (user msg, isCompactSummary=true)                   ││
  │  │                                                             ││
  │  │ 1. Primary Request: Fix login bug + update README + tests   ││
  │  │ 2. Key Concepts: JWT auth, null coalescing, jest            ││
  │  │ 3. Files:                                                   ││
  │  │    - src/auth.ts: fixed null check on line 42               ││
  │  │    - src/auth.test.ts: added 3 test cases                   ││
  │  │ 4. Errors: test failing on edge case (null token)           ││
  │  │ 5. Problem Solving: investigating token validation          ││
  │  │ 6. All User Messages:                                       ││
  │  │    - "Fix the login bug and also update the README"         ││
  │  │    - "Also make sure to add tests"                          ││
  │  │    - "The test is failing for the edge case"                ││
  │  │ 7. Pending: fix failing test, update README                 ││
  │  │ 8. Current Work: debugging test failure in auth.test.ts     ││
  │  │ 9. Next Step: "check the null token path" (verbatim quote)  ││
  │  │                                                             ││
  │  │ Transcript: /tmp/claude/transcript-xxx.json                 ││
  │  └─────────────────────────────────────────────────────────────┘│
  │                                                                 │
  │  ┌─────────────────────────────────────────────────────────────┐│
  │  │ RESTORED STATE (attachments)                                ││
  │  │  │  [file] auth.ts (re-read, most recent file)              ││
  │  │  │  [file] auth.test.ts (re-read)                           ││
  │  │  │  [plan] "1. fix auth 2. add tests 3. update readme"      ││
  │  │  │  [skill] typescript-reviewer (was invoked earlier)       ││
  │  └─────────────────────────────────────────────────────────────┘│
  │                                                                 │
  │  ┌─────────────────────────────────────────────────────────────┐│
  │  │ CONTINUATION INSTRUCTION                                    ││
  │  │ "Resume directly — do not acknowledge the summary,          ││
  │  │  do not recap. Pick up the last task as if the break        ││
  │  │  never happened."                                           ││
  │  └─────────────────────────────────────────────────────────────┘│
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  MODEL'S NEXT TURN:                                             │
  │  "The null token path in auth.ts line 42 needs a guard..."      │
  │                                                                 │
  │  The model:                                                     │
  │  ✓ Knows the overall task (from summary §1)                     │
  │  ✓ Knows exactly what failed (from summary §4, §8)              │
  │  ✓ Has auth.ts content (from re-read attachment)                │
  │  ✓ Knows all user feedback (from summary §6)                    │
  │  ✓ Knows pending work (from summary §7)                         │
  │  ✓ Can read transcript for exact details if needed              │
  │  ✓ Doesn't waste a turn saying "I see we were working on..."    │
  └─────────────────────────────────────────────────────────────────┘
```

### 4.1 The Summary Is the Memory

The 9-section summary prompt forces the model to capture:

- **All user messages** (section 6) — this is the key to not losing track of user intent. Every non-tool-result user message is listed.
- **Current work with verbatim context** (section 8) — precisely what was happening, including file names and code snippets
- **Next step with direct quotes** (section 9) — verbatim quotes from the most recent conversation to prevent task drift
- **Errors and how they were fixed** (section 4) — prevents repeating mistakes
- **Pending tasks** (section 7) — work the model explicitly committed to

### 4.2 The Continuation Prompt

After the summary is injected, it includes:

```
This session is being continued from a previous conversation that ran out of context.

[Detailed summary...]

Continue the conversation from where it left off without asking the user any further questions.
Resume directly — do not acknowledge the summary, do not recap what was happening,
do not preface with "I'll continue" or similar. Pick up the last task as if the
break never happened.
```

This prevents the model from wasting a turn on "I see we were working on..." acknowledgments.

### 4.3 State Restoration

Beyond the summary, concrete state is re-injected:

| What | How | Budget |
|------|-----|--------|
| Recently read files | Re-reads up to 5 most recent files from `readFileState` cache | 50K tokens total, 5K per file |
| Plan file | `plan_file_reference` attachment with full plan content | Unbounded |
| Plan mode | `plan_mode` attachment reminding model it's in plan mode | Small |
| Invoked skills | `invoked_skills` attachment with skill content (truncated per-skill) | 25K token budget, 5K per skill |
| Running async agents | `task_status` attachments for un-retrieved background agents | Small |
| Tool/MCP/Agent deltas | Re-announces tools, agents, and MCP instructions since message history is empty | Based on actual deltas |
| Session context | SessionStart hooks re-executed | Variable |

### 4.4 Transcript Path

The summary always includes the transcript file path:

```
If you need specific details from before compaction (like exact code snippets,
error messages, or content you generated), read the full transcript at: /path/to/transcript
```

This gives the model an escape hatch — it can `Read` the transcript for exact details.

### 4.5 Partial Compaction: Keeping Recent Messages

In partial compaction with `direction='up_to'`, recent messages are **kept verbatim**. The summary only covers older messages. This means the most recent context (which is usually the most relevant) is 100% intact — no summarization loss.

The `preservedSegment` metadata in the boundary message ensures the message chain is correctly relinked when loading from disk.

---

## 5. Cache Break Detection

`src/services/api/promptCacheBreakDetection.ts` provides a two-phase detection system:

```
               CACHE BREAK DETECTION FLOW
               ──────────────────────────

  PHASE 1 (PRE-CALL)                      PHASE 2 (POST-CALL)
  ┌──────────────────────┐                ┌──────────────────────────────┐
  │ recordPromptState()  │                │ checkResponseForCacheBreak() │
  │                      │                │                              │
  │ Snapshot everything  │                │ Compare cache_read tokens:   │
  │ that affects cache:  │                │                              │
  │                      │                │  prev: 45,000 tokens         │
  │ ✓ system prompt hash │                │   now:  6,200 tokens  ← DROP │
  │ ✓ tool schemas hash  │      API       │                              │
  │ ✓ model string       │    ──CALL──▶   │  ▸ 86% drop (>5% threshold)  │
  │ ✓ fast mode flag     │                │  ▸ 38,800 token drop (>2K)   │
  │ ✓ beta headers       │                │                              │
  │ ✓ cache_control map  │                │  → CACHE BREAK DETECTED      │
  │ ✓ effort value       │                │                              │
  │ ✓ extra body params  │                │  Match against pending:      │
  │ ✓ globalCacheStrategy│                │  ▸ systemPromptChanged=true  │
  │ ✓ ...                │                │  ▸ systemCharDelta=+142      │
  │                      │                │                              │
  │ Store as pending     │                │  Reason: "system prompt      │
  │ changes if anything  │                │   changed (+142 chars)"      │
  │ differs from previous│                │                              │
  └──────────────────────┘                │  Additional checks:          │
                                          │  ▸ Was there a compaction?   │
                                          │    → reset baseline, skip    │
                                          │  ▸ Was there a cache delete? │
                                          │    → expected drop, skip     │
                                          │  ▸ >5min since last msg?     │
                                          │    → "possible TTL expiry"   │
                                          │  ▸ No changes + <5min gap?   │
                                          │    → "likely server-side"    │
                                          │                              │
                                          │  Log + write diff for debug  │
                                          └──────────────────────────────┘
```

### Phase 1 (Pre-Call): `recordPromptState()`

Records a snapshot of everything that could affect the cache key:

- System prompt hash (content + cache_control layout)
- Tool schema hash (aggregate + per-tool)
- Model, fast mode, global cache strategy
- Beta headers, auto-mode, overage, cached microcompact state
- Effort value, extra body params
- Full diffable content string (for debugging)

### Phase 2 (Post-Call): `checkResponseForCacheBreak()`

After the API response:

1. Compares `cache_read_input_tokens` to the previous call's value
2. If the drop is >5% AND >2,000 tokens → **cache break detected**
3. Matches against pending changes from Phase 1 to explain **why**:
   - "model changed (claude-sonnet-4-5 → claude-opus-4-6)"
   - "system prompt changed (+142 chars)"
   - "tools changed (+1/-0 tools)"
   - "cache_control changed (scope or TTL)"
   - "likely server-side (prompt unchanged, <5min gap)"
   - "possible 5min TTL expiry"
4. Writes a diff file to temp directory for debugging
5. Logs `tengu_prompt_cache_break` event

### Anti-False-Positive Measures

- **Compaction resets baseline**: After compaction, `prevCacheReadTokens` is set to `null` — the next call's drop is expected and not flagged
- **Cache deletion awareness**: `notifyCacheDeletion()` marks `cacheDeletionsPending = true` — the next call's lower cache read is expected
- **TTL awareness**: If >5 minutes since last assistant message, the reason includes TTL expiry
- **Excluded models**: Haiku models are excluded (different caching behavior)
- **Minimum threshold**: Drops smaller than 2K tokens are ignored
- **Source isolation**: Each query source (main thread, subagent type) has independent tracking state
