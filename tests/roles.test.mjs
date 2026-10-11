// The three roles on a fake host (copilot-host 1.0) with a scripted model: what each asks of the host, what it keeps,
// what the person reads, without the core. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activate } from "../server/index.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn) => { for (let i = 0; i < 200; i++) { if (await fn()) return true; await tick(); } return false; };

// A host keeping conversations in memory, its tools recording their calls.
function fakeHost({ tools = {}, configured = true, script }) {
    const kept = new Map();
    const calls = [];
    const audits = [];
    const key = (role, owner, k) => `${role}:${owner}:${k ?? ""}`;
    const tool = (name, answer) => ({ description: name, input_schema: { type: "object", properties: {} }, output_schema: { type: "object" }, run: async (caller, input) => { calls.push({ name, caller, input }); return typeof answer === "function" ? answer(input, caller) : answer; } });
    const provider = { name: "scripted", model: "scripted-1", available: configured, complete: script };
    const host = {
        contract: "1.0",
        person: async (self) => { if (!self?.who) throw Object.assign(new Error("Sign in first."), { expose: true, status: 401 }); return { id: self.who, name: self.who }; },
        tools: { design: { get_contract: tool("get_contract", { summary: "The rules." }), ...tools.design }, monitor: tools.monitor ?? {}, analyst: tools.analyst ?? {} },
        design: { shared: async (self, change) => { if (change === "00000000-0000-4000-8000-00000000dead") throw Object.assign(new Error("No such change."), { expose: true, status: 404 }); } },
        conversations: {
            get: async (role, owner, k) => kept.get(key(role, owner, k)) ?? null,
            put: async (role, owner, k, value) => { const at = new Date().toISOString(); const row = { ...structuredClone({ messages: value.messages, transcript: value.transcript, saves: value.saves, focus: value.focus, report: value.report, layout: value.layout }), running: value.running, started_at: kept.get(key(role, owner, k))?.started_at ?? at, updated_at: at }; kept.set(key(role, owner, k), row); return { started_at: row.started_at, updated_at: row.updated_at }; },
            remove: async (role, owner, k) => { kept.delete(key(role, owner, k)); },
        },
        limits: { take: () => true },
        attachments: null,
        audit: { analysis: async (user, after) => audits.push({ kind: "analysis", user, after }), query: async (user, action, after) => audits.push({ kind: action, user, after }) },
        reports: { layout: async (n) => (n === "daily" ? { name: "daily", label: "Daily", version: 1 } : null), layoutWords: async (n) => (n ? `\n\nDraw it on ${n}.` : null), digest: async () => [] },
        settings: { ai: { provider } },
        fail: (message, opts = {}) => { throw Object.assign(new Error(message), { expose: true, ...opts }); },
        log: { error() {}, warn() {} },
    };
    return { host, kept, calls, audits, tool };
}
const as = (who) => ({ who });
const CHANGE = "11111111-2222-4333-8444-555555555555";

test("the designer's: reads, saves on the draft it read, is held to its change, and the person reads each step", async () => {
    let turn = 0;
    const seen = [];
    const { host, calls, tool } = fakeHost({
        tools: { design: {} },
        script: async ({ system, tools }) => {
            seen.push({ system, tools: tools.map((t) => t.name) });
            turn += 1;
            if (turn === 1) return { stop: "tools", content: [{ type: "tool_use", id: "a", name: "get_change", input: { id: CHANGE } }] };
            if (turn === 2) return { stop: "tools", content: [{ type: "tool_use", id: "b", name: "save_draft", input: { id: CHANGE, reason: "x" } }, { type: "tool_use", id: "c", name: "save_draft", input: { id: "99999999-2222-4333-8444-555555555555" } }] };
            return { stop: "end", content: [{ type: "text", text: "Saved." }] };
        },
    });
    host.tools.design.get_change = tool("get_change", { title: "T", state: "design", draft_rev: 7 });
    host.tools.design.save_draft = tool("save_draft", { ok: true, problems: [], draft_rev: 8 });
    const m = await activate(host);
    const s = m.roles.design.services;
    await assert.rejects(() => s["copilot.get"].call({}, { change: CHANGE }), /Sign in first/);
    assert.deepEqual(await s["copilot.status"].call(as("dana")), { configured: true, provider: "scripted", model: "scripted-1", hint: null });
    const sent = await s["copilot.send"].call(as("dana"), { change: CHANGE, text: "Add a field." });
    assert.equal(sent.running, true);
    assert.ok(await until(async () => !(await s["copilot.get"].call(as("dana"), { change: CHANGE })).running));
    const v = await s["copilot.get"].call(as("dana"), { change: CHANGE });
    assert.deepEqual(v.transcript.filter((m) => m.role === "tool").map((m) => `${m.name}:${m.ok}:${m.text}`), ["get_change:true:change \"T\" (design)", "save_draft:true:saved; no problems", `save_draft:false:This conversation works on change request ${CHANGE} only.`]);
    assert.equal(v.saves, 1);
    assert.equal(calls.find((c) => c.name === "save_draft").input.seen, 7, "its save builds on the draft as it read it");
    assert.equal(calls.find((c) => c.name === "save_draft").caller.agent, "scripted-1");
    assert.match(seen[0].system, /You are the design copilot/);
    assert.match(seen[0].system, /"summary":"The rules."|"summary": "The rules."/);
    await assert.rejects(() => s["copilot.send"].call(as("dana"), { change: "00000000-0000-4000-8000-00000000dead", text: "x" }), /No such change/);
    await s["copilot.reset"].call(as("dana"), { change: CHANGE });
    assert.equal((await s["copilot.get"].call(as("dana"), { change: CHANGE })).transcript.length, 0);
});

