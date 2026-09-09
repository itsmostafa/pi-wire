// Requires an installed Pi package: these tests use Pi's real parseFrontmatter,
// parseArgs, and extension entry rather than a YAML/parser substitute.
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import net from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, syncBuiltinESMExports } from "node:module";
import test from "node:test";

const wireRoot = await mkdtemp("/tmp/piw-");
process.env.PI_WIRE_DIR = wireRoot;
register(new URL("./wire-test-resolve-hook.mjs", import.meta.url));

const { parseArgs } = await import("@earendil-works/pi-coding-agent");
const { configureAgentDefinition, selectAgentDefinition } = await import("./extensions/wire/agents.ts");
const { default: wireExtension } = await import("./extensions/wire.ts");
const { NamedEditor, renderPool } = await import("./extensions/wire/widget.ts");
const { hexFg } = await import("./extensions/wire/util.ts");
const { invalidateEntryCache, liveEntries } = await import("./extensions/wire/registry.ts");
const { visibleWidth } = await import("@mariozechner/pi-tui");

test.after(async () => { await rm(wireRoot, { recursive: true, force: true }); });

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-wire-agents-"));
    const user = join(root, "user", "agents");
    const project = join(root, "project", ".pi", "agents");
    await mkdir(user, { recursive: true });
    await mkdir(project, { recursive: true });
    return { root, user, project, cwd: join(root, "project") };
}

