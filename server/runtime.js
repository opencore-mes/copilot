// One conversation loop for every copilot (the three the core had kept as three copies): a person's conversation,
// kept by the host as it grows (copilot-host 1.0: host.conversations), answered by the model in steps, each step's
// tool calls run through the host's tools as the person, each said in a line the person reads.
//
//   const chat = createChat({ role, host, ai, tools, instructions, steps, chars, … })
//   chat.open(owner, key)            the conversation (kept, or new): one a stopped server left running says so
//   chat.start(session, user, content, said, notes)  the person's message, then the model answering it, not awaited
//   chat.run(session, user)          the model answering what the conversation holds, awaited (a kept prompt's run)
//   chat.forget(owner, key)          a new conversation: the kept one deleted
//   chat.busy()                      whether a conversation is being answered (the host lets a version go once not)
//
// A role says what is particular to it: its instructions (`instructions(session)`), which tools it offers, how a
// call's input is made sure of (`guard`), what it keeps of an answer (`after`), what each call is said as
// (`summarize`), what the person reads of the conversation (`viewOf`), and what is said when it ends (`finished`).

// A conversation kept as running that nothing has kept for this long was left by a server that stopped.
const STALE_MS = 10 * 60_000;

export function createChat({ role, host, ai, tools, instructions, steps = 16, chars = 16_000, cut = "ask for less", agentOf = () => ai.agent(), summarize = () => "done", guard = () => {}, after = (call, result) => result, callerOf = (session, user) => ({ user, agent: agentOf() }), extraOf = () => ({}), finished = async () => {}, stopped = "The copilot was stopped before it finished (the server restarted): ask it again." }) {
    const sessions = new Map(); // `${owner}:${key}` → the conversation, while this version answers it
    let answering = 0;
    const idOf = (owner, key) => `${owner}:${key ?? ""}`;
    const at = () => new Date().toISOString();

    async function keep(s) {
        if (s.detached) return;
        const kept = await host.conversations.put(role, s.owner, s.key, s);
        s.started_at = kept.started_at;
        s.updated_at = kept.updated_at;
    }
    const keepQuietly = (s) => keep(s).catch((error) => host.log.error?.(`${role} copilot: keeping the conversation`, error));

    async function open(owner, key = null) {
        const id = idOf(owner, key);
        if (sessions.get(id)?.running) return sessions.get(id);
        const row = await host.conversations.get(role, owner, key);
        const s = { owner, key, messages: row?.messages ?? [], transcript: row?.transcript ?? [], running: false, step: 0, error: null, started_at: row?.started_at ?? null, updated_at: row?.updated_at ?? null, ...extraOf(row) };
        if (row?.running) {
            // Answered elsewhere (another instance, or the version before this one on this server): shown as running.
            if (Date.now() - new Date(row.updated_at).getTime() < STALE_MS) return { ...s, running: true, elsewhere: true };
            s.transcript.push({ role: "note", text: stopped, at: at() });
            await keep(s);
        }
        sessions.set(id, s);
        return s;
    }

    const clip = (value) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return text.length > chars ? `${text.slice(0, chars)}… (cut at ${chars} characters: ${cut})` : text;
    };
    const offered = () => Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));

    async function run(session, user) {
        answering += 1;
        try {
            const provider = await ai.provider();
            for (session.step = 1; session.step <= steps; session.step++) {
                // What the person attached (§34.10), given as the model reads it: kept in the conversation by name only.
                const messages = host.attachments ? await host.attachments.expand(session.messages) : session.messages;
                const answer = await provider.complete({ system: await instructions(session, user), messages, tools: offered() });
                session.messages.push({ role: "assistant", content: answer.content });
                for (const block of answer.content) if (block.type === "text" && block.text.trim()) session.transcript.push({ role: "assistant", text: block.text });
                if (answer.stop === "pause") continue;
                if (answer.stop !== "tools") {
                    if (answer.note) session.transcript.push({ role: "note", text: answer.note });
                    if (answer.stop === "max_tokens") session.transcript.push({ role: "note", text: "The answer was cut short; ask to continue." });
                    return;
                }
                const results = [];
                for (const call of answer.content.filter((b) => b.type === "tool_use")) {
                    let ok = true;
                    let result;
                    try {
                        if (!Object.hasOwn(tools, call.name)) throw Object.assign(new Error(`There is no tool ${call.name}.`), { expose: true });
                        const input = guard(call, session) ?? call.input ?? {};
                        result = after(call, await tools[call.name].run(callerOf(session, user), input), session, input);
                    } catch (error) {
                        ok = false;
                        // Only words written for the reader reach the model; anything else is logged.
                        if (error?.expose !== true) host.log.error?.(`${role} copilot tool`, call.name, error);
                        result = { message: error?.expose === true ? error.message : "The tool failed.", ...(error?.fields ? { fields: error.fields } : {}) };
                    }
                    session.transcript.push({ role: "tool", name: call.name, ok, text: summarize(call.name, ok, result) });
                    results.push({ type: "tool_result", tool_use_id: call.id, content: clip(result), ...(ok ? {} : { is_error: true }) });
                }
                session.messages.push({ role: "user", content: results });
                await keepQuietly(session);
            }
            session.transcript.push({ role: "note", text: `Stopped after ${steps} steps; ask to continue.` });
        } catch (error) {
            host.log.error?.(`${role} copilot`, error);
            // The provider's own words (a bad key, a missing setting, a limit) say what to fix.
            session.error = error?.reason ? `The AI failed: ${error.reason}` : "The AI could not be reached or failed; try again.";
            session.transcript.push({ role: "note", text: session.error });
        } finally {
            answering -= 1;
            session.running = false;
            await keepQuietly(session);
            await finished(session, user).catch((error) => host.log.error?.(`${role} copilot: finishing`, error));
        }
    }

    // The person's message: kept at once, then answered (not awaited: the page reads the transcript as it grows).
    // `notes`: what is said after the message (the kept reports handed over with it).
    async function start(session, user, content, said, notes = []) {
        session.messages.push({ role: "user", content });
        session.transcript.push({ role: "user", at: at(), ...said });
        for (const text of notes) session.transcript.push({ role: "note", text, at: at() });
        session.running = true;
        session.error = null;
        session.step = 0;
        await keep(session);
        run(session, user);
        return session;
    }

    async function forget(owner, key = null) {
        const session = await open(owner, key);
        if (session.running) host.fail("Wait until the copilot has answered.", { status: 409 });
        sessions.delete(idOf(owner, key));
        await host.conversations.remove(role, owner, key);
    }

    return { open, start, run, forget, keep, clip, busy: () => answering > 0 };
}

// What every copilot checks before it answers a message: an AI is configured, the message is one, the person has not
// asked too much this hour, and it is not answering already.
export async function readyFor({ host, ai, role, user, session, text, limit = 8000, asked = "Say what you want" }) {
    const status = await ai.status();
    if (!status.configured) host.fail(status.hint ?? "No AI is configured.", { status: 503, code: "ai.unconfigured" });
    if (typeof text !== "string" || !text.trim() || text.length > limit) host.fail(`${asked}, in at most ${limit} characters.`, { fields: { text: "Required." } });
    if (!host.limits.take(role, user.id)) host.fail("The copilot has been asked a great deal in the past hour: try again later.", { status: 429, code: "rate.limited" });
    if (session.running) host.fail("The copilot is still working on your last message.", { status: 409 });
}

export const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);
