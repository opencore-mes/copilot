// The designer's copilot (DESIGN.md §16.3): a conversation, inside one change request, with the configured AI. It
// works through the design tools the host gives (host.tools.design) as the person who asks, and drafts only: it saves
// the draft and checks its work, and a person submits, reviews and approves. What it drafts is recorded on the change
// ("Drafted with AI") by the host's tools. A conversation is one per person and change, kept with the change.
import { createChat, readyFor, iso } from "../runtime.js";

// The tools that name a change request by its id: held to the conversation's own.
const ON_ITS_CHANGE = ["get_change", "add_to_change", "save_draft", "run_fitness"];

// One line a person reads for each tool call.
function summarize(name, ok, result) {
    if (!ok) return result?.message ?? "failed";
    switch (name) {
        case "add_to_change": return result?.already ? "already in this change" : `brought in at v${result?.version}`;
        case "save_draft": return result?.problems?.length ? `saved; ${result.problems.length} problem(s) left` : "saved; no problems";
        case "validate": return result?.problems?.length ? `${result.problems.length} problem(s)` : `no problems; approvers: ${(result?.route ?? []).map((r) => r.department).join(", ") || "none"}`;
        case "test_script": return `${result?.script}: ${result?.passed} passed, ${result?.failed} failed`;
        case "run_pipe": return result?.ok ? "the pipe passed" : `the pipe stopped: ${result?.error?.message}`;
        case "simulate_access": return `roles ${result?.roles?.join(", ") || "none"}: ${result?.actions?.length ?? 0} action(s), writes ${Object.entries(result?.fields ?? {}).filter(([, l]) => l === "w").map(([f]) => f).join(", ") || "nothing"}`;
        case "get_change": return `change "${result?.title}" (${result?.state})`;
        case "get_catalog": return Array.isArray(result?.objects) ? `${result.objects.length} object(s)` : `${Object.keys(result ?? {}).join(", ")}`;
        case "get_index": return `${Object.entries(result?.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ") || "nothing"}${result?.more ? " (not all listed)" : ""}`;
        case "get_design": return `${result?.kind} ${result?.name} v${result?.version}${result?.openChanges?.length ? `, in ${result.openChanges.length} open change(s)` : ""}`;
        case "get_related": return [result?.transactions && `${result.transactions.length} transaction(s)`, result?.objects && `${result.objects.length} related object(s)`, result?.writes && `writes ${result.writes.length} object(s)`, result?.usedBy && `used by ${result.usedBy.length}`, result?.uses && `uses ${result.uses.length}`].filter(Boolean).join(", ") || "read";
        case "find_in_designs": return `${result?.total ?? 0} place(s)`;
        case "get_organization": return result?.departments ? `${result.departments.length} department(s), ${result.people?.total ?? 0} people` : result?.people ? `${result.total} found` : result?.members ? `${result.members.length} member(s)` : "roles";
        case "get_runs": return Array.isArray(result?.runs) ? `${result.runs.length} run(s)${result.more ? ", more" : ""}` : `run ${result?.id}: ${result?.outcome}${result?.scriptStack ? `, line ${result.scriptStack.line}` : ""}`;
        case "get_suites": return `${result?.suites?.length ?? 0} suite(s)${result?.suites?.some((x) => x.newest) ? `, ${result.suites.filter((x) => x.newest).length} with a newer version` : ""}${result?.broken?.length ? `; ${result.broken.length} need(s) not met` : ""}`;
        case "run_fitness": return result?.passed ? `passed${result.counts?.warn ? `, ${result.counts.warn} warning(s)` : ""}` : `failed: ${(result?.checks ?? []).filter((c) => c.status === "fail").map((c) => c.title).join(", ")}`;
        case "dry_run": return result?.ok ? `ran; would write ${result.writes?.length ?? 0}, send ${result.requests?.length ?? 0}` : `${result?.error?.line ? `line ${result.error.line}: ` : ""}${result?.error?.message ?? "failed"}`;
        default: return "done";
    }
}