async function definition(dir, file, frontmatter, body = "") {
    await writeFile(join(dir, file), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

async function withFixture(run) {
    const f = await fixture();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try { await run(f); } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(f.root, { recursive: true, force: true });
    }
}

function piMock(options = {}) {
    const flags = { ...options.flags };
    const hooks = new Map();
    const calls = { active: [...(options.active ?? ["wire_list", "wire_send", "wire_respond"])], setModel: 0, setTools: 0, entries: [], notices: [], tools: new Map(), shortcuts: new Map(), messages: [] };
    const ctx = {
        cwd: options.cwd ?? process.cwd(),
        hasUI: options.hasUI ?? true,
        model: { provider: "base", id: "baseline" },
        isProjectTrusted: () => options.trusted ?? true,
        getContextUsage: () => undefined,
        modelRegistry: {
            find: (provider, id) => provider === "vendor" && id === "model/with:part" ? { provider, id } : undefined,
            hasConfiguredAuth: () => options.auth ?? true,
        },
        ui: {
            notify: (message, type) => calls.notices.push({ message, type }),
            setStatus: () => {}, setWidget: () => {}, setEditorComponent: () => {},
        },
    };
    const pi = {
        registerFlag: (name, option) => { if (!(name in flags)) flags[name] = option.default; },
        getFlag: (name) => flags[name],
        getSessionName: () => options.restoredName,
        on: (event, handler) => {
            const handlers = hooks.get(event) ?? [];
            handlers.push(handler);
            hooks.set(event, handlers);
        },
        registerMessageRenderer: () => {}, registerTool: (tool) => calls.tools.set(tool.name, tool), registerCommand: () => {}, registerShortcut: (key, option) => calls.shortcuts.set(key, option),
        sendMessage: (message, delivery) => calls.messages.push({ message, delivery }),
        appendEntry: (type, data) => calls.entries.push({ type, data }),
        getAllTools: () => (options.available ?? ["read", "grep", "wire_list", "wire_send", "wire_respond"]).map((name) => ({ name })),
        getActiveTools: () => calls.active,
        setActiveTools: (names) => {
            calls.setTools++;
            calls.active = names.filter((name) => pi.getAllTools().some((tool) => tool.name === name));
        },
        setModel: async (model) => {
            calls.setModel++;
            if (options.setModel === "throw") throw new Error("model failed");
            if (options.setModel === false) return false;
            ctx.model = model;
            return true;
        },
    };
    wireExtension(pi);
    return { pi, ctx, hooks, calls };
}

async function withArgv(args, run) {
    const previous = process.argv;
    process.argv = [previous[0], previous[1], ...args];
    try { return await run(); } finally { process.argv = previous; }
}

async function start(mock) {
    for (const handler of mock.hooks.get("session_start") ?? []) await handler({ reason: "startup" }, mock.ctx);
}

async function shutdown(mock) {
    for (const handler of mock.hooks.get("session_shutdown") ?? []) await handler({ reason: "reload" }, mock.ctx);
}

async function cleanWire() {
    await rm(wireRoot, { recursive: true, force: true });
}

function registryFiles() {
    const dir = join(wireRoot, "agents");
    return existsSync(dir) ? readdir(dir) : Promise.resolve([]);
}

async function runBeforeAgent(mock, prompt = "base") {
    const handler = mock.hooks.get("before_agent_start")?.[0];
    return handler({ systemPrompt: prompt }, mock.ctx);
}

test("definitions use Pi frontmatter parsing for BOM, CRLF, quoted fields, YAML tools, and empty allowlists", async () => withFixture(async ({ user, cwd }) => {
    await writeFile(join(user, "reviewer.md"), "\ufeff---\r\nname: \"reviewer\"\r\ndescription: 'Reviews changes'\r\ntools: [read, grep]\r\nmodel: vendor/model/with:part\r\ncolor: \"#C792EA\"\r\n---\r\nBe precise.\r\n");
    await definition(user, "none.md", 'name: none\ndescription: none\ntools: ""');
    await definition(user, "also-none.md", "name: also-none\ndescription: none\ntools: []");
    const agent = selectAgentDefinition(cwd, "user", "reviewer", { userDir: user });
    assert.deepEqual(agent.tools, ["read", "grep"]);
    assert.equal(agent.model, "vendor/model/with:part");
    assert.equal(agent.color, "#C792EA");
    assert.equal(agent.body, "Be precise.");
    assert.deepEqual(selectAgentDefinition(cwd, "user", "none", { userDir: user }).tools, []);
    assert.deepEqual(selectAgentDefinition(cwd, "user", "also-none", { userDir: user }).tools, []);
}));

test("unselectable files are diagnosed while valid siblings and exact-name overrides remain usable", async () => withFixture(async ({ user, project, cwd }) => {
    await definition(user, "valid.md", "name: valid\ndescription: valid");
    await definition(user, "number.md", "name: number\ndescription: 7");
    await definition(user, "map.md", "name: map\ndescription: valid\ntools: {read: true}");
    await definition(user, "no-name.md", "description: no name");
    await writeFile(join(user, "broken.md"), "---\nname: [\n---\n", "utf8");
    const diagnostics = [];
    assert.equal(selectAgentDefinition(cwd, "user", "valid", { userDir: user, onDiagnostic: (message) => diagnostics.push(message) }).name, "valid");
    assert.equal(diagnostics.length, 2);
    await definition(project, "override.md", "name: valid\ndescription: valid\ncolor: no");
    assert.throws(() => selectAgentDefinition(cwd, "both", "valid", { userDir: user, projectDir: project }), /color must be/);
}));

test("invalid null, number, map, color, and YAML-list values reject selected definitions", async () => withFixture(async ({ user, cwd }) => {
    const invalid = {
        name: ['null', '7', '[]', '{}', '""', '" "'],
        description: ['null', '7', '[]', '{}', '""', '" "'],
        model: ['null', '7', '[]', '{}', '""'],
        color: ['null', '7', '[]', '{}', '""', '"#ABC"', '"#GGGGGG"'],
        tools: ['null', '7', '{}', '[read, 2]', '[read, null]', '[[]]', '[{}]', '[" "]', '[""]'],
    };
    for (const [field, values] of Object.entries(invalid)) {
        for (const value of values) {
            const fields = { name: 'selected', description: 'valid', [field]: value };
            await definition(user, 'selected.md', Object.entries(fields).map(([key, val]) => `${key}: ${val}`).join('\n'));
            assert.throws(() => selectAgentDefinition(cwd, 'user', 'selected', { userDir: user }), `${field}: ${value}`);
        }
    }
}));

test("scope selection is exact, project wins in both, duplicate names reject, and user scope skips project discovery", async () => withFixture(async ({ user, project, cwd }) => {
    await definition(user, "user.md", "name: reviewer\ndescription: user");
    await definition(project, "project.md", "name: reviewer\ndescription: project");
    assert.equal(selectAgentDefinition(cwd, "user", "reviewer", { userDir: user, projectDir: "/does/not/exist" }).description, "user");
    assert.equal(selectAgentDefinition(cwd, "project", "reviewer", { userDir: user, projectDir: project }).description, "project");
    assert.equal(selectAgentDefinition(cwd, "both", "reviewer", { userDir: user, projectDir: project }).source, "project");
    const nested = join(cwd, "nested", "child");
    await mkdir(nested, { recursive: true });
    assert.equal(selectAgentDefinition(nested, "project", "reviewer").source, "project");
    await definition(user, "dup.md", "name: reviewer\ndescription: duplicate");
    assert.throws(() => selectAgentDefinition(cwd, "user", "reviewer", { userDir: user }), /multiple user/);
    assert.throws(() => selectAgentDefinition(cwd, "invalid", "reviewer", { userDir: user }), /wire-agent-scope/);
}));

test("Pi parseArgs detects aliases, disabling/exclusion options, and the end-of-options delimiter", () => {
    const parsed = parseArgs(["-n", "cli", "-t", "read", "-xt", "grep", "-nt", "-nbt"]);
    assert.equal(parsed.name, "cli");
    assert.deepEqual(parsed.tools, ["read"]);
    assert.deepEqual(parsed.excludeTools, ["grep"]);
    assert.equal(parsed.noTools, true);
    assert.equal(parsed.noBuiltinTools, true);
    const afterDelimiter = parseArgs(["--", "--name", "not-a-flag"]);
    assert.equal(afterDelimiter.name, undefined);
    assert.deepEqual(afterDelimiter.messages, ["--name", "not-a-flag"]);
});

test("configure validates model/auth/tools/effective wire tools before mutation", async () => {
    const definition = { name: "reviewer", description: "review", tools: ["read", "grep"], model: "vendor/model/with:part", body: "", source: "user", filePath: "agent.md" };
    const mock = piMock();
    await configureAgentDefinition(mock.pi, mock.ctx, definition, {});
    assert.equal(mock.calls.setModel, 1);
    assert.deepEqual(mock.calls.active, ["read", "grep", "wire_list", "wire_send", "wire_respond"]);

    const badTool = piMock();
    await assert.rejects(configureAgentDefinition(badTool.pi, badTool.ctx, { ...definition, tools: ["missing"] }, { model: "explicit" }), /unknown tool/);
    assert.equal(badTool.calls.setModel, 0);
    assert.deepEqual(badTool.calls.active, ["wire_list", "wire_send", "wire_respond"]);

    const noWire = piMock({ active: ["read"] });
    await assert.rejects(configureAgentDefinition(noWire.pi, noWire.ctx, definition, { tools: ["read"] }), /required wire tools/);
    assert.equal(noWire.calls.setModel, 0);
    assert.deepEqual(noWire.calls.active, ["read"]);

    const badModel = piMock();
    await assert.rejects(configureAgentDefinition(badModel.pi, badModel.ctx, { ...definition, model: "bare" }, { model: "explicit" }), /unknown model/);
    assert.equal(badModel.calls.setModel, 0);
    await assert.rejects(configureAgentDefinition(piMock({ auth: false }).pi, piMock({ auth: false }).ctx, definition, {}), /authentication/);
});

test("explicit CLI tool options skip validation of the discarded definition allowlist", async () => {
    const definition = { name: "reviewer", description: "review", tools: ["grep", "missing"], body: "", source: "user", filePath: "agent.md" };
    const mock = piMock();
    await configureAgentDefinition(mock.pi, mock.ctx, definition, { excludeTools: ["grep"] });
    assert.equal(mock.calls.setTools, 0);
});

test("actual lifecycle rejects untrusted project before reads and reports UI/headless failures without storage or persona", async () => withFixture(async ({ user, cwd }) => {
    await cleanWire();
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    const untrusted = piMock({ cwd, trusted: false, flags: { "wire-agent": "reviewer", "wire-agent-scope": "project" } });
    await withArgv(["--wire-agent", "reviewer", "--wire-agent-scope", "project"], () => start(untrusted));
    assert.match(untrusted.calls.notices.at(-1).message, /trusted project/);
    assert.deepEqual(await registryFiles(), []);
    assert.equal(await runBeforeAgent(untrusted), undefined);

    const headless = piMock({ cwd, hasUI: false, flags: { "wire-agent": "missing" } });
    const errors = [];
    const original = console.error;
    console.error = (message) => errors.push(String(message));
    try { await withArgv(["--wire-agent", "missing"], () => start(headless)); } finally { console.error = original; }
    assert.match(errors.at(-1), /no user agent definition/);
    assert.deepEqual(await registryFiles(), []);
}));

test("actual lifecycle fail-closes malformed, ambiguous, invalid overrides, setModel failures, and missing CLI wire tools", async () => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await definition(user, "reviewer.md", "name: reviewer\ndescription: review\ntools: [read]\nmodel: vendor/model/with:part", "persona");
    const cases = [
        [{ "wire-agent": "missing" }, [], /no user agent/],
        [{ "wire-agent": "reviewer" }, ["-t", "read"], /required wire tools/],
    ];
    for (const [flags, extra, expected] of cases) {
        await cleanWire();
        const mock = piMock({ cwd, flags, active: ["read"] });
        await withArgv(["--wire-agent", flags["wire-agent"], ...extra], () => start(mock));
        assert.match(mock.calls.notices.at(-1).message, expected);
        assert.equal(mock.calls.setModel, 0);
        assert.deepEqual(await registryFiles(), []);
        assert.equal(await runBeforeAgent(mock), undefined);
    }
    for (const setModel of [false, "throw"]) {
        await cleanWire();
        const mock = piMock({ cwd, flags: { "wire-agent": "reviewer" }, setModel });
        await withArgv(["--wire-agent", "reviewer"], () => start(mock));
        assert.match(mock.calls.notices.at(-1).message, setModel === false ? /could not apply/ : /model failed/);
        assert.deepEqual(await registryFiles(), []);
    }
    await definition(user, "duplicate.md", "name: reviewer\ndescription: duplicate");
    await cleanWire();
    const duplicate = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    await withArgv(["--wire-agent", "reviewer"], () => start(duplicate));
    assert.match(duplicate.calls.notices.at(-1).message, /multiple user/);
    assert.deepEqual(await registryFiles(), []);
}));

