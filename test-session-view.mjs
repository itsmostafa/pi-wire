import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { createServer } from "node:net";
import test, { after } from "node:test";

process.env.PI_WIRE_PING_INTERVAL_MS = "100";
// The viewer only reads session files under pi's own sessions dir; point that at a fixture dir.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-wire-agent-"));
const sessionsRoot = join(process.env.PI_CODING_AGENT_DIR, "sessions");
await mkdir(sessionsRoot, { recursive: true });
after(() => rm(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true }));
register(new URL("./wire-test-resolve-hook.mjs", import.meta.url));
const { sessionText, showPeerSession } = await import("./extensions/wire/session-view.ts");
const { visibleWidth } = await import("@mariozechner/pi-tui");

const header = { type: "session", version: 3, id: "session", cwd: "/tmp", timestamp: new Date().toISOString() };
const message = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId, message: { role, content, ...extra } });
const jsonl = (...entries) => [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("session view follows the saved branch, renders messages/tools, and tolerates an unfinished append", () => {
    const source = jsonl(
        message("a", null, "user", "hello"),
        message("b", "a", "assistant", [{ type: "text", text: "abandoned branch" }]),
        message("c", "a", "assistant", [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "answer\u001b[2J\u0007" },
            { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ]),
        message("d", "c", "toolResult", [{ type: "text", text: "contents" }, { type: "image", data: "SECRET_BASE64" }], { toolName: "read" }),
        { type: "custom_message", id: "e", parentId: "d", customType: "wire-inbound", display: true, content: "request" },
        { type: "custom_message", id: "f", parentId: "e", customType: "hidden", display: false, content: "hidden payload" },
        { type: "compaction", id: "g", parentId: "f", summary: "summary" },
    ) + '{"type":"message"';
    const text = sessionText(source);
    for (const expected of ["[user]\nhello", "[thinking]\nconsidering", "answer", "[tool call: read]", '"path": "a.ts"', "[tool result: read]", "contents", "[image]", "[wire-inbound]\nrequest", "[compaction]\nsummary"]) assert.ok(text.includes(expected), expected);
    for (const hidden of ["abandoned branch", "SECRET_BASE64", "hidden payload", "\u001b", "\u0007"]) assert.ok(!text.includes(hidden), hidden);
    assert.throws(() => sessionText("not a session"), /Not a Pi session/);
    assert.equal(sessionText(jsonl()), "No saved messages yet.");
    assert.doesNotThrow(() => sessionText(jsonl(message("a", "a", "user", "cycle"))));
});

async function until(check) {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for session viewer refresh");
}

test("viewer refreshes read-only, scrolls, bounds widths, restores focus via done, and cleans up", async () => {
    const root = await mkdtemp(join(sessionsRoot, "view-"));
    const file = join(root, "session.jsonl");
    let component;
    let opens = 0, closes = 0, renders = 0;
    const notices = [];
    const state = {
        currentCtx: {
            mode: "tui",
            ui: {
                notify: (...args) => notices.push(args),
                custom: (factory, options) => new Promise((resolve) => {
                    opens++;
                    assert.equal(options.overlay, true);
                    const keys = { up: "tui.select.up", down: "tui.select.down", pgup: "tui.select.pageUp", pgdn: "tui.select.pageDown", esc: "tui.select.cancel" };
                    component = factory(
                        { terminal: { rows: 8 }, requestRender: () => renders++ },
                        { fg: (_role, text) => text },
                        { matches: (data, id) => keys[data] === id },
                        () => { closes++; resolve(); },
                    );
                }),
            },
        },
    };
    const source = jsonl(message("a", null, "user", Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")));
    await writeFile(file, source);
    await showPeerSession(state, { name: "intruder", session_file: "/etc/passwd" });
    assert.equal(opens, 0);
    assert.match(notices.shift()[0], /no saved session path/);
    const viewing = showPeerSession(state, { name: "worker", session_file: file });
    const screen = () => component.render(100).join("\n");
    try {
        await until(() => screen().includes("line-19"));
        await showPeerSession(state, { name: "duplicate", session_file: file });
        assert.equal(opens, 1);
        assert.equal(await readFile(file, "utf8"), source);
        component.handleInput("\u001b[H"); // Home
        assert.ok(screen().includes("line-0"));
        assert.ok(!screen().includes("line-19"));
        assert.ok(screen().includes("paused"));
        await writeFile(file, source + JSON.stringify(message("b", "a", "assistant", [{ type: "text", text: "fresh output" }])) + "\n");
        const before = renders;
        await until(() => renders > before);
        assert.ok(screen().includes("line-0"));
        component.handleInput("\u001b[F"); // End
        await until(() => screen().includes("fresh output"));
        for (const width of [1, 5, 20, 80]) {
            const lines = component.render(width);
            assert.equal(lines.length, 8);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
        }
        component.handleInput("esc");
        await viewing;
        assert.equal(state.closeSessionViewer, undefined);
        const afterClose = renders;
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(renders, afterClose);
        assert.ok(closes >= 1);
        assert.deepEqual(notices, []);
    } finally {
        state.closeSessionViewer?.();
        await viewing;
        await rm(root, { recursive: true, force: true });
    }
});

test("live viewer shows unsaved tokens and tool progress, retries, and stops polling on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-wire-live-view-"));
    const endpoint = join(root, "peer.sock");
    let source = jsonl(message("a", null, "assistant", [{ type: "text", text: "partial token" }]));
    let status = "running", unavailable = false, hold = false, pending;
    let component, requests = 0, renders = 0;
    const server = createServer((socket) => {
        socket.once("data", (chunk) => {
            requests++;
            assert.equal(JSON.parse(chunk.toString()).type, "session_snapshot");
            if (hold) { pending = socket; return; }
            socket.end(JSON.stringify(unavailable ? { type: "nack", error: "temporarily unavailable" }
                : { type: "session_snapshot", source, status }) + "\n");
        });
    });
    await new Promise((resolve) => server.listen(endpoint, resolve));
    const state = { currentCtx: { mode: "tui", ui: {
        custom: (factory) => new Promise((resolve) => {
            component = factory({ terminal: { rows: 10 }, requestRender() { renders++; } },
                { fg: (_r, t) => t }, { matches: (key, id) => key === "esc" && id === "tui.select.cancel" }, resolve);
        }),
        notify() { assert.fail("live-only sessions must not require a saved file"); },
    } } };
    const viewing = showPeerSession(state, { name: "worker", endpoint });
    const screen = () => component.render(110).join("\n");
    try {
        await until(() => screen().includes("partial token"));
        assert.ok(screen().includes("live · running"));
        source = jsonl(message("a", null, "assistant", [{ type: "text", text: "partial token continues before saving" }]));
        await until(() => screen().includes("continues before saving"));
        source = jsonl(message("a", null, "toolResult", [{ type: "text", text: "compiling 42%" }], { toolName: "bash" }));
        await until(() => screen().includes("compiling 42%"));
        unavailable = true;
        await until(() => screen().includes("live unavailable"));
        assert.ok(screen().includes("compiling 42%")); // Keep the last snapshot during disconnects.
        unavailable = false;
        status = "idle";
        source = jsonl(message("a", null, "assistant", [{ type: "text", text: "finished" }]));
        await until(() => screen().includes("finished") && screen().includes("live · idle"));
        hold = true;
        await until(() => pending);
        component.handleInput("esc");
        await viewing;
        const closedRequests = requests, closedRenders = renders;
        pending.end(JSON.stringify({ type: "session_snapshot", source, status }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(requests, closedRequests);
        assert.equal(renders, closedRenders);
        assert.equal(state.closeSessionViewer, undefined);
    } finally {
        state.closeSessionViewer?.();
        pending?.destroy();
        await viewing;
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test("missing file stays cancellable and shutdown closes the viewer", async () => {
    let component, closed = false;
    const state = { currentCtx: { mode: "tui", ui: {
        custom: (factory) => new Promise((resolve) => {
            component = factory({ terminal: { rows: 8 }, requestRender() {} }, { fg: (_r, t) => t }, { matches: () => false }, () => { closed = true; resolve(); });
        }),
        notify() { assert.fail("missing session should be shown in the viewer"); },
    } } };
    const viewing = showPeerSession(state, { name: "worker", session_file: join(sessionsRoot, `absent-${process.pid}.jsonl`) });
    await until(() => component.render(100).join("\n").includes("No saved session yet"));
    state.closeSessionViewer();
    await viewing;
    assert.equal(closed, true);
    assert.equal(state.closeSessionViewer, undefined);
});
