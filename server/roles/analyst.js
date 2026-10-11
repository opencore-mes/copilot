// The analytics copilot of AI Report (DESIGN.md §34): it reads the views the person may query, through the host's
// tools (host.tools.analyst: the schema, a query, a report drawn), as them, and draws a report: words, figures, charts
// and tables. It changes nothing and keeps nothing: the person keeps and shares what it draws. Each query it runs is
// in the audit trail (the host's tools record them). On a report layout the person picked (§34.5), the host says what
// the layout asks for (host.reports.layoutWords), and render_report holds the report to it.
//
// For the core's kept prompts (§34.7, §34.11): generate() asks a prompt as its owner and answers the report drawn;
// words() writes a pinned report's words afresh from what its blocks answer now.
import { createChat, readyFor, iso } from "../runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WITH_REPORTS = 12;
const MODEL_ROWS = 40;
const MODEL_CELL = 200;
const WORDS = 1500;
const cell = (v) => (typeof v === "string" && v.length > MODEL_CELL ? `${v.slice(0, MODEL_CELL)}…` : v);

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const WRITE_WORDS = {
    write_words: {
        description: "The report's words: one text for each block you are asked for, by its number.",
        input_schema: obj({ words: { type: "array", items: obj({ block: { type: "integer", description: "The block's number, as given." }, text: { type: "string", description: "Its words." } }, ["block", "text"]) } }, ["words"]),
    },
};

function summarize(name, ok, result) {
    if (!ok) return result?.message ?? "failed";
    if (name === "get_schema") return `${result.views.length} view(s)`;
    if (name === "run_query") return `${result.rowCount} row(s)`;
    if (name === "render_report") { const bad = result.blocks.filter((b) => !b.ok).length; return bad ? `drawn; ${bad} block(s) need fixing` : `drawn: ${result.blocks.length} block(s)`; }
    return "done";
}