test("actual lifecycle applies precedence, effective model, collision suffix, prompt body, shutdown, reload, and legacy startup", async () => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await definition(user, "reviewer.md", "name: reviewer\ndescription: definition\ntools: [read]\nmodel: vendor/model/with:part\ncolor: '#C792EA'", "persona one");
    await cleanWire();
    await mkdir(join(wireRoot, "agents"), { recursive: true });
    await writeFile(join(wireRoot, "agents", "reviewer.json"), JSON.stringify({ session_id: "existing", name: "reviewer", pid: process.pid }), "utf8");
    const first = piMock({ cwd, restoredName: "restored", flags: { "wire-agent": "reviewer", color: "#112233" } });
    await withArgv(["--wire-agent", "reviewer", "-n", "cli-name", "--model", "explicit", "-t", "read"], () => start(first));
    const files = await registryFiles();
    assert.equal(files.length, 2);
    const entry = JSON.parse(await readFile(join(wireRoot, "agents", files.find((file) => file !== "reviewer.json")), "utf8"));
    assert.equal(entry.name, "cli-name");
    assert.equal(entry.purpose, "definition"); // No --purpose flag: the definition description is the only source.
    assert.equal(entry.color, "#112233");
    assert.equal(entry.model, "baseline"); // --model is authoritative; definition was still validated.
    assert.deepEqual(first.calls.active, ["wire_list", "wire_send", "wire_respond"]); // -t preserves Pi's active set.
    assert.equal((await runBeforeAgent(first)).systemPrompt, "base\n\npersona one");
    assert.equal((await runBeforeAgent(first)).systemPrompt, "base\n\npersona one");
    await shutdown(first);
    assert.equal(await runBeforeAgent(first), undefined);

    await cleanWire();
    await mkdir(join(wireRoot, "agents"), { recursive: true });
    await writeFile(join(wireRoot, "agents", "reviewer.json"), JSON.stringify({ session_id: "existing", name: "reviewer", pid: process.pid }), "utf8");
    const collision = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    await withArgv(["--wire-agent", "reviewer"], () => start(collision));
    const collisionEntry = JSON.parse(await readFile(join(wireRoot, "agents", "reviewer2.json"), "utf8"));
    assert.equal(collisionEntry.name, "reviewer2");
    assert.equal(collisionEntry.purpose, "definition");
    assert.equal(collisionEntry.color, "#C792EA");
    assert.equal(collisionEntry.model, "model/with:part");
    assert.deepEqual(collision.calls.active, ["read", "wire_list", "wire_send", "wire_respond"]);
    await shutdown(collision);

    await cleanWire();
    await writeFile(join(user, "reviewer.md"), "---\nname: reviewer\ndescription: definition\ntools: [read]\nmodel: vendor/model/with:part\n---\npersona two\n");
    const reload = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    await withArgv(["--wire-agent", "reviewer"], () => start(reload));
    assert.equal((await runBeforeAgent(reload)).systemPrompt, "base\n\npersona two");
    await shutdown(reload);
    await writeFile(join(user, "reviewer.md"), "---\nname: reviewer\ndescription: 4\n---\nbad\n");
    const invalidReload = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    await withArgv(["--wire-agent", "reviewer"], () => start(invalidReload));
    assert.equal(await runBeforeAgent(invalidReload), undefined);
    assert.deepEqual(await registryFiles(), []);

    await cleanWire();
    const legacy = piMock({ cwd, restoredName: "legacy" });
    await withArgv([], () => start(legacy));
    assert.equal((await registryFiles()).length, 1);
    assert.equal(legacy.calls.setModel, 0);
    assert.equal(await runBeforeAgent(legacy), undefined);
    await shutdown(legacy);
}));

