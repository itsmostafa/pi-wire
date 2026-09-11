/**
 * wire — registry I/O: one JSON file per agent under ~/.pi/wire/agents/,
 * written atomically, with a PING_INTERVAL_MS-throttled live-entries cache.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WIRE_DIR, PING_INTERVAL_MS } from "./types";
import type { RegistryEntry } from "./types";

export function agentsDir(): string {
    return path.join(WIRE_DIR, "agents");
}

function registryFilePath(name: string): string {
    return path.join(agentsDir(), `${name}.json`);
}

function sanitizeRegistryEntry(entry: RegistryEntry): RegistryEntry {
    if (entry.session_file === undefined || typeof entry.session_file === "string") return entry;
    const sanitized = { ...entry };
    delete sanitized.session_file;
    return sanitized;
}

export function writeRegistryAtomic(entry: RegistryEntry): string {
    const dir = agentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeEntry = sanitizeRegistryEntry(entry);
    const final = registryFilePath(safeEntry.name);
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safeEntry, null, 2));
    fs.renameSync(tmp, final);
    return final;
}

function readAllRegistryEntries(): RegistryEntry[] {
    const dir = agentsDir();
    if (!fs.existsSync(dir)) return [];
    const out: RegistryEntry[] = [];
    let files: string[];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
            const raw = fs.readFileSync(path.join(dir, f), "utf-8");
            const parsed = JSON.parse(raw) as RegistryEntry;
            if (parsed && typeof parsed.session_id === "string") {
                out.push(sanitizeRegistryEntry(parsed));
            }
        } catch {
            // skip malformed
        }
    }
    return out;
}

/** Unlink an agent's file only if it still holds that agent's session — a name
 *  freed by one agent can already be reserved by another. */
export function removeRegistryEntry(name: string, session_id: string): void {
    const file = registryFilePath(name);
    try {
        const owner = (JSON.parse(fs.readFileSync(file, "utf-8")) as RegistryEntry).session_id;
        if (owner !== session_id) return;
        fs.unlinkSync(file);
    } catch {
        // best-effort
    }
}

function pruneDeadEntries(): RegistryEntry[] {
    const entries = readAllRegistryEntries();
    const live: RegistryEntry[] = [];
    for (const entry of entries) {
        try {
            process.kill(entry.pid, 0);
            live.push(entry);
        } catch (e: any) {
            if (e && e.code === "ESRCH") {
                removeRegistryEntry(entry.name, entry.session_id);
            } else {
                // EPERM means the process exists but we can't signal it — treat as live.
                live.push(entry);
            }
        }
    }
    return live;
}

// Registry cache — the render path and tools read from here; refreshed at most
// every PING_INTERVAL_MS so sync fs stays off hot paths.
let cachedEntries: RegistryEntry[] = [];
let cachedEntriesAt = 0;

export function liveEntries(): RegistryEntry[] {
    if (Date.now() - cachedEntriesAt > PING_INTERVAL_MS) {
        cachedEntries = pruneDeadEntries();
        cachedEntriesAt = Date.now();
    }
    return cachedEntries;
}

/** Drop the cache so the next liveEntries() re-reads from disk. Tests need it:
 *  the cache is process-wide and outlives the registry files they clean up. */
export function invalidateEntryCache(): void {
    cachedEntriesAt = 0;
}

/** Read the cache without ever triggering a refresh — for the render path. */
export function peekCachedEntries(): RegistryEntry[] {
    return cachedEntries;
}

/** Claim a file for `entry` under the first free name derived from entry.name.
 *  The exclusive create IS the reservation, so two agents racing on the same
 *  desired name can never both win it. Readers already skip unparseable JSON,
 *  so seeing a partially written entry is harmless. */
export function reserveRegistryEntry(entry: RegistryEntry): { name: string; file: string } {
    fs.mkdirSync(agentsDir(), { recursive: true });
    pruneDeadEntries(); // frees the names of agents that have exited
    const safeEntry = sanitizeRegistryEntry(entry);
    for (let n = 1; ; n++) {
        const name = n === 1 ? safeEntry.name : `${safeEntry.name}${n}`;
        const file = registryFilePath(name);
        try {
            fs.writeFileSync(file, JSON.stringify({ ...safeEntry, name }, null, 2), { flag: "wx" });
            return { name, file };
        } catch (err: any) {
            if (err?.code !== "EEXIST") throw err;
        }
    }
}
