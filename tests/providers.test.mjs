// The models (server/providers.js): one chosen by the server's AI settings; none set says how to set one; one handed
// in is used as it is; an OpenAI-compatible chat API, against a fake one: tools out as functions, tool calls back as
// blocks, a tool's result as a tool message. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProvider } from "../server/providers.js";

test("no AI set: not available, saying how to set one", async () => {
    const p = await createProvider({});
    assert.equal(p.available, false);
    assert.match(p.hint, /AI_PROVIDER=anthropic/);
    await assert.rejects(() => p.complete({ system: "", messages: [], tools: [] }));
});

test("a model handed in is used as it is: what it says of itself is read at each call", async () => {
    const given = { name: "scripted", model: "m", available: true, complete: async () => ({ content: [], stop: "end" }) };
    const p = await createProvider({ provider: given });
    assert.equal(p, given);
    given.available = false;
    assert.equal(p.available, false);
});

test("an OpenAI-compatible API: tools as functions, tool calls as blocks, tool results as tool messages", async () => {
    const seen = [];
    const fake = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            const request = JSON.parse(body);
            seen.push(request);
            const answered = request.messages.some((m) => m.role === "tool");
            const message = answered ? { role: "assistant", content: "The Lot object has these fields." } : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_object", arguments: JSON.stringify({ object: "lot" }) } }] };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message, finish_reason: answered ? "stop" : "tool_calls" }] }));
        });
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    try {
        const p = await createProvider({ AI_PROVIDER: "openai", AI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, AI_MODEL: "any-model" });
        const tools = [{ name: "get_object", description: "One object.", input_schema: { type: "object", properties: { object: { type: "string" } } } }];
        const first = await p.complete({ system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "Fields of a lot?" }] }], tools });
        assert.equal(first.stop, "tools");
        assert.deepEqual(first.content[0], { type: "tool_use", id: "call_1", name: "get_object", input: { object: "lot" } });
        assert.equal(seen[0].tools[0].type, "function");
        assert.equal(seen[0].model, "any-model");
        assert.equal(seen[0].messages[0].role, "system");
        const second = await p.complete({ system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "Fields of a lot?" }] }, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"fields\":[]}" }] }], tools });
        assert.equal(second.stop, "end");
        assert.ok(seen[1].messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1"));
        assert.match(second.content[0].text, /Lot object/);
    } finally {
        fake.close();
    }
});

test("an OpenAI-compatible API without its address or model: not available, saying what is missing", async () => {
    const p = await createProvider({ AI_PROVIDER: "openai" });
    assert.equal(p.available, false);
    assert.match(p.hint, /AI_BASE_URL/);
});
