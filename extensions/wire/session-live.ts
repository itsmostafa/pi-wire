/** In-memory, read-only snapshots of the current peer session. */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import { LINE_CAP_BYTES, type LiveToolState, type SessionSnapshotEnvelope, type WireState } from "./types";

// ponytail: keep each text preview's newest 8K characters; use deltas for unbounded live history.
const VALUE_CAP = 8 * 1024;

type AnyRecord = Record<string, any>;

function text(value: unknown, cap = VALUE_CAP): string {
    let result: string;
    if (typeof value === "string") result = value;
    else {
        try { result = JSON.stringify(value) ?? String(value); }
        catch { result = String(value); }
    }
    if (result.length <= cap) return result;
    const marker = "[truncated prefix]\n";
    return marker + result.slice(-(cap - marker.length));
}

function safeContent(content: unknown): unknown {
    if (typeof content === "string") return text(content);
    if (!Array.isArray(content)) return [];
    return content.map((block: AnyRecord) => {
        if (!block || typeof block !== "object") return { type: "text", text: text(block) };
        if (block.type === "image") return { type: "text", text: "[image]" };
        if (block.type === "text") return { type: "text", text: text(block.text) };
        if (block.type === "thinking") return { type: "thinking", thinking: text(block.thinking) };
        if (block.type === "toolCall") {
            let args: unknown = block.arguments;
            const encoded = JSON.stringify(args);
            if (encoded && encoded.length > VALUE_CAP) args = { preview: text(encoded) };
            return { type: "toolCall", id: text(block.id, 256), name: text(block.name, 256), arguments: args };
        }
        return { type: "text", text: `[${text(block.type, 256) || "content"}]` };
    });
}

function safeMessage(message: AnyRecord): AnyRecord {
    const out: AnyRecord = {
        role: typeof message.role === "string" ? message.role : "custom",
        content: safeContent(message.content),
    };
    if (typeof message.timestamp === "number") out.timestamp = message.timestamp;
    switch (out.role) {
        case "assistant":
            if (typeof message.stopReason === "string") out.stopReason = message.stopReason;
            if (message.errorMessage !== undefined) out.errorMessage = text(message.errorMessage);
            break;
        case "toolResult":
            out.toolCallId = text(message.toolCallId, 256);
            out.toolName = text(message.toolName, 256);
            out.isError = message.isError === true;
            break;
        case "custom":
            out.customType = text(message.customType, 256);
            out.display = message.display === true;
            break;
        case "bashExecution":
            out.command = text(message.command);
            out.output = text(message.output);
            out.exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
            out.cancelled = message.cancelled === true;
            out.truncated = message.truncated === true;
            break;
        case "branchSummary":
        case "compactionSummary":
            out.summary = text(message.summary);
            break;
    }
    return out;
}

function stableTimestamp(state: WireState): string {
    const header = state.currentCtx?.sessionManager?.getHeader?.();
    if (header && typeof header.timestamp === "string") return header.timestamp;
    return state.identity?.started_at || "1970-01-01T00:00:00.000Z";
}

function safeEntry(entry: AnyRecord, state: WireState): AnyRecord | null {
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return null;
    if (typeof entry.id !== "string") return null;
    const base = {
        type: text(entry.type, 256),
        id: text(entry.id, 256),
        parentId: typeof entry.parentId === "string" ? text(entry.parentId, 256) : null,
        timestamp: typeof entry.timestamp === "string" ? text(entry.timestamp, 256) : stableTimestamp(state),
    };
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
        if (entry.message.role === "custom" && entry.message.display !== true) return null;
        return { ...base, message: safeMessage(entry.message) };
    }
    if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
        return { ...base, summary: text(entry.summary) };
    }
    if (entry.type === "custom_message" && entry.display === true) {
        return {
            ...base,
            customType: text(entry.customType, 256),
            content: safeContent(entry.content),
            display: entry.display === true,
        };
    }
    return null;
}