export function analystRole({ host, ai, skills }) {
    const instructions = async (session) => {
        const words = session.layout ? await host.reports.layoutWords(session.layout) : null;
        return words ? skills.analyst + words : skills.analyst;
    };
    const chat = createChat({
        role: "analyst", host, ai, tools: host.tools.analyst, instructions, steps: 16, cut: "ask for fewer rows or columns", summarize,
        extraOf: (row) => ({ report: row?.report ?? null, layout: row?.layout ?? null }),
        callerOf: (session, user) => ({ user, layout: session.layout ?? null, agent: ai.agent() }),
        // The report drawn is the page's, not the model's: kept with the conversation, the model told how it came out.
        after(call, result, session) {
            if (call.name !== "render_report") return result;
            const { report, ...told } = result;
            session.report = report;
            return told;
        },
    });
    const view = (s) => ({ transcript: s.transcript, running: s.running, step: s.step, error: s.error, report: s.report ?? null, layout: s.layout ?? null, started_at: iso(s.started_at), updated_at: iso(s.updated_at) });

    const services = {
        async "analyst.status"() {
            await host.person(this, "query");
            return ai.status();
        },
        async "analyst.get"() {
            return view(await chat.open((await host.person(this, "query")).id));
        },
        // `layout`: the report layout to draw on from now on (a name; null or "" for none; left out, the
        // conversation's own stays). `reports`: kept reports to work from (their ids, at most a dozen): the copilot is
        // handed each as the person may read it now, with the message.
        async "analyst.send"({ text, layout, reports: withReports, attachments: attached } = {}) {
            const user = await host.person(this, "query");
            const ids = withReports === undefined || withReports === null ? [] : withReports;
            if (!Array.isArray(ids) || ids.length > WITH_REPORTS || !ids.every((id) => typeof id === "string" && UUID.test(id)) || new Set(ids).size !== ids.length) host.fail(`Pick at most ${WITH_REPORTS} kept reports to work from.`, { fields: { reports: "Too many, or not reports." } });
            const session = await chat.open(user.id);
            await readyFor({ host, ai, role: "analyst", user, session, text, asked: "Say what you want to know" });
            if (layout !== undefined) {
                const picked = layout === null || layout === "" ? null : await host.reports.layout(layout);
                if (layout && !picked) host.fail("That report layout is not published (any more): pick another, or none.", { fields: { layout: "Not published." }, status: 409 });
                if ((picked?.name ?? null) !== (session.layout ?? null)) {
                    session.layout = picked?.name ?? null;
                    session.transcript.push({ role: "note", text: picked ? `Drawn on the layout ${picked.label} from here on.` : "No layout from here on: the copilot arranges the report.", at: new Date().toISOString() });
                }
            }
            // Files the person attached (§34.10): read by the copilot, shown in the report if it says so.
            const files = host.attachments && attached?.length ? await host.attachments.checked(attached) : { list: [] };
            if (files.problem) host.fail(files.problem, { fields: { attachments: files.problem } });
            const digest = ids.length ? await host.reports.digest(this, user, ids) : [];
            const content = [{ type: "text", text: text.trim() }, ...(host.attachments?.blocks(files.list) ?? []), ...(digest.length ? [{ type: "text", text: `The person picked these ${digest.length} kept report(s) to work from. Each is given as they may read it now: its words as they were written when it was drawn, and what its blocks answer at this moment.\n${chat.clip(digest)}` }] : [])];
            await chat.start(session, user, content, { text: text.trim(), ...(files.list.length ? { files: files.list.map(({ blob, name, type }) => ({ blob, name, type })) } : {}) }, digest.length ? [`With ${digest.length} kept report(s): ${digest.map((d) => d.title).join("; ")}.`] : []);
            return view(session);
        },
        async "analyst.reset"() {
            const user = await host.person(this, "query");
            await chat.forget(user.id);
            return { ok: true };
        },
    };

    // A kept prompt asked as its owner (the core checked them), beside their own conversation: the report drawn, or
    // why not (transient: the AI did not answer, which passes; the core tries again later).
    async function generate({ user, prompt, layout = null, attachments = [] } = {}) {
        const session = { owner: user.id, key: null, detached: true, messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...(host.attachments?.blocks(attachments) ?? [])] }], transcript: [], report: null, layout, running: true, step: 0, error: null };
        await chat.run(session, user);
        if (session.report) return { report: session.report, error: null, transient: false };
        return { report: null, error: session.error ?? "The copilot answered without drawing a report.", transient: Boolean(session.error) };
    }

    // A pinned report's words written afresh (§34.11): the copilot is handed each block's answer now (a few rows, as
    // the person reads them) and the words as first written, and writes each text block and each advice again. Its
    // blocks, queries and charts are not its to change. Answers the report with its new words.
    // `about`: what the trail says the words were written for (the core's prompt: its id and title).
    async function words({ user, prompt, report, blocks, about = {} } = {}) {
        const wanted = report.blocks.map((b, i) => (b.block === "text" || b.block === "assist" ? i + 1 : null)).filter(Boolean);
        if (!wanted.length) return report;
        const digest = blocks.map((b, i) => ({
            block: i + 1, kind: b.block, ...(b.title ? { title: b.title } : {}),
            ...(b.block === "text" ? { firstWritten: String(b.text).slice(0, WORDS) }
                : b.block === "media" ? { file: b.caption ?? b.name ?? "a file" }
                : b.error ? { error: b.error }
                : { ...(b.block === "assist" ? { firstWritten: String(b.text).slice(0, WORDS) } : {}), columns: b.data.columns.map((c) => c.name ?? c), rows: b.data.rows.slice(0, MODEL_ROWS).map((row) => row.map(cell)), ...(b.data.rows.length > MODEL_ROWS ? { more: b.data.rows.length - MODEL_ROWS } : {}) }),
        }));
        const messages = [{ role: "user", content: [{ type: "text", text: `What the report is for, as its owner asked for it: ${prompt}\n\nWrite the words of block(s) ${wanted.join(", ")}. The report, as its queries answer now:\n${chat.clip(digest)}` }] }];
        const provider = await ai.provider();
        const tools = Object.entries(WRITE_WORDS).map(([name, t]) => ({ name, ...t }));
        for (let attempt = 0; attempt < 2; attempt++) {
            const answer = await provider.complete({ system: skills["analyst-words"], messages, tools });
            const call = (answer.content ?? []).find((b) => b.type === "tool_use" && b.name === "write_words");
            const written = new Map((Array.isArray(call?.input?.words) ? call.input.words : []).filter((w) => wanted.includes(w?.block) && typeof w.text === "string" && w.text.trim()).map((w) => [w.block, w.text.trim().slice(0, 8000)]));
            if (wanted.every((n) => written.has(n))) {
                await host.audit.query(user, "ai-report-words", { ...about, blocks: wanted.length, via: { token: "analytics copilot", agent: ai.agent() } });
                return { ...report, blocks: report.blocks.map((b, i) => (written.has(i + 1) ? { ...b, text: written.get(i + 1) } : b)) };
            }
            messages.push({ role: "assistant", content: answer.content ?? [] });
            if (call) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `Every block asked for needs its words: ${wanted.filter((n) => !written.has(n)).join(", ")}.`, is_error: true }] });
            else messages.push({ role: "user", content: [{ type: "text", text: "Call write_words with the words of every block asked for." }] });
        }
        throw Object.assign(new Error("The copilot did not write the report's words: try again, or keep its words as written."), { expose: true });
    }

    return { services, generate, words, busy: chat.busy };
}