export function designRole({ host, ai, skills }) {
    const tools = host.tools.design;
    // The design contract, said once to the model after its instructions (read through the host's get_contract).
    let contract = null;
    const instructions = async (session, user) => {
        contract ??= JSON.stringify(await tools.get_contract.run({ user, agent: ai.agent() }, {}), null, 1);
        return `${skills.design}\n\n${contract}`;
    };
    const chat = createChat({
        role: "design", host, ai, tools, instructions, steps: 24, chars: 24_000, summarize, cut: "ask for a part (only), a kind or a text",
        stopped: "The copilot was stopped before it finished (the server restarted): ask it to continue.",
        extraOf: (row) => ({ saves: row?.saves ?? 0 }),
        // Held to the change it was opened on: what it reads (a draft, a catalog entry, someone else's words) cannot
        // send it to work on another of the person's changes. Its saves build on the draft as it last read it: one a
        // co-designer saved since is not undone (§5.3); it is told, reads again, and makes its edits on theirs.
        guard(call, session) {
            if (ON_ITS_CHANGE.includes(call.name) && call.input?.id !== undefined && call.input.id !== session.key) throw Object.assign(new Error(`This conversation works on change request ${session.key} only.`), { expose: true });
            return call.name === "save_draft" && call.input?.seen === undefined && session.rev !== undefined ? { ...call.input, seen: session.rev } : undefined;
        },
        after(call, result, session) {
            if (result?.draft_rev !== undefined && result?.draft_rev !== null) session.rev = Number(result.draft_rev);
            if (call.name === "save_draft") session.saves += 1;
            return result;
        },
    });
    const view = (s) => ({ transcript: s.transcript, running: s.running, step: s.step, saves: s.saves ?? 0, error: s.error, started_at: iso(s.started_at), updated_at: iso(s.updated_at) });
    const changeOf = (change) => { if (typeof change !== "string" || !/^[0-9a-f-]{36}$/.test(change)) host.fail("A bad change request id."); return change; };

    const services = {
        async "copilot.status"() {
            await host.person(this, "design");
            return ai.status();
        },
        async "copilot.get"({ change } = {}) {
            const user = await host.person(this, "design");
            return view(await chat.open(user.id, changeOf(change)));
        },
        async "copilot.send"({ change, text, attachments: attached } = {}) {
            const user = await host.person(this, "design");
            const session = await chat.open(user.id, changeOf(change));
            await readyFor({ host, ai, role: "design", user, session, text });
            await host.design.shared(this, change);
            // Files the person attached (§34.10): a drawing, a form, a spec, a spreadsheet of values.
            const files = host.attachments && attached?.length ? await host.attachments.checked(attached) : { list: [] };
            if (files.problem) host.fail(files.problem, { fields: { attachments: files.problem } });
            const opening = session.messages.length === 0;
            const prompt = `${opening ? `This conversation is about change request ${change}. Read it with get_change before you change anything.\n\n` : ""}${text.trim()}`;
            await chat.start(session, user, [{ type: "text", text: prompt }, ...(host.attachments?.blocks(files.list) ?? [])], { text: text.trim(), ...(files.list.length ? { files: files.list.map(({ blob, name, type }) => ({ blob, name, type })) } : {}) });
            return view(session);
        },
        async "copilot.reset"({ change } = {}) {
            const user = await host.person(this, "design");
            await chat.forget(user.id, changeOf(change));
            return { ok: true };
        },
        // After the copilot saved the draft, the page asks the change's live views to re-run (the host's touches:
        // the copilot's saves do not pass through the dispatcher, so they announce nothing themselves).
        async "copilot.refresh"({ change } = {}) {
            await host.person(this, "design");
            return { ok: true, change };
        },
    };
    return { services, busy: chat.busy };
}
