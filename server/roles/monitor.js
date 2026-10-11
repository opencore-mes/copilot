// The integration monitor's copilot (DESIGN.md §15.3): asked in words why a schedule fails, what a service's failures
// have in common, since when a connection is slow. It reads what the monitor shows, through the host's tools
// (host.tools.monitor), as the person who asks, and explains. It writes nothing, and pauses, resumes, retries or runs
// nothing (the AI never acts on a real tool, §16): it names the design a fix belongs to (point_at), and the person
// hands that to a change of it, where the designer's copilot drafts. Each answered message is in the audit trail, as
// the person, with the tools it used and the runs it read.
import { createChat, readyFor, iso } from "../runtime.js";

function summarize(name, ok, result) {
    if (!ok) return result?.message ?? "failed";
    if (name === "find_runs") return `${result.rows.length} run(s)${result.more ? ", more" : ""}`;
    if (name === "get_run") return `run ${result.id}: ${result.outcome}`;
    if (name === "get_design") return `${result.kind} ${result.name} v${result.version}`;
    if (name === "get_stats") return `${result.byDay.length} day(s) of calls`;
    if (name === "point_at") return "pointed at the design to change";
    return "read";
}

export function monitorRole({ host, ai, skills }) {
    const chat = createChat({
        role: "monitor", host, ai, tools: host.tools.monitor, instructions: async () => skills.monitor, steps: 12, summarize,
        extraOf: (row) => ({ focus: row?.focus ?? null, used: [], read: [] }),
        callerOf: (session, user) => ({ user, self: session.self, agent: ai.agent() }),
        after(call, result, session, input) {
            session.used.push(call.name);
            if (call.name === "get_run") session.read.push(input.id);
            // The design the fix belongs to: kept with the conversation, for the person to hand over.
            if (call.name === "point_at") { session.focus = result.focus; return { pointed: result.pointed, note: result.note }; }
            return result;
        },
        // What it read, in the trail, as the person: never what the runs held.
        finished: (session, user) => (session.detached ? Promise.resolve() : host.audit.analysis(user, { asked: session.asked, tools: [...new Set(session.used)], runs: [...new Set(session.read)].slice(0, 100), ...(session.focus ? { pointedAt: `${session.focus.kind}:${session.focus.name}` } : {}), via: { token: "monitor copilot", agent: ai.agent() } })),
    });
    const view = (s) => ({ transcript: s.transcript, running: s.running, step: s.step, error: s.error, focus: s.focus ?? null, started_at: iso(s.started_at), updated_at: iso(s.updated_at) });

    const services = {
        async "monitor.status"() {
            await host.person(this, "design");
            return ai.status();
        },
        async "monitor.get"() {
            return view(await chat.open((await host.person(this, "design")).id));
        },
        async "monitor.send"({ text } = {}) {
            const user = await host.person(this, "design");
            const session = await chat.open(user.id);
            await readyFor({ host, ai, role: "monitor", user, session, text, asked: "Say what you want to know" });
            Object.assign(session, { used: [], read: [], asked: text.trim().slice(0, 200), self: this });
            await chat.start(session, user, [{ type: "text", text: text.trim() }], { text: text.trim() });
            return view(session);
        },
        async "monitor.reset"() {
            const user = await host.person(this, "design");
            await chat.forget(user.id);
            return { ok: true };
        },
    };
    return { services, busy: chat.busy };
}