function messageEntry(state: WireState, id: string, parentId: string | null, message: AnyRecord): AnyRecord {
    const timestamp = typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : stableTimestamp(state);
    return { type: "message", id, parentId, timestamp, message: safeMessage(message) };
}

function toolMessage(tool: LiveToolState): AnyRecord {
    const result = tool.result ?? tool.partialResult;
    const content = result && typeof result === "object" ? (result as AnyRecord).content : undefined;
    return {
        role: "toolResult",
        toolCallId: text(tool.toolCallId, 256),
        toolName: text(tool.toolName, 256),
        content: safeContent(content ?? [{ type: "text", text: "Tool running…" }]),
        isError: result && typeof result === "object" && (result as AnyRecord).isError === true,
    };
}

interface CachedEntry {
    parentId: string | null;
    entry: AnyRecord;
    part: string;
    cost: number;
}

// Persisted entries are immutable once written and pi hands back the same objects
// on every getBranch(), so a poll only pays for what changed. Keyed on the raw
// entry, with the linked parent recorded: a branch switch or compaction gives a
// different predecessor and misses, so the cache needs no explicit invalidation.
const entryCache = new WeakMap<object, CachedEntry>();

interface Branch {
    entries: AnyRecord[];
    parts: string[];
    costs: number[];
}

function branch(state: WireState): Branch {
    const source = state.currentCtx?.sessionManager?.getBranch?.() ?? [];
    const out: Branch = { entries: [], parts: [], costs: [] };
    let parentId: string | null = null;
    for (const raw of source as SessionEntry[]) {
        if (!raw || typeof raw !== "object") continue;
        const cached = entryCache.get(raw);
        if (cached && cached.parentId === parentId) {
            out.entries.push(cached.entry);
            out.parts.push(cached.part);
            out.costs.push(cached.cost);
            parentId = cached.entry.id as string;
            continue;
        }
        const safe = safeEntry(raw as unknown as AnyRecord, state);
        if (!safe) continue;
        const entry = { ...safe, parentId };
        const part = JSON.stringify(entry);
        const cost = outerPartBytes(part);
        entryCache.set(raw, { parentId, entry, part, cost });
        out.entries.push(entry);
        out.parts.push(part);
        out.costs.push(cost);
        parentId = entry.id as string;
    }
    return out;
}

function sameMessage(left: AnyRecord, right: AnyRecord): boolean {
    try { return JSON.stringify(safeMessage(left)) === JSON.stringify(safeMessage(right)); }
    catch { return false; }
}

function hasPersistedAssistant(entries: AnyRecord[], message: AnyRecord): boolean {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "message" && entries[i].message?.role === "assistant") {
            return sameMessage(entries[i].message, message);
        }
    }
    return false;
}

function hasPersistedTool(entries: AnyRecord[], toolCallId: string): boolean {
    return entries.some((entry) => entry.type === "message"
        && entry.message?.role === "toolResult"
        && entry.message.toolCallId === toolCallId);
}

function liveEntries(state: WireState, entries: AnyRecord[]): AnyRecord[] {
    const out: AnyRecord[] = [];
    let parentId = entries.at(-1)?.id ?? null;
    const assistant = state.liveAssistantMessage;
    if (assistant && typeof assistant === "object") {
        // ponytail: safe'd here, not per streaming chunk; snapshots are rare, chunks are not.
        const message = safeMessage(assistant as AnyRecord);
        if (!hasPersistedAssistant(entries, message)) {
            const id = "wire-live-assistant";
            out.push(messageEntry(state, id, parentId, message));
            parentId = id;
        }
    }

    if (!(state.liveTools instanceof Map)) return out;
    for (const [toolCallId, tool] of state.liveTools.entries()) {
        if (hasPersistedTool(entries, toolCallId)) {
            state.liveTools.delete(toolCallId);
            continue;
        }
        const id = `wire-live-tool-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160)}`;
        out.push(messageEntry(state, id, parentId, toolMessage(tool)));
        parentId = id;
    }
    return out;
}

