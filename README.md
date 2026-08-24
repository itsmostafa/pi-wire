# coms — pi2pi extension

Two-way messaging between Pi agents on the same machine. Unix-socket transport.
One global pool: every agent registers in `~/.pi/coms/agents/<name>.json` and
sees every other agent in the same working directory.

## Installation

From the repo root:

```bash
pi install /path/to/pi-coms/extensions/coms.ts
```

Or copy the repo's `.pi/settings.json` pattern — add the extension path to
`packages` — and run plain `pi` from the repo root.

## Run two collaborating sessions

```bash
# terminal 1
cd ~/common-workspace && pi --name alice

# terminal 2
cd ~/common-workspace && pi --name bob
```

The extension is installed project-local (`.pi/settings.json`), so plain `pi`
from `~/pi-coms` loads it — no `-e` needed.

## Identity

Agent name comes from pi's built-in `--name`/`-n` flag (also settable at
runtime via `/name`). Fallback order: `--name` > system-prompt frontmatter
`name` > `agent-<id>`. Names are sanitized for use as registry filenames
(`[^a-zA-Z0-9._-]` → `-`).

Other flags:

- `--color #RRGGBB` — display color (falls back to frontmatter `color`, then a
  deterministic palette pick)
- `--explicit` — hide from peer discovery; only addressable by exact name

## Usage

Either agent: `coms_list` → `coms_send`. Sending never waits for the peer's
answer: the sender keeps working, and the reply arrives automatically as a
follow-up message, queued until its current work finishes. Inbound prompts tell
the receiver to use `coms_respond` to reply or explicitly decline.

A live pool widget under the editor shows peers, their models, and
context-window usage. `/coms [--all]` force-refreshes it (`--all` reveals
`--explicit` agents).

Env knobs: `PI_COMS_DIR`, `PI_COMS_MAX_HOPS`, `PI_COMS_PING_INTERVAL_MS`,
`PI_COMS_LINE_CAP_BYTES`.

## Long-running tasks & reliability ceiling

`coms` is designed for long-running single-hop work: a `coms_send` waits only
for the transport ack (never the peer's answer — a 30-minute task holds no
connection and trips no timeout), replies arrive as queued follow-ups, and
peer liveness is PID-based, so a busy agent is never pruned mid-task.

Guarantees and known ceilings (deliberate — no durable bookkeeping):

- **Responses are at-most-once per msg_id, in-memory.** The receiver dedups
  terminal responses by msg_id, so a responder retry after a lost ACK or a
  racing "interrupted" cleanup can't double-deliver. The dedup cache is
  bounded (512 entries, FIFO) — the guarantee holds within that window; a
  duplicate of an evicted msg_id would be delivered again. Nothing survives
  a hard kill: if the responder crashes or is SIGKILLed after acking
  the prompt, the requester is never notified. Graceful shutdown
  (`SIGINT`/`SIGTERM`, `/new`, `/resume`, `/fork`) best-effort notifies every
  accepted-but-unanswered request ("peer session ended") before teardown.
  Prompt retries are NOT deduped — each `coms_send` is a fresh msg_id, so a
  model retry after a failed send creates a new request.
- **One endpoint per session identity.** `/new`, `/resume`, `/fork`, `/reload`
  replace the endpoint; late replies targeting the old socket are lost. Keep
  the requester session alive for the whole task.
- **No durable multi-hop relay.** If B delegates part of A's request to C and
  B's run settles before C replies, A is told "interrupted". Long delegated
  chains don't compose; keep long tasks single-hop.
- **Payload bound is the transport line cap** (`PI_COMS_LINE_CAP_BYTES`, default
  10 MB) — send file paths or summaries for large results, both to stay under
  the cap and to avoid blowing the peer's model context.
- **Responses are retried by the model, not the transport.** A failed
  `coms_respond` delivery throws a tool error (inbound retained, retryable,
  deduped at the receiver); an auto-cleanup (interrupted run, shutdown) is
  fire-and-forget.
