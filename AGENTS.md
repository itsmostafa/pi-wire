# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

`wire` — a pi2pi extension providing two-way messaging between Pi agents on
the same machine via Unix sockets. Multi-file TypeScript extension (entry +
`extensions/wire/` modules), no build step, no external dependencies.

## Layout

- `extensions/wire.ts` — extension entry point (composition root): CLI flags, message renderers, session lifecycle, `/wire` command, clean shutdown.
- `extensions/wire/` — modules the entry wires together:
  - `types.ts` — constants, envelope/registry types, shared `WireState`
  - `util.ts` — colors, legacy system-prompt frontmatter parsing, CLI-flag identity resolution
  - `agents.ts` — agent definition discovery, host frontmatter parsing, selection and configuration validation
  - `registry.ts` — `~/.pi/wire/agents/` I/O + throttled live-entry cache
  - `transport.ts` — socket bind, line framing, envelope send
  - `server.ts` — inbound connection handlers, respond dispatch
  - `widget.ts` — `NamedEditor` + live pool widget
  - `pool.ts` — ping cycle, peer discovery, target resolution
  - `tools.ts` — `wire_list` / `wire_send` / `wire_respond`
- `test-async.mjs` — stdlib-only tests; asserts the async send/respond contract stays async across all extension sources.
- `test-agents.mjs` — definition parsing/selection and mocked extension-lifecycle tests; uses an installed Pi package's real parsers.
- `wire-test-resolve-hook.mjs` — test-only loader for extensionless TS imports and installed Pi packages.
- `.pi/settings.json` — project-local install; plain `pi` from repo root loads the extension.
- `Taskfile.yml` — `task check` (lint + test in parallel), `task lint`, `task test`; holds the pinned oxlint version.

## Commands

```bash
task                     # list tasks
task check               # lint + tests in parallel
task test                # all tests; native TS support and installed Pi 0.85.1+ required
node --test test-async.mjs # stdlib-only messaging tests
pi --name alice          # manual test: run two sessions and wire_send between them
pi --wire-agent reviewer # configure from ~/.pi/agent/agents/*.md
task lint                # lint (oxlint); must stay at zero findings
```

No build, no package.json. Stdlib only (`node:net`, `node:fs`, etc.) — do not add dependencies.

## Key invariants — don't break these

- **Sends never await replies.** `wire_send` returns a `msg_id` immediately; replies arrive as follow-up messages. There is no `wire_await`. `test-async.mjs` enforces this.
- **One registry, one file per agent**: `~/.pi/wire/agents/<name>.json`, written atomically. Registry reads go through the `liveEntries()` cache (refreshed at most every `PI_WIRE_PING_INTERVAL_MS`), not raw fs calls — keep sync fs off hot paths.
- **Inbound requests must be answered exactly once** via `wire_respond` (or declined).
- Envelopes hop-relayed with `MAX_HOPS` guard; registry entries are pruned when sockets go stale.
- Definition launches fail closed before registration/persona activation on validation or configuration errors. All three wire tools must remain active. Legacy launches without `--wire-agent` keep their identity fallback order (`--name` > frontmatter > generated) — but not the removed `--purpose` flag, and not Pi below 0.85.1.
- Project definitions require explicit `project`/`both` scope and `ctx.isProjectTrusted()`. Use Pi's parsers and config roots; `PI_WIRE_DIR` affects transport storage only.
- Definitions load once per `session_start`; one factory-level `before_agent_start` handler appends the successful body to the current event prompt. No prompt accumulation or module-level definition cache.

## Conventions

- New code goes into the `extensions/wire/` module that owns the concern; `extensions/wire.ts` stays the thin composition root. Shared mutable state lives in the single `WireState` object created in the entry and passed by reference — no module-level mutable state except the registry cache and the refresh guard.
- Env knobs: `PI_WIRE_DIR`, `PI_WIRE_MAX_HOPS`, `PI_WIRE_PING_INTERVAL_MS`, `PI_WIRE_LINE_CAP_BYTES`. Transport timeouts are fixed, not configurable: 5s send cap (transport.ts `sendEnvelope`), 30s idle-socket cap (server.ts `connHandler`).
- Non-trivial logic changes require the test in `test-async.mjs` to still pass; extend it when touching the async contract.
- Lint is oxlint on its default (correctness) rules, no config file. Version is pinned in `Taskfile.yml` since there is no package.json to hold it. Fix findings rather than suppressing them; add a config only when a default rule genuinely misfires here.
- Commit before refactors — the async rewrite sat uncommitted, which made the split's diff hard to review.
