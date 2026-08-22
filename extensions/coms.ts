/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a single endpoint (unix socket on POSIX, named pipe on
 * Windows) and discovers peers through registry files under
 * ~/.pi/coms/agents/<name>.json — one global pool, all agents see each other.
 *
 * Phase A (foundation): identity resolution, registry I/O, transport bind/send,
 * connection handlers. Phase B: tools (coms_list/send/get/await), agent_end
 * response capture. Phase C: live pool widget, ping + keepalive cycles, /coms
 * slash command, clean shutdown lifecycle.
 *
 * Usage: pi -e extensions/coms.ts
 */

import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExtensionDefaults } from "./themeMap.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseEnvInt(name: string, fallback: number, min?: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const val = Number(raw);
    if (!Number.isFinite(val) || Number.isNaN(val)) return fallback;
    const clamped = min !== undefined ? Math.max(min, val) : val;
    return clamped;
}

const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = parseEnvInt("PI_COMS_MAX_HOPS", 5, 1);
const TIMEOUT_MS = parseEnvInt("PI_COMS_TIMEOUT_MS", 1_800_000, 0);
const PING_INTERVAL_MS = parseEnvInt("PI_COMS_PING_INTERVAL_MS", 2_000, 100);
const KEEPALIVE_INTERVAL_MS = 30_000;
const LINE_CAP_BYTES = parseEnvInt("PI_COMS_LINE_CAP_BYTES", 10 * 1024 * 1024, 1024);

const FALLBACK_PALETTE = [
    "#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
    "#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping";

interface Envelope {
    type: EnvelopeType;
    msg_id: string;
    sender_session: string;
    sender_endpoint: string;
    hops: number;
    timestamp: string;
}

interface PromptEnvelope extends Envelope {
    type: "prompt";
    prompt: string;
    sender_name: string;
    sender_cwd: string;
    conversation_id?: string | null;
    response_schema?: object | null;
}

interface ResponseEnvelope extends Envelope {
    type: "response";
    response: any;
    error?: string | null;
}

interface PingEnvelope extends Envelope {
    type: "ping";
}

interface AgentCard {
    name: string;
    purpose: string;
    model: string;
    color: string;
    context_used_pct: number;
    queue_depth: number;
}

interface Pong {
    type: "pong";
    msg_id: string;
    agent_card: AgentCard;
}

interface RegistryEntry {
    session_id: string;
    name: string;
    purpose: string;
    model: string;
    color: string;
    pid: number;
    endpoint: string;
    cwd: string;
    started_at: string;
    explicit: boolean;
    version: number;
    // Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
    // Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
    context_used_pct?: number;
    queue_depth?: number;
    heartbeat_at?: string;
}

interface PendingReply {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout | null;
    promise: Promise<{ response?: any; error?: string | null }>;
    result?: { response?: any; error?: string | null };
    target_name?: string;
    created_at: string;
}

interface InboundContext {
    msg_id: string;
    hops: number;
    sender_endpoint: string;
    sender_session: string;
    response_schema?: object | null;
    fulfilled: boolean;
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
    const time = Date.now();
    const rand = crypto.randomBytes(10);
    let timeStr = "";
    let t = time;
    for (let i = 9; i >= 0; i--) {
        timeStr = CROCKFORD[t % 32] + timeStr;
        t = Math.floor(t / 32);
    }
    let randStr = "";
    let bits = 0;
    let value = 0;
    for (const byte of rand) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            randStr += CROCKFORD[(value >> bits) & 31];
        }
    }
    return (timeStr + randStr).slice(0, 26);
}

function hexFg(hex: string, s: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function isValidHex(hex: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(sessionId: string): string {
    const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
    return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { body: raw };
    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            const key = line.slice(0, idx).trim();
            let val = line.slice(idx + 1).trim();
            // strip surrounding quotes for values like color: "#36F9F6"
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            frontmatter[key] = val;
        }
    }
    return {
        name: frontmatter.name,
        description: frontmatter.description,
        color: frontmatter.color,
        body: match[2],
    };
}

function makeEndpoint(sessionId: string): string {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\pi-coms-${sessionId}`;
    }
    return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

function nowIso(): string {
    return new Date().toISOString();
}

function abbreviateModel(model: string): string {
    let m = model || "";
    if (m.startsWith("claude-")) m = m.slice("claude-".length);
    if (m.length > 14) m = m.slice(0, 14);
    return m;
}

// ━━ CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━━━━━━━━━━━━━━━━━━

interface CliFlags {
    name?: string;
    purpose?: string;
    color?: string;
    explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
    // Identity flags are declared via pi.registerFlag at extension load time so
    // pi's CLI parser accepts them; here we just read them back.
    // Agent name comes from pi's built-in --name/-n (read via getSessionName).
    const name = pi.getSessionName();
    const purpose = pi.getFlag("purpose") as string | undefined;
    const color = pi.getFlag("color") as string | undefined;
    const explicit = pi.getFlag("explicit") as boolean | undefined;
    return {
        name: name && name.length > 0 ? name : undefined,
        purpose: purpose && purpose.length > 0 ? purpose : undefined,
        color: color && color.length > 0 ? color : undefined,
        explicit: explicit === true,
    };
}

// ━━ Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function agentsDir(): string {
    return path.join(COMS_DIR, "agents");
}

function registryFilePath(name: string): string {
    return path.join(agentsDir(), `${name}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry): string {
    const dir = agentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const final = registryFilePath(entry.name);
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, final);
    return final;
}

