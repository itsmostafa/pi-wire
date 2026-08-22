/**
 * coms — pure helpers: colors, frontmatter parsing, endpoint paths, identity
 * resolution from CLI flags and system-prompt frontmatter.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { COMS_DIR, FALLBACK_PALETTE } from "./types";

export function hexFg(hex: string, s: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function isValidHex(hex: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function fallbackColor(sessionId: string): string {
    const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
    return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

export function parseFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
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

export function makeEndpoint(sessionId: string): string {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\pi-coms-${sessionId}`;
    }
    return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function abbreviateModel(model: string): string {
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

export function readCliFlags(pi: ExtensionAPI): CliFlags {
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

export function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
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
