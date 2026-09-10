/**
 * wire — inbound connection handling: envelope validation, prompt/response/ping
 * dispatch, and the outbound response path for wire_respond.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type {
    AgentCard,
    WireState,
    Envelope,
    InboundContext,
    PingEnvelope,
    Pong,
    PromptEnvelope,
    ResponseEnvelope,
    SessionSnapshotEnvelope,
} from "./types";
import { LINE_CAP_BYTES, MAX_HOPS, SEEN_RESPONSE_IDS_CAP } from "./types";
import { nowIso } from "./util";
import { sendEnvelope } from "./transport";
import { handleSessionSnapshot } from "./session-live";

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

function handlePrompt(pi: ExtensionAPI, state: WireState, socket: net.Socket, env: PromptEnvelope): void {
    // Admission gate: during shutdown the queue snapshot is taken and this
    // prompt could never be answered — reject it so the sender knows now.
    if (state.shuttingDown) {
        nack(socket, env.msg_id, "shutting down");
        return;
    }
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
        response_schema: env.response_schema ?? null,
        started: false,
    };
    state.inboundQueue.set(env.msg_id, inbound);

    // 3. Inject as a follow-up message into the receiver's next turn. The
    //    receiver explicitly replies or declines, so unrelated turns can never
    //    be mistaken for a response.
    const schema = env.response_schema
        ? ` The response must match this JSON Schema: ${JSON.stringify(env.response_schema)}.`
        : "";
    try {
        pi.sendMessage(
            {
                customType: "wire-inbound",
                content: `@${env.sender_name}>\n\n${env.prompt}\n\n` +
                    `[Async wire request ${env.msg_id}. Decide whether a reply is useful. ` +
                    `Before finishing, call wire_respond exactly once with this msg_id: ` +
                    `provide response, or set decline=true.${schema} Do not wait for the sender.]`,
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
    } catch {
        // If sendMessage fails, drop the inbound and nack.
        state.inboundQueue.delete(env.msg_id);
        nack(socket, env.msg_id, "internal error");
        return;
    }

    // 4. Ack + audit log
    ackOk(socket, env.msg_id);
    try {
        pi.appendEntry("wire-log", {
            event: "inbound_prompt",
            msg_id: env.msg_id,
            sender: env.sender_session,
            hops: env.hops,
        });
    } catch {
        // best-effort
    }
}

function handleResponse(pi: ExtensionAPI, state: WireState, socket: net.Socket, env: ResponseEnvelope): void {
    // Admission gate: during shutdown the follow-up could never be delivered;
    // nack so the responder retains the inbound and sees the failure.
    if (state.shuttingDown) {
        nack(socket, env.msg_id, "shutting down");
        return;
    }
    // Dedup by msg_id: a lost ACK makes delivery ambiguous — the responder may
    // retry wire_respond or fire agent_settled cleanup, delivering a second
    // (possibly contradictory) terminal message for the same request. The
    // first terminal message wins; later ones are acked and dropped.
    if (state.seenResponseIds.has(env.msg_id)) {
        ackOk(socket, env.msg_id);
        return;
    }
    state.seenResponseIds.add(env.msg_id);
    // ponytail: FIFO trim, O(1) — a ring buffer if this ever shows up in profiles
    if (state.seenResponseIds.size > SEEN_RESPONSE_IDS_CAP) {
        const oldest = state.seenResponseIds.values().next().value;
        if (oldest !== undefined) state.seenResponseIds.delete(oldest);
    }

    // Deliver the reply as a follow-up. If this session is mid-turn, followUp
    // queues it until the agent run settles; if idle, triggerTurn fires
    // a new turn immediately. The requesting agent never polls.
    const senderName = env.sender_name || "peer";
    const text = env.error
        ? `@${senderName}<\n\nRequest ${env.msg_id}: ${env.error}. No reply is required.`
        : `@${senderName}<\n\n${typeof env.response === "string" ? env.response : JSON.stringify(env.response, null, 2)}\n\n` +
            `[Async response to ${env.msg_id}. Continue using this result. Do not reply unless a new request is necessary.]`;
    // Enqueue locally BEFORE acking, so a failed follow-up injection is reported
    // to the responder instead of silently dropping the result. Enqueueing is
    // synchronous queue admission — we never wait for the local agent to run.
    try {
        pi.sendMessage(
            {
                customType: "wire-response",
                content: text,
                display: true,
                details: { msg_id: env.msg_id, sender_name: senderName, error: env.error ?? null },
            },
            { deliverAs: "followUp", triggerTurn: true },
        );
    } catch {
        // Roll back the dedup mark so the responder's retry can re-enqueue.
        state.seenResponseIds.delete(env.msg_id);
        nack(socket, env.msg_id, "internal error");
        return;
    }
    ackOk(socket, env.msg_id);
}

function handlePing(state: WireState, socket: net.Socket, env: PingEnvelope): void {
    const ctx = state.currentCtx;
    const ident = state.identity;
    const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    const card: AgentCard = {
        name: ident?.name ?? "unknown",
        purpose: ident?.purpose ?? "",
        model: ctx?.model?.id ?? ident?.model ?? "unknown",
        color: ident?.color ?? "#36F9F6",
        context_used_pct: pct,
        ...(typeof sessionFile === "string" ? { session_file: sessionFile } : {}),
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

export function createConnHandler(pi: ExtensionAPI, state: WireState): (socket: net.Socket) => void {
    return function connHandler(socket: net.Socket): void {
        // ponytail: idle cap so stalled inbound connections can't accumulate
        socket.setTimeout(30_000, () => socket.destroy());
        const decoder = new StringDecoder("utf-8");
        let buf = "";
        let bufBytes = 0;
        let handled = false;
        const onData = (chunk: Buffer) => {
            if (handled) return;
            // StringDecoder: a multibyte UTF-8 char split across TCP chunks
            // must not be decoded per-chunk.
            buf += decoder.write(chunk);
            bufBytes += chunk.length; // byte cap, not JS string length (non-ASCII)
            if (bufBytes > LINE_CAP_BYTES) {
                handled = true;
                socket.removeListener("data", onData);
                nack(socket, "", `line too large (${bufBytes} > ${LINE_CAP_BYTES} bytes)`);
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
                    handlePrompt(pi, state, socket, parsed as PromptEnvelope);
                } else if (parsed.type === "response") {
                    handleResponse(pi, state, socket, parsed as ResponseEnvelope);
                } else if (parsed.type === "ping") {
                    handlePing(state, socket, parsed as PingEnvelope);
                } else if (parsed.type === "session_snapshot") {
                    handleSessionSnapshot(state, socket, parsed as SessionSnapshotEnvelope);
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
    };
}

/**
 * Fire-and-forget error notification for a request this session can no longer
 * answer (interrupted run, shutdown). Used by auto-cleanup paths where the
 * queue entry is already being removed regardless of delivery success.
 */
