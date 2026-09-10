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
 *   agents.ts    definition discovery, validation, configuration
 *   registry.ts  ~/.pi/wire/agents I/O + live-entry cache
 *   transport.ts socket bind, line framing, envelope send
 *   server.ts    inbound connection handlers, respond dispatch
 *   widget.ts    NamedEditor + live pool widget
 *   session-live.ts in-memory streaming snapshots
 *   session-view.ts read-only peer session overlay
 *   pool.ts      ping cycle, peer discovery, target resolution
 *   tools.ts     wire_list / wire_send / wire_respond
 *
 * Usage: pi -e extensions/wire.ts
 */

import { parseArgs } from "@earendil-works/pi-coding-agent";
import type { Args, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { WIRE_DIR, KEEPALIVE_INTERVAL_MS, PING_INTERVAL_MS } from "./wire/types";
import type { RegistryEntry, WireState } from "./wire/types";
import { fallbackColor, hexFg, isValidHex, makeEndpoint, nowIso, readCliFlags, readFrontmatterFromArgv } from "./wire/util";
import { agentsDir, removeRegistryEntry, resolveUniqueName, writeRegistryAtomic } from "./wire/registry";
import { bindEndpoint } from "./wire/transport";
import { createConnHandler, sendErrorResponse } from "./wire/server";
import { NamedEditor, installPoolWidget } from "./wire/widget";
import { refreshPool } from "./wire/pool";
import { registerTools } from "./wire/tools";
import { registerSessionLive } from "./wire/session-live";
import { configureAgentDefinition, selectAgentDefinition, type AgentDefinition, type AgentScope } from "./wire/agents";

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
    // ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
    // Without these, pi 0.73+ rejects the invocation with "Unknown options:
    // --color, ..." before this extension's hooks ever fire.
    // Agent name uses pi's built-in --name/-n flag — no extension flag needed.
    // Purpose has no flag: it always comes from the definition or frontmatter
    // description, so there is one and only one place to edit it.
    pi.registerFlag("color", {
        description: "Hex color #RRGGBB (otherwise from definition, frontmatter, or palette)",
        type: "string",
        default: undefined,
    });
    pi.registerFlag("explicit", {
        description: "Hide this agent from auto-discovery; only addressable by exact name",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("wire-agent", {
        description: "Load this wire peer from an agent definition",
        type: "string",
        default: undefined,
    });
    pi.registerFlag("wire-agent-scope", {
        description: "Agent definition scope: user, project, or both",
        type: "string",
        default: "user",
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
        poolSelected: null,
        currentCtx: null,
        currentInbound: null,
        definitionBody: null,
        liveTools: new Map(),
        liveStatus: "idle",
    };

    registerSessionLive(pi, state);

    // Session-lifecycle resources owned here, not shared with other modules.
    let server: net.Server | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;

    // The persona is injected per turn, never into a saved prompt. A failed
    // startup leaves this null, including after a reload.
    pi.on("before_agent_start", (event) => {
        if (!state.definitionBody) return;
        return { systemPrompt: `${event.systemPrompt}\n\n${state.definitionBody}` };
    });

    function reportStartError(ctx: ExtensionContext, error: unknown): void {
        const message = `📡 wire: agent definition failed — ${error instanceof Error ? error.message : String(error)}`;
        if (ctx.hasUI) ctx.ui?.notify?.(message, "error");
        else console.error(message);
    }

    // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pi.on("session_start", async (_event, ctx) => {
        state.currentCtx = ctx;
        state.definitionBody = null;

        // With no definition, retain the old identity/frontmatter launch path.
        const flags = readCliFlags(pi);
        const fm = readFrontmatterFromArgv(process.argv);
        const requestedAgent = pi.getFlag("wire-agent") as string | undefined;
        let definition: AgentDefinition | undefined;
        let cli: Args | undefined;
        // configureAgentDefinition must run before the bind — setModel's success is
        // only observable by calling it, and a definition failure must bind nothing.
        // So the model/tool mutation lands before steps 2-4, which can still fail;
        // every failure path from here on reverts it. Null unless a definition ran.
        let unwind: (() => Promise<void>) | null = null;
        if (requestedAgent !== undefined) {
            try {
                if (typeof requestedAgent !== "string" || requestedAgent.trim() === "") {
                    throw new Error("--wire-agent requires a definition name");
                }
                const scope = pi.getFlag("wire-agent-scope") as AgentScope;
                if (scope !== "user" && scope !== "project" && scope !== "both") {
                    throw new Error("--wire-agent-scope must be user, project, or both");
                }
                if (scope !== "user" && !ctx.isProjectTrusted()) {
                    throw new Error("project agent definitions require a trusted project");
                }
                definition = selectAgentDefinition(ctx.cwd || process.cwd(), scope, requestedAgent, {
                    onDiagnostic: (message) => {
                        if (ctx.hasUI) ctx.ui.notify(message, "warning");
                        else console.error(message);
                    },
                });
                cli = parseArgs(process.argv.slice(2));

                // Captured before the mutation. Both halves are self-guarding, so
                // unwinding is a no-op unless something was actually applied —
                // which is why the catch below can call it unconditionally.
                const prevModel = ctx.model;
                const prevTools = pi.getActiveTools();
                unwind = async () => {
                    try {
                        if (prevModel && ctx.model !== prevModel) await pi.setModel(prevModel);
                        // Compare by content: the host may hand back a fresh array.
                        if (pi.getActiveTools().join("\0") !== prevTools.join("\0")) pi.setActiveTools(prevTools);
                    } catch { /* best-effort */ }
                };
                await configureAgentDefinition(pi, ctx, definition, cli);
            } catch (error) {
                // configureAgentDefinition validates before mutating, with one
                // exception: its final wire-tool check runs after, because the
                // host drops unknown tools and model hooks may change the set.
                if (unwind) await unwind();
                reportStartError(ctx, error);
                return;
            }
        }

        // 1. Resolve identity from CLI flags > definition > frontmatter > defaults.
        const explicit = flags.explicit === true;
        const session_id = crypto.randomUUID();
        const cwd = ctx.cwd || process.cwd();
        const defaultName = `agent-${session_id.replace(/-/g, "").slice(-6)}`;
        // A restored session name is legacy fallback only; it cannot outrank a definition.
        const desiredName = ((definition ? cli?.name ?? definition.name : flags.name) || fm.name || defaultName)
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
        const purpose = definition ? definition.description : fm.description || "";

        // Color: validate at every level; fall through invalid hex to next.
        // Order: --color CLI flag > definition > frontmatter > palette fallback.
        let color = fallbackColor(session_id);
        if (fm.color && isValidHex(fm.color)) color = fm.color;
        if (definition?.color) color = definition.color;
        if (flags.color && isValidHex(flags.color)) color = flags.color;

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
            if (unwind) await unwind();
            return;
        }

        // 3. Bind the endpoint.
        try {
            server = await bindEndpoint(endpoint, createConnHandler(pi, state));
        } catch (err) {
            ctx.ui?.notify?.(`📡 wire: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
            if (unwind) await unwind();
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
            session_file: ctx.sessionManager?.getSessionFile?.(),
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
            if (unwind) await unwind();
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
        state.definitionBody = definition?.body || null;

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
            if (ctx.hasUI) {
                // Always ours: NamedEditor also carries the pool list's keyboard,
                // and widgets never receive input. Only the border label is
                // conditional — auto-generated agent-XXXXX names stay off it.
                const label = (flags.name || definition?.name || fm.name) ? hexFg(color, ` ${name} `) : "";
                ctx.ui.setEditorComponent((tui, theme, keybindings) =>
                    new NamedEditor(tui, theme, keybindings, label, state));
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
                    session_file: ctx?.sessionManager?.getSessionFile?.(),
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
        // A shutdown or failed reload must never leave the old persona active.
        state.definitionBody = null;
        // Gate inbound admission immediately: server.close() only stops new
        // accepts, so an already-accepted socket could still deliver a prompt
        // after the notification snapshot below. handlePrompt/handleResponse
        // nack while this flag is set.
        state.shuttingDown = true;
        state.closeSessionViewer?.();
        if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
        if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
        if (server) {
            try { server.close(); } catch { /* ignore */ }
            server = null;
        }
        // Let in-flight wire_respond dispatches finish (each bounded by the
        // fixed 5s transport cap); successes remove their queue entries
        // themselves, failures retain them for the notification below.
        await Promise.allSettled(state.inflightResponses);
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
        state.identity = null;
        state.poolSelected = null;
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