function readAllRegistryEntries(): RegistryEntry[] {
    const dir = agentsDir();
    if (!fs.existsSync(dir)) return [];
    const out: RegistryEntry[] = [];
    let files: string[];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
            const raw = fs.readFileSync(path.join(dir, f), "utf-8");
            const parsed = JSON.parse(raw) as RegistryEntry;
            if (parsed && typeof parsed.session_id === "string") {
                out.push(parsed);
            }
        } catch {
            // skip malformed
        }
    }
    return out;
}

function removeRegistryEntry(name: string): void {
    try {
        fs.unlinkSync(registryFilePath(name));
    } catch {
        // best-effort
    }
}

function pruneDeadEntries(): RegistryEntry[] {
    const entries = readAllRegistryEntries();
    const live: RegistryEntry[] = [];
    for (const entry of entries) {
        try {
            process.kill(entry.pid, 0);
            live.push(entry);
        } catch (e: any) {
            if (e && e.code === "ESRCH") {
                removeRegistryEntry(entry.name);
            } else {
                // EPERM means the process exists but we can't signal it — treat as live.
                live.push(entry);
            }
        }
    }
    return live;
}

// Registry cache — the render path and tools read from here; refreshed at most
// every PING_INTERVAL_MS so sync fs stays off hot paths.
let cachedEntries: RegistryEntry[] = [];
let cachedEntriesAt = 0;
function liveEntries(): RegistryEntry[] {
    if (Date.now() - cachedEntriesAt > PING_INTERVAL_MS) {
        cachedEntries = pruneDeadEntries();
        cachedEntriesAt = Date.now();
    }
    return cachedEntries;
}

function resolveUniqueName(desiredName: string): string {
    // Returns a name that doesn't collide with any LIVE registered agent.
    // pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
    const liveEntries = pruneDeadEntries();
    const liveNames = new Set(liveEntries.map(e => e.name));
    if (!liveNames.has(desiredName)) return desiredName;
    let n = 2;
    while (liveNames.has(`${desiredName}${n}`)) n++;
    return `${desiredName}${n}`;
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
    return new Promise((resolve) => {
        const sock = net.createConnection({ path: endpoint });
        let settled = false;
        const finish = (verdict: "in_use" | "stale") => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* ignore */ }
            resolve(verdict);
        };
        const timer = setTimeout(() => finish("stale"), 250);
        sock.once("connect", () => {
            clearTimeout(timer);
            finish("in_use");
        });
        sock.once("error", (err: any) => {
            clearTimeout(timer);
            if (err && err.code === "ECONNREFUSED") {
                finish("stale");
            } else {
                // ENOENT or other — treat as stale (file may be gone or unusable)
                finish("stale");
            }
        });
    });
}

async function bindEndpoint(
    endpoint: string,
    connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
    if (process.platform !== "win32" && fs.existsSync(endpoint)) {
        const verdict = await probeStaleSocket(endpoint);
        if (verdict === "in_use") {
            throw new Error(`coms: endpoint already in use (${endpoint})`);
        }
        try {
            fs.unlinkSync(endpoint);
        } catch {
            // best-effort
        }
    }
    return await new Promise<net.Server>((resolve, reject) => {
        const server = net.createServer(connHandler);
        server.once("error", reject);
        server.listen(endpoint, () => {
            server.removeListener("error", reject);
            resolve(server);
        });
    });
}

function readOneLine(socket: net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
        let buf = "";
        let settled = false;
        const onData = (chunk: Buffer) => {
            buf += chunk.toString("utf-8");
            if (buf.length > LINE_CAP_BYTES) {
                if (settled) return;
                settled = true;
                socket.removeListener("data", onData);
                reject(new Error(`line too large (${buf.length} > ${LINE_CAP_BYTES} bytes)`));
                return;
            }
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
                if (settled) return;
                settled = true;
                socket.removeListener("data", onData);
                resolve(buf.slice(0, nl));
            }
        };
        socket.on("data", onData);
        socket.once("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        socket.once("close", () => {
            if (settled) return;
            settled = true;
            reject(new Error("connection closed before line received"));
        });
    });
}

