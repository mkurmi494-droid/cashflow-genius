// Regression test for the voice-entry parser (client/parseEntry.ts).
// Transpiles the real TS sources with the repo's own TypeScript
// (transpile-only, no typecheck) and asserts the parse results — no
// mocks of the parser itself.
// Run: node scripts/voice-parse-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-parse-test-"));
try {
  for (const f of ["parseEntry", "lib"]) {
    const src = readFileSync(join(repo, "client", `${f}.ts`), "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: `${f}.ts`,
    }).outputText;
    writeFileSync(join(out, `${f}.js`), js);
  }
  const { parseSpokenEntry, extractAmountRupees } = require(join(out, "parseEntry.js"));

  let pass = 0, fail = 0;
  const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (ok) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  };

  // The demo's flagship example (bug, 2026-11-15): was ₹500,000 / "harcha, chai".
  // Note: "Food & groceries" / "Transport" are personal-mode categories —
  // in business mode the parser correctly falls back to "General".
  let d = parseSpokenEntry("₹500 kharcha, chai", "business");
  check('"₹500 kharcha, chai" amount', d.amount, "500");
  check('"₹500 kharcha, chai" description', d.description, "kharcha, chai");
  check('"₹500 kharcha, chai" type', d.type, "expense");
  check('"₹500 kharcha, chai" category (business)', d.category, "General");
  d = parseSpokenEntry("₹500 kharcha, chai", "personal");
  check('"₹500 kharcha, chai" category (personal)', d.category, "Food & groceries");

  d = parseSpokenEntry("500 kharcha chai", "business");
  check('"500 kharcha chai" amount', d.amount, "500");
  check('"500 kharcha chai" description', d.description, "kharcha chai");

  d = parseSpokenEntry("₹1,000 petrol", "personal");
  check('"₹1,000 petrol" amount', d.amount, "1000");
  check('"₹1,000 petrol" description', d.description, "petrol");
  check('"₹1,000 petrol" category', d.category, "Transport");

  d = parseSpokenEntry("chai 250", "business");
  check('"chai 250" amount', d.amount, "250");
  check('"chai 250" description', d.description, "chai");

  // The "k" multiplier must still work when it really is a multiplier.
  check('"2.5k chai" amount', extractAmountRupees("2.5k chai"), 2500);
  check('"₹500k kharcha" amount', extractAmountRupees("₹500k kharcha"), 500000);
  check('"500 k chai" amount', extractAmountRupees("500 k chai"), 500000);
  check('"500 rupees kharcha chai" amount', extractAmountRupees("500 rupees kharcha chai"), 500);
  d = parseSpokenEntry("500 rupees kharcha chai", "business");
  check('"500 rupees kharcha chai" description', d.description, "kharcha chai");
  d = parseSpokenEntry("₹5,000 kharcha", "business");
  check('"₹5,000 kharcha" amount', d.amount, "5000");
  check('"₹5,000 kharcha" description', d.description, "kharcha");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  rmSync(out, { recursive: true, force: true });
}
