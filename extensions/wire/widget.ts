/**
 * wire — pool widget: live peer list under the editor, plus the NamedEditor
 * that shows the agent's name in the input border.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { WireState } from "./types";
import { abbreviateModel, hexFg } from "./util";
import { peekCachedEntries } from "./registry";

// ━━ Editor with agent name in the top-right of the input border ━━━━━━━━━━

export class NamedEditor extends CustomEditor {
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

// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function renderPool(state: WireState, width: number, theme: Theme): string[] {
    // Peer rows only — own name lives in the editor border top-right.
    // Render from the refreshPool cache — zero fs on the render path.
    const registryEntries = peekCachedEntries();

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

    for (const [sid, card] of state.peerCards.entries()) {
        if (state.identity && sid === state.identity.session_id) continue;
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
        if (state.identity && entry.session_id === state.identity.session_id) continue;
        if (!state.includeExplicit && entry.explicit) continue;
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

export function installPoolWidget(state: WireState, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
        ctx.ui.setWidget("wire-pool", (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
                return renderPool(state, width, theme);
            },
        }), { placement: "belowEditor" });
    } catch {
        // non-fatal
    }
}
