// The copilot package's server side (copilot-host 1.0): what the OpenCore MES core takes up, without a restart, as
// its copilots. `activate(host)` is called once per version the core takes up; everything it holds is its own, so
// the version before keeps answering what it started while this one answers what comes next.
//
//   activate(host) → { roles: { design, monitor, analyst }, ai, busy(), close() }
//
// It reaches the core only through `host` (docs/contracts/copilot-host in the core), and imports nothing of it.
import { readFileSync, readdirSync } from "node:fs";
import { createProvider } from "./providers.js";
import { designRole } from "./roles/design.js";
import { monitorRole } from "./roles/monitor.js";
import { analystRole } from "./roles/analyst.js";

const SKILLS = new URL("../skills/", import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL("../copilot.json", import.meta.url), "utf8"));

// The instructions, as data (skills/<name>.md): improved with the package, read when a version is taken up.
export function readSkills(dir = SKILLS) {
    return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), readFileSync(new URL(f, dir), "utf8").trim()]));
}

export async function activate(host) {
    if (!host || typeof host.person !== "function" || !host.tools) throw new Error("activate(host): the host is not a copilot-host.");
    const skills = readSkills();
    // The model, built from the server's AI settings (the core reads them; the package owns the providers). Built
    // once, when first asked, so a server without an AI takes the package up all the same.
    let provider = null;
    const ai = {
        provider: async () => (provider ??= await createProvider(host.settings?.ai ?? {})),
        agent: () => provider?.model ?? provider?.name ?? "model",
        async status() {
            const p = await ai.provider();
            // A model that does not say otherwise is there (one handed in ready-made need not say).
            return { configured: p.available !== false, provider: p.name ?? "given", model: p.model ?? null, hint: p.hint ?? null };
        },
        async complete(request) { return (await ai.provider()).complete(request); },
    };
    const roles = { design: designRole({ host, ai, skills }), monitor: monitorRole({ host, ai, skills }), analyst: analystRole({ host, ai, skills }) };
    let closed = false;
    return {
        version: manifest.version,
        roles,
        ai: { status: () => ai.status(), complete: (request) => ai.complete(request) },
        busy: () => Object.values(roles).some((r) => r.busy()),
        close() { closed = true; return closed; },
    };
}
