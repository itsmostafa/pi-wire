import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { register } from "node:module";
import test from "node:test";

process.env.PI_WIRE_LINE_CAP_BYTES = "16384";
register(new URL("./wire-test-resolve-hook.mjs", import.meta.url));
const { registerSessionLive } = await import("./extensions/wire/session-live.ts");
const { createConnHandler } = await import("./extensions/wire/server.ts");
const { sendEnvelope } = await import("./extensions/wire/transport.ts");
const { parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
const { sessionText } = await import("./extensions/wire/session-view.ts");

const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
const assistant = (content, stopReason = "toolUse") => ({
    role: "assistant", content, stopReason, provider: "test", model: "test", usage: {}, timestamp: Date.now(),
});
const request = (msg_id = crypto.randomUUID()) => ({
    type: "session_snapshot", msg_id, sender_session: "requester", sender_endpoint: "/tmp/requester.sock", hops: 0,
    timestamp: new Date().toISOString(),
});

function makePeer() {
    const hooks = new Map();
    const pi = { on(type, handler) { hooks.set(type, [...(hooks.get(type) ?? []), handler]); } };
    const branch = [entry("u", null, { role: "user", content: "start", timestamp: Date.now() })];
    const state = {
        identity: { session_id: "peer", cwd: "/tmp" },
        currentCtx: {
            mode: "tui",
            isIdle: () => state.liveStatus === "idle",
            sessionManager: {
                getSessionId: () => "peer-session",
                getCwd: () => "/tmp",
                getBranch: () => branch,
            },
        },
        shuttingDown: false,
        liveTools: new Map(),
        liveStatus: "idle",
    };
    registerSessionLive(pi, state);
    const emit = async (type, event = {}) => {
        for (const handler of hooks.get(type) ?? []) await handler(event, state.currentCtx);
    };
    return { state, branch, emit };
}

async function withServer(state, run) {
    const endpoint = `/tmp/pi-wire-live-${process.pid}-${crypto.randomUUID()}.sock`;
    const server = net.createServer(createConnHandler({}, state));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    try { await run(endpoint); } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function snapshot(endpoint, id = crypto.randomUUID()) {
    return sendEnvelope(endpoint, request(id));
}

test("snapshots expose partial assistant/tool output and settle without duplicate completion", async () => {
    const peer = makePeer();
    await peer.emit("agent_start");
    await peer.emit("message_start", { message: assistant([]) });
    await peer.emit("message_update", { message: assistant([{ type: "text", text: "streaming token" }]) });
    await peer.emit("message_update", { message: assistant([{ type: "text", text: `${"x".repeat(9000)} latest-token` }]) });
    await peer.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
    await peer.emit("tool_execution_update", { toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" }, partialResult: { content: [{ type: "text", text: "running output" }] } });

    await withServer(peer.state, async (endpoint) => {
        const running = await snapshot(endpoint);
        assert.equal(running.type, "session_snapshot");
        assert.equal(running.status, "running");
        assert.ok(running.source.includes("latest-token"));
        assert.ok(running.source.includes("[truncated prefix]"));
        assert.ok(running.source.includes("running output"));
        assert.ok(!running.source.includes("SECRET_BASE64"));
        assert.equal(parseSessionEntries(running.source)[0].type, "session");
        const runningAgain = await snapshot(endpoint);
        assert.equal(runningAgain.source, running.source);

        const finalAssistant = assistant([
            { type: "text", text: "final answer" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
        ]);
        await peer.emit("message_end", { message: finalAssistant });
        peer.branch.push(entry("a", "u", finalAssistant));
        const finalResult = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "completed output" }], isError: false };
        await peer.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash", result: { content: finalResult.content }, isError: true });
        const ending = await snapshot(endpoint);
        assert.match(sessionText(ending.source), /tool result: bash \(error\)/);
        await peer.emit("message_end", { message: finalResult });
        peer.branch.push(entry("t", "a", finalResult));
        await peer.emit("agent_settled");

        const idle = await snapshot(endpoint);
        assert.equal(idle.status, "idle");
        assert.ok(idle.source.includes("final answer"));
        assert.ok(idle.source.includes("completed output"));
        assert.equal(idle.source.split("final answer").length - 1, 1);
        assert.equal(idle.source.split("completed output").length - 1, 1);
    });
});

test("large tool arguments stay bounded without hiding streaming text or leaking image data", async () => {
    const peer = makePeer();
    const current = assistant([
        { type: "text", text: "still streaming" },
        { type: "toolCall", id: "write-1", name: "write", arguments: { content: "x".repeat(20000) + "latest-argument" } },
        { type: "image", data: "SECRET_BASE64", mimeType: "image/png" },
    ]);
    await peer.emit("message_update", { message: current });
    await withServer(peer.state, async (endpoint) => {
        const result = await snapshot(endpoint);
        assert.match(sessionText(result.source), /still streaming/);
        assert.match(result.source, /latest-argument/);
        assert.doesNotMatch(result.source, /SECRET_BASE64/);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) + 1 <= 16384);
        await peer.emit("message_end", { message: current });
        peer.branch.push(entry("done", "u", current));
        const completed = await snapshot(endpoint); // Before agent_settled clears the final preview.
        assert.equal(completed.source.split("still streaming").length - 1, 1);
    });
});

test("displayed entries are relinked across omitted metadata and hidden messages", async () => {
    const peer = makePeer();
    peer.branch.push(
        { type: "model_change", id: "model", parentId: "u", provider: "test", modelId: "test" },
        { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
        { type: "custom_message", id: "hidden", parentId: "thinking", customType: "secret", content: "hidden payload", display: false },
        entry("newer", "hidden", { role: "user", content: "newer message" }),
    );
    await withServer(peer.state, async (endpoint) => {
        const result = await snapshot(endpoint);
        const rendered = sessionText(result.source);
        assert.match(rendered, /start[\s\S]*newer message/);
        assert.doesNotMatch(rendered, /hidden payload/);
        const entries = parseSessionEntries(result.source).slice(1);
        assert.deepEqual(entries.map((item) => item.parentId), entries.map((_item, i) => i === 0 ? null : entries[i - 1].id));
    });
});

test("snapshots are bounded with an explicit notice and shutdown refuses requests", async () => {
    const peer = makePeer();
    let parent = "u";
    for (let i = 0; i < 40; i++) {
        const id = `large-${i}`;
        peer.branch.push(entry(id, parent, { role: "user", content: `large-${i} ${"x".repeat(500)}` }));
        parent = id;
    }
    await withServer(peer.state, async (endpoint) => {
        const result = await snapshot(endpoint);
        const line = JSON.stringify(result);
        assert.ok(Buffer.byteLength(line) + 1 <= 16384);
        assert.match(result.source, /Snapshot truncated:/);
        assert.equal(parseSessionEntries(result.source)[0].type, "session");

        peer.state.shuttingDown = true;
        await assert.rejects(snapshot(endpoint), /shutting down/);
    });
});
