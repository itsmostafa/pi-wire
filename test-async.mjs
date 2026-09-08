import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, unlinkSync as fsUnlinkSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
const fs = { unlinkSync: fsUnlinkSync };

// Resolve hook for extensionless TS imports inside extensions/wire/.
register(new URL("./wire-test-resolve-hook.mjs", import.meta.url));

// Collect every .ts source under extensions/ (entry + wire/ modules), in a
// deterministic order, and concatenate — the async contract spans files.
function collectTs(dir, out = []) {
    for (const name of readdirSync(dir).sort()) {
        const p = `${dir}/${name}`;
        if (statSync(p).isDirectory()) collectTs(p, out);
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}
const source = collectTs(new URL("./extensions", import.meta.url).pathname)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

test("wire requests and responses stay asynchronous — no polling, no bookkeeping", () => {
    // No blocking poll tool, no pending-reply map, no timeout timers.
    assert.ok(!source.includes('name: "wire_get"'));
    assert.ok(!source.includes("pendingReplies"));
    assert.ok(!source.includes("TIMEOUT_MS"));

    // Sender waits only for the transport ack, never for the answer.
    const send = source.slice(source.indexOf('name: "wire_send"'), source.indexOf('name: "wire_respond"'));
    assert.match(send, /await sendEnvelope\(target\.endpoint, env\)/);
    assert.ok(!send.includes("setTimeout"));

    // Replies auto-deliver as follow-ups, queued until the sender's current work finishes.
    assert.match(source, /customType: "wire-response"[\s\S]*deliverAs: "followUp", triggerTurn: true/);
    assert.match(source, /name: "wire_respond"[\s\S]*decline/);
});

test("wire_respond dispatch is truthful — transport ack awaited, failure retryable", () => {
    // wire_respond awaits the dispatch so a failed delivery becomes a tool error,
    // but only the transport ack (bounded by sendEnvelope's fixed cap) — never
    // requester-side agent work.
    const respond = source.slice(source.indexOf('name: "wire_respond"'));
    assert.match(respond, /await dispatchInboundResponse\(/);
    assert.ok(!respond.includes("wire_await"));

    // dispatchInboundResponse retains the inbound queue entry on failure (delete
    // happens only in the transport-ack success handler) so the model can retry.
    const dispatch = source.slice(source.indexOf("export async function dispatchInboundResponse"));
    const okBranch = dispatch.slice(dispatch.indexOf(".then(() => {"), dispatch.indexOf("}, (e: any)"));
    assert.ok(okBranch.includes("inboundQueue.delete"),
        "delete must happen only in the transport-ack success branch");
    const failBranch = dispatch.slice(dispatch.indexOf("}, (e: any)"), dispatch.indexOf("state.inflightResponses.add"));
    assert.ok(failBranch.includes("inbound.sending = false"),
        "failure branch must reset sending and retain the entry");

    // Oversize responses are rejected BEFORE any state changes (preflight).
    assert.match(dispatch, /Buffer\.byteLength\(JSON\.stringify\(env\)\)/);

    // Double-send guard for parallel batches.
    assert.match(dispatch, /inbound\.sending/);
});

test("inbound response is enqueued before acking the responder", () => {
    const handler = source.slice(source.indexOf("function handleResponse"), source.indexOf("function handlePing"));
    // The early-return ackOk is the dedup path (already delivered); the
    // happy-path ack (last ackOk) must follow the successful follow-up enqueue.
    assert.ok(handler.lastIndexOf("ackOk") > handler.indexOf("pi.sendMessage"),
        "happy-path ack must follow successful local follow-up enqueue, not precede it");
});

test("auto-cleanup runs at agent_settled, not agent_end", () => {
    // agent_end can precede retry/compaction/queued follow-up continuations —
    // cleaning up there would prematurely finalize requests Pi is still on.
    assert.ok(!source.includes('pi.on("agent_end"'));
    assert.match(source, /pi\.on\("agent_settled"[\s\S]*interrupted/);
});

test("graceful shutdown notifies every accepted-but-unanswered inbound request", () => {
    const shutdown = source.slice(source.indexOf("async function doCleanShutdown"), source.indexOf('pi.on("session_shutdown"'));
    assert.match(shutdown, /sendErrorResponse[\s\S]*"peer session ended"/);
});

test("line caps are enforced in bytes, not JS string length", () => {
    assert.match(source, /bufBytes \+= chunk\.length/);
    assert.ok(!source.includes("buf.length > LINE_CAP_BYTES"));
});

test("terminal responses are deduplicated by msg_id (lost-ACK ambiguity guard)", () => {
    // First terminal message for a msg_id wins; retries / agent_settled
    // "interrupted" cleanup for an already-delivered msg_id are acked and
    // dropped — no duplicates, no contradictions.
    const handler = source.slice(source.indexOf("function handleResponse"), source.indexOf("function handlePing"));
    assert.ok(handler.indexOf("seenResponseIds.has") >= 0 && handler.indexOf("seenResponseIds.has") < handler.indexOf("pi.sendMessage"),
        "dedup check must precede follow-up enqueue");
    // Failed local enqueue rolls the dedup mark back so the responder's retry
    // can re-enqueue.
    assert.match(handler, /seenResponseIds\.delete\(env\.msg_id\)/);
    // Bounded cache — not a pending-request ledger.
    assert.match(source, /SEEN_RESPONSE_IDS_CAP/);
});

test("shutdown closes the listener before snapshotting pending requests", () => {
    const shutdown = source.slice(source.indexOf("async function doCleanShutdown"));
    assert.ok(shutdown.indexOf("server.close()") < shutdown.indexOf("[...state.inboundQueue.values()]"),
        "server must stop accepting prompts before the notification snapshot");
    // In-flight wire_respond dispatches are awaited (bounded ~5s), not raced.
    assert.match(shutdown, /await Promise\.allSettled\(state\.inflightResponses\)/);
    // Concurrent shutdown callers share one in-flight cleanup.
    assert.match(source, /if \(!shutdownPromise\) shutdownPromise = doCleanShutdown\(\)/);
});

test("wire framing decodes multibyte UTF-8 safely across chunk boundaries", () => {
    assert.match(source, /new StringDecoder\("utf-8"\)/);
    assert.ok(!source.includes("buf += chunk.toString"),
        "per-chunk toString corrupts split multibyte characters");
});

// ━━ Behavioral tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Source-shape assertions above can't catch wiring regressions (wrong call
// signature, missing state init, missing import), so the transport and inbound
// handling are also exercised over real sockets. transport.ts and server.ts
// import only stdlib modules at runtime, so they load without pi installed.

process.env.PI_WIRE_LINE_CAP_BYTES = "4096"; // small cap for the byte-cap test

const { readOneLine } = await import(new URL("./extensions/wire/transport.ts", import.meta.url));
const { createConnHandler, dispatchInboundResponse } = await import(new URL("./extensions/wire/server.ts", import.meta.url));
const net = await import("node:net");
const os = await import("node:os");
const path = await import("node:path");

function makeState(overrides = {}) {
    return {
        identity: {
            session_id: "me", name: "me", purpose: "", color: "#36F9F6", explicit: false,
            cwd: "/tmp", model: "m", endpoint: "/tmp/me.sock", registryFile: "/tmp/me.json", started_at: "",
        },
        peerCards: new Map(),
        inboundQueue: new Map(),
        seenResponseIds: new Set(),
        shuttingDown: false,
        inflightResponses: new Set(),
        includeExplicit: false,
        currentCtx: null,
        currentInbound: null,
        definitionBody: null,
        ...overrides,
    };
}

function listenTcp(handler) {
    return new Promise((resolve) => {
        const srv = net.createServer(handler);
        srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
    });
}

function connect(port) {
    return new Promise((resolve) => {
        const sock = net.connect(port, "127.0.0.1", () => resolve(sock));
    });
}

test("readOneLine decodes multibyte UTF-8 split across chunks", async () => {
    const { srv, port } = await listenTcp(() => {});
    const serverSockP = new Promise((r) => srv.once("connection", (s) => r(s)));
    const client = await connect(port);
    const serverSock = await serverSockP;
    const line = readOneLine(serverSock);
    client.write(Buffer.from([0x68, 0xc3])); // "h" + high byte of é
    client.write(Buffer.from([0xa9, 0x6c, 0x6c, 0x6f, 0x0a])); // low byte + "llo\n"
    assert.equal(await line, "héllo");
    client.destroy();
    srv.close();
});

test("readOneLine enforces the byte cap without a newline", async () => {
    const { srv, port } = await listenTcp(() => {});
    const serverSockP = new Promise((r) => srv.once("connection", (s) => r(s)));
    const client = await connect(port);
    const serverSock = await serverSockP;
    const line = readOneLine(serverSock);
    client.write("x".repeat(5000)); // no newline, > 4096-byte cap
    await assert.rejects(line, /line too large/);
    client.destroy();
    srv.close();
});

test("duplicate terminal responses are acked but delivered once (lost-ACK guard)", async () => {
    const delivered = [];
    const pi = { sendMessage: (m) => delivered.push(m), appendEntry: () => {} };
    const state = makeState();
    const { srv, port } = await listenTcp(createConnHandler(pi, state));
    const env = {
        type: "response", msg_id: "m1", sender_session: "s", sender_endpoint: "e",
        sender_name: "bob", hops: 0, timestamp: "", response: "hi",
    };
    const sendOnce = async () => {
        const sock = await connect(port);
        sock.write(JSON.stringify(env) + "\n");
        const reply = JSON.parse(await readOneLine(sock));
        sock.destroy();
        return reply;
    };
    assert.equal((await sendOnce()).type, "ack");
    assert.equal((await sendOnce()).type, "ack"); // duplicate acked...
    assert.equal(delivered.length, 1); // ...but enqueued exactly once
    srv.close();
});

test("inbound admission is gated during shutdown", async () => {
    const pi = {
        sendMessage: () => { throw new Error("must not enqueue during shutdown"); },
        appendEntry: () => {},
    };
    const state = makeState({ shuttingDown: true });
    const { srv, port } = await listenTcp(createConnHandler(pi, state));
    for (const type of ["prompt", "response"]) {
        const sock = await connect(port);
        sock.write(JSON.stringify({
            type, msg_id: `p-${type}`, sender_session: "s", sender_endpoint: "e",
            sender_name: "a", hops: 0, timestamp: "", prompt: "hi", response: "r",
        }) + "\n");
        const reply = JSON.parse(await readOneLine(sock));
        sock.destroy();
        assert.equal(reply.type, "nack");
        assert.match(reply.error, /shutting down/);
    }
    srv.close();
});

test("wire_respond dispatch: success removes the inbound, failure retains it", async () => {
    const pi = { sendMessage: () => {}, appendEntry: () => {} };
    const sockPath = path.join(os.tmpdir(), `pi-wire-test-${process.pid}-${Date.now()}.sock`);
    let replyType = "ack";
    const peer = net.createServer((s) => {
        let buf = "";
        s.on("data", (c) => {
            buf += c.toString("utf-8");
            if (buf.includes("\n")) {
                s.write(JSON.stringify({
                    type: replyType, msg_id: "m1",
                    error: replyType === "nack" ? "nope" : undefined,
                }) + "\n");
            }
        });
    });
    await new Promise((r) => peer.listen(sockPath, r));
    const state = makeState();

    // Success → transport ack → queue entry removed.
    const ok = { msg_id: "m1", hops: 0, sender_endpoint: sockPath, started: true };
    state.inboundQueue.set("m1", ok);
    await dispatchInboundResponse(pi, state, ok, "answer", null);
    assert.ok(!state.inboundQueue.has("m1"));

    // Failure (nack) → throws, entry retained, retryable.
    replyType = "nack";
    const bad = { msg_id: "m2", hops: 0, sender_endpoint: sockPath, started: true };
    state.inboundQueue.set("m2", bad);
    await assert.rejects(dispatchInboundResponse(pi, state, bad, "answer", null), /nope/);
    assert.ok(state.inboundQueue.has("m2"));
    assert.equal(bad.sending, false);

    peer.close();
    try { fs.unlinkSync(sockPath); } catch { /* best-effort */ }
});