const wireTools = ["wire_list", "wire_send", "wire_respond"];

test("startup failures never bind, create storage, or activate a persona in UI or headless mode", async (t) => withFixture(async ({ user, project, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    const listen = t.mock.method(net.Server.prototype, "listen", () => { throw new Error("unexpected bind"); });
    const valid = "name: reviewer\ndescription: valid\nmodel: vendor/model/with:part\ntools: read";
    const failures = [
        { fields: "name: reviewer\ndescription: null", error: /description/ },
        { fields: "name: [", error: /no user agent/ },
        { fields: "name: reviewer\ndescription: valid\nmodel: vendor/missing", args: ["--model", "explicit"], error: /unknown model/ },
        { fields: "name: reviewer\ndescription: valid\ntools: missing", error: /unknown tool/ },
        { fields: valid, options: { auth: false }, args: ["--model", "explicit"], error: /authentication/ },
        { fields: valid, options: { setModel: false }, error: /could not apply/, modelCalls: 1 },
        { fields: valid, options: { setModel: "throw" }, error: /model failed/, modelCalls: 1 },
        { fields: valid, options: { active: ["read"] }, args: ["--no-tools"], error: /required wire tools/ },
        { fields: valid, flags: { "wire-agent-scope": "bad" }, error: /wire-agent-scope/ },
        { fields: valid, flags: { "wire-agent-scope": "both" }, project: "name: reviewer\ndescription: valid\ntools: null", error: /tools must/ },
    ];
    for (const hasUI of [true, false]) {
        for (const item of failures) {
            await cleanWire();
            await definition(user, "reviewer.md", item.fields, "must not activate");
            await definition(project, "reviewer.md", item.project ?? "name: other\ndescription: ignored");
            const mock = piMock({ cwd, hasUI, ...item.options, flags: { "wire-agent": "reviewer", ...item.flags } });
            const errors = [];
            const stderr = t.mock.method(console, "error", (message) => errors.push(String(message)));
            try {
                await withArgv(item.args ?? [], () => start(mock));
                const reported = hasUI ? mock.calls.notices.filter((notice) => notice.type === "error").map((notice) => notice.message) : errors;
                assert.match(reported.at(-1), item.error);
                assert.equal(existsSync(wireRoot), false);
                assert.equal(listen.mock.callCount(), 0);
                assert.equal(mock.calls.entries.length, 0);
                assert.equal(mock.calls.setModel, item.modelCalls ?? 0);
                assert.equal(mock.calls.setTools, 0);
                assert.equal(await runBeforeAgent(mock), undefined);
            } finally {
                stderr.mock.restore();
                await shutdown(mock);
            }
        }
    }
}));

test("a failed bind reverts the definition's model and tool set", async (t) => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    t.mock.method(net.Server.prototype, "listen", () => { throw new Error("EADDRINUSE"); });
    await definition(user, "reviewer.md", "name: reviewer\ndescription: valid\nmodel: vendor/model/with:part\ntools: read", "persona");
    await cleanWire();
    const mock = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    try {
        await withArgv([], () => start(mock));
        assert.match(mock.calls.notices.at(-1).message, /bind failed/);
        assert.deepEqual(mock.ctx.model, { provider: "base", id: "baseline" }); // model restored
        assert.equal(mock.calls.setTools, 2); // applied, then reverted
        assert.deepEqual(mock.calls.active, wireTools);
        assert.equal(mock.calls.entries.length, 0);
        assert.equal(await runBeforeAgent(mock), undefined);
    } finally { await shutdown(mock); }
}));

