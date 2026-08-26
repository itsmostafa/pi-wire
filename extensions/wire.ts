/**
 * wire — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a single endpoint (unix socket on POSIX, named pipe on
 * Windows) and discovers peers through registry files under
 * ~/.pi/wire/agents/<name>.json — one global pool, all agents see each other.
 *
 * Composition root: registers flags, renderers, tools, hooks, the /wire
 * command, and owns the session lifecycle (bind, registry, ping/keepalive
 * cycles, clean shutdown). All logic lives in ./wire/*:
 *   types.ts     constants, envelopes, shared WireState
 *   util.ts      colors, frontmatter, identity resolution
 *   registry.ts  ~/.pi/wire/agents I/O + live-entry cache
 *   transport.ts socket bind, line framing, envelope send
 *   server.ts    inbound connection handlers, respond dispatch
 *   widget.ts    NamedEditor + live pool widget
 *   pool.ts      ping cycle, peer discovery, target resolution
 *   tools.ts     wire_list / wire_send / wire_respond
 *
 * Usage: pi -e extensions/wire.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { WIRE_DIR, WireState, KEEPALIVE_INTERVAL_MS, PING_INTERVAL_MS, RegistryEntry } from "./wire/types";
import { fallbackColor, hexFg, isValidHex, makeEndpoint, nowIso, readCliFlags, readFrontmatterFromArgv } from "./wire/util";
import { agentsDir, removeRegistryEntry, resolveUniqueName, writeRegistryAtomic } from "./wire/registry";
import { bindEndpoint } from "./wire/transport";
import { createConnHandler, dispatchInboundResponse, sendErrorResponse } from "./wire/server";
import { NamedEditor, installPoolWidget } from "./wire/widget";
import { refreshPool } from "./wire/pool";
import { registerTools } from "./wire/tools";

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
    // ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
    // Without these, pi 0.73+ rejects the invocation with "Unknown options:
    // --purpose, ..." before this extension's hooks ever fire.
    // Agent name uses pi's built-in --name/-n flag — no extension flag needed.
    pi.registerFlag("purpose", {
        description: "Override agent purpose (otherwise from frontmatter description)",
        type: "string",
        default: undefined,
    });
    pi.registerFlag("color", {
        description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
        type: "string",
        default: undefined,
    });
    pi.registerFlag("explicit", {
        description: "Hide this agent from auto-discovery; only addressable by exact name",
        type: "boolean",
        default: false,
    });

    pi.registerMessageRenderer("wire-inbound", (message, { outputPad }, theme) => {
        const sender = (message.details as { sender_name: string }).sender_name;
        const tag = `@${sender}>`;
        const box = new Box(outputPad, 1, (text) => text);
        box.addChild(new Text(`${theme.fg("accent", theme.bold(tag))}\n\n${String(message.content).slice(tag.length + 2)}`, 0, 0));
        return box;
    });

    pi.registerMessageRenderer("wire-response", (message, { outputPad }, theme) => {
        const sender = (message.details as { sender_name: string }).sender_name;
        const tag = `@${sender}<`;
        const box = new Box(outputPad, 1, (text) => text);
        box.addChild(new Text(`${theme.fg("accent", theme.bold(tag))}\n\n${String(message.content).slice(tag.length + 2)}`, 0, 0));
        return box;
    });

    // Shared mutable state — one instance per extension load, threaded through
    // every module that needs it.
    const state: WireState = {
        identity: null,
        peerCards: new Map(),
        inboundQueue: new Map(),
        seenResponseIds: new Set(),
        shuttingDown: false,
        inflightResponses: new Set(),
        includeExplicit: false,
        currentCtx: null,
        currentInbound: null,
    };

    // Session-lifecycle resources owned here, not shared with other modules.
    let server: net.Server | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;

    // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pi.on("session_start", async (_event, ctx) => {
        state.currentCtx = ctx;

        // 1. Resolve identity from CLI flags > frontmatter > defaults.
        const flags = readCliFlags(pi);
        const fm = readFrontmatterFromArgv(process.argv);
        const explicit = flags.explicit === true;
        const session_id = crypto.randomUUID();
        const cwd = ctx.cwd || process.cwd();

        const defaultName = `agent-${session_id.replace(/-/g, "").slice(-6)}`;
        // --name accepts free text; registry keys are filenames, so sanitize.
        const desiredName = (flags.name || fm.name || defaultName)
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || defaultName;
        const name = resolveUniqueName(desiredName);
        if (name !== desiredName) {
            try {
                pi.appendEntry("wire-log", { event: "name_collision", desired: desiredName, assigned: name });
            } catch {
                // best-effort
            }
        }
        const purpose = flags.purpose || fm.description || "";

        // Color: validate at every level; fall through invalid hex to next.
        // Order: --color CLI flag > frontmatter color > deterministic fallback.
        let color = fallbackColor(session_id);
        if (fm.color && isValidHex(fm.color)) {
            color = fm.color;
        }
        if (flags.color && isValidHex(flags.color)) {
            color = flags.color;
        }

        const endpoint = makeEndpoint(session_id);
        const model = ctx.model?.id ?? "unknown";

        // 2. Ensure storage dirs exist.
        try {
            fs.mkdirSync(agentsDir(), { recursive: true });
            if (process.platform !== "win32") {
                fs.mkdirSync(path.join(WIRE_DIR, "sockets"), { recursive: true });
                try { fs.chmodSync(WIRE_DIR, 0o700); } catch { /* best-effort */ }
            }
        } catch (err) {
            ctx.ui?.notify?.(`📡 wire: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
        }

        // 3. Bind the endpoint.
        try {
            server = await bindEndpoint(endpoint, createConnHandler(pi, state));
        } catch (err) {
            ctx.ui?.notify?.(`📡 wire: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
        }

        // 4. Build + write registry entry atomically.
        const entry: RegistryEntry = {
            session_id,
            name,
            purpose,
            model,
            color,
            pid: process.pid,
            endpoint,
            cwd,
            started_at: nowIso(),
            explicit,
            version: 1,
        };
        let registryFile: string;
        try {
            registryFile = writeRegistryAtomic(entry);
        } catch (err) {
            ctx.ui?.notify?.(`📡 wire: registry write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
            try { server?.close(); } catch { /* ignore */ }
            return;
        }

        state.identity = {
            session_id,
            name,
            purpose,
            color,
            explicit,
            cwd,
            model,
            endpoint,
            registryFile,
            started_at: entry.started_at,
        };
        state.includeExplicit = false;

        // 5. Audit log: boot.
        try {
            pi.appendEntry("wire-log", { event: "boot", session_id, name });
        } catch {
            // best-effort
        }

        // 6. Surface presence in the UI + install the live pool widget.
        try {
            ctx.ui.setStatus("wire", name);
            installPoolWidget(state, ctx);
            if (ctx.hasUI && (flags.name || fm.name)) {
                // Only label the editor when the agent was deliberately named;
                // auto-generated agent-XXXXX names stay off the input border.
                ctx.ui.setEditorComponent((tui, theme, keybindings) =>
                    new NamedEditor(tui, theme, keybindings, hexFg(color, ` ${name} `)));
            }
            ctx.ui.notify(`📡 ready · ${name}`, "info");
        } catch {
            // hasUI may be false in some contexts — non-fatal.
        }

        // 7. Start ping + keepalive cycles.
        pingTimer = setInterval(() => { refreshPool(state).catch(() => {}); }, PING_INTERVAL_MS);
        try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
        keepaliveTimer = setInterval(() => {
            if (!state.identity) return;
            try {
                const ctx = state.currentCtx;
                const live: RegistryEntry = {
                    session_id: state.identity.session_id,
                    name: state.identity.name,
                    purpose: state.identity.purpose,
                    model: ctx?.model?.id ?? state.identity.model,
                    color: state.identity.color,
                    pid: process.pid,
                    endpoint: state.identity.endpoint,
                    cwd: state.identity.cwd,
                    started_at: state.identity.started_at,
                    explicit: state.identity.explicit,
                    version: 1,
                };
                // Unconditional atomic write: pure self-heal (re-create the entry if
                // the file was unlinked under us).
                writeRegistryAtomic(live);
            } catch { /* best-effort */ }
        }, KEEPALIVE_INTERVAL_MS);
        try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }

        // Kick one ping cycle immediately so the widget populates fast.
        refreshPool(state).catch(() => {});
    });

    // ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    registerTools(pi, state);

    // Track the request whose follow-up is actually being processed, rather than
    // whichever request happened to arrive most recently.
    pi.on("message_start", (event) => {
        if (event.message.role !== "custom" || event.message.customType !== "wire-inbound") return;
        const msg_id = (event.message.details as { msg_id?: string } | undefined)?.msg_id;
        const inbound = msg_id ? state.inboundQueue.get(msg_id) : undefined;
        if (inbound) {
            inbound.started = true;
            state.currentInbound = inbound;
        }
    });

    pi.on("agent_settled", () => {
        // agent_end can precede auto-retry, compaction retry, or queued follow-up
        // continuations — cleaning up there would prematurely finalize requests
        // Pi is about to keep working on. agent_settled means Pi will not run
        // again automatically, so started-but-unanswered requests are truly done.
        // Unstarted requests remain queued for the next continuation.
        for (const inbound of state.inboundQueue.values()) {
            if (!inbound.started) continue;
            state.inboundQueue.delete(inbound.msg_id);
            void sendErrorResponse(pi, state, inbound, "interrupted");
        }
        state.currentInbound = null;
    });

    // ━━ /wire slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pi.registerCommand("wire", {
        description: "Force-refresh the wire pool widget (--all toggles hidden --explicit agents)",
        handler: async (args, ctx) => {
            if ((args ?? "").trim().includes("--all")) {
                state.includeExplicit = !state.includeExplicit;
                try { ctx.ui.notify(`wire: include_explicit = ${state.includeExplicit}`, "info"); } catch { /* best-effort */ }
            }
            await refreshPool(state);
        },
    });

    // ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let shutdownPromise: Promise<void> | null = null;
    function cleanShutdown(): Promise<void> {
        if (!shutdownPromise) shutdownPromise = doCleanShutdown();
        return shutdownPromise;
    }
    async function doCleanShutdown(): Promise<void> {
        // Gate inbound admission immediately: server.close() only stops new
        // accepts, so an already-accepted socket could still deliver a prompt
        // after the notification snapshot below. handlePrompt/handleResponse
        // nack while this flag is set.
        state.shuttingDown = true;
        if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
        if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
        if (server) {
            try { server.close(); } catch { /* ignore */ }
            server = null;
        }
        // Let in-flight wire_respond dispatches finish (each bounded by the
        // fixed 5s transport cap); successes remove their queue entries
        // themselves, failures retain them for the notification below.
        await Promise.allSettled([...state.inflightResponses]);
        // Notify every accepted-but-unanswered inbound request before teardown —
        // otherwise the requester waits forever for a reply that will never come.
        const pending = [...state.inboundQueue.values()];
        for (const inbound of pending) state.inboundQueue.delete(inbound.msg_id);
        if (pending.length > 0) {
            await Promise.allSettled(pending.map((inbound) => sendErrorResponse(pi, state, inbound, "peer session ended")));
        }
        if (state.identity) {
            if (process.platform !== "win32") {
                try { fs.unlinkSync(state.identity.endpoint); } catch { /* ignore */ }
            }
            try { removeRegistryEntry(state.identity.name); } catch { /* ignore */ }
            try {
                pi.appendEntry("wire-log", { event: "shutdown", session_id: state.identity.session_id });
            } catch {
                // best-effort
            }
        }
        if (state.currentCtx?.hasUI) {
            try { state.currentCtx.ui.setWidget("wire-pool", undefined); } catch { /* ignore */ }
        }
    }

    // pi routes Ctrl+C, Ctrl+D, SIGHUP and SIGTERM through session_shutdown
    // (see docs/extensions.md lifecycle) — no raw process signal listeners here.
    // Raw listeners would also accumulate across /reload since extensions are
    // re-loaded in the same process.
    pi.on("session_shutdown", async () => { await cleanShutdown(); });
}
