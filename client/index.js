// The copilot package's panels (copilot-host 1.0): what the core's CopilotSlot draws in the designer's Copilot tab,
// the integration monitor's and AI Report's copilot column. One chat (the transcript, the box, files, the buttons),
// each role adding what is its own. They are registered under the version's tag, so a page that has another version's
// open takes this one up without a reload; their state paths are the contract's, so what was typed and read stays.
//
//   register(juris, kit, { tag }) → { design, monitor, analyst }   the components' names
//
// It imports nothing of the core: what it draws with is `kit`'s (icon, richText, isEnter, plant, confirmDialog,
// AttachFiles, pasteFiles, fileChips, design.canEdit, design.saveUnsaved, openDesign).

const POLL_MS = 700;
const RETRY_MS = 2000;
const said = (st, what) => `${st.provider === "anthropic" ? "Claude" : st.provider} · ${st.model}. ${what}`;

// One chat: `C` is its state path, `service` its services' prefix (copilot, monitor, analyst), `args()` what each call
// carries, `onView(view)` told every view read, `extra` what a role draws between the transcript and the box, `above`
// what is drawn above the box, `actions` buttons beside Ask, `attach` whether files may be attached.
function chat(kit, api, o) {
    const { C, service, args = () => ({}), onView = () => {}, logId } = o;
    let timer = null;
    const apply = (v) => { api.setValue(`${C}.view`, v); onView(v); };
    const poll = () => {
        clearTimeout(timer);
        api.call(`${service}.get`, args()).then((v) => { apply(v); if (v.running) timer = setTimeout(poll, POLL_MS); }, () => { timer = setTimeout(poll, RETRY_MS); });
    };
    if (!api.isServer) {
        api.onMount(() => {
            api.call(`${service}.status`, args()).then((st) => api.setValue(`${C}.status`, st), (e) => api.setValue(`${C}.error`, e.message));
            api.call(`${service}.get`, args()).then((v) => { o.first?.(v); apply(v); if (v.running) poll(); }, () => {});
            return () => clearTimeout(timer);
        });
    }
    const running = () => Boolean(api.getState(`${C}.view.running`, false));
    const draft = () => api.getState(`${C}.draft`, "") ?? "";
    const send = async () => {
        const text = draft().trim();
        if (!text) return;
        api.setValue(`${C}.error`, null);
        try {
            await o.before?.();
            o.setDraft ? o.setDraft("") : api.setValue(`${C}.draft`, "");
            const files = o.attach ? (api.peek(`${C}.files`) ?? []).map(({ blob, name }) => ({ blob, name })) : [];
            apply(await api.call(`${service}.send`, { ...args(), text, ...o.sending?.(), ...(files.length ? { attachments: files } : {}) }));
            api.batch(() => { if (o.attach) api.setValue(`${C}.files`, []); o.sent?.(); });
            poll();
        } catch (e) {
            api.batch(() => { api.setValue(`${C}.error`, e.message); if (!o.setDraft) api.setValue(`${C}.draft`, text); });
        }
    };
    const reset = async () => {
        if (o.confirmReset && (api.peek(`${C}.view.transcript`) ?? []).length && !(await kit.confirmDialog(api, o.confirmReset))) return;
        api.call(`${service}.reset`, args()).then(() => { const v = o.emptied ?? { transcript: [], running: false }; apply(v); o.reset?.(); }, (e) => api.setValue(`${C}.error`, e.message));
    };
    const transcript = {
        div: {
            id: logId, className: "copilot-log",
            children: () => {
                const v = api.getState(`${C}.view`, null);
                const items = v?.transcript ?? [];
                // The newest message in view once it is drawn.
                if (!api.isServer) setTimeout(() => { const el = globalThis.document?.getElementById(logId); if (el) el.scrollTop = el.scrollHeight; }, 0);
                const out = items.map((m, i) => (m.role === "tool"
                    ? { div: { key: i, className: `cp-tool icon-text ${m.ok ? "ok" : "bad"}`, children: [kit.icon(m.ok ? "check" : "x"), { span: `${m.name.replace(/_/g, " ")} — ${m.text}` }] } }
                    : m.role === "assistant" ? { div: { key: i, className: "cp-msg assistant", children: kit.richText(m.text) } }
                    : m.files?.length ? { div: { key: i, className: `cp-msg ${m.role}`, children: [{ div: m.text }, kit.fileChips(m.files)] } }
                    : { div: { key: i, className: `cp-msg ${m.role}`, textContent: m.text } }));
                if (v?.running) out.push({ div: { key: "working", className: "cp-working", textContent: `Working… (step ${v.step || 1})` } });
                if (!items.length && !v?.running) out.push({ p: { key: "empty", className: "muted small", textContent: o.empty } });
                return out;
            },
        },
    };
    const status = () => {
        const st = api.getState(`${C}.status`, null);
        if (!st) return { p: { className: "muted small", textContent: "…" } };
        if (!st.configured) return { p: { className: "copilot-off", textContent: st.hint } };
        return { p: { className: "muted small", textContent: said(st, o.what()) } };
    };
    const box = {
        div: {
            className: "copilot-input",
            children: [
                ...(o.above ?? []),
                o.attach ? { [kit.AttachFiles]: { key: `${logId}-files`, path: `${C}.files`, disabled: running } } : { span: {} },
                { textarea: { ...(o.attach ? kit.pasteFiles(api, `${C}.files`) : {}), id: o.inputId, rows: 3, placeholder: o.placeholder, "aria-label": o.label, value: () => draft(), disabled: running, oninput: (e) => (o.setDraft ? o.setDraft(e.target.value) : api.setValue(`${C}.draft`, e.target.value)), onkeydown: (e) => { if (kit.isEnter(e) && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } } } },
                { div: { className: "copilot-buttons", children: [
                    { button: { type: "button", className: "btn primary", textContent: o.ask ?? "Send", disabled: () => !draft().trim() || running() || !api.getState(`${C}.status.configured`, false), onclick: send } },
                    ...(o.actions ?? []).map((a, i) => ({ button: { key: `action-${i}`, type: "button", className: "btn", title: a.title ?? "", textContent: a.label, onclick: a.onclick } })),
                    { button: { type: "button", className: o.newClass ?? "btn", textContent: o.newLabel ?? "New conversation", title: o.newTitle ?? "", disabled: running, onclick: reset } },
                    ...(o.errorBeside ? [{ span: { className: "error small", textContent: () => api.getState(`${C}.error`, "") ?? "" } }] : []),
                ] } },
            ],
        },
    };
    const error = { p: { className: "error", textContent: () => api.getState(`${C}.error`, null) ?? "" } };
    return { status, transcript, box, error, running };
}

