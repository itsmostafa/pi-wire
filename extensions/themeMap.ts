import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * No-op stand-in for the themeMap helper used by coms.ts.
 * If you have the real themeMap.ts (per-extension theme defaults), drop it in
 * place of this file.
 */
export function applyExtensionDefaults(_extensionUrl: string, _ctx: ExtensionContext): void {
    // intentionally empty
}
