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
