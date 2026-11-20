// Smart Add tests for server/lib/smartEntry.ts (pure).
// Proves the fallback parser and the AI-answer repair pass:
// (1) "dinner 50, shopping 200" splits into two expense entries;
// (2) amounts with ₹/k/thousand parse right, and the "k" of
// "kharcha" is NOT a thousands multiplier; (3) "kal"/yesterday
// shift the date, a written "12 Nov" is honoured; (4) income words
// flip the type and pick an income category; (5) a chunk with no
// amount is skipped, never invented; (6) a bad AI shape (empty
// description, negative amount, impossible date) is repaired.
// Run: node scripts/smart-entry-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-smart-entry-test-"));

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

const src = readFileSync(join(repo, "server/lib/smartEntry.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "smartEntry.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);

const today = "2026-11-20";
const cats = {
  today,
  expenseCategories: ["Food & groceries", "Rent", "Shopping", "Transport", "General"],
  incomeCategories: ["Salary", "Customer payments", "Other income"],
};

const two = mod.parseSmartEntryText("dinner 50, shopping 200", cats);
check("two entries from one line", two.entries.length, 2);
check("first is dinner 50", [two.entries[0]?.description, two.entries[0]?.amountCents, two.entries[0]?.type], ["dinner", 5000, "expense"]);
check("dinner maps to food", two.entries[0]?.category, "Food & groceries");
check("second is shopping 200", [two.entries[1]?.description, two.entries[1]?.amountCents], ["shopping", 20000]);
check("both dated today", two.entries.map((e) => e.date), ["2026-11-20", "2026-11-20"]);

const kal = mod.parseSmartEntryText("dinner 50, shopping 200 yesterday", cats);
check("yesterday shifts both dates", kal.entries.map((e) => e.date), ["2026-11-19", "2026-11-19"]);

const inc = mod.parseSmartEntryText("received 5000 salary from client", cats);
check("income detected", inc.entries[0]?.type, "income");
check("salary category", inc.entries[0]?.category, "Salary");
check("counterparty from client", inc.entries[0]?.counterparty, "client");

check("2.5k means 2500", mod.extractAmountCents("chai 2.5k"), 250000);
check("kharcha k is not thousands", mod.extractAmountCents("₹500 kharcha"), 50000);
check("no amount gives no entry", mod.parseSmartEntryText("just some words", cats).entries.length, 0);
check("mixed good and bad keeps the good", mod.parseSmartEntryText("dinner 50, hello there", cats).entries.length, 1);

const written = mod.parseSmartEntryText("paid 18000 rent on 12 Nov", cats);
check("written date honoured", written.entries[0]?.date, "2026-11-12");
check("rent category", written.entries[0]?.category, "Rent");

const fixed = mod.normalizeSmartEntry(
  {
    entries: [
      { description: "Rice", amountCents: 12000, type: "expense", category: "Food & groceries", date: "2026-11-12", counterparty: "TEST MART" },
      { description: "", amountCents: 5000, type: "expense", category: "General", date: "2026-11-12", counterparty: "" },
      { description: "Bad", amountCents: -100, type: "expense", category: "General", date: "2026-11-12", counterparty: "" },
      { description: "Future", amountCents: 1000, type: "expense", category: "General", date: "2026-02-30", counterparty: "" },
    ],
    note: "test",
  },
  { today },
);
check("bad rows dropped, good kept", fixed?.entries.length, 2);
check("impossible date falls back to today", fixed?.entries[1]?.date, "2026-11-20");
check("garbage returns null", mod.normalizeSmartEntry({ entries: [] }, { today }), null);
check("missing entries returns null", mod.normalizeSmartEntry({}, { today }), null);

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
if (fail > 0) process.exit(1);