export function register(juris, kit, { tag = "" } = {}) {
    const names = { design: `CopilotDesign${tag}`, monitor: `CopilotMonitor${tag}`, analyst: `CopilotAnalyst${tag}` };

    // The designer's copilot (§16.3), inside one change: it drafts and checks as the person; the draft it saves
    // reaches every window like any save.
    juris.registerComponent(names.design, ({ id }, api) => {
        // A live design being viewed is not a change: the copilot drafts in one.
        if (String(id).startsWith("view-")) return { p: { className: "muted", textContent: "The copilot works inside a change: press Change it above, and ask it there." } };
        const C = `cp.${id}`;
        // What is being typed belongs to the change, not to this panel: it survives switching tabs and pages (app
        // state) and a reload, such as the page's own on a server update (this browser's storage, the viewer's
        // convenience only; it may be unavailable).
        const keyOf = `mes.copilot.draft.${id}`;
        const stored = () => { try { return globalThis.localStorage?.getItem(keyOf) ?? ""; } catch { return ""; } };
        if (!api.isServer && api.peek(`${C}.draft`) === undefined) api.setValue(`${C}.draft`, stored());
        const setDraft = (text) => {
            api.setValue(`${C}.draft`, text);
            try { if (text) globalThis.localStorage?.setItem(keyOf, text); else globalThis.localStorage?.removeItem(keyOf); } catch { /* storage may be off */ }
        };
        let seenSaves = null;
        const c = chat(kit, api, {
            C, service: "copilot", args: () => ({ change: id }), logId: `copilot-log-${id}`, attach: true, setDraft, errorBeside: true,
            // The copilot saved the draft: re-run this change's live views, so every window shows it.
            onView: (v) => { if (seenSaves !== null && v.saves > seenSaves) api.call("copilot.refresh", { change: id }).catch(() => {}); seenSaves = v.saves ?? 0; },
            first: (v) => { seenSaves = v.saves ?? 0; },
            // The person's unsaved edits are saved first, so the AI works on what they see.
            before: () => kit.design.saveUnsaved(api, id),
            emptied: { transcript: [], running: false, saves: 0 },
            confirmReset: { title: "Start a new conversation?", message: "The conversation kept with this change is deleted; the draft stays as it is.", confirm: "Start anew", danger: true },
            newClass: "btn ghost", placeholder: "Ask the copilot…", label: "Ask the copilot",
            what: () => `It drafts and checks through the design tools as you; you submit, others review and approve.${kit.design.canEdit(api, id) ? "" : " This change is not open for your edits, so it can read and explain but not save."}`,
            empty: "Ask for a change (\"add a moisture field that Quality can edit while on hold, with a rule that it is between 0 and 5\"), or ask a question about the model.",
        });
        return {
            div: {
                className: "copilot design",
                children: [
                    c.status,
                    // Kept with the change: it picks up here, any time.
                    () => {
                        const v = api.getState(`${C}.view`, null);
                        if (!v?.transcript?.length || !v.started_at) return { span: {} };
                        return { p: { className: "muted small icon-text", children: [kit.icon("archive"), { span: `Kept with this change: started ${kit.plant().dateTime(v.started_at)}, last ${kit.plant().dateTime(v.updated_at)}. It picks up here, any time.` }] } };
                    },
                    c.transcript,
                    c.box,
                ],
            },
        };
    });

    // The integration monitor's copilot (§15.3): it reads, explains, and names the design a fix belongs to, which the
    // person hands to a change of it.
    juris.registerComponent(names.monitor, (props, api) => {
        const C = "im.cp";
        const c = chat(kit, api, {
            C, service: "monitor", logId: "monitor-log", inputId: "monitor-ask", ask: "Ask", newLabel: "New chat", newTitle: "Start a new conversation: this one is forgotten",
            emptied: { transcript: [], running: false, focus: null },
            placeholder: "What do you want to know?", label: "Ask the integration monitor's copilot",
            what: () => "It reads the runs, the designs and the call statistics, as you, and explains; it pauses, retries and changes nothing. What it finds can be handed to a change of the design.",
            empty: "Ask what you want to know: \"Why does the ERP export fail since this morning?\", \"Which connections got slower this week?\", \"What do the failures of label_print have in common?\"",
        });
        // The design the fix belongs to, handed to a change of it: the designer's copilot is given what was found.
        const handOver = (focus) => kit.openDesign(api, { kind: focus.kind, name: focus.name, view: "copilot", draft: `From the integration monitor: ${focus.summary}` }).catch((e) => api.setValue(`${C}.error`, e.message));
        return {
            div: {
                className: "copilot monitor",
                children: [
                    c.status,
                    c.transcript,
                    () => {
                        const focus = api.getState(`${C}.view.focus`, null);
                        if (!focus) return { span: {} };
                        return { div: { className: "im-focus", children: [
                            { p: { className: "small", children: [{ strong: `The fix belongs to the ${focus.kind} ${focus.label}` }, { span: { className: "muted", textContent: ` (${focus.name})` } }] } },
                            { p: { className: "small", textContent: focus.summary } },
                            { button: { type: "button", className: "btn primary", disabled: c.running, onclick: () => handOver(focus), textContent: `Open a change for ${focus.label}` } },
                        ] } };
                    },
                    c.error,
                    c.box,
                ],
            },
        };
    });

    // The analytics copilot (§34): the page draws what it drew (onView); above its box, what the page gives (the
    // layout picker, the reports handed over); beside Ask, the page's actions (Keep prompt).
    juris.registerComponent(names.analyst, ({ onView = () => {}, above = [], actions = [] }, api) => {
        const R = "rep.home";
        const c = chat(kit, api, {
            C: R, service: "analyst", logId: "analyst-log", inputId: "analyst-ask", attach: true, ask: "Ask", newLabel: "New chat", newTitle: "Start a new conversation: this one and the report it drew are forgotten; kept reports stay",
            onView,
            // The conversation's layout, unless the page picked one (opened on a layout).
            first: (v) => { if (api.peek(`${R}.layout`) === undefined) api.setValue(`${R}.layout`, v.layout ?? ""); },
            sending: () => { const withReports = api.peek(`${R}.with`) ?? []; return { layout: api.peek(`${R}.layout`) || null, ...(withReports.length ? { reports: withReports } : {}) }; },
            sent: () => { api.setValue(`${R}.with`, []); api.setValue(`${R}.picked`, []); },
            emptied: { transcript: [], running: false, report: null },
            reset: () => api.setValue(`${R}.layout`, ""),
            confirmReset: { title: "Start a new conversation?", message: "The conversation and the report it drew are forgotten; reports you kept stay.", confirm: "Start anew", danger: true },
            above, actions, placeholder: "What do you want to know?", label: "Ask the analytics copilot",
            what: () => "It reads the views you may query, as you, and draws a report; it changes nothing. Each query it runs is in the audit trail.",
            empty: "Ask what you want to see: \"How many lots are in each state, and which have waited longest?\", \"Scrap by reason this month, as a chart\", \"What is the situation on line 2?\"",
        });
        return { div: { className: "copilot analyst", children: [c.status, c.transcript, c.box] } };
    });

    return names;
}