function sendEnvelope(endpoint: string, envelope: Envelope | Pong | { type: string; msg_id?: string; [k: string]: any }): Promise<any> {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ path: endpoint });
        let settled = false;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch { /* ignore */ }
            reject(err);
        };
        // ponytail: peer that accepts but never replies would wedge the caller forever; 5s cap.
        const timer = setTimeout(() => fail(new Error("send timeout")), 5_000);
        try { (timer as any).unref?.(); } catch { /* ignore */ }
        sock.once("error", fail);
        sock.once("connect", async () => {
            try {
                sock.write(JSON.stringify(envelope) + "\n");
                const line = await readOneLine(sock);
                const parsed = JSON.parse(line);
                try { sock.end(); } catch { /* ignore */ }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (parsed && parsed.type === "nack") {
                    reject(new Error(parsed.error || "nack"));
                } else {
                    resolve(parsed);
                }
            } catch (err) {
                fail(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
}

// ━━ System-prompt frontmatter scan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findSystemPromptPath(argv: string[]): string | null {
    // Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
    // These flags are pi-builtin (not extension-registered) so we still scan
    // argv directly. First match wins per preference order.
    const scan = (flag: string): string | null => {
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === flag && i + 1 < argv.length) {
                const candidate = argv[i + 1];
                if (candidate.endsWith(".md")) {
                    try {
                        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                            return candidate;
                        }
                    } catch {
                        // fall through
                    }
                }
            }
        }
        return null;
    };
    return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
    const p = findSystemPromptPath(argv);
    if (!p) return {};
    try {
        const raw = fs.readFileSync(p, "utf-8");
        const { name, description, color } = parseFrontmatter(raw);
        return { name, description, color };
    } catch {
        return {};
    }
}

// ━━ Editor with agent name in the top-right of the input border ━━━━━━━━━━

class NamedEditor extends CustomEditor {
    private label: string;
    private labelWidth: number;

    constructor(tui: any, theme: any, keybindings: any, label: string) {
        super(tui, theme, keybindings);
        this.label = label;
        this.labelWidth = visibleWidth(label);
    }

