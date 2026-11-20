// Home AI chat plan tests for server/lib/homeChat.ts (pure).
// Proves: (1) a valid add_transaction normalizes, (2) "kal"/"aaj"/
// "parson" resolve to yesterday/today/tomorrow, (3) an impossible
// date is rejected, (4) zero/negative/over-ceiling amounts are
// rejected, (5) add_budget normalizes, (6) add_savings_goal
// normalizes, (7) deposit_savings normalizes, (8) add_lend_borrow
// normalizes with a null due date, (9) an empty note is rejected,
// (10) add_recurring normalizes and a bad frequency is rejected,
// (11) delete_transaction normalizes and needs confirm, (12)
// change_currency normalizes and needs confirm, and a bad currency
// is rejected, (13) add_transaction does NOT need confirm,
// (14) an unknown plan kind is rejected, (15) a non-object plan is
// rejected, (16) describePlan writes a plain-language line.
// Run: node scripts/home-chat-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(import.meta.url), "..", "..");
const out = mkdtempSync(join(tmpdir(), "home-chat-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
};

const src = readFileSync(join(repo, "server/lib/homeChat.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "homeChat.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);
rmSync(out, { recursive: true, force: true });

const TODAY = "2026-11-20";
const fmt = (c) => `₹${(c / 100).toLocaleString("en-IN")}`;

const txn = mod.normalizeHomeChatPlan(
  {
    kind: "add_transaction",
    type: "expense",
    amountCents: 50000,
    category: "  Food & groceries  ",
    description: "dinner",
    counterparty: "",
    date: "2026-11-20",
  },
  TODAY,
);
check("valid add_transaction normalizes", txn, {
  ok: true,
  plan: {
    kind: "add_transaction",
    type: "expense",
    amountCents: 50000,
    category: "Food & groceries",
    description: "dinner",
    counterparty: "",
    date: "2026-11-20",
  },
});

check("kal resolves to yesterday", mod.resolveChatDate("kal", TODAY), "2026-11-19");
check("aaj resolves to today", mod.resolveChatDate("aaj", TODAY), "2026-11-20");
check("parson resolves to tomorrow", mod.resolveChatDate("parson", TODAY), "2026-11-21");
check("impossible date rejected", mod.resolveChatDate("2026-02-30", TODAY), null);
check(
  "add_transaction with kal date normalizes",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: 100, category: "Food", date: "kal" },
    TODAY,
  ).plan?.date,
  "2026-11-19",
);
check(
  "zero amount rejected",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: 0, category: "Food", date: "2026-11-20" },
    TODAY,
  ).ok,
  false,
);
check(
  "negative amount rejected",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: -5, category: "Food", date: "2026-11-20" },
    TODAY,
  ).ok,
  false,
);
check(
  "over-ceiling amount rejected",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: 100_000_000_01, category: "Food", date: "2026-11-20" },
    TODAY,
  ).ok,
  false,
);
check(
  "add_budget normalizes",
  mod.normalizeHomeChatPlan(
    { kind: "add_budget", category: "Food & groceries", monthlyLimitCents: 500000 },
    TODAY,
  ),
  { ok: true, plan: { kind: "add_budget", category: "Food & groceries", monthlyLimitCents: 500000 } },
);
check(
  "add_savings_goal normalizes",
  mod.normalizeHomeChatPlan(
    { kind: "add_savings_goal", name: "Goa trip", targetCents: 1000000, targetDate: "2027-05-18" },
    TODAY,
  ).ok,
  true,
);
check(
  "deposit_savings normalizes",
  mod.normalizeHomeChatPlan(
    { kind: "deposit_savings", goalName: "Emergency", amountCents: 50000, date: "2026-11-20" },
    TODAY,
  ).ok,
  true,
);
check(
  "add_lend_borrow normalizes with null due date",
  mod.normalizeHomeChatPlan(
    { kind: "add_lend_borrow", direction: "lent", person: "Rohan", amountCents: 100000, date: "2026-11-20", dueDate: null, note: "" },
    TODAY,
  ),
  {
    ok: true,
    plan: {
      kind: "add_lend_borrow",
      direction: "lent",
      person: "Rohan",
      amountCents: 100000,
      date: "2026-11-20",
      dueDate: null,
      note: "",
    },
  },
);
check(
  "empty note rejected",
  mod.normalizeHomeChatPlan({ kind: "add_note", text: "   " }, TODAY).ok,
  false,
);
check(
  "add_recurring normalizes",
  mod.normalizeHomeChatPlan(
    { kind: "add_recurring", type: "expense", category: "Rent", description: "", amountCents: 1500000, frequency: "monthly", nextDate: "2026-12-01" },
    TODAY,
  ).ok,
  true,
);
check(
  "add_recurring bad frequency rejected",
  mod.normalizeHomeChatPlan(
    { kind: "add_recurring", type: "expense", category: "Rent", amountCents: 1500000, frequency: "daily", nextDate: "2026-12-01" },
    TODAY,
  ).ok,
  false,
);
const del = mod.normalizeHomeChatPlan(
  { kind: "delete_transaction", type: "expense", amountCents: 50000, date: "2026-11-19", description: "dinner" },
  TODAY,
);
check("delete_transaction normalizes", del.ok, true);
check("delete_transaction needs confirm", mod.planNeedsConfirm(del.plan), true);
const cur = mod.normalizeHomeChatPlan({ kind: "change_currency", currency: "usd" }, TODAY);
check("change_currency normalizes (lowercase in)", cur, {
  ok: true,
  plan: { kind: "change_currency", currency: "USD" },
});
check("change_currency needs confirm", mod.planNeedsConfirm(cur.plan), true);
check(
  "bad currency rejected",
  mod.normalizeHomeChatPlan({ kind: "change_currency", currency: "XXX" }, TODAY).ok,
  false,
);
check(
  "add_transaction does NOT need confirm",
  mod.planNeedsConfirm(txn.plan),
  false,
);
check("unknown kind rejected", mod.normalizeHomeChatPlan({ kind: "teleport_money" }, TODAY).ok, false);
check("non-object plan rejected", mod.normalizeHomeChatPlan("hello", TODAY).ok, false);
// (17) nested plan: the model sometimes wraps the plan in a key named
// after its kind — plan: {"add_transaction": {...}} (live, 2026-11-20).
// The unwrap must recover the inner plan, including for confirm kinds.
const nestedTxn = mod.normalizeHomeChatPlan(
  {
    add_transaction: {
      kind: "add_transaction",
      type: "expense",
      amountCents: 50000,
      category: "Food",
      description: "Food expense",
      counterparty: "N/A",
      date: "2026-11-20",
    },
  },
  TODAY,
);
check("nested add_transaction unwraps", nestedTxn, {
  ok: true,
  plan: {
    kind: "add_transaction",
    type: "expense",
    amountCents: 50000,
    category: "Food",
    description: "Food expense",
    counterparty: "N/A",
    date: "2026-11-20",
  },
});
check(
  "nested delete_transaction unwraps and needs confirm",
  mod.planNeedsConfirm(
    mod.normalizeHomeChatPlan(
      {
        delete_transaction: {
          kind: "delete_transaction",
          type: "expense",
          amountCents: 50000,
          date: "2026-11-20",
          description: "food",
        },
      },
      TODAY,
    ).plan,
  ),
  true,
);
check(
  "two-key wrapper rejected (not a single-kind nest)",
  mod.normalizeHomeChatPlan(
    { add_transaction: { kind: "add_transaction" }, add_budget: { kind: "add_budget" } },
    TODAY,
  ).ok,
  false,
);
check(
  "describePlan add_transaction",
  mod.describePlan(txn.plan, fmt),
  "Add expense ₹500 · Food & groceries · dinner · 2026-11-20",
);
check(
  "describePlan change_currency",
  mod.describePlan(cur.plan, fmt),
  "Change this workspace's currency to USD (every amount converts at the live rate)",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