test("effective wire tools are checked after host activation and model hooks", async () => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await definition(user, "reviewer.md", "name: reviewer\ndescription: valid\ntools: []", "persona");
    await cleanWire();
    const missingRegistered = piMock({ cwd, available: ["read", "wire_list", "wire_send"], flags: { "wire-agent": "reviewer" } });
    await withArgv([], () => start(missingRegistered));
    assert.match(missingRegistered.calls.notices.at(-1).message, /wire_respond/);
    assert.equal(existsSync(wireRoot), false);
    // This check is the one mutation configureAgentDefinition makes before throwing,
    // so it is also the one failure inside it that has to be unwound.
    assert.equal(missingRegistered.calls.setTools, 2); // applied, then reverted
    assert.deepEqual(missingRegistered.ctx.model, { provider: "base", id: "baseline" });
    assert.equal(await runBeforeAgent(missingRegistered), undefined);

    const modelHook = piMock();
    modelHook.pi.setModel = async () => { modelHook.calls.active = ["read"]; return true; };
    await assert.rejects(configureAgentDefinition(modelHook.pi, modelHook.ctx,
        { model: "vendor/model/with:part" }, {}), /required wire tools/);
}));

test("project trust gates actual definition reads and user scope never walks project directories", async (t) => withFixture(async ({ user, project, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await definition(user, "reviewer.md", "name: reviewer\ndescription: user");
    await definition(project, "reviewer.md", "name: reviewer\ndescription: project");
    const reads = [];
    const stats = [];
    const read = fs.readFileSync;
    const stat = fs.statSync;
    const readSpy = t.mock.method(fs, "readFileSync", (file, ...args) => { reads.push(String(file)); return read(file, ...args); });
    const statSpy = t.mock.method(fs, "statSync", (file, ...args) => { stats.push(String(file)); return stat(file, ...args); });
    syncBuiltinESMExports();
    try {
        assert.equal(selectAgentDefinition(cwd, "user", "reviewer", { userDir: user }).description, "user");
        assert.equal(stats.length, 0);
        reads.length = 0;
        for (const scope of ["project", "both"]) {
            const mock = piMock({ cwd, trusted: false, flags: { "wire-agent": "reviewer", "wire-agent-scope": scope } });
            await withArgv([], () => start(mock));
            assert.match(mock.calls.notices.at(-1).message, /trusted project/);
        }
        assert.equal(reads.length, 0);
        assert.equal(stats.length, 0);
    } finally {
        readSpy.mock.restore(); statSpy.mock.restore(); syncBuiltinESMExports();
    }
}));

test("all CLI tool aliases preserve Pi's active set; delimiter restores definition precedence", async () => {
    const agent = { tools: ["grep", "grep"], model: "vendor/model/with:part" };
    const options = [["--tools", "read"], ["-t", "read"], ["--exclude-tools", "grep"], ["-xt", "grep"],
        ["--no-tools"], ["-nt"], ["--no-builtin-tools"], ["-nbt"], ["--tools", ""], ["--exclude-tools", ""]];
    for (const args of options) {
        const mock = piMock({ active: ["read", ...wireTools] });
        await configureAgentDefinition(mock.pi, mock.ctx, agent, parseArgs(args));
        assert.deepEqual(mock.calls.active, ["read", ...wireTools], args.join(" "));
        assert.equal(mock.calls.setTools, 0);
    }
    const afterDelimiter = piMock();
    await configureAgentDefinition(afterDelimiter.pi, afterDelimiter.ctx, agent, parseArgs(["--", "-nt", "--model", "explicit"]));
    assert.deepEqual(afterDelimiter.calls.active, ["grep", ...wireTools]);
    assert.equal(afterDelimiter.calls.setModel, 1);
    const inherited = piMock({ active: ["read", ...wireTools] });
    await configureAgentDefinition(inherited.pi, inherited.ctx, {}, {});
    assert.deepEqual(inherited.calls.active, ["read", ...wireTools]);
    assert.equal(inherited.calls.setTools, 0);
    assert.equal(inherited.calls.setModel, 0);
});

test("name precedence, legacy prompt frontmatter, empty bodies, and per-session loading", async () => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await definition(user, "filename-does-not-match.md", "name: reviewer\ndescription: definition");
    const promptPath = join(user, "..", "system.md");
    await writeFile(promptPath, "---\nname: prompt-name\ndescription: prompt purpose\ncolor: '#123456'\n---\nBase prompt.\n");
    for (const [args, selected, restoredName, expectedName] of [
        [["--name", "cli name"], true, "restored", "cli-name"],
        [["-n", "alias"], true, "renamed", "alias"],
        [[], true, "restored", "reviewer"],
        [["--", "--name", "ignored"], true, "renamed", "reviewer"],
        [[], false, undefined, "prompt-name"],
        [[], false, "legacy", "legacy"],
    ]) {
        await cleanWire();
        const mock = piMock({ cwd, restoredName, flags: selected ? { "wire-agent": "reviewer" } : {}, active: selected ? wireTools : [] });
        try {
            await withArgv(["--system-prompt", promptPath, ...args], () => start(mock));
            const entry = JSON.parse(await readFile(join(wireRoot, "agents", `${expectedName}.json`), "utf8"));
            assert.equal(entry.name, expectedName);
            assert.equal(entry.purpose, selected ? "definition" : "prompt purpose");
            assert.equal(entry.color, "#123456");
            assert.equal(await runBeforeAgent(mock), undefined);
            assert.equal(mock.hooks.get("before_agent_start").length, 1);
        } finally { await shutdown(mock); }
    }
    await definition(user, "filename-does-not-match.md", "name: reviewer\ndescription: definition", "first body");
    const mock = piMock({ cwd, flags: { "wire-agent": "reviewer" } });
    try {
        await withArgv([], () => start(mock));
        const entry = JSON.parse(await readFile(join(wireRoot, "agents", "reviewer.json"), "utf8"));
        assert.equal(entry.purpose, "definition");
        await definition(user, "filename-does-not-match.md", "name: reviewer\ndescription: definition", "edited body");
        assert.equal((await runBeforeAgent(mock, "Host prompt with skills")).systemPrompt, "Host prompt with skills\n\nfirst body");
    } finally { await shutdown(mock); }
}));