    render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length > 0 && this.labelWidth < width) {
            // First line is the full-width top border; carve out space at the right.
            lines[0] = truncateToWidth(lines[0], width - this.labelWidth, "") + this.label;
        }
        return lines;
    }
}

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

    pi.registerMessageRenderer("coms-inbound", (message, { outputPad }, theme) => {
        const sender = (message.details as { sender_name: string }).sender_name;
        const tag = `@${sender}>`;
        const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(`${theme.bold(tag)}\n\n${String(message.content).slice(tag.length + 2)}`, 0, 0));
        return box;
    });

    // State containers — shared across all hooks for this extension instance.
    let identity: {
        session_id: string;
        name: string;
        purpose: string;
        color: string;
        explicit: boolean;
        cwd: string;
        model: string;
        endpoint: string;
        registryFile: string;
        started_at: string;
    } | null = null;
    const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
    const pendingReplies: Map<string, PendingReply> = new Map();
    const inboundQueue: Map<string, InboundContext> = new Map();
    let server: net.Server | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let includeExplicit = false;
    let currentCtx: ExtensionContext | null = null;
    let currentInbound: InboundContext | null = null;

    // Phase A stub handlers — each just acks valid envelopes. Phase B replaces these.
    function ackOk(socket: net.Socket, msg_id: string): void {
        try {
            socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
        } catch {
            // ignore
        }
        try { socket.end(); } catch { /* ignore */ }
    }

    function nack(socket: net.Socket, msg_id: string, error: string): void {
        try {
            socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
        } catch {
            // ignore
        }
        try { socket.end(); } catch { /* ignore */ }
    }

    function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
        // 1. Hop limit check
        if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
            nack(socket, env.msg_id, "hops exceeded");
            return;
        }

        // 2. Insert into inbound queue
        const inbound: InboundContext = {
            msg_id: env.msg_id,
            hops: env.hops,
            sender_endpoint: env.sender_endpoint,
            sender_session: env.sender_session,
            response_schema: env.response_schema ?? null,
            fulfilled: false,
        };
        inboundQueue.set(env.msg_id, inbound);

        // 3. Track the current inbound so that any coms_send issued during the
        //    resulting LLM turn inherits the right hop count.
        currentInbound = inbound;

        // 4. Inject as a follow-up message into the receiver's next turn.
        try {
            pi.sendMessage(
                {
                    customType: "coms-inbound",
                    content: `@${env.sender_name}>\n\n${env.prompt}`,
                    display: true,
                    details: {
                        msg_id: env.msg_id,
                        sender_name: env.sender_name,
                        sender_session: env.sender_session,
                        response_schema: env.response_schema ?? null,
                    },
                },
                { deliverAs: "followUp", triggerTurn: true },
            );
        } catch (err) {
            // If sendMessage fails, drop the inbound and nack.
            inboundQueue.delete(env.msg_id);
            currentInbound = null;
            nack(socket, env.msg_id, "internal error");
            return;
        }

        // 5. Ack + audit log
        ackOk(socket, env.msg_id);
        try {
            pi.appendEntry("coms-log", {
                event: "inbound_prompt",
                msg_id: env.msg_id,
                sender: env.sender_session,
                hops: env.hops,
            });
        } catch {
            // best-effort
        }
    }

    function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
        const pending = pendingReplies.get(env.msg_id);
        if (pending) {
            if (pending.timer) {
                try { clearTimeout(pending.timer); } catch { /* ignore */ }
                pending.timer = null;
            }
            pending.result = { response: env.response, error: env.error ?? null };
            try {
                pending.resolve(pending.result);
            } catch {
                // ignore
            }
            // Note: do NOT delete the entry here — coms_get poll may still want it.
            // ponytail: drop after a grace period — response payloads can be large and
            // entries were previously retained for the process lifetime.
            const t = setTimeout(() => pendingReplies.delete(env.msg_id), 10 * 60_000);
            try { (t as any).unref?.(); } catch { /* ignore */ }
        } else {
            try {
                pi.appendEntry("coms-log", { event: "orphan_response", msg_id: env.msg_id });
            } catch {
                // best-effort
            }
        }
        ackOk(socket, env.msg_id);
    }

    function handlePing(socket: net.Socket, env: PingEnvelope): void {
        const ctx = currentCtx;
        const ident = identity;
        const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
        const card: AgentCard = {
            name: ident?.name ?? "unknown",
            purpose: ident?.purpose ?? "",
            model: ctx?.model?.id ?? ident?.model ?? "unknown",
            color: ident?.color ?? "#36F9F6",
            context_used_pct: pct,
            queue_depth: inboundQueue.size,
        };
        const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
        try {
            socket.write(JSON.stringify(pong) + "\n");
        } catch {
            // ignore
        }
        try { socket.end(); } catch { /* ignore */ }
    }

    function isValidEnvelope(obj: any): obj is Envelope {
        return (
            obj &&
            typeof obj === "object" &&
            typeof obj.type === "string" &&
            typeof obj.msg_id === "string" &&
            typeof obj.sender_session === "string" &&
            typeof obj.sender_endpoint === "string"
        );
    }

    function connHandler(socket: net.Socket): void {
        // ponytail: idle cap so stalled inbound connections can't accumulate
        socket.setTimeout(30_000, () => socket.destroy());
        let buf = "";
        let handled = false;
        const onData = (chunk: Buffer) => {
            if (handled) return;
            buf += chunk.toString("utf-8");
            if (buf.length > LINE_CAP_BYTES) {
                handled = true;
                socket.removeListener("data", onData);
                nack(socket, "", `line too large (${buf.length} > ${LINE_CAP_BYTES} bytes)`);
                return;
            }
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            handled = true;
            socket.removeListener("data", onData);
            const line = buf.slice(0, nl);
            let parsed: any;
            try {
                parsed = JSON.parse(line);
            } catch {
                nack(socket, "", "malformed envelope");
                return;
            }
            if (!isValidEnvelope(parsed)) {
                const mid = parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
                nack(socket, mid, "malformed envelope");
                return;
            }
            try {
                if (parsed.type === "prompt") {
                    handlePrompt(socket, parsed as PromptEnvelope);
                } else if (parsed.type === "response") {
                    handleResponse(socket, parsed as ResponseEnvelope);
                } else if (parsed.type === "ping") {
                    handlePing(socket, parsed as PingEnvelope);
                } else {
                    nack(socket, parsed.msg_id, "unknown type");
                }
            } catch {
                nack(socket, parsed.msg_id, "internal error");
            }
        };
        socket.on("data", onData);
        socket.once("error", () => {
            // connection failures during handshake — drop quietly
            try { socket.destroy(); } catch { /* ignore */ }
        });
    }

    // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pi.on("session_start", async (_event, ctx) => {
        applyExtensionDefaults(import.meta.url, ctx);
        currentCtx = ctx;

        // 1. Resolve identity from CLI flags > frontmatter > defaults.
        const flags = readCliFlags(pi);
        const fm = readFrontmatterFromArgv(process.argv);
        const explicit = flags.explicit === true;
        const session_id = ulid();
        const cwd = ctx.cwd || process.cwd();

        const defaultName = `agent-${session_id.slice(-6)}`;
        // --name accepts free text; registry keys are filenames, so sanitize.
        const desiredName = (flags.name || fm.name || defaultName)
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || defaultName;
        const name = resolveUniqueName(desiredName);
        if (name !== desiredName) {
            try {
                pi.appendEntry("coms-log", { event: "name_collision", desired: desiredName, assigned: name });
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
                fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
                try { fs.chmodSync(COMS_DIR, 0o700); } catch { /* best-effort */ }
            }
        } catch (err) {
            ctx.ui?.notify?.(`📡 coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
        }

        // 3. Bind the endpoint.
        try {
            server = await bindEndpoint(endpoint, connHandler);
        } catch (err) {
            ctx.ui?.notify?.(`📡 coms: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
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
            ctx.ui?.notify?.(`📡 coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
            try { server?.close(); } catch { /* ignore */ }
            return;
        }

        identity = {
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
        includeExplicit = false;

        // 5. Audit log: boot.
        try {
            pi.appendEntry("coms-log", { event: "boot", session_id, name });
        } catch {
            // best-effort
        }

        // 6. Surface presence in the UI + install the live pool widget.
        try {
            ctx.ui.setStatus("coms", name);
            installPoolWidget(ctx);
            if (ctx.hasUI) {
                ctx.ui.setEditorComponent((tui, theme, keybindings) =>
                    new NamedEditor(tui, theme, keybindings, hexFg(color, ` ${name} `)));
            }
            ctx.ui.notify(`📡 ready · ${name}`, "info");
        } catch {
            // hasUI may be false in some contexts — non-fatal.
        }

        // 7. Start ping + keepalive cycles.
        pingTimer = setInterval(() => { refreshPool().catch(() => {}); }, PING_INTERVAL_MS);
        try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
        keepaliveTimer = setInterval(() => {
            if (!identity) return;
            try {
                const ctx = currentCtx;
                const live: RegistryEntry = {
                    session_id: identity.session_id,
                    name: identity.name,
                    purpose: identity.purpose,
                    model: ctx?.model?.id ?? identity.model,
                    color: identity.color,
                    pid: process.pid,
                    endpoint: identity.endpoint,
                    cwd: identity.cwd,
                    started_at: identity.started_at,
                    explicit: identity.explicit,
                    version: 1,
                };
                // Unconditional atomic write: pure self-heal (re-create the entry if
                // the file was unlinked under us).
                writeRegistryAtomic(live);
            } catch { /* best-effort */ }
        }, KEEPALIVE_INTERVAL_MS);
        try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }

        // Kick one ping cycle immediately so the widget populates fast.
        refreshPool().catch(() => {});
    });

    // ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    async function pingPeer(endpoint: string): Promise<AgentCard | null> {
        if (!identity) return null;
        const env: PingEnvelope = {
            type: "ping",
            msg_id: ulid(),
            sender_session: identity.session_id,
            sender_endpoint: identity.endpoint,
            hops: 0,
            timestamp: nowIso(),
        };
        try {
            const resp = await sendEnvelope(endpoint, env);
            if (resp && resp.type === "pong" && resp.agent_card) {
                return resp.agent_card as AgentCard;
            }
        } catch {
            // ignore — peer unreachable
        }
        return null;
    }

    // ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function renderPool(width: number, theme: Theme): string[] {
        // Peer rows only — own name lives in the editor border top-right.
        // Render from the refreshPool cache — zero fs on the render path.
        const registryEntries = cachedEntries;

        interface Row {
            name: string;
            model: string;
            color: string;
            purpose: string;
            pct: number | null;
            pending: boolean;
            stale: boolean;
        }
        const rows: Row[] = [];
        const seenSessions = new Set<string>();

        for (const [sid, card] of peerCards.entries()) {
            if (identity && sid === identity.session_id) continue;
            seenSessions.add(sid);
            rows.push({
                name: card.name,
                model: card.model,
                color: card.color,
                purpose: card.purpose,
                pct: card.context_used_pct,
                pending: false,
                stale: (card.staleCount ?? 0) >= 3,
            });
        }

        // Registry-only entries that aren't yet in peerCards → pending
        const seenNames = new Set(rows.map((r) => r.name));
        for (const entry of registryEntries) {
            if (identity && entry.session_id === identity.session_id) continue;
            if (!includeExplicit && entry.explicit) continue;
            if (seenSessions.has(entry.session_id)) continue;
            if (seenNames.has(entry.name)) continue;
            rows.push({
                name: entry.name,
                model: entry.model,
                color: entry.color,
                purpose: entry.purpose,
                pct: null,
                pending: true,
                stale: false,
            });
        }

        // Peer rows sandwiched between two dim rules.
        const safeWidth = Math.max(0, width);
        const rule = theme.fg("dim", "━".repeat(safeWidth));
        const topBorder = rule;
        const bottomBorder = rule;

        if (rows.length === 0) {
            // Zero rows → render nothing; an empty widget collapses cleanly.
            return [];
        }

        rows.sort((a, b) => a.name.localeCompare(b.name));

        const out: string[] = [topBorder];

        for (const r of rows) {
            const pctNum = r.pct ?? 0;
            const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
            const empty = 15 - filled;
            const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

            if (r.stale) {
                const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
                out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
                continue;
            }

            const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
            const namePart = theme.fg("accent", r.name.padEnd(12));
            const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
            const barFill = r.pending
                ? theme.fg("dim", "-".repeat(15))
                : hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
            const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
            const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
            const sep = theme.fg("dim", "  —  ");
            const purposePart = theme.fg("muted", r.purpose || "");

            const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + sep + purposePart;
            out.push(truncateToWidth(line, width));
        }

        out.push(bottomBorder);
        return out;
    }

    function installPoolWidget(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        try {
            ctx.ui.setWidget("coms-pool", (_tui, theme) => ({
                invalidate() {},
                render(width: number): string[] {
                    return renderPool(width, theme);
                },
            }), { placement: "belowEditor" });
        } catch {
            // non-fatal
        }
    }

    // ━━ Ping cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let refreshingPool = false;
    async function refreshPool(): Promise<void> {
        if (!identity || refreshingPool) return;
        refreshingPool = true;
        try {
            const live = liveEntries();

            const peers = live.filter((e) =>
                e.session_id !== identity!.session_id && (includeExplicit || !e.explicit),
            );

            const results = await Promise.allSettled(peers.map(async (peer) => {
                const pingEnv: PingEnvelope = {
                    type: "ping",
                    msg_id: ulid(),
                    sender_session: identity!.session_id,
                    sender_endpoint: identity!.endpoint,
                    hops: 0,
                    timestamp: nowIso(),
                };
                const reply = await sendEnvelope(peer.endpoint, pingEnv);
                return { peer, pong: reply as Pong };
            }));

            const seenSessions = new Set<string>();
            let changed = false;

            for (const r of results) {
                if (r.status === "fulfilled" && r.value.pong && r.value.pong.agent_card) {
                    const { peer, pong } = r.value;
                    seenSessions.add(peer.session_id);
                    const prev = peerCards.get(peer.session_id);
                    const next = { ...pong.agent_card, staleCount: 0 };
                    // Field-wise compare — cheaper than JSON.stringify and order-insensitive.
                    const differs = !prev
                        || (["name", "purpose", "model", "color", "context_used_pct", "queue_depth"] as const)
                            .some((k) => prev[k] !== next[k]);
                    if (differs) {
                        peerCards.set(peer.session_id, next);
                        changed = true;
                    }
                }
            }

            for (const [sid, card] of peerCards.entries()) {
                if (identity && sid === identity.session_id) continue;
                if (!seenSessions.has(sid)) {
                    card.staleCount = (card.staleCount ?? 0) + 1;
                    if (card.staleCount > 6) {
                        peerCards.delete(sid);
                    }
                    changed = true;
                }
            }

            if (changed && currentCtx?.hasUI) {
                installPoolWidget(currentCtx);
            }
        } finally {
            refreshingPool = false;
        }
    }

    function resolveTarget(target: string): RegistryEntry | null {
        // Global pool — any live agent is addressable.
        if (!identity) return null;
        const entries = liveEntries();
        return entries.find((e) => e.session_id === target) ?? entries.find((e) => e.name === target) ?? null;
    }

    // ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    pi.registerTool({
        name: "coms_list",
        label: "Coms List",
        description:
            "List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
            "include_explicit=true reveals agents marked --explicit.",
        parameters: Type.Object({
            include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
        }),
        async execute(_callId, params) {
            const includeExp = params.include_explicit === true;

            const collected: RegistryEntry[] = [];
            for (const entry of liveEntries()) {
                if (entry.explicit && !includeExp) continue;
                if (identity && entry.session_id === identity.session_id) continue;
                collected.push(entry);
            }

            // Ping each peer in parallel for live context usage.
            const pongs = await Promise.allSettled(collected.map((c) => pingPeer(c.endpoint)));

            const agents = collected.map((entry, i) => {
                const r = pongs[i];
                const pong = r.status === "fulfilled" ? r.value : null;
                return {
                    name: entry.name,
                    session_id: entry.session_id,
                    purpose: entry.purpose,
                    model: entry.model,
                    cwd: entry.cwd,
                    alive: pong != null,
                    context_used_pct: pong ? pong.context_used_pct : null,
                    color: entry.color,
                };
            });

            const lines = agents.length === 0
                ? "No peer agents found."
                : agents.map((a) => {
                    const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
                    const live = a.alive ? "●" : "✗";
                    return `${live} ${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
                }).join("\n");

            return {
                content: [{ type: "text" as const, text: `${agents.length} peer(s):\n${lines}` }],
                details: { agents },
            };
        },
        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold("coms_list")), 0, 0);
        },
        renderResult(result, options, theme) {
            const details = result.details as any;
            const agents: any[] = details?.agents ?? [];
            const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
            if (!options.expanded || agents.length === 0) {
                return new Text(header, 0, 0);
            }
            const rows = agents.map((a) => {
                const dot = a.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
                const pct = a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
                return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
            }).join("\n");
            return new Text(header + "\n" + rows, 0, 0);
        },
    });

    pi.registerTool({
        name: "coms_send",
        label: "Coms Send",
        description:
            "Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
            "Use coms_get (non-blocking) or coms_await (blocking) with the msg_id to retrieve the response. " +
            "Throws if the receiver is unreachable or rejects the envelope.",
        parameters: Type.Object({
            target: Type.String({ description: "Peer name or session_id." }),
            prompt: Type.String({ description: "The prompt to send." }),
            conversation_id: Type.Optional(Type.String()),
            response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
        }),
        async execute(_callId, params) {
            if (!identity) {
                throw new Error("coms not initialised");
            }
            const target = resolveTarget(params.target);
            if (!target) {
                throw new Error(`coms: no live agent matching "${params.target}"`);
            }
            const hops = currentInbound ? currentInbound.hops + 1 : 0;
            if (hops >= MAX_HOPS) {
                throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
            }
            const msg_id = ulid();
            const env: PromptEnvelope = {
                type: "prompt",
                msg_id,
                sender_session: identity.session_id,
                sender_endpoint: identity.endpoint,
                sender_name: identity.name,
                sender_cwd: identity.cwd,
                hops,
                timestamp: nowIso(),
                prompt: params.prompt,
                conversation_id: params.conversation_id ?? null,
                response_schema: (params.response_schema as object | undefined) ?? null,
            };

            // Send the envelope synchronously and wait for the receiver's ack.
            await sendEnvelope(target.endpoint, env);

            // Register a pending entry whose promise the receiver-side handleResponse
            // (or the timeout below) will settle.
            let resolveFn!: (v: { response?: any; error?: string | null }) => void;
            let rejectFn!: (e: Error) => void;
            const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => {
                resolveFn = res;
                rejectFn = rej;
            });
            const entry: PendingReply = {
                resolve: resolveFn,
                reject: rejectFn,
                timer: null,
                promise,
                target_name: target.name,
                created_at: nowIso(),
            };
            if (TIMEOUT_MS > 0) {
                entry.timer = setTimeout(() => {
                    if (entry.result) return;
                    entry.result = { error: "timeout" };
                    try { entry.resolve(entry.result); } catch { /* ignore */ }
                    pendingReplies.delete(msg_id);
                }, TIMEOUT_MS);
                // Don't keep the event loop alive solely for this timer.
                try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
            }
            pendingReplies.set(msg_id, entry);

            try {
                pi.appendEntry("coms-log", {
                    event: "outbound_prompt",
                    msg_id,
                    target: target.name,
                    hops,
                });
            } catch {
                // best-effort
            }

            return {
                content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}` }],
                details: { msg_id, target: target.name, target_session: target.session_id, hops },
            };
        },
        renderCall(args, theme) {
            const tgt = (args as any).target ?? "?";
            const prompt = (args as any).prompt ?? "";
            const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
            return new Text(
                theme.fg("toolTitle", theme.bold("coms_send ")) +
                theme.fg("accent", tgt) +
                theme.fg("dim", " — ") +
                theme.fg("muted", preview),
                0, 0,
            );
        },
        renderResult(result, _options, theme) {
            const d = result.details as any;
            if (!d) {
                const t = result.content[0];
                return new Text(t?.type === "text" ? t.text : "", 0, 0);
            }
            return new Text(
                theme.fg("success", "→ ") +
                theme.fg("accent", d.target) +
                theme.fg("dim", `  msg_id `) +
                theme.fg("warning", d.msg_id),
                0, 0,
            );
        },
    });

    pi.registerTool({
        name: "coms_get",
        label: "Coms Get",
        description:
            "Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
        parameters: Type.Object({
            msg_id: Type.String({ description: "msg_id returned by coms_send." }),
        }),
        async execute(_callId, params) {
            const entry = pendingReplies.get(params.msg_id);
            if (!entry) {
                return {
                    content: [{ type: "text" as const, text: `coms_get: unknown msg_id ${params.msg_id}` }],
                    details: { status: "error", error: "unknown msg_id" },
                };
            }
            if (entry.result) {
                const r = entry.result;
                const text = r.error
                    ? `coms_get: error — ${r.error}`
                    : `coms_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
                return {
                    content: [{ type: "text" as const, text }],
                    details: { status: "complete", response: r.response, error: r.error ?? null },
                };
            }
            return {
                content: [{ type: "text" as const, text: `coms_get: pending` }],
                details: { status: "pending" },
            };
        },
        renderCall(args, theme) {
            const id = (args as any).msg_id ?? "?";
            return new Text(
                theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", id),
                0, 0,
            );
        },
        renderResult(result, _options, theme) {
            const d = result.details as any;
            const status = d?.status ?? "?";
            const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
            return new Text(theme.fg(color, status), 0, 0);
        },
    });

    pi.registerTool({
        name: "coms_await",
        label: "Coms Await",
        description:
            "Block until a pending coms_send reply lands or the timeout fires. Default timeout 30 minutes (PI_COMS_TIMEOUT_MS).",
        parameters: Type.Object({
            msg_id: Type.String({ description: "msg_id returned by coms_send." }),
            timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
        }),
        async execute(_callId, params) {
            const entry = pendingReplies.get(params.msg_id);
            if (!entry) {
                return {
                    content: [{ type: "text" as const, text: `coms_await: unknown msg_id ${params.msg_id}` }],
                    details: { error: "unknown msg_id" },
                };
            }
            const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms >= 0
                ? params.timeout_ms
                : TIMEOUT_MS;

            let winner: { response?: any; error?: string | null };
            if (timeoutMs > 0) {
                const timed = new Promise<{ error: string }>((resolve) => {
                    const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
                    try { (t as any).unref?.(); } catch { /* ignore */ }
                });
                winner = await Promise.race([entry.promise, timed]);
            } else {
                winner = await entry.promise;
            }
            if ((winner as any).error) {
                return {
                    content: [{ type: "text" as const, text: `coms_await: error — ${(winner as any).error}` }],
                    details: { error: (winner as any).error },
                };
            }
            const resp = (winner as any).response;
            return {
                content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }],
                details: { response: resp },
            };
        },
        renderCall(args, theme) {
            const id = (args as any).msg_id ?? "?";
            return new Text(
                theme.fg("toolTitle", theme.bold("coms_await ")) + theme.fg("warning", id),
                0, 0,
            );
        },
        renderResult(result, _options, theme) {
            const d = result.details as any;
            if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
            return new Text(theme.fg("success", "✓ response received"), 0, 0);
        },
    });

    // ━━ agent_end: capture turn output and dispatch response back ━━━━━━━━

    pi.on("agent_end", async (_event, ctx) => {
        const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
        if (!inbound || !identity) return;

        // Walk the session branch backwards for the most recent assistant message text.
        let lastAssistantText = "";
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry.type === "message" && entry.message.role === "assistant") {
                const m = entry.message as any;
                if (typeof m.content === "string") {
                    lastAssistantText = m.content;
                } else if (Array.isArray(m.content)) {
                    lastAssistantText = m.content
                        .filter((b: any) => b && b.type === "text")
                        .map((b: any) => b.text)
                        .join("\n");
                }
                break;
            }
        }

        let payload: any = lastAssistantText;
        let error: string | null = null;
        if (inbound.response_schema && typeof inbound.response_schema === "object") {
            try {
                payload = JSON.parse(lastAssistantText);
            } catch {
                error = "response not valid JSON";
                payload = null;
            }
        }

        const respEnv: ResponseEnvelope = {
            type: "response",
            msg_id: inbound.msg_id,
            sender_session: identity.session_id,
            sender_endpoint: identity.endpoint,
            hops: 0,
            timestamp: nowIso(),
            response: payload,
            error,
        };

        try {
            await sendEnvelope(inbound.sender_endpoint, respEnv);
            try {
                pi.appendEntry("coms-log", {
                    event: "outbound_response",
                    msg_id: inbound.msg_id,
                    error,
                });
            } catch {
                // best-effort
            }
        } catch (e: any) {
            try {
                pi.appendEntry("coms-log", {
                    event: "outbound_response_failed",
                    msg_id: inbound.msg_id,
                    reason: e?.message ?? String(e),
                });
            } catch {
                // best-effort
            }
        }

        inbound.fulfilled = true;
        inboundQueue.delete(inbound.msg_id);
        if (currentInbound && currentInbound.msg_id === inbound.msg_id) {
            currentInbound = null;
        }
    });

    // ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    pi.registerCommand("coms", {
        description: "Force-refresh the coms pool widget (--all toggles hidden --explicit agents)",
        handler: async (args, ctx) => {
            if ((args ?? "").trim().includes("--all")) {
                includeExplicit = !includeExplicit;
                try { ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
            }
            await refreshPool();
        },
    });

    // ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let shuttingDown = false;
    async function cleanShutdown(): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
        if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
        if (server) {
            try { server.close(); } catch { /* ignore */ }
            server = null;
        }
        if (identity) {
            if (process.platform !== "win32") {
                try { fs.unlinkSync(identity.endpoint); } catch { /* ignore */ }
            }
            try { removeRegistryEntry(identity.name); } catch { /* ignore */ }
            try {
                pi.appendEntry("coms-log", { event: "shutdown", session_id: identity.session_id });
            } catch {
                // best-effort
            }
        }
        if (currentCtx?.hasUI) {
            try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
        }
    }

    pi.on("session_shutdown", async () => { await cleanShutdown(); });
    process.on("SIGINT", () => { void cleanShutdown(); });
    process.on("SIGTERM", () => { void cleanShutdown(); });
}
