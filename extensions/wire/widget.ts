/**
 * wire — pool widget: live peer list under the editor, plus the NamedEditor
 * that shows the agent's name in the input border and hands Down-arrow focus
 * to the peer list.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { POOL_MAX_ROWS, type RegistryEntry, type WireState } from "./types";
import { abbreviateModel, hexFg } from "./util";
import { peekCachedEntries } from "./registry";

// ━━ Editor with agent name in the top-right of the input border ━━━━━━━━━━
//
// Also the pool list's keyboard: widgets never receive input (pi routes keys to
// the focused editor), so the peer list is driven from here.

export class NamedEditor extends CustomEditor {
    private label: string;
    private labelWidth: number;
    private kb: any;
    // Not `state`: the base Editor already owns a private field by that name.
    private wire: WireState;

    constructor(tui: any, theme: any, keybindings: any, label: string, state: WireState) {
        super(tui, theme, keybindings);
        this.label = label;
        this.labelWidth = visibleWidth(label);
        this.kb = keybindings;
        this.wire = state;
    }

    render(width: number): string[] {
        const lines = super.render(width);
        if (this.labelWidth > 0 && lines.length > 0 && this.labelWidth < width) {
            // First line is the full-width top border; carve out space at the right.
            lines[0] = truncateToWidth(lines[0], width - this.labelWidth, "") + this.label;
        }
        return lines;
    }

    handleInput(data: string): void {
        if (this.wire.poolSelected !== null) {
            // An autocomplete request already in flight can land *after* focus
            // moved here — it applies whenever text and cursor are unchanged,
            // which is exactly the state that let us take focus. Re-check every
            // key so the menu, when it appears, keeps the arrows.
            if (!this.isShowingAutocomplete()) {
                if (this.kb.matches(data, "tui.editor.cursorUp")) {
                    // Up off the top row hands focus back to the editor.
                    this.wire.poolSelected = this.wire.poolSelected === 0 ? null : this.wire.poolSelected - 1;
                    this.repaintPool();
                    return;
                }
                if (this.kb.matches(data, "tui.editor.cursorDown")) {
                    this.wire.poolSelected = Math.min(this.wire.poolSelected + 1, poolRows(this.wire).length - 1);
                    this.repaintPool();
                    return;
                }
            }
            // Anything else resumes the editor and is handled there — escape
            // included, so it still reaches pi's abort instead of being eaten.
            this.wire.poolSelected = null;
            this.repaintPool();
            super.handleInput(data);
            return;
        }

        // Enter the peer list only when Down is inert in the editor: the cursor
        // sits at the end of the last line and prompt history is exhausted.
        // Probing the real editor beats reimplementing its history rules.
        if (this.kb.matches(data, "tui.editor.cursorDown") && !this.isShowingAutocomplete() && poolRows(this.wire).length > 0) {
            const before = this.editorSnapshot();
            super.handleInput(data);
            if (this.editorSnapshot() === before) {
                this.wire.poolSelected = 0;
                this.repaintPool();
            }
            return;
        }

        super.handleInput(data);
    }

    private editorSnapshot(): string {
        const cursor = this.getCursor();
        return `${cursor.line}:${cursor.col}\n${this.getText()}`;
    }

    private repaintPool(): void {
        if (this.wire.currentCtx?.hasUI) installPoolWidget(this.wire, this.wire.currentCtx);
    }
}

// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Row {
    name: string;
    model: string;
    color: string;
    purpose: string;
    pct: number | null;
    pending: boolean;
    stale: boolean;
}

/** Peer rows in display order. Also the source of truth for "are there peers". */
export function poolRows(state: WireState, registryEntries: RegistryEntry[] = peekCachedEntries()): Row[] {
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

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

export function renderPool(
    state: WireState,
    width: number,
    theme: Theme,
    // Render from the refreshPool cache — zero fs on the render path.
    registryEntries: RegistryEntry[] = peekCachedEntries(),
): string[] {
    // Peer rows only — own name lives in the editor border top-right.
    const rows = poolRows(state, registryEntries);

    const safeWidth = Math.max(0, width);
    const rule = theme.fg("dim", "━".repeat(safeWidth));

    if (rows.length === 0) {
        // Zero rows → render nothing; an empty widget collapses cleanly.
        state.poolSelected = null;
        return [];
    }

    // Peers come and go under the selection, so clamp and write it back.
    const selected = state.poolSelected === null
        ? null
        : Math.max(0, Math.min(state.poolSelected, rows.length - 1));
    state.poolSelected = selected;

    // Window follows the selection, centred like pi's own SelectList.
    const first = selected === null
        ? 0
        : Math.max(0, Math.min(selected - Math.floor(POOL_MAX_ROWS / 2), rows.length - POOL_MAX_ROWS));
    const visible = rows.slice(first, first + POOL_MAX_ROWS);

    const out: string[] = [rule];

    for (const [i, r] of visible.entries()) {
        const pctNum = r.pct ?? 0;
        const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
        const empty = 15 - filled;
        const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;
        const isSelected = first + i === selected;
        const marker = isSelected ? "›" : " ";

        if (r.stale) {
            const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
            out.push(highlight(theme, truncateToWidth(marker + theme.fg("dim", dimRow), width), isSelected, safeWidth));
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

        const line = marker + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + sep + purposePart;
        out.push(highlight(theme, truncateToWidth(line, width), isSelected, safeWidth));
    }

    // Position and key hint rides the bottom rule so widget height stays fixed.
    let bottomBorder = rule;
    if (selected !== null) {
        bottomBorder = ruleWithHint(theme, ` ${selected + 1} of ${rows.length} · ↑↓ move · esc back `, safeWidth);
    } else if (rows.length > POOL_MAX_ROWS) {
        bottomBorder = ruleWithHint(theme, ` ${first + 1}–${first + visible.length} of ${rows.length} · ↓ to browse `, safeWidth);
    }
    out.push(bottomBorder);
    return out;
}

/** Paint the selected row edge to edge. Theme fg/bg reset independently, so the
 *  row's own colors survive inside the highlight. */
function highlight(theme: Theme, line: string, selected: boolean, width: number): string {
    if (!selected) return line;
    return theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
}

function ruleWithHint(theme: Theme, hint: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(hint) - 2);
    return theme.fg("dim", truncateToWidth("━━" + hint + "━".repeat(pad), width));
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