test("definition peers discover and exchange requests/replies through unchanged wire tools", async () => withFixture(async ({ user, cwd }) => {
    process.env.PI_CODING_AGENT_DIR = join(user, "..");
    await cleanWire();
    for (const name of ["sender", "receiver"]) await definition(user, `${name}.md`, `name: ${name}\ndescription: ${name} purpose\ntools: []`);
    const sender = piMock({ cwd, flags: { "wire-agent": "sender" } });
    const receiver = piMock({ cwd, flags: { "wire-agent": "receiver" } });
    try {
        await withArgv([], () => start(sender));
        await withArgv([], () => start(receiver));
        // Expire the registry cache without waiting for a real ping interval.
        const now = Date.now;
        Date.now = () => now() + 10000;
        try {
            const listed = await sender.calls.tools.get("wire_list").execute("list", {});
            assert.equal(listed.details.agents.find((agent) => agent.name === "receiver").purpose, "receiver purpose");
            const sent = await sender.calls.tools.get("wire_send").execute("send", { target: "receiver", prompt: "Review this" });
            assert.ok(sent.details.msg_id);
            assert.equal(sender.calls.messages.length, 0); // Send returned without a reply.
            assert.equal(receiver.calls.messages[0].delivery.deliverAs, "followUp");
            await receiver.calls.tools.get("wire_respond").execute("respond", { msg_id: sent.details.msg_id, response: "Reviewed" });
            assert.equal(sender.calls.messages[0].message.customType, "wire-response");
            assert.equal(sender.calls.messages[0].delivery.deliverAs, "followUp");
        } finally { Date.now = now; }
    } finally { await shutdown(sender); await shutdown(receiver); }
}));