test("the monitor's: what it points at is kept with the conversation, the model told only that it pointed; its question is audited", async () => {
    let turn = 0;
    const { host, audits, tool } = fakeHost({ script: async () => (++turn === 1 ? { stop: "tools", content: [{ type: "tool_use", id: "a", name: "get_run", input: { id: 4 } }, { type: "tool_use", id: "b", name: "point_at", input: { kind: "service", name: "erp", summary: "Line 6." } }] } : { stop: "end", content: [{ type: "text", text: "Run 4." }] }) });
    host.tools.monitor = { get_run: tool("get_run", { id: 4, outcome: "failed" }), point_at: tool("point_at", { pointed: true, focus: { kind: "service", name: "erp", label: "ERP", summary: "Line 6." }, note: "Handed over." }) };
    const m = await activate(host);
    const s = m.roles.monitor.services;
    await s["monitor.send"].call(as("dana"), { text: "Why?" });
    assert.ok(await until(async () => !(await s["monitor.get"].call(as("dana"))).running));
    const v = await s["monitor.get"].call(as("dana"));
    assert.deepEqual(v.focus, { kind: "service", name: "erp", label: "ERP", summary: "Line 6." });
    assert.ok(await until(() => audits.length > 0));
    assert.deepEqual(audits[0].after, { asked: "Why?", tools: ["get_run", "point_at"], runs: [4], pointedAt: "service:erp", via: { token: "monitor copilot", agent: "scripted-1" } });
});

test("the analyst's: the report drawn is kept for the page, the layout's words added; a kept prompt's generation and its words", async () => {
    let turn = 0;
    const systems = [];
    const { host, tool, audits } = fakeHost({
        script: async ({ system, tools }) => {
            systems.push(system);
            if (tools.some((t) => t.name === "write_words")) return { stop: "tools", content: [{ type: "tool_use", id: "w", name: "write_words", input: { words: [{ block: 1, text: "Fresh words." }] } }] };
            return (++turn % 2) === 1 ? { stop: "tools", content: [{ type: "tool_use", id: "r", name: "render_report", input: { title: "Lots", blocks: [] } }] } : { stop: "end", content: [{ type: "text", text: "Drawn." }] };
        },
    });
    host.tools.analyst = { render_report: tool("render_report", (input, caller) => ({ drawn: true, blocks: [], report: { title: input.title, blocks: [{ block: "text", text: "Old." }], layout: caller.layout } })) };
    const m = await activate(host);
    const s = m.roles.analyst.services;
    await assert.rejects(() => s["analyst.send"].call(as("sam"), { text: "x", layout: "nope" }), /not published/);
    await s["analyst.send"].call(as("sam"), { text: "Lots by state", layout: "daily" });
    assert.ok(await until(async () => !(await s["analyst.get"].call(as("sam"))).running));
    const v = await s["analyst.get"].call(as("sam"));
    assert.equal(v.report.title, "Lots");
    assert.equal(v.layout, "daily");
    assert.match(systems[0], /Draw it on daily\.$/);
    assert.ok(v.transcript.some((m) => m.role === "note" && /Drawn on the layout Daily/.test(m.text)));
    const g = await m.roles.analyst.generate({ user: { id: "sam", name: "Sam" }, prompt: "Lots", layout: null });
    assert.equal(g.report.title, "Lots");
    assert.equal(g.error, null);
    const report = { title: "Lots", blocks: [{ block: "text", text: "Old." }] };
    const w = await m.roles.analyst.words({ user: { id: "sam" }, prompt: "Lots", report, blocks: [{ block: "text", text: "Old." }], about: { prompt: "p1" } });
    assert.equal(w.blocks[0].text, "Fresh words.");
    assert.ok(audits.some((a) => a.kind === "ai-report-words" && a.after.prompt === "p1"));
});

test("busy while answering; no AI configured is said, in the provider's words", async () => {
    let release;
    const { host } = fakeHost({ script: () => new Promise((r) => { release = () => r({ stop: "end", content: [{ type: "text", text: "Done." }] }); }) });
    const m = await activate(host);
    await m.roles.monitor.services["monitor.send"].call(as("dana"), { text: "Slow?" });
    assert.ok(await until(() => m.busy()));
    release();
    assert.ok(await until(() => !m.busy()));
    const off = await activate(fakeHost({ configured: false, script: async () => ({}) }).host);
    await assert.rejects(() => off.roles.design.services["copilot.send"].call(as("dana"), { change: CHANGE, text: "x" }), (e) => e.code === "ai.unconfigured");
});
