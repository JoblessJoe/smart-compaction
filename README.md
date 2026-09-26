# smart-compaction

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that gives the
model two tools: `compact_now`, so it can trigger compaction itself at a point *it* knows is safe
— right after finishing a step, never mid-edit — instead of only ever being interrupted by dsh's
automatic token-threshold trigger; and `context_status`, so it can check real, current token
usage against its actual context window instead of guessing whether a conversation "feels long."

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

Two tools, both no-argument.

**`compact_now`**

- Selects the largest currently-compactable span of conversation history — the same
  tool-call-pairing-safe boundary logic dsh's own compaction already guarantees, reimplemented
  here against dsh's *public* APIs only (no dsh core changes, no dependency on
  `compaction-basic`'s internals).
- Calls dsh's own `ctx.compaction.compactRegion()` to actually do the compaction — the same
  summarizer, the same durable `compaction/start`/`compaction/end` log events, the same guarantees
  as any other compaction in the session.
- No-ops harmlessly (`"Not enough compactable history yet."`) if there isn't enough history yet —
  safe for the model to call speculatively.

**`context_status`**

- Read-only — never modifies the session, safe to call anytime.
- Reports current token usage and the model's actual context-window size for *this* session,
  e.g. `"~42,300 / 77,824 tokens used (54.3%)."`
- Reads dsh's own `contextPressure` session projection (registered by
  `@deepseek-ai/dsh-token-meter`, mounted wherever `compaction-basic` is) via the public
  `ctx.sessionProjections.stateOf()` API — the same numbers the web UI's own context meter
  reads. Nothing is hardcoded: the context-window figure comes from whatever model this
  session is actually routed to, so it's correct unchanged across different models, profiles,
  and context-window sizes.
- Exists because, without it, the model has zero visibility into its own context usage — the
  only prior signal was a vague "if the conversation feels long" in `compact_now`'s own
  description.

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

**`compact_now` requires a `compaction` service on your profile.** Most profile templates ship
one, but not all do (e.g. `@deepseek-ai/dsh-web-app`-based profiles don't by default). If yours
doesn't, `compact_now` still installs cleanly (it won't break your profile's boot) but returns an
error every time it's called: `"no compaction service is configured on this profile"`. Add a
`compaction-basic` bundle to get one.

**`context_status` requires `@deepseek-ai/dsh-token-meter` mounted** (it registers the
`contextPressure` projection this tool reads). It's normally pulled in wherever `compaction-basic`
is, so if `compact_now` works, `context_status` should too. If it isn't mounted, the tool still
installs cleanly and just reports `available: false` instead of erroring.

### Tell the model when to use it

Neither tool calls itself — nothing uses them unless instructed to. Add something like this to
your `AGENTS.md` (or whatever your profile injects as standing instructions):

> After marking a todo item `completed` (never while one is `in_progress`), call `context_status`.
> If usage is climbing past roughly 70-80% of the context window, call `compact_now` too. Both are
> safe to call speculatively — `context_status` is read-only, and `compact_now` no-ops if there
> isn't enough history to compact yet.

Tying this to todo-completion matters: it's a real, already-tracked signal for "I just finished a
self-contained unit of work," instead of asking the model to estimate its own remaining work or
guess whether a conversation "feels long," both of which it's generally bad at. `context_status`
replaces that guess with the real number.

## Building from source

Requires Node 22+. Plain JS, no build step — `git clone`, `pnpm install`, done.

```bash
git clone https://github.com/JoblessJoe/smart-compaction.git
cd smart-compaction
pnpm install
node test.js
```

`test.js` is a pure unit-test check of the range-selection logic (`select-range.js`) and the
context-usage summary logic (`context-status.js`) — no live dsh/Ollama session required.

## Configuration

None. The tool takes no arguments and needs no setup beyond installing it.

## Status

`compact_now` verified end-to-end against a real dsh session, including:

- Basic call: the tool loads, the model calls it, it selects a valid boundary-safe range, and it
  drives `compactRegion()` mid-turn without ever hitting the `busy` failure this design exists to
  avoid.
- A real tool-call/tool-result pair (`todo_write`, marked `in_progress` then `completed`) sitting
  in the compacted range — stays correctly paired, nothing split.
- Three `compact_now` calls in a row in one session (one accidental, caught by dsh's own
  duplicate-call guard mid-task) — each completed cleanly, no crash, no `busy`, no corrupted state
  from operating on a surface that already contains an earlier compaction's checkpoint message.

**Troubleshooting:** if the tool returns an error like `summarization produced no text summary
content`, that's not this plugin — `compact_now` selected a valid range and handed it to dsh's own
summarizer, which returned nothing. Observed specifically when the compacted range contains only
injected boilerplate (e.g. standing instructions) with no real assistant-generated text yet —
succeeded reliably once genuine conversation content was in the range. If it happens on ranges with
real content too, check whether your model's "thinking" level is an actually-enforced token budget
or just an instruction (e.g. Ollama's `think: low` is unenforced — a model can still spend its
entire output budget on hidden reasoning and return no visible summary text). Either way, this is a
model/summarizer-side issue, not something `compact_now` itself controls.

## License

MIT
