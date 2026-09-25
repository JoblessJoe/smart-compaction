# smart-compaction

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that gives the
model a `compact_now` tool, so it can trigger compaction itself at a point *it* knows is safe —
right after finishing a step, never mid-edit — instead of only ever being interrupted by dsh's
automatic token-threshold trigger.

## Why

dsh's built-in compaction is purely reactive: an automatic trigger fires between agent steps
whenever token pressure crosses a fixed threshold, with no idea whether that moment is a good one
to interrupt. It can land between two dependent steps — e.g. right after reading a file and right
before editing it based on what was just read — and the resulting summary loses exactly the
context the very next step needed.

This plugin doesn't change *how* compaction works, only *who decides when*. It hands the model a
tool it can call proactively, on its own judgment, instead of leaving that decision entirely to a
blind token counter.

## What it does

One tool: **`compact_now`**. No arguments.

- Selects the largest currently-compactable span of conversation history — the same
  tool-call-pairing-safe boundary logic dsh's own compaction already guarantees, reimplemented
  here against dsh's *public* APIs only (no dsh core changes, no dependency on
  `compaction-basic`'s internals).
- Calls dsh's own `ctx.compaction.compactRegion()` to actually do the compaction — the same
  summarizer, the same durable `compaction/start`/`compaction/end` log events, the same guarantees
  as any other compaction in the session.
- No-ops harmlessly (`"Not enough compactable history yet."`) if there isn't enough history yet —
  safe for the model to call speculatively.

## How it works

Two entry points exist on dsh's compaction service: `compactNow()` (what the human `/compact`
command uses — requires an **idle** agent, throws `busy` otherwise) and `compactRegion()` (what
dsh's own *automatic* between-step trigger uses — works fine **mid-turn**). A tool's `execute()`
always runs mid-turn — that's what calling a tool means — so `compact_now` is built on
`compactRegion()`, not `compactNow()`.

## Install

From your dsh **web profile** (`web` below is the profile name; use whichever profile backs your
session):

```bash
dsh plugin --profile web add smart-compaction
```

This installs the package and adds it to `dsh.profile.bundles` for you. (No local `dsh` binary?
Run the equivalent by hand from the profile directory, e.g. `~/.dsh/profiles/web/`: `pnpm add
smart-compaction`, then add `"smart-compaction"` to that `package.json`'s `dsh.profile.bundles`
array yourself.)

No build step, no config. Restart your dsh service after adding it — new bundles are only picked
up on boot.

### Tell the model when to use it

`compact_now` only *offers* the capability — nothing calls it unless instructed to. Add something
like this to your `AGENTS.md` (or whatever your profile injects as standing instructions):

> After marking a todo item `completed` (never while one is `in_progress`), if the conversation
> has gotten long, call `compact_now`. It's safe to call speculatively — it no-ops if there isn't
> enough history to compact yet.

Tying it to todo-completion matters: it's a real, already-tracked signal for "I just finished a
self-contained unit of work," instead of asking the model to estimate its own remaining work,
which it's generally bad at.

## Building from source

Requires Node 22+. Plain JS, no build step — `git clone`, `pnpm install`, done.

```bash
git clone https://github.com/JoblessJoe/smart-compaction.git
cd smart-compaction
pnpm install
node test.js
```

`test.js` is a pure unit-test check of the range-selection logic (`select-range.js`) — no live
dsh/Ollama session required.

## Configuration

None. The tool takes no arguments and needs no setup beyond installing it.

## Status

Verified end-to-end against a real dsh session: the tool loads, the model calls it, it selects a
valid boundary-safe range, and it drives `compactRegion()` mid-turn without ever hitting the
`busy` failure this design exists to avoid.

**Troubleshooting:** if the tool returns an error like `summarization produced no text summary
content`, that's not this plugin — it means the underlying model spent its entire output budget on
hidden reasoning and returned no visible text for the summary. This is a known failure mode on
local models whose "thinking" level isn't an enforced token budget (e.g. Ollama's `think: low`).
If your adapter supports capping reasoning length, enable it; otherwise it's a model/adapter issue
independent of `compact_now`.

## License

MIT
