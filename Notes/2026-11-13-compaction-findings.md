# Context management: findings and plan (2026-11-13)

Branch: `fix/early-compaction-headroom` (pushed). `main` untouched.
Status: unit tests + fake-dsh smoke tests pass. **Not yet run on a real dsh.**

## The original bug: compaction at ~33%

- **Cause is dsh core, not this plugin.** `compaction-basic` triggers at
  `floor(min(W × 0.8, W − O − headroomTokens))`.
  - `W` = context window, `O` = reply reserve (request `maxTokens`), `headroomTokens` = 65,536.
  - On a 128k local model, `W − O − 65,536` wins → ~33–45%.
- **Why it loops:** after compacting, the kept tail (16% of `W − O`) + summary + system prompt
  sits just under the trigger, so it fires again a step or two later.
- **Summary cap** (`maxTokens` of the summary call) also defaults to 65,536.
- **Reply reserve `O`:** dsh's DeepSeek adapter (`dsh-llm-deepseek`) defaults to 256,000. Any `O`
  is subtracted from the trigger as well.
- The preset's `compaction-basic` row can't be reached by a profile/bundle patch (it lives inside
  the preset's isolated group). Plugins work around this by changing the live engine.

## What the branch now does

| Feature | Setting (default) | Idea from |
|---|---|---|
| Lower engine headroom + summary cap on the live engine → trigger back near 80% | `summaryMaxTokens` (16384) | `dsh-compaction-policy`, `dsh-compaction-threshold` |
| Cap reply reserve per request (`agent/request` hook), never raise a lower value | `maxOutputTokens` (16384) | — |
| Hide stale tool output (>4 steps old, ≥2,000 chars) → 300-char preview + marker, in batches (≥10% of window) | `mask.*` | `@maskpoint/dsh`, JetBrains study |
| Hide outdated file reads (re-read same lines, or file rewritten) | `mask.dedupeReads` (true) | — |
| `recall_output` tool: full original back, word for word (walks `sourceEventSeqs`) | — | `dsh-compaction-vcc` |
| Cap one `read` result at a line boundary with `offset=N` hint | `readMaxChars` (20000) | — |
| System prompt: size report; opt-in drop/replace/cut sections and contexts (AGENTS.md) | `prompt.*` (report only) | — |
| Safe-point compaction after a finished todo: mask first, summarize only if still over | `safePointRatio` (0.6, was 0.5) | — |
| Compaction keeps the newest ~16% verbatim instead of only the last node | engine `retainRatio` | core `region.ts` |
| One-time warning if headroom still caps the trigger (when tune is off) | — | — |

Principles kept: no silent loss (every hidden item says what it was + how to get it back); no
model-written summaries for hidden content (they can invent facts → hallucination); batch rewrites
because each rewrite of old history makes a local model re-read the prompt (llama.cpp KV reuse is
prefix-only).

## Test on the server

1. Deploy the branch to the dsh profile; start a long session on the local model.
2. Logs should show, once:
   - `compaction headroom and summary cap set to 16384 tokens`
   - `system prompt sections: ... contexts: ...` (sizes — use to pick trims)
3. Watch: compaction should start near 70–80%, not 33%; no compact-every-few-steps loop.
4. Check masked results look right and the model uses `recall_output` when needed.
5. Check `read` caps don't cause edit failures (read-before-edit policy).
6. Grab summary lengths: `grep -rl "compaction/end" ~/.dsh/` → read the events.

## Risks / unverified on real dsh

- **Engine config swap** (`engine.config = {...}`) — proven by `dsh-compaction-threshold`, not by us.
- **`agent/request`** is deprecated (still dispatched). If removed, the reserve cap silently stops.
- **16k reply reserve** may cut off long reasoning on thinking models → raise `maxOutputTokens`.
- **Prune-protocol replacements** follow dsh's own `tool-result-pruner` (same API back to
  0.2.0-rc.2), but the session double in tests is simplified.
- `isMasked` uses a text pattern: reading this plugin's own source could look "already masked".
- Read cap and dedupe assume the tool is named `read` with `file_path` / `N: text` output.

## Open ideas (not built)

- **File contents in old `write`/`edit` call arguments.** Would need replacing `assistant/message`
  events; their `usage`/stream data feed the token meter, so a careless rewrite double-counts
  usage. Only with a real dsh to test on. Alternative: VCC-style deterministic compaction (tool
  calls → one-liners with seq pointers) as our own `summarize()`.
- **Old reasoning text:** check whether the adapter in use replays past reasoning blocks; if so,
  that is a large hidden cost.
- **Tool schemas:** can't be edited by a plugin (provider-owned); preset-registered tools can't be
  hidden by `tools.restrict()` either. Use the web preset editor to drop unused tool rows
  (office, plugin market/manager, workflow, schedule, …) on small windows.
- **Partly stale reads after `edit`** are still kept (only full rewrites/re-reads hide them).
- **Pressure gate like `dsh-compaction-policy`** (wrap `compactIfNeeded`) if the config swap ever
  stops working.
- Measure real numbers: summary lengths, tool-schema size, AGENTS.md size, per-step growth.

## Other plugins worth knowing

- `dsh-compaction-policy` — gates the engine's pressure check at your own trigger.
- `dsh-compaction-vcc` — LLM-free compaction + `recall`/`search` tools; replaces compaction-basic.
- `@maskpoint/dsh` — observation-masking backend; README targets an older dsh (0.1.0-rc.8).
- `@deepseek-ai/dsh-spill-policy` — official; big tool results to a file + preview (new, rc).
