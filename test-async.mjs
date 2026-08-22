import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

// Collect every .ts source under extensions/ (entry + coms/ modules), in a
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

test("coms requests and responses stay asynchronous — no polling, no bookkeeping", () => {
    // No blocking poll tool, no pending-reply map, no timeout timers.
    assert.ok(!source.includes('name: "coms_get"'));
    assert.ok(!source.includes("pendingReplies"));
    assert.ok(!source.includes("TIMEOUT_MS"));

    // Sender waits only for the transport ack, never for the answer.
    const send = source.slice(source.indexOf('name: "coms_send"'), source.indexOf('name: "coms_respond"'));
    assert.match(send, /await sendEnvelope\(target\.endpoint, env\)/);
    assert.ok(!send.includes("setTimeout"));

    // Replies auto-deliver as follow-ups, queued until the sender's current work finishes.
    assert.match(source, /customType: "coms-response"[\s\S]*deliverAs: "followUp", triggerTurn: true/);
    assert.match(source, /name: "coms_respond"[\s\S]*decline/);
});