// ━━ Pool widget selection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const plainTheme = { fg: (_role, text) => text, bg: (_role, text) => `[${text}]` };

function poolState(count, poolSelected = null) {
    const peerCards = new Map();
    for (let i = 0; i < count; i++) {
        const name = String.fromCharCode(97 + i);
        peerCards.set(`session-${name}`, { name, purpose: "", model: "m", color: "#ffffff", context_used_pct: 10, staleCount: 0 });
    }
    return { identity: null, includeExplicit: false, poolSelected, peerCards };
}

// Registry entries are passed explicitly so the shared cache can't leak rows in.
// Names are padEnd(12) in the row, which no other column can produce.
const rowsOf = (state) => {
    const lines = renderPool(state, 120, plainTheme, []);
    return "abcde".split("").filter((name) => lines.some((line) => line.includes(name + " ".repeat(11))));
};

test("pool window follows the selection and clamps it to the live peers", () => {
    const state = poolState(5);
    assert.deepEqual(rowsOf(state), ["a", "b", "c"]); // unfocused: top of the list

    state.poolSelected = 0;
    assert.deepEqual(rowsOf(state), ["a", "b", "c"]);

    state.poolSelected = 3;
    assert.deepEqual(rowsOf(state), ["c", "d", "e"]);

    // Past the last peer: clamped, and written back so the next key press moves.
    state.poolSelected = 99;
    assert.deepEqual(rowsOf(state), ["c", "d", "e"]);
    assert.equal(state.poolSelected, 4);

    // No peers means no selection to return to.
    const empty = poolState(0, 2);
    assert.equal(renderPool(empty, 120, plainTheme, []).length, 0);
    assert.equal(empty.poolSelected, null);
});

test("pool widget keeps a fixed height, highlights one row, and hints the keys", () => {
    const browsing = renderPool(poolState(5, 3), 120, plainTheme, []);
    assert.equal(browsing.length, 5); // 3 rows + 2 rules
    assert.equal(browsing.filter((line) => line.startsWith("[")).length, 1); // one highlighted row
    assert.ok(browsing.find((line) => line.startsWith("[")).includes("d" + " ".repeat(11)));
    assert.match(browsing.at(-1), /4 of 5 · ↑↓ move · esc back/);

    const idle = renderPool(poolState(5), 120, plainTheme, []);
    assert.equal(idle.filter((line) => line.startsWith("[")).length, 0);
    assert.match(idle.at(-1), /1–3 of 5 · ↓ to browse/);

    const fitting = renderPool(poolState(2), 120, plainTheme, []);
    assert.equal(fitting.length, 4);
    assert.equal(fitting.at(-1), fitting[0]); // plain rule, no hint
});

