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
  - `util.ts` — colors, frontmatter parsing, CLI-flag identity resolution
  - `registry.ts` — `~/.pi/wire/agents/` I/O + throttled live-entry cache
  - `transport.ts` — socket bind, line framing, envelope send
  - `server.ts` — inbound connection handlers, respond dispatch
  - `widget.ts` — `NamedEditor` + live pool widget
  - `pool.ts` — ping cycle, peer discovery, target resolution
  - `tools.ts` — `wire_list` / `wire_send` / `wire_respond`
- `test-async.mjs` — the test suite (`node --test`); asserts the async send/respond contract stays async across all extension sources.
- `.pi/settings.json` — project-local install; plain `pi` from repo root loads the extension.

## Commands

```bash
node --test              # run tests (test-async.mjs)
pi --name alice          # manual test: run two sessions and wire_send between them
```

No build, no lint, no package.json. Stdlib only (`node:net`, `node:fs`, etc.) — do not add dependencies.

## Key invariants — don't break these

- **Sends never await replies.** `wire_send` returns a `msg_id` immediately; replies arrive as follow-up messages. There is no `wire_await`. `test_async.mjs` enforces this.
- **One registry, one file per agent**: `~/.pi/wire/agents/<name>.json`, written atomically. Registry reads go through the `liveEntries()` cache (refreshed at most every `PI_WIRE_PING_INTERVAL_MS`), not raw fs calls — keep sync fs off hot paths.
- **Inbound requests must be answered exactly once** via `wire_respond` (or declined).
- Envelopes hop-relayed with `MAX_HOPS` guard; registry entries are pruned when sockets go stale.

## Conventions

- New code goes into the `extensions/wire/` module that owns the concern; `extensions/wire.ts` stays the thin composition root. Shared mutable state lives in the single `WireState` object created in the entry and passed by reference — no module-level mutable state except the registry cache and the refresh guard.
- Env knobs: `PI_WIRE_DIR`, `PI_WIRE_MAX_HOPS`, `PI_WIRE_PING_INTERVAL_MS`, `PI_WIRE_LINE_CAP_BYTES`. Transport timeouts are fixed, not configurable: 5s send cap (transport.ts `sendEnvelope`), 30s idle-socket cap (server.ts `connHandler`).
- Non-trivial logic changes require the test in `test-async.mjs` to still pass; extend it when touching the async contract.
- Commit before refactors — the async rewrite sat uncommitted, which made the split's diff hard to review.
