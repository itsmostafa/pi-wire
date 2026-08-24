/**
 * coms — tool registration: coms_list, coms_send, coms_respond.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import { ComsState, MAX_HOPS, PromptEnvelope, RegistryEntry } from "./types";
import { nowIso } from "./util";
import { liveEntries } from "./registry";
import { sendEnvelope } from "./transport";
import { dispatchInboundResponse } from "./server";
import { pingPeer, resolveTarget } from "./pool";

export function registerTools(pi: ExtensionAPI, state: ComsState): void {
    pi.registerTool({
        name: "coms_list",
        label: "Coms List",
        description:
            "List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
            "include_explicit=true reveals agents marked --explicit.",
        parameters: Type.Object({
            include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
        }),
        renderShell: "self",
        async execute(_callId, params) {
            const includeExp = params.include_explicit === true;

            const collected: RegistryEntry[] = [];
            for (const entry of liveEntries()) {
                if (entry.explicit && !includeExp) continue;
                if (state.identity && entry.session_id === state.identity.session_id) continue;
                collected.push(entry);
            }

            // Ping each peer in parallel for live context usage.
            const pongs = await Promise.allSettled(collected.map((c) => pingPeer(state, c.endpoint)));

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
            "Send an asynchronous request to a peer. Returns a msg_id once the peer accepts it; never waits for its response. " +
            "The peer's reply arrives automatically as a follow-up message, queued until this agent's current work finishes. " +
            "Throws if the peer is unreachable or rejects delivery.",
        parameters: Type.Object({
            target: Type.String({ description: "Peer name or session_id." }),
            prompt: Type.String({ description: "The prompt to send." }),
            response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
        }),
        renderShell: "self",
        async execute(_callId, params) {
            if (!state.identity) {
                throw new Error("coms not initialised");
            }
            const target = resolveTarget(state, params.target);
            if (!target) {
                throw new Error(`coms: no live agent matching "${params.target}"`);
            }
            const hops = state.currentInbound ? state.currentInbound.hops + 1 : 0;
            if (hops >= MAX_HOPS) {
                throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
            }
            const msg_id = crypto.randomUUID();
            const env: PromptEnvelope = {
                type: "prompt",
                msg_id,
                sender_session: state.identity.session_id,
                sender_endpoint: state.identity.endpoint,
                sender_name: state.identity.name,
                hops,
                timestamp: nowIso(),
                prompt: params.prompt,
                response_schema: (params.response_schema as object | undefined) ?? null,
            };

            // Wait only for the transport ack, never for the peer's answer. The
            // reply is delivered as a queued follow-up when it arrives.
            await sendEnvelope(target.endpoint, env);

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
            const target = (args as any).target ?? "?";
            return new Text(theme.fg("success", "→ ") + theme.fg("accent", target), 0, 0);
        },
        renderResult(_result, _options, _theme, context) {
            return new Text((context.args as any).prompt ?? "", 0, 0);
        },
    });

    pi.registerTool({
        name: "coms_respond",
        label: "Coms Respond",
        description:
            "Finish an inbound coms request asynchronously. Provide response to reply, or decline=true when no reply is useful. " +
            "Call exactly once for each inbound request; never use it for ordinary user prompts or peer responses. " +
            "If delivery fails (peer unreachable, response too large) the error is thrown and you may retry with a smaller payload.",
        promptSnippet: "Reply to or decline an inbound asynchronous coms request",
        promptGuidelines: [
            "For each inbound coms request, call coms_respond exactly once with its msg_id; provide response or set decline=true.",
        ],
        parameters: Type.Object({
            msg_id: Type.String({ description: "Inbound request id shown in the peer message." }),
            response: Type.Optional(Type.Any({ description: "Response payload. Omit when declining." })),
            decline: Type.Optional(Type.Boolean({ description: "Set true when no response is useful." })),
        }),
        renderShell: "self",
        async execute(_callId, params) {
            const inbound = state.inboundQueue.get(params.msg_id);
            if (!inbound) throw new Error(`coms_respond: unknown or completed msg_id ${params.msg_id}`);
            if (params.decline === true && params.response !== undefined) {
                throw new Error("coms_respond: provide response or decline=true, not both");
            }
            if (params.decline !== true && params.response === undefined) {
                throw new Error("coms_respond: response is required unless decline=true");
            }

            let response = params.decline === true ? null : params.response;
            if (inbound.response_schema && typeof response === "string") {
                try {
                    response = JSON.parse(response);
                } catch {
                    throw new Error("coms_respond: response must be valid JSON for this request");
                }
            }
            // Await the transport ack only (≤5s, never requester work). On failure
            // the tool throws and the inbound is retained — the model can retry.
            await dispatchInboundResponse(pi, state, inbound, response, params.decline === true ? "declined" : null);
            return {
                content: [{ type: "text" as const, text: params.decline === true ? "Response declined." : "Response dispatched." }],
                details: { msg_id: params.msg_id, declined: params.decline === true },
                terminate: true,
            };
        },
        renderCall(args, theme) {
            return new Text(theme.fg((args as any).decline ? "warning" : "success", (args as any).decline ? "↛ decline" : "← respond"), 0, 0);
        },
    });
}
