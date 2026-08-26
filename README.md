# pi-wire — Two way messaging between Pi Agents

![pi-wire](assets/img/pi-wire.png)

Two-way messaging between Pi agents on the same machine. Unix-socket transport.
One global pool: every agent registers in `~/.pi/wire/agents/<name>.json` and
sees every other agent in the same working directory.

## Installation

From the repo root:

```bash
pi install /path/to/pi-wire/extensions/wire.ts
```

Install the `wire.ts` entry point, including the `.ts` suffix. Do not install
`extensions/wire`; that directory contains helper modules, not another
extension. If that path was previously installed, remove it with:

```bash
pi remove /path/to/pi-wire/extensions/wire
```

Or copy the repo's `.pi/settings.json` pattern — add the extension path to
`packages` — and run plain `pi` from the repo root.

## Run two collaborating sessions

```bash
# terminal 1
cd ~/path/to/workspace && pi --name alice

# terminal 2
cd ~/path/to/another-workspace && pi --name bob
```

The extension is installed project-local (`.pi/settings.json`), so plain `pi`
from `~/pi-wire` loads it — no `-e` needed.

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

Either agent: `wire_list` → `wire_send`. Sending never waits for the peer's
answer: the sender keeps working, and the reply arrives automatically as a
follow-up message, queued until its current work finishes. Inbound prompts tell
the receiver to use `wire_respond` to reply or explicitly decline.

A live pool widget under the editor shows peers, their models, and
context-window usage. `/wire [--all]` force-refreshes it (`--all` reveals
`--explicit` agents).

Env knobs: `PI_WIRE_DIR`, `PI_WIRE_MAX_HOPS`, `PI_WIRE_PING_INTERVAL_MS`,
`PI_WIRE_LINE_CAP_BYTES`.
