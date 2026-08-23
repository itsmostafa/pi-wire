/**
 * coms — shared constants, types, and cross-module state container.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseEnvInt(name: string, fallback: number, min?: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const val = Number(raw);
    if (!Number.isFinite(val) || Number.isNaN(val)) return fallback;
    return min !== undefined ? Math.max(min, val) : val;
}

export const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
export const MAX_HOPS = parseEnvInt("PI_COMS_MAX_HOPS", 5, 1);
export const PING_INTERVAL_MS = parseEnvInt("PI_COMS_PING_INTERVAL_MS", 2_000, 100);
export const KEEPALIVE_INTERVAL_MS = 30_000;
export const LINE_CAP_BYTES = parseEnvInt("PI_COMS_LINE_CAP_BYTES", 10 * 1024 * 1024, 1024);

export const FALLBACK_PALETTE = [
    "#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
    "#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type EnvelopeType = "prompt" | "response" | "ping";

export interface Envelope {
    type: EnvelopeType;
    msg_id: string;
    sender_session: string;
    sender_endpoint: string;
    hops: number;
    timestamp: string;
}

export interface PromptEnvelope extends Envelope {
    type: "prompt";
    prompt: string;
    sender_name: string;
    response_schema?: object | null;
}

export interface ResponseEnvelope extends Envelope {
    type: "response";
    sender_name?: string;
    response: any;
    error?: string | null;
}

export interface PingEnvelope extends Envelope {
    type: "ping";
}

export interface AgentCard {
    name: string;
    purpose: string;
    model: string;
    color: string;
    context_used_pct: number;
}

export interface Pong {
    type: "pong";
    msg_id: string;
    agent_card: AgentCard;
}

export interface RegistryEntry {
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
}

export interface InboundContext {
    msg_id: string;
    hops: number;
    sender_endpoint: string;
    response_schema?: object | null;
    started: boolean;
}

export interface Identity {
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
}

/**
 * Mutable state shared across all modules for one extension instance.
 * Created once in coms.ts (the composition root) and passed by reference.
 */
export interface ComsState {
    identity: Identity | null;
    peerCards: Map<string, AgentCard & { staleCount: number }>;
    inboundQueue: Map<string, InboundContext>;
    includeExplicit: boolean;
    currentCtx: ExtensionContext | null;
    currentInbound: InboundContext | null;
}
