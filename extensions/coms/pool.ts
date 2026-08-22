/**
 * coms — peer discovery: ping cycle, live pool refresh, and target resolution.
 */

import * as crypto from "node:crypto";
import { AgentCard, ComsState, PingEnvelope, Pong, RegistryEntry } from "./types";
import { nowIso } from "./util";
import { liveEntries } from "./registry";
import { sendEnvelope } from "./transport";
import { installPoolWidget } from "./widget";

export async function pingPeer(state: ComsState, endpoint: string): Promise<AgentCard | null> {
    if (!state.identity) return null;
    const env: PingEnvelope = {
        type: "ping",
        msg_id: crypto.randomUUID(),
        sender_session: state.identity.session_id,
        sender_endpoint: state.identity.endpoint,
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

let refreshingPool = false;
export async function refreshPool(state: ComsState): Promise<void> {
    if (!state.identity || refreshingPool) return;
    refreshingPool = true;
    try {
        const live = liveEntries();

        const peers = live.filter((e) =>
            e.session_id !== state.identity!.session_id && (state.includeExplicit || !e.explicit),
        );

        const results = await Promise.allSettled(peers.map(async (peer) => {
            const pingEnv: PingEnvelope = {
                type: "ping",
                msg_id: crypto.randomUUID(),
                sender_session: state.identity!.session_id,
                sender_endpoint: state.identity!.endpoint,
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
                const prev = state.peerCards.get(peer.session_id);
                const next = { ...pong.agent_card, staleCount: 0 };
                // Field-wise compare — cheaper than JSON.stringify and order-insensitive.
                const differs = !prev
                    || (["name", "purpose", "model", "color", "context_used_pct"] as const)
                        .some((k) => prev[k] !== next[k]);
                if (differs) {
                    state.peerCards.set(peer.session_id, next);
                    changed = true;
                }
            }
        }

        for (const [sid, card] of state.peerCards.entries()) {
            if (state.identity && sid === state.identity.session_id) continue;
            if (!seenSessions.has(sid)) {
                card.staleCount = (card.staleCount ?? 0) + 1;
                if (card.staleCount > 6) {
                    state.peerCards.delete(sid);
                }
                changed = true;
            }
        }

        if (changed && state.currentCtx?.hasUI) {
            installPoolWidget(state, state.currentCtx);
        }
    } finally {
        refreshingPool = false;
    }
}

export function resolveTarget(state: ComsState, target: string): RegistryEntry | null {
    // Global pool — any live agent is addressable.
    if (!state.identity) return null;
    const entries = liveEntries();
    return entries.find((e) => e.session_id === target) ?? entries.find((e) => e.name === target) ?? null;
}
