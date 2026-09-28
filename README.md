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
- Posts a one-line "Compacting now" notice to the chat *before* calling `compactRegion()`, not
  after — the summarization call is one extra model request and can take a while (minutes, on a
  local model), and without this the chat just looks stuck between the tool call and its result.
  Tagged `kind: 'plugin', form: 'notice'` (the same tagging dsh-compaction-basic's own checkpoint
  messages and other host-generated asides use), so it renders as a collapsed system aside, not as
  if the user typed it, and needs no model output of its own.
- Calls dsh's own `ctx.compaction.compactRegion()` to actually do the compaction — the same
  summarizer, the same durable `compaction/start`/`compaction/end` log events, the same guarantees
  as any other compaction in the session.
- No-ops harmlessly (`"Not enough compactable history yet."`) if there isn't enough history yet —
  safe for the model to call speculatively. No notice is posted for a no-op call.

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

No build step. Restart your dsh service after adding it — new bundles are only picked up on boot.

**`compact_now` requires a `compaction` service reachable from wherever this plugin itself is
mounted** — it reads `ctx.get('compaction')` at its own mount point, nothing fancier. Most profile
templates ship one at the host plane and the ordinary bundle install above is enough. But
`@deepseek-ai/dsh-web-app`-based profiles are different: they disable the host-plane
`compaction-basic` row and instead have each **preset** mount its own private instance inside an
isolated cordis realm (`isolate: { compaction: true }`). Isolation in cordis is strictly downward —
only a plugin mounted as a *descendant of that exact group* can see it (`vendor/cordis/src/service.ts`).
A plugin on the host plane, including this one installed the ordinary way, is that isolated
compaction's ancestor, not a descendant, so it can never see it no matter how cleverly it reads the
service at call time. The only fix is a second, scoped copy of this plugin mounted as a sibling row
inside that same isolated group — which safely coexists with the host-plane copy (dsh-tools' scoped
tool registrations shadow the global one in a separate layer, see `ScopedLayers.merge` in
`packages/core/scope/src/store.ts`).

This package's own `postinstall` script (`scripts/mount-into-presets.mjs`) does that automatically:
it scans `$DSH_HOME/.agent-presets/*/agent.cordis.yml` (your local, user-owned preset overrides —
never a shipped read-only preset under `node_modules`) for any preset that already isolates
`@deepseek-ai/dsh-compaction-basic`, and inserts a scoped `smart-compaction` row as its sibling if
one isn't already there. It's idempotent and a no-op (with a one-line log saying so) on profiles
that don't use presets at all. **Modern npm and pnpm block postinstall scripts by default** —
you'll need to approve it once: `npm install-scripts approve smart-compaction`, or for pnpm, add
`smart-compaction: true` under `allowBuilds` in the profile's `pnpm-workspace.yaml` (or run
`pnpm approve-builds` if your pnpm version offers it) — then reinstall. If you add a new preset
later, or skipped the approval, re-run it anytime with
`npx smart-compaction-mount-into-presets` (or `pnpm exec smart-compaction-mount-into-presets` from
the profile directory).

If `compact_now` still errors with `"no compaction service is configured on this profile"` after
that, your agent's preset genuinely has no `compaction-basic` anywhere in its scope chain — add one
(see [`docs/subsystems/compaction.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/compaction.md)
in the harness repo).

**`context_status` requires `@deepseek-ai/dsh-token-meter` mounted** (it registers the
`contextPressure` projection this tool reads). Unlike `compaction-basic`, the token meter is
deliberately kept on the **host plane** even on preset-isolated profiles (it owns a process-wide,
per-session projection table, not something that should come and go with which preset is mounted),
so the ordinary host-plane install always sees it — no preset patching needed for this one. If it
isn't mounted at all, the tool still installs cleanly and just reports `available: false` instead of
erroring.

### Tell the model when to use it

This is baked into both tools' own descriptions, so it works out of the box with no setup: each
tool's description tells the model to check `context_status` right after finishing a
self-contained step (e.g. right after `todo_write` marks an item `completed`) and to follow up
with `compact_now` once usage climbs past roughly 70-90%. Since both descriptions are sent to the
model on every request automatically, no `AGENTS.md` edit is required for this behavior — unlike
an early version of this plugin, which relied entirely on a hand-written `AGENTS.md` rule and
(measured directly against real session logs) got essentially no organic use as a result: the
description alone wasn't a strong enough signal.

That said, standing instructions carry more weight than a tool description competing against
everything else in a long tool catalog. If you want to reinforce it further, copy
[`agents-snippet.md`](./agents-snippet.md) into your `AGENTS.md` (or whatever your profile injects
as standing instructions).

Tying this to todo-completion matters: it's a real, already-tracked signal for "I just finished a
self-contained unit of work," instead of asking the model to estimate its own remaining work or
guess whether a conversation "feels long," both of which it's generally bad at. `context_status`
replaces that guess with the real number.

The snippet deliberately does *not* say "compact once usage crosses 70-80%" as the primary rule —
a threshold check alone is still reactive: a step that turns out bigger than expected (a large
file, a long diff, a subagent dispatch) can blow straight past a comfortable-looking percentage
*during* that step, which is exactly the mid-step interruption this plugin exists to avoid. The
percentage is kept only as a hard backstop; the primary check is comparing remaining headroom
against the size of the step about to start, and compacting early — before that step, not during
or after it — whenever the fit looks tight.

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