// ━━ Pool list keyboard (lives in the editor: widgets never receive input) ━━

// poolRows falls back to the process-wide registry cache, which the lifecycle
// tests populate — empty it so only the peers this fixture declares show up.
// Invalidating beats skipping the clock forward: a faked future timestamp would
// stick in the cache and starve later tests of refreshes for that long.
async function poolEditor(peers) {
    await cleanWire();
    invalidateEntryCache();
    liveEntries();
    const ids = { "\u001b[A": "tui.editor.cursorUp", "\u001b[B": "tui.editor.cursorDown", "\u001b": "app.interrupt" };
    const keybindings = { matches: (data, id) => ids[data] === id, getKeys: () => [], getDefinition: () => ({ description: "" }) };
    const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
    const state = { ...poolState(peers), currentCtx: null };
    const editor = new NamedEditor(tui, { borderColor: (t) => t, selectList: {} }, keybindings, "", state);
    editor.render(80); // establishes the width the visual-line map needs
    return { editor, state };
}

const DOWN = "\u001b[B", UP = "\u001b[A", ESC = "\u001b";

test("named editor uses the identity color for both borders and its name", () => {
    const color = "#C792EA";
    const label = hexFg(color, " orchestrator ");
    const state = { ...poolState(0), identity: { color }, currentCtx: null };
    const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
    const keybindings = { matches: () => false };
    const hostBorder = (text) => `[host]${text}[/host]`;
    const editor = new NamedEditor(tui, { borderColor: hostBorder, selectList: {} }, keybindings, label, state);
    editor.setText("prompt text");
    editor.borderColor = hostBorder;

    const lines = editor.render(80);
    const top = lines[0];
    const bottom = lines.at(-1);
    const identityStart = "\u001b[38;2;199;146;234m";
    assert.ok(top.startsWith(identityStart + "─".repeat(80 - visibleWidth(label))));
    assert.ok(top.endsWith(label));
    assert.equal(bottom, hexFg(color, "─".repeat(80)));
    assert.ok(!top.includes("[host]"));
    assert.ok(!bottom.includes("[host]"));
    assert.ok(!lines.slice(1, -1).join("\n").includes("38;2;199;146;234"));
});

test("down enters the peer list only when it is inert in the editor", async () => {
    const { editor, state } = await poolEditor(3);
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, 0);

    editor.handleInput(DOWN);
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, 2);
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, 2); // clamped at the last peer

    editor.handleInput(UP);
    assert.equal(state.poolSelected, 1);
    editor.handleInput(UP);
    editor.handleInput(UP);
    assert.equal(state.poolSelected, null); // up off the top row returns to the editor

    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, 0);
    editor.handleInput(ESC);
    assert.equal(state.poolSelected, null);

    // Typing while browsing resumes the editor and keeps the keystroke.
    editor.handleInput(DOWN);
    editor.handleInput("x");
    assert.equal(state.poolSelected, null);
    assert.equal(editor.getText(), "x");

    // Down mid-prompt still moves the cursor rather than stealing focus.
    editor.setText("one\ntwo");
    editor.render(80);
    editor.handleInput(UP);
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, null);
});

test("down stays in the editor when there are no peers to browse", async () => {
    const { editor, state } = await poolEditor(0);
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, null);
});

test("browsing yields to abort and to a late autocomplete instead of eating keys", async () => {
    const { editor, state } = await poolEditor(3);

    // Escape must still reach pi's interrupt, not just close the list.
    let aborted = 0;
    editor.onEscape = () => { aborted++; };
    editor.handleInput(DOWN);
    editor.handleInput(ESC);
    assert.equal(state.poolSelected, null);
    assert.equal(aborted, 1);

    // An autocomplete request in flight applies when text and cursor are
    // unchanged — the very state that let the list take focus. The menu wins.
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, 0);
    editor.isShowingAutocomplete = () => true;
    editor.handleInput(DOWN);
    assert.equal(state.poolSelected, null);
});

test("pool rows never outgrow a narrow terminal", () => {
    // Real theme colors are zero-width ANSI; plainTheme's "[]" markers are not.
    const ansiTheme = { fg: (_r, t) => t, bg: (_r, t) => `\u001b[7m${t}\u001b[27m` };
    for (const width of [10, 20, 40]) {
        const lines = renderPool(poolState(5, 3), width, ansiTheme, []);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
    }
});