function header(state: WireState): AnyRecord {
    const manager = state.currentCtx?.sessionManager;
    const id = manager?.getSessionId?.();
    const cwd = manager?.getCwd?.();
    return {
        type: "session",
        version: 3,
        id: text(typeof id === "string" ? id : state.identity?.session_id ?? "wire-snapshot", 256),
        timestamp: stableTimestamp(state),
        cwd: text(typeof cwd === "string" ? cwd : state.identity?.cwd ?? "", 1024),
    };
}

function sourceFromParts(parts: string[]): string {
    return parts.join("\n") + "\n";
}

function snapshotLine(msg_id: string, source: string, status: "running" | "idle"): string {
    return JSON.stringify({ type: "session_snapshot", msg_id, source, status });
}

/** Bytes added by one JSONL part, including its escaped trailing newline. */
function outerPartBytes(part: string): number {
    // The two JSON string quotes cost exactly as much as the escaped newline.
    return Buffer.byteLength(JSON.stringify(part));
}

function lineBytes(msg_id: string, status: "running" | "idle", parts: string[], suffixBytes = 0): number {
    const emptySource = Buffer.byteLength(snapshotLine(msg_id, "", status)) + 1;
    return emptySource + parts.reduce((total, part) => total + outerPartBytes(part), suffixBytes);
}

function truncationNotice(parentId: string | null, dropped: number): AnyRecord {
    return {
        type: "custom_message",
        id: "wire-snapshot-notice",
        parentId,
        timestamp: "1970-01-01T00:00:00.000Z",
        customType: "wire-session",
        content: `Snapshot truncated: ${dropped} older entr${dropped === 1 ? "y" : "ies"} omitted to fit the wire line limit.`,
        display: true,
    };
}

function boundedSource(state: WireState, msg_id: string, status: "running" | "idle"): string {
    const base = branch(state);
    const live = liveEntries(state, base.entries);
    const liveParts = live.map((entry) => JSON.stringify(entry));
    const all = [...base.entries, ...live];
    const headerPart = JSON.stringify(header(state));
    const parts = [...base.parts, ...liveParts];
    const costs = [...base.costs, ...liveParts.map(outerPartBytes)];
    const suffix = Array.from({ length: costs.length + 1 }, () => 0);
    for (let i = costs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + costs[i];
    const baseBytes = lineBytes(msg_id, status, [headerPart]);
    if (baseBytes + suffix[0] <= LINE_CAP_BYTES) return sourceFromParts([headerPart, ...parts]);

    // Reserve a worst-case notice, then find the longest fitting suffix in one pass.
    const worstNotice = JSON.stringify(truncationNotice(all.at(-1)?.id ?? null, all.length));
    const noticeBytes = outerPartBytes(worstNotice);
    let start = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
        if (baseBytes + suffix[i] + noticeBytes <= LINE_CAP_BYTES) start = i;
        else break;
    }
    // Only the notice and the entry it adopts change; the rest of the kept
    // suffix is already chained, so reuse the parts serialized above.
    const notice = truncationNotice(null, start);
    const head = start < all.length ? { ...all[start], parentId: notice.id as string } : null;
    const finalParts = [
        headerPart,
        JSON.stringify(notice),
        ...(head ? [JSON.stringify(head)] : []),
        ...parts.slice(start + 1),
    ];
    const source = sourceFromParts(finalParts);
    return Buffer.byteLength(snapshotLine(msg_id, source, status)) + 1 <= LINE_CAP_BYTES
        ? source
        : sourceFromParts([headerPart]);
}

function status(state: WireState): "running" | "idle" {
    if (state.liveStatus === "running" || state.liveStatus === "idle") return state.liveStatus;
    return state.liveAssistantMessage || (state.liveTools instanceof Map && state.liveTools.size > 0) ? "running" : "idle";
}

