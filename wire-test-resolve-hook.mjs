// Test-only ESM resolve hook. Pi loads TypeScript and package aliases at runtime;
// Node's test runner needs their local/global installation paths.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let aliases;

function packageRoot() {
    if (process.env.PI_WIRE_TEST_PI_ROOT) return process.env.PI_WIRE_TEST_PI_ROOT;
    const local = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(local, "package.json"))) return local;
    return join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
}

function importEntry(root) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const entry = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main;
    if (!entry) throw new Error(`No import entry for ${root}`);
    return join(root, entry);
}

function packageAliases() {
    if (aliases) return aliases;
    const root = packageRoot();
    // Keep a package-scoped resolver for layouts where host dependencies are
    // hoisted rather than nested beside coding-agent.
    const requireFromPi = createRequire(join(root, "package.json"));
    const dependency = (name) => {
        const nested = join(root, "node_modules", ...name.split("/"));
        if (existsSync(join(nested, "package.json"))) return importEntry(nested);
        return requireFromPi.resolve(name);
    };
    const pi = importEntry(root);
    aliases = new Map([
        ["@earendil-works/pi-coding-agent", pi],
        ["@mariozechner/pi-coding-agent", pi],
        ["@mariozechner/pi-tui", dependency("@earendil-works/pi-tui")],
        ["@sinclair/typebox", dependency("typebox")],
    ]);
    return aliases;
}

export async function resolve(specifier, context, next) {
    if (specifier.startsWith("@")) {
        const alias = packageAliases().get(specifier);
        if (alias) return { url: pathToFileURL(alias).href, shortCircuit: true };
    }
    try {
        return await next(specifier, context);
    } catch (error) {
        if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
        throw error;
    }
}
