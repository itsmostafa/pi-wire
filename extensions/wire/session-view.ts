/** Read-only live session snapshots, with saved-file fallback for older peers. */
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, parseSessionEntries, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { PING_INTERVAL_MS, type WireState } from "./types";
import { sendEnvelope } from "./transport";

function plain(text: string): string {
    return stripVTControlCharacters(text).replace(/\p{Cc}/gu, (char) => char === "\n" || char === "\t" ? char : "");
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => {
        if (block?.type === "text") return block.text;
        if (block?.type === "thinking") return `[thinking]\n${block.thinking}`;
        if (block?.type === "toolCall") return `[tool call: ${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
        if (block?.type === "image") return "[image]";
        return "";
    }).filter(Boolean).join("\n\n");
}

/** Pi's parser tolerates a partially appended final line; follow the saved branch. */
export function sessionText(source: string): string {
    const parsed = parseSessionEntries(source);
    if (parsed[0]?.type !== "session") throw new Error("Not a Pi session file");
    const entries = parsed.filter((entry): entry is SessionEntry => entry?.type !== "session" && typeof entry?.id === "string");
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch: SessionEntry[] = [];
    let entry = entries.at(-1);
    const seen = new Set<string>();
    while (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        branch.push(entry);
        entry = entry.parentId ? byId.get(entry.parentId) : undefined;
    }
    const messages = branch.reverse().map((entry) => {
        if (entry.type === "compaction" || entry.type === "branch_summary") return `[${entry.type}]\n${entry.summary}`;
        if (entry.type === "custom_message") return entry.display ? `[${entry.customType}]\n${contentText(entry.content)}` : "";
        if (entry.type !== "message") return "";
        const message = entry.message;
        if (message.role === "custom" && !message.display) return "";
        if (message.role === "bashExecution") return `[bash]\n$ ${message.command}\n${message.output}`;
        if (message.role === "branchSummary" || message.role === "compactionSummary") return `[${message.role}]\n${message.summary}`;
        const label = message.role === "toolResult" ? `tool result: ${message.toolName}${message.isError ? " (error)" : ""}`
            : message.role === "custom" ? message.customType : message.role;
        const error = message.role === "assistant" && message.errorMessage ? `\n${message.errorMessage}` : "";
        return `[${label}]\n${contentText(message.content)}${error}`;
    }).filter(Boolean);
    return plain(messages.join("\n\n") || "No saved messages yet.");
}

export async function showPeerSession(state: WireState, peer: { name: string; session_file?: string; endpoint?: string }): Promise<void> {
    const ctx = state.currentCtx;
    if (!ctx || ctx.mode !== "tui" || state.shuttingDown || state.closeSessionViewer) return;
    // ponytail: prefix check, no realpath (a symlink inside the sessions dir means the account is already owned); --session-dir peers are live-only.
    const sessionsRoot = resolve(getAgentDir(), "sessions") + sep;
    const file = typeof peer.session_file === "string" && resolve(peer.session_file).startsWith(sessionsRoot) ? peer.session_file : undefined;
    const endpoint = typeof peer.endpoint === "string" && isAbsolute(peer.endpoint) ? peer.endpoint : undefined;
    if (!file && !endpoint) {
        ctx.ui.notify(`wire: ${peer.name} has no saved session path or live endpoint (reload wire on the peer).`, "warning");
        return;
    }

    let close = () => {};
    const closeViewer = () => close();
    state.closeSessionViewer = closeViewer;
    try {
        await ctx.ui.custom<void>((tui, theme, kb, done) => {
            let disposed = false;
            let timer: NodeJS.Timeout | undefined;
            let text = endpoint ? "Connecting to live session…" : "Loading saved session…";
            let status = endpoint ? "connecting" : "saved session";
            let source: string | undefined;
            let offset = Infinity; // Follow new messages until the user scrolls up.
            let page = 1;
            let maxOffset = 0;
            const body = new Text(text, 0, 0);
            const refresh = async () => {
                if (disposed) return;
                const previousText = text, previousStatus = status;
                let live = false;
                try {
                    if (endpoint) {
                        try {
                            const snapshot = await sendEnvelope(endpoint, {
                                type: "session_snapshot", msg_id: randomUUID(),
                                sender_session: state.identity?.session_id ?? "viewer",
                                sender_endpoint: state.identity?.endpoint ?? "",
                                hops: 0, timestamp: new Date().toISOString(),
                            });
                            if (snapshot?.type !== "session_snapshot" || typeof snapshot.source !== "string"
                                || !["running", "idle"].includes(snapshot.status)) throw new Error("Peer does not support live viewing");
                            if (snapshot.source !== source) {
                                text = sessionText(snapshot.source);
                                source = snapshot.source;
                            }
                            live = snapshot.status === "running";
                            status = `live · ${snapshot.status}`;
                            return;
                        } catch (error) {
                            status = "live unavailable · retrying";
                            if (!file) {
                                if (source === undefined) text = `Cannot read live session: ${error instanceof Error ? error.message : String(error)}. Reload wire on the peer.`;
                                return;
                            }
                            status = "saved session · live unavailable (reload peer)";
                        }
                    }
                    const info = await stat(file!);
                    if (!info.isFile()) throw new Error("Session path is not a regular file");
                    // ponytail: reload whole files up to 32 MiB; tail incrementally if larger sessions need viewing.
                    if (info.size > 32 * 1024 * 1024) throw new Error("Session exceeds the 32 MiB viewer limit");
                    const next = await readFile(file!, "utf8");
                    if (next !== source) {
                        text = sessionText(next);
                        source = next;
                    }
                } catch (error) {
                    source = undefined;
                    text = (error as NodeJS.ErrnoException).code === "ENOENT"
                        ? "No saved session yet, or the session file was removed. Waiting…"
                        : `Cannot read session: ${error instanceof Error ? error.message : String(error)}`;
                } finally {
                    if (!disposed) {
                        if (text !== previousText) body.setText(plain(text));
                        if (text !== previousText || status !== previousStatus) tui.requestRender();
                        // Only an open viewer polls; never hold up the peer's agent loop.
                        timer = setTimeout(() => { void refresh(); }, live ? 100 : PING_INTERVAL_MS);
                        timer.unref?.();
                    }
                }
            };
            const dispose = () => { disposed = true; clearTimeout(timer); };
            close = () => {
                if (disposed) return;
                dispose();
                done();
            };
            void refresh();
            return {
                dispose,
                invalidate() { body.invalidate(); },
                handleInput(data: string) {
                    if (kb.matches(data, "tui.select.cancel")) { close(); return; }
                    if (kb.matches(data, "tui.select.up")) offset = Math.max(0, Math.min(offset, maxOffset) - 1);
                    else if (kb.matches(data, "tui.select.down")) offset = Math.min(offset, maxOffset) + 1;
                    else if (kb.matches(data, "tui.select.pageUp")) offset = Math.max(0, Math.min(offset, maxOffset) - page);
                    else if (kb.matches(data, "tui.select.pageDown")) offset = Math.min(offset, maxOffset) + page;
                    else if (matchesKey(data, "home")) offset = 0;
                    else if (matchesKey(data, "end")) offset = Infinity;
                    if (offset >= maxOffset) offset = Infinity;
                    tui.requestRender();
                },
                render(width: number): string[] {
                    const height = Math.max(3, tui.terminal.rows);
                    page = height - 2;
                    const lines = body.render(Math.max(1, width));
                    maxOffset = Math.max(0, lines.length - page);
                    const start = Math.min(offset, maxOffset);
                    const visible = lines.slice(start, start + page);
                    while (visible.length < page) visible.push("");
                    return [
                        theme.fg("accent", ` ${plain(peer.name)} — read-only ${status} `),
                        ...visible,
                        theme.fg("dim", ` ↑↓ scroll · PgUp/PgDn page · Home/End · esc back · ${offset === Infinity ? "following" : "paused"}`),
                    ].map((line) => truncateToWidth(line, width));
                },
            };
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
    } catch (error) {
        ctx.ui.notify(`wire: cannot open session — ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
        close();
        if (state.closeSessionViewer === closeViewer) state.closeSessionViewer = undefined;
    }
}
