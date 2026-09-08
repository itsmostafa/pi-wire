/** Agent-definition discovery, validation, and configuration. */

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Args, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentDefinition {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    color?: string;
    body: string;
    source: "user" | "project";
    filePath: string;
}

type RawFrontmatter = {
    name?: unknown;
    description?: unknown;
    tools?: unknown;
    model?: unknown;
    color?: unknown;
};

interface Candidate {
    name?: string;
    source: "user" | "project";
    filePath: string;
    definition?: AgentDefinition;
    error?: string;
}

export interface AgentSelectionOptions {
    userDir?: string;
    projectDir?: string | null;
    onDiagnostic?: (message: string) => void;
}

function invalid(filePath: string, message: string): never {
    throw new Error(`${filePath}: ${message}`);
}

function stringField(value: unknown, field: string, filePath: string): string {
    if (typeof value !== "string" || value.trim() === "") invalid(filePath, `${field} must be a non-empty string`);
    return value;
}

function toolsField(value: unknown, filePath: string): string[] {
    if (typeof value === "string") return value.split(",").map((tool) => tool.trim()).filter(Boolean);
    if (!Array.isArray(value)) invalid(filePath, "tools must be a comma-separated string or YAML list");
    return value.map((tool) => {
        if (typeof tool !== "string" || tool.trim() === "") invalid(filePath, "tools list members must be non-empty strings");
        return tool.trim();
    });
}

function parseCandidate(filePath: string, source: "user" | "project"): Candidate {
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        return { source, filePath, error: error instanceof Error ? error.message : String(error) };
    }
    let frontmatter: RawFrontmatter;
    let body: string;
    try {
        ({ frontmatter, body } = parseFrontmatter<RawFrontmatter>(content));
    } catch (error) {
        return { source, filePath, error: error instanceof Error ? error.message : String(error) };
    }
    if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
        return { source, filePath, error: "name must be a non-empty string" };
    }
    const name = frontmatter.name;
    try {
        const description = stringField(frontmatter.description, "description", filePath);
        const tools = Object.hasOwn(frontmatter, "tools") ? toolsField(frontmatter.tools, filePath) : undefined;
        const model = Object.hasOwn(frontmatter, "model") ? stringField(frontmatter.model, "model", filePath) : undefined;
        const color = Object.hasOwn(frontmatter, "color") ? stringField(frontmatter.color, "color", filePath) : undefined;
        if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) invalid(filePath, "color must be #RRGGBB");
        return { source, filePath, name, definition: { name, description, tools, model, color, body, source, filePath } };
    } catch (error) {
        return { source, filePath, name, error: error instanceof Error ? error.message : String(error) };
    }
}

function candidatesIn(dir: string, source: "user" | "project", onDiagnostic?: (message: string) => void): Candidate[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
        .map((entry) => parseCandidate(path.join(dir, entry.name), source))
        .map((candidate) => {
            if (candidate.error && !candidate.name) onDiagnostic?.(`wire agent definition unselectable: ${candidate.filePath}: ${candidate.error}`);
            return candidate;
        });
}

function nearestProjectAgentsDir(cwd: string): string | null {
    for (let dir = path.resolve(cwd);;) {
        const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch { /* keep walking */ }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function choose(candidates: Candidate[], name: string, scope: "user" | "project"): AgentDefinition | undefined {
    const matching = candidates.filter((candidate) => candidate.name === name);
    if (matching.length > 1) throw new Error(`multiple ${scope} agent definitions named "${name}"`);
    if (matching.length === 0) return undefined;
    const candidate = matching[0];
    if (candidate.error) throw new Error(candidate.error);
    return candidate.definition;
}

export function selectAgentDefinition(
    cwd: string,
    scope: AgentScope,
    name: string,
    options: AgentSelectionOptions = {},
): AgentDefinition {
    if (scope !== "user" && scope !== "project" && scope !== "both") {
        throw new Error("--wire-agent-scope must be user, project, or both");
    }
    const user = scope === "project" ? [] : candidatesIn(options.userDir ?? path.join(getAgentDir(), "agents"), "user", options.onDiagnostic);
    // User-only discovery must not inspect the project tree at all.
    const projectDir = scope === "user" ? null
        : options.projectDir === undefined ? nearestProjectAgentsDir(cwd) : options.projectDir;
    const project = projectDir ? candidatesIn(projectDir, "project", options.onDiagnostic) : [];
    const selected = scope === "both" ? choose(project, name, "project") ?? choose(user, name, "user")
        : scope === "project" ? choose(project, name, "project")
        : choose(user, name, "user");
    if (!selected) throw new Error(`no ${scope} agent definition named "${name}"`);
    return selected;
}

export async function configureAgentDefinition(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    definition: AgentDefinition,
    cli: Pick<Args, "model" | "tools" | "excludeTools" | "noTools" | "noBuiltinTools">,
): Promise<void> {
    const explicitTools = cli.tools !== undefined || cli.excludeTools !== undefined ||
        cli.noTools === true || cli.noBuiltinTools === true;
    const wireTools = ["wire_list", "wire_send", "wire_respond"];
    const activeTools = definition.tools === undefined || explicitTools
        ? pi.getActiveTools()
        : [...new Set([...definition.tools, ...wireTools])];

    // Validate all fields and the effective tool set before changing either.
    if (definition.tools !== undefined && !explicitTools) {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        for (const tool of definition.tools) {
            if (!available.has(tool)) throw new Error(`unknown tool "${tool}"`);
        }
    }
    const requireWireTools = (tools: string[]) => {
        const missing = wireTools.filter((tool) => !tools.includes(tool));
        if (missing.length) throw new Error(`required wire tools are inactive: ${missing.join(", ")}`);
    };
    requireWireTools(activeTools);

    let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
    if (definition.model) {
        const slash = definition.model.indexOf("/");
        const provider = slash < 1 ? "" : definition.model.slice(0, slash);
        const modelId = slash < 1 ? "" : definition.model.slice(slash + 1);
        model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
        if (!model) throw new Error(`unknown model "${definition.model}"`);
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
            throw new Error(`no authentication configured for model provider "${provider}"`);
        }
    }

    if (model && cli.model === undefined && await pi.setModel(model) === false) {
        throw new Error(`could not apply model "${definition.model}"`);
    }
    if (definition.tools !== undefined && !explicitTools) pi.setActiveTools(activeTools);
    // The host silently ignores unknown tools, and model hooks may change tools.
    requireWireTools(pi.getActiveTools());
}
