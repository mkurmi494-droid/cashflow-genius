// Budget planner tests for server/lib/budgetPlanner.ts (pure).
// Proves the suggestion math the AI planner falls back to — and the
// repair pass the AI's own suggestion goes through:
// (1) 50/30/20 splits income across needs/wants by 3-month history;
// (2) bucket totals are exact after rounding; (3) categories with no
// history share their bucket equally; (4) needs/wants classification
// follows the category name; (5) a bad AI shape (percentages over
// 100, negative amounts, empty categories) is repaired or rejected;
// (6) no income means no suggestion.
// Run: node scripts/budget-planner-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-budget-planner-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
};

const src = readFileSync(join(repo, "server/lib/budgetPlanner.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "budgetPlanner.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);

check("food is needs", mod.classifyBudgetCategory("Food & groceries"), "needs");
check("rent is needs", mod.classifyBudgetCategory("Rent & home"), "needs");
check("shopping is wants", mod.classifyBudgetCategory("Shopping"), "wants");
check("entertainment is wants", mod.classifyBudgetCategory("Entertainment"), "wants");
check("general is wants", mod.classifyBudgetCategory("General"), "wants");
check("transport is needs", mod.classifyBudgetCategory("Transport"), "needs");

const base = {
  monthlyIncomeCents: 10000000, // ₹1,00,000
  needsPct: 50,
  wantsPct: 30,
  savingsPct: 20,
  history: [
    { category: "Food & groceries", avgMonthlyCents: 2000000 },
    { category: "Rent", avgMonthlyCents: 2000000 },
    { category: "Shopping", avgMonthlyCents: 1000000 },
    { category: "Entertainment", avgMonthlyCents: 500000 },
  ],
  categories: ["Food & groceries", "Rent", "Shopping", "Entertainment"],
};
const d = mod.deterministicBudget(base);
check("needs bucket totals 50%", d.allocations.filter((a) => a.bucket === "needs").reduce((s, a) => s + a.monthlyCents, 0), 5000000);
check("wants bucket totals 30%", d.allocations.filter((a) => a.bucket === "wants").reduce((s, a) => s + a.monthlyCents, 0), 3000000);
check("savings pct kept", d.savingsPct, 20);
check("food gets half the needs bucket", d.allocations.find((a) => a.category === "Food & groceries")?.monthlyCents, 2500000);
check("shopping gets 2/3 of wants", d.allocations.find((a) => a.category === "Shopping")?.monthlyCents, 2000000);

const noHistory = mod.deterministicBudget({ ...base, history: [] });
check("no history splits needs equally", noHistory.allocations.find((a) => a.category === "Food & groceries")?.monthlyCents, 2500000);

const custom = mod.deterministicBudget({ ...base, needsPct: 60, wantsPct: 25, savingsPct: 15 });
check("custom rule rebalances savings", custom.savingsPct, 15);
check("custom needs total", custom.allocations.filter((a) => a.bucket === "needs").reduce((s, a) => s + a.monthlyCents, 0), 6000000);

const fixed = mod.normalizeBudgetSuggestion(
  {
    needsPct: 70,
    wantsPct: 50,
    savingsPct: 0,
    allocations: [
      { category: "Food & groceries", bucket: "needs", monthlyCents: 3000000 },
      { category: "Rent", bucket: "needs", monthlyCents: 3000000 },
      { category: "", bucket: "wants", monthlyCents: 1000000 },
      { category: "Shopping", bucket: "wants", monthlyCents: -500 },
      { category: "Entertainment", bucket: "wants", monthlyCents: 1000000 },
    ],
    note: "test",
  },
  { monthlyIncomeCents: 10000000, categories: [] },
);
check("percentages over 100 are rebalanced", fixed?.needsPct, 58);
check("bad rows dropped, wants kept", fixed?.allocations.filter((a) => a.bucket === "wants").length, 1);
check("wants rescaled to its pct", fixed?.allocations.filter((a) => a.bucket === "wants").reduce((s, a) => s + a.monthlyCents, 0), 4200000);
check("garbage returns null", mod.normalizeBudgetSuggestion({ allocations: [] }, { monthlyIncomeCents: 10000000, categories: [] }), null);
check("no income returns null", mod.normalizeBudgetSuggestion({ needsPct: 50, wantsPct: 30, allocations: [{ category: "Rent", bucket: "needs", monthlyCents: 100 }] }, { monthlyIncomeCents: 0, categories: [] }), null);

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
if (fail > 0) process.exit(1);
