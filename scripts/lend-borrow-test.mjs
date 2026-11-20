// Lend / Borrow ledger tests for server/lib/lendBorrow.ts (pure).
// Proves: (1) a valid lent record normalizes, (2) a valid borrowed
// record normalizes, (3) an empty person is rejected, (4) a bad
// direction is rejected, (5) zero/negative amounts are rejected,
// (6) an amount over the ceiling is rejected, (7) an impossible
// date is rejected, (8) an impossible due date is rejected, (9) a
// long note is trimmed to 500, (10) a settled record keeps its
// settled date, (11) an open record past its due date is overdue,
// (12) due today is not overdue, (13) a settled record is never
// overdue, (14) totals count open lent/borrowed only, (15) the
// direction filter works, (16) hide-completed hides settled rows,
// (17) sorting puts overdue first, then earliest due date.
// Run: node scripts/lend-borrow-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-lend-borrow-test-"));

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

const src = readFileSync(join(repo, "server/lib/lendBorrow.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "lendBorrow.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);

const lent = mod.normalizeLendBorrow({
  person: "  Rohan  ",
  direction: "lent",
  amountCents: 500000,
  date: "2026-11-20",
  dueDate: "2026-12-20",
  note: "For the bike repair",
  status: "open",
});
check("valid lent record normalizes", lent, {
  ok: true,
  record: {
    person: "Rohan",
    direction: "lent",
    amountCents: 500000,
    date: "2026-11-20",
    dueDate: "2026-12-20",
    note: "For the bike repair",
    status: "open",
    settledDate: null,
  },
});

const borrowed = mod.normalizeLendBorrow({
  person: "Meera",
  direction: "borrowed",
  amountCents: 200000,
  date: "2026-11-18",
  dueDate: null,
  note: "",
});
check("valid borrowed record normalizes (no due date)", borrowed.ok, true);
check("borrowed keeps null due date", borrowed.record?.dueDate, null);

check("empty person rejected", mod.normalizeLendBorrow({ person: "   ", direction: "lent", amountCents: 100, date: "2026-11-20" }).ok, false);
check("bad direction rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "gift", amountCents: 100, date: "2026-11-20" }).ok, false);
check("zero amount rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: 0, date: "2026-11-20" }).ok, false);
check("negative amount rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: -500, date: "2026-11-20" }).ok, false);
check("amount over ceiling rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: 100_000_000_01, date: "2026-11-20" }).ok, false);
check("impossible date rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: 100, date: "2026-02-30" }).ok, false);
check("impossible due date rejected", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: 100, date: "2026-11-20", dueDate: "2026-13-01" }).ok, false);
check("long note trimmed to 500", mod.normalizeLendBorrow({ person: "Rohan", direction: "lent", amountCents: 100, date: "2026-11-20", note: "x".repeat(600) }).record.note.length, 500);

const settled = mod.normalizeLendBorrow({
  person: "Rohan",
  direction: "lent",
  amountCents: 100,
  date: "2026-11-01",
  status: "settled",
  settledDate: "2026-11-15",
});
check("settled record keeps settled date", settled.record.settledDate, "2026-11-15");

const today = "2026-11-20";
const openOverdue = { person: "A", direction: "lent", amountCents: 100000, date: "2026-11-01", dueDate: "2026-11-10", note: "", status: "open", settledDate: null };
const openDueToday = { person: "B", direction: "borrowed", amountCents: 50000, date: "2026-11-19", dueDate: "2026-11-20", note: "", status: "open", settledDate: null };
const settledOverdue = { person: "C", direction: "lent", amountCents: 70000, date: "2026-10-01", dueDate: "2026-10-05", note: "", status: "settled", settledDate: "2026-10-20" };
const openNoDue = { person: "D", direction: "borrowed", amountCents: 30000, date: "2026-11-15", dueDate: null, note: "", status: "open", settledDate: null };
check("open record past due date is overdue", mod.isOverdue(openOverdue, today), true);
check("due today is not overdue", mod.isOverdue(openDueToday, today), false);
check("settled record is never overdue", mod.isOverdue(settledOverdue, today), false);
check("no due date is never overdue", mod.isOverdue(openNoDue, today), false);

check("totals count open only", mod.lendBorrowTotals([openOverdue, openDueToday, settledOverdue, openNoDue], today), {
  owedToMeCents: 100000,
  iOweCents: 80000,
  netCents: 20000,
  openCount: 3,
  overdueCount: 1,
  settledCount: 1,
});

const all = [openOverdue, openDueToday, settledOverdue, openNoDue];
check("direction filter lent", mod.filterLendBorrow(all, { direction: "lent", hideCompleted: false }).length, 2);
check("hide-completed hides settled", mod.filterLendBorrow(all, { direction: "all", hideCompleted: true }).length, 3);
check("direction + hide-completed together", mod.filterLendBorrow(all, { direction: "borrowed", hideCompleted: true }).map((r) => r.person), ["B", "D"]);
check(
  "sort puts overdue first then earliest due date",
  mod.sortLendBorrow([openNoDue, openDueToday, openOverdue], today).map((r) => r.person),
  ["A", "B", "D"],
);

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
if (fail > 0) process.exit(1);
