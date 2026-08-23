/**
 * coms — inbound connection handling: envelope validation, prompt/response/ping
 * dispatch, and the outbound response path for coms_respond.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import {
    AgentCard,
    ComsState,
    Envelope,
    InboundContext,
    LINE_CAP_BYTES,
    MAX_HOPS,
    PingEnvelope,
    Pong,
    PromptEnvelope,
    ResponseEnvelope,
} from "./types";
import { nowIso } from "./util";
import { sendEnvelope } from "./transport";

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

function handlePrompt(pi: ExtensionAPI, state: ComsState, socket: net.Socket, env: PromptEnvelope): void {
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
                customType: "coms-inbound",
                content: `@${env.sender_name}>\n\n${env.prompt}\n\n` +
                    `[Async coms request ${env.msg_id}. Decide whether a reply is useful. ` +
                    `Before finishing, call coms_respond exactly once with this msg_id: ` +
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
    } catch (err) {
        // If sendMessage fails, drop the inbound and nack.
        state.inboundQueue.delete(env.msg_id);
        nack(socket, env.msg_id, "internal error");
        return;
    }

    // 4. Ack + audit log
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

function handleResponse(pi: ExtensionAPI, socket: net.Socket, env: ResponseEnvelope): void {
    // Ack before touching the local agent: the responder never waits for this
    // session to process the answer.
    ackOk(socket, env.msg_id);

    // Deliver the reply as a follow-up. If this session is mid-turn, followUp
    // queues it until the last tool call completes; if idle, triggerTurn fires
    // a new turn immediately. The requesting agent never polls.
    const senderName = env.sender_name || "peer";
    const text = env.error
        ? `@${senderName}<\n\nRequest ${env.msg_id}: ${env.error}. No reply is required.`
        : `@${senderName}<\n\n${typeof env.response === "string" ? env.response : JSON.stringify(env.response, null, 2)}\n\n` +
            `[Async response to ${env.msg_id}. Continue using this result. Do not reply unless a new request is necessary.]`;
    try {
        pi.sendMessage(
            {
                customType: "coms-response",
                content: text,
                display: true,
                details: { msg_id: env.msg_id, sender_name: senderName, error: env.error ?? null },
            },
            { deliverAs: "followUp", triggerTurn: true },
        );
    } catch {
        // Session may be shutting down; nothing more to do.
    }
}

function handlePing(state: ComsState, socket: net.Socket, env: PingEnvelope): void {
    const ctx = state.currentCtx;
    const ident = state.identity;
    const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
    const card: AgentCard = {
        name: ident?.name ?? "unknown",
        purpose: ident?.purpose ?? "",
        model: ctx?.model?.id ?? ident?.model ?? "unknown",
        color: ident?.color ?? "#36F9F6",
        context_used_pct: pct,
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

export function createConnHandler(pi: ExtensionAPI, state: ComsState): (socket: net.Socket) => void {
    return function connHandler(socket: net.Socket): void {
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
                    handlePrompt(pi, state, socket, parsed as PromptEnvelope);
                } else if (parsed.type === "response") {
                    handleResponse(pi, socket, parsed as ResponseEnvelope);
                } else if (parsed.type === "ping") {
                    handlePing(state, socket, parsed as PingEnvelope);
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

export function dispatchInboundResponse(pi: ExtensionAPI, state: ComsState, inbound: InboundContext, response: any, error: string | null): void {
    if (!state.identity) return;
    state.inboundQueue.delete(inbound.msg_id);
    if (state.currentInbound?.msg_id === inbound.msg_id) state.currentInbound = null;

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

    // Fire and forget: replying never waits for the requesting session to do work.
    void sendEnvelope(inbound.sender_endpoint, env).then(() => {
        try {
            pi.appendEntry("coms-log", { event: "outbound_response", msg_id: inbound.msg_id, error });
        } catch { /* best-effort */ }
    }).catch((e: any) => {
        try {
            pi.appendEntry("coms-log", {
                event: "outbound_response_failed",
                msg_id: inbound.msg_id,
                reason: e?.message ?? String(e),
            });
        } catch { /* best-effort */ }
    });
}
