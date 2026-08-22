# coms — pi2pi extension

Two-way messaging between Pi agents on the same machine. Unix-socket transport.
One global pool: every agent registers in `~/.pi/coms/agents/<name>.json` and
sees every other agent, regardless of working directory.

## Run two collaborating sessions

```bash
# terminal 1
cd ~/pi-coms && pi --name alice --purpose "frontend"

# terminal 2
cd ~/pi-coms && pi --name bob --purpose "backend"
```

The extension is installed project-local (`.pi/settings.json`), so plain `pi`
from `~/pi-coms` loads it — no `-e` needed.

## Identity

Agent name comes from pi's built-in `--name`/`-n` flag (also settable at
runtime via `/name`). Fallback order: `--name` > system-prompt frontmatter
`name` > `agent-<id>`. Names are sanitized for use as registry filenames
(`[^a-zA-Z0-9._-]` → `-`).

Other flags:

- `--purpose <text>` — description shown next to the agent in the pool widget
  (falls back to frontmatter `description`)
- `--color #RRGGBB` — display color (falls back to frontmatter `color`, then a
  deterministic palette pick)
- `--explicit` — hide from peer discovery; only addressable by exact name

## Usage

Either agent: `coms_list` → `coms_send` → `coms_await` (or poll `coms_get`).
Inbound prompts arrive as a bold `@peer>` follow-up message; the receiver's
next turn output is sent back automatically.

A live pool widget under the editor shows peers, their models, and
context-window usage. `/coms [--all]` force-refreshes it (`--all` reveals
`--explicit` agents).

Env knobs: `PI_COMS_DIR`, `PI_COMS_MAX_HOPS`, `PI_COMS_TIMEOUT_MS`,
`PI_COMS_PING_INTERVAL_MS`, `PI_COMS_LINE_CAP_BYTES`.
