// The boundary (copilot-host 1.0): the package imports nothing of the core, only its own files, node: built-ins and
// its own dependencies; the browser's files nothing at all but their own; its two manifests agree; its instructions
// are there. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "copilot.json"), "utf8"));
const filesUnder = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : /\.m?js$/.test(n) ? [p] : []; });
const importsOf = (source) => [...source.matchAll(/(?:^|[;\s])import\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

test("the server side imports only its own files, node: built-ins and its own dependencies", () => {
    const deps = new Set(Object.keys(pkg.dependencies ?? {}));
    const strays = filesUnder(path.join(ROOT, "server")).flatMap((file) => importsOf(readFileSync(file, "utf8")).filter((s) => !s.startsWith("node:") && !(s.startsWith(".") && path.resolve(path.dirname(file), s).startsWith(ROOT + path.sep)) && !deps.has(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0])).map((s) => `${path.relative(ROOT, file)}: ${s}`));
    assert.deepEqual(strays, []);
});

test("the browser's files import nothing but their own: what they draw with is the core's kit", () => {
    const strays = filesUnder(path.join(ROOT, "client")).flatMap((file) => importsOf(readFileSync(file, "utf8")).filter((s) => !s.startsWith("./")).map((s) => `${path.relative(ROOT, file)}: ${s}`));
    assert.deepEqual(strays, []);
    // The browser floor (Safari 15.4, Chrome 93, Firefox 92): nothing newer.
    const newer = filesUnder(path.join(ROOT, "client")).filter((f) => /structuredClone|\.findLast\(|\.toSorted\(|Object\.groupBy|\(\?<[=!]/.test(readFileSync(f, "utf8")));
    assert.deepEqual(newer, []);
});

test("its manifests agree, and its instructions are there", () => {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.match(manifest.host, /^\^1\.\d+$/);
    for (const skill of ["design", "monitor", "analyst", "analyst-words"]) assert.ok(readFileSync(path.join(ROOT, "skills", `${skill}.md`), "utf8").length > 200, skill);
    assert.ok(pkg.files.includes("skills/") && pkg.files.includes("client/") && pkg.files.includes("server/") && pkg.files.includes("copilot.json"));
});
