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

export function writeRegistryAtomic(entry: RegistryEntry): string {
    const dir = agentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const final = registryFilePath(entry.name);
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
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
                out.push(parsed);
            }
        } catch {
            // skip malformed
        }
    }
    return out;
}

export function removeRegistryEntry(name: string): void {
    try {
        fs.unlinkSync(registryFilePath(name));
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
                removeRegistryEntry(entry.name);
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

/** Read the cache without ever triggering a refresh — for the render path. */
export function peekCachedEntries(): RegistryEntry[] {
    return cachedEntries;
}

export function resolveUniqueName(desiredName: string): string {
    // Returns a name that doesn't collide with any LIVE registered agent.
    // pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
    const live = pruneDeadEntries();
    const liveNames = new Set(live.map(e => e.name));
    if (!liveNames.has(desiredName)) return desiredName;
    let n = 2;
    while (liveNames.has(`${desiredName}${n}`)) n++;
    return `${desiredName}${n}`;
}