function sendSnapshot(state: WireState, socket: net.Socket, env: SessionSnapshotEnvelope): void {
    const currentStatus = status(state);
    const source = boundedSource(state, env.msg_id, currentStatus);
    const line = snapshotLine(env.msg_id, source, currentStatus);
    if (Buffer.byteLength(line) + 1 > LINE_CAP_BYTES) {
        try { socket.write(JSON.stringify({ type: "nack", msg_id: env.msg_id, error: "session snapshot too large" }) + "\n"); } catch { /* ignore */ }
    } else {
        try { socket.write(line + "\n"); } catch { /* ignore */ }
    }
    try { socket.end(); } catch { /* ignore */ }
}

function clearLive(state: WireState): void {
    state.liveAssistantMessage = undefined;
    if (state.liveTools instanceof Map) state.liveTools.clear();
    else state.liveTools = new Map();
    state.liveStatus = "idle";
}

function ensureLive(state: WireState): void {
    if (!(state.liveTools instanceof Map)) state.liveTools = new Map();
    if (state.liveStatus !== "running" && state.liveStatus !== "idle") state.liveStatus = "idle";
}

/** Register the event hooks once from the extension composition root. */
export function registerSessionLive(pi: ExtensionAPI, state: WireState): void {
    ensureLive(state);
    pi.on("session_start", (_event, ctx) => {
        state.currentCtx = ctx;
        clearLive(state);
    });
    pi.on("session_shutdown", () => clearLive(state));
    pi.on("session_tree", () => clearLive(state));
    pi.on("agent_start", () => {
        ensureLive(state);
        state.liveStatus = "running";
        state.liveAssistantMessage = undefined;
        state.liveTools.clear();
    });
    // agent_settled follows persistence and all automatic retries/continuations.
    pi.on("agent_settled", () => clearLive(state));
    pi.on("message_start", (event) => {
        ensureLive(state);
        if (event.message.role === "assistant") {
            state.liveStatus = "running";
            state.liveAssistantMessage = event.message;
        } else if (event.message.role === "toolResult") {
            const tool = state.liveTools.get(event.message.toolCallId);
            if (tool) {
                tool.ended = true;
                tool.result = { content: safeContent(event.message.content), isError: event.message.isError === true };
            }
        }
    });
    pi.on("message_update", (event) => {
        if (event.message.role === "assistant") {
            state.liveStatus = "running";
            state.liveAssistantMessage = event.message;
        }
    });
    pi.on("message_end", (event) => {
        if (event.message.role === "assistant") {
            state.liveAssistantMessage = event.message;
        } else if (event.message.role === "toolResult") {
            const tool = state.liveTools.get(event.message.toolCallId);
            if (tool) {
                tool.ended = true;
                tool.result = { content: safeContent(event.message.content), isError: event.message.isError === true };
            }
        }
    });
    pi.on("tool_execution_start", (event) => {
        ensureLive(state);
        state.liveStatus = "running";
        state.liveTools.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ended: false,
        });
    });
    pi.on("tool_execution_update", (event) => {
        ensureLive(state);
        const tool = state.liveTools.get(event.toolCallId) ?? {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ended: false,
        };
        tool.partialResult = event.partialResult;
        state.liveTools.set(event.toolCallId, tool);
    });
    pi.on("tool_execution_end", (event) => {
        ensureLive(state);
        const tool = state.liveTools.get(event.toolCallId) ?? {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ended: false,
        };
        tool.ended = true;
        tool.result = event.result && typeof event.result === "object"
            ? { ...(event.result as AnyRecord), isError: event.isError === true }
            : { isError: event.isError === true };
        state.liveTools.set(event.toolCallId, tool);
    });
}

/** Handle a validated session_snapshot request; replies with one bounded line. */
export function handleSessionSnapshot(state: WireState, socket: net.Socket, env: SessionSnapshotEnvelope): void {
    if (state.shuttingDown) {
        try { socket.write(JSON.stringify({ type: "nack", msg_id: env.msg_id, error: "shutting down" }) + "\n"); } catch { /* ignore */ }
        try { socket.end(); } catch { /* ignore */ }
        return;
    }
    ensureLive(state);
    sendSnapshot(state, socket, env);
}