export function sendErrorResponse(pi: ExtensionAPI, state: WireState, inbound: InboundContext, error: string): Promise<void> {
    if (!state.identity) return Promise.resolve();
    const env: ResponseEnvelope = {
        type: "response",
        msg_id: inbound.msg_id,
        sender_session: state.identity.session_id,
        sender_endpoint: state.identity.endpoint,
        sender_name: state.identity.name,
        hops: 0,
        timestamp: nowIso(),
        response: null,
        error,
    };
    // Fire and forget: bounded by sendEnvelope's fixed 5s cap.
    return sendEnvelope(inbound.sender_endpoint, env).then(() => {
        try {
            pi.appendEntry("wire-log", { event: "outbound_response", msg_id: inbound.msg_id, error });
        } catch { /* best-effort */ }
    }).catch((e: any) => {
        try {
            pi.appendEntry("wire-log", {
                event: "outbound_response_failed",
                msg_id: inbound.msg_id,
                reason: e?.message ?? String(e),
            });
        } catch { /* best-effort */ }
    });
}

/**
 * Dispatch a peer's answer. Awaits ONLY the transport ack (≤5s) — never any
 * requester-side agent work — so wire_respond can truthfully report success.
 * On failure the inbound queue entry is RETAINED so the model can retry; on
 * success it is removed. Throws on failure.
 */
export async function dispatchInboundResponse(pi: ExtensionAPI, state: WireState, inbound: InboundContext, response: any, error: string | null): Promise<void> {
    if (!state.identity) throw new Error("wire not initialised");
    if (inbound.sending) throw new Error("wire_respond: response already being sent for this msg_id");

    const env: ResponseEnvelope = {
        type: "response",
        msg_id: inbound.msg_id,
        sender_session: state.identity.session_id,
        sender_endpoint: state.identity.endpoint,
        sender_name: state.identity.name,
        hops: 0,
        timestamp: nowIso(),
        response,
        error,
    };

    // Preflight the wire size before touching any state — a >LINE_CAP payload
    // would be nacked by the receiver and, pre-fix, silently lost. +1 for the
    // framing newline written on the wire.
    const bytes = Buffer.byteLength(JSON.stringify(env)) + 1;
    if (bytes > LINE_CAP_BYTES) {
        throw new Error(`wire_respond: response too large (${bytes} > ${LINE_CAP_BYTES} bytes) — send a file path or summary instead`);
    }

    inbound.sending = true;
    const outcome: Promise<void> = sendEnvelope(inbound.sender_endpoint, env).then(() => {
        // Transport ack received — the responder accepted the result.
        state.inboundQueue.delete(inbound.msg_id);
        if (state.currentInbound?.msg_id === inbound.msg_id) state.currentInbound = null;
        try {
            pi.appendEntry("wire-log", { event: "outbound_response", msg_id: inbound.msg_id, error });
        } catch { /* best-effort */ }
    }, (e: any) => {
        // Delivery failed: retain the inbound so the model can retry.
        inbound.sending = false;
        try {
            pi.appendEntry("wire-log", {
                event: "outbound_response_failed",
                msg_id: inbound.msg_id,
                reason: e?.message ?? String(e),
            });
        } catch { /* best-effort */ }
        throw e;
    });
    // Track the in-flight send so cleanShutdown can await it (bounded by the
    // fixed 5s transport cap) instead of racing it with teardown.
    state.inflightResponses.add(outcome);
    void outcome.finally(() => state.inflightResponses.delete(outcome)).catch(() => {});
    return outcome;
}
