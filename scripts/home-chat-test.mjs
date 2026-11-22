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
// (17+) effectiveReplyKind: a model "confirm" with a safe add plan
// executes at once (owner's decision, 2026-11-20), with a delete it
// still waits, and a plan on a "chat" reply never executes.
// (18) edit_transaction (owner's report, 2026-11-20 — "1000 nahi,
// 1500 karo" must change the entry, never add a second one): a
// correction normalizes, needs no confirm, executes at once, and
// rejects no-matcher / no-change / bad amounts / bad dates; the
// match date defaults to today and a nested edit plan unwraps.
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
// (17+) effectiveReplyKind — adds execute immediately (owner's decision,
// 2026-11-20), even when the model hedged with kind "confirm"; only
// delete/currency wait; a plan on a "chat" reply never executes.
check(
  'model "confirm" + add_transaction executes at once',
  mod.effectiveReplyKind("confirm", txn.plan),
  "action",
);
check(
  'model "confirm" + delete_transaction still waits',
  mod.effectiveReplyKind("confirm", del.plan),
  "confirm",
);
check(
  'model "action" + add_transaction executes',
  mod.effectiveReplyKind("action", txn.plan),
  "action",
);
check(
  'model "chat" + add_transaction never executes',
  mod.effectiveReplyKind("chat", txn.plan),
  "chat",
);
check(
  'model "confirm" + nested add_transaction executes at once',
  mod.effectiveReplyKind(
    "confirm",
    mod.normalizeHomeChatPlan(
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
    ).plan,
  ),
  "action",
);

// (18) edit_transaction — Sarya's correction: "1000 nahi, 1500 karo"
const edit = mod.normalizeHomeChatPlan(
  {
    kind: "edit_transaction",
    matchType: "expense",
    matchAmountCents: 100000,
    matchCategory: "Food & groceries",
    matchDescription: "",
    matchDate: "2026-11-20",
    amountCents: 150000,
    category: null,
    description: null,
    date: null,
  },
  TODAY,
);
check("edit_transaction normalizes (1000 -> 1500 correction)", edit, {
  ok: true,
  plan: {
    kind: "edit_transaction",
    matchType: "expense",
    matchAmountCents: 100000,
    matchCategory: "Food & groceries",
    matchDescription: "",
    matchDate: "2026-11-20",
    amountCents: 150000,
    category: null,
    description: null,
    date: null,
  },
});
check("edit_transaction does NOT need confirm", mod.planNeedsConfirm(edit.plan), false);
check(
  'model "confirm" + edit_transaction executes at once',
  mod.effectiveReplyKind("confirm", edit.plan),
  "action",
);
check(
  "edit_transaction with no matcher rejected",
  mod.normalizeHomeChatPlan(
    {
      kind: "edit_transaction",
      matchType: "expense",
      matchAmountCents: null,
      matchCategory: null,
      matchDescription: "",
      matchDate: "2026-11-20",
      amountCents: 150000,
    },
    TODAY,
  ).ok,
  false,
);
check(
  "edit_transaction with no change rejected",
  mod.normalizeHomeChatPlan(
    {
      kind: "edit_transaction",
      matchType: "expense",
      matchAmountCents: 100000,
      matchDate: "2026-11-20",
      amountCents: null,
      category: null,
      description: null,
      date: null,
    },
    TODAY,
  ).ok,
  false,
);
check(
  "edit_transaction with zero new amount rejected",
  mod.normalizeHomeChatPlan(
    {
      kind: "edit_transaction",
      matchType: "expense",
      matchAmountCents: 100000,
      matchDate: "2026-11-20",
      amountCents: 0,
    },
    TODAY,
  ).ok,
  false,
);
check(
  "edit_transaction with impossible match date rejected",
  mod.normalizeHomeChatPlan(
    {
      kind: "edit_transaction",
      matchType: "expense",
      matchAmountCents: 100000,
      matchDate: "2026-02-30",
      amountCents: 150000,
    },
    TODAY,
  ).ok,
  false,
);
check(
  "edit_transaction matchDate defaults to today",
  mod.normalizeHomeChatPlan(
    { kind: "edit_transaction", matchType: "expense", matchAmountCents: 100000, amountCents: 150000 },
    TODAY,
  ).plan?.matchDate,
  "2026-11-20",
);
check(
  "edit_transaction matches by category alone",
  mod.normalizeHomeChatPlan(
    { kind: "edit_transaction", matchType: "expense", matchCategory: "Food", amountCents: 150000 },
    TODAY,
  ).ok,
  true,
);
check(
  "nested edit_transaction unwraps",
  mod.normalizeHomeChatPlan(
    {
      edit_transaction: {
        kind: "edit_transaction",
        matchType: "expense",
        matchAmountCents: 100000,
        amountCents: 150000,
      },
    },
    TODAY,
  ).ok,
  true,
);
check(
  "describePlan edit_transaction",
  mod.describePlan(edit.plan, fmt),
  "Edit the expense on 2026-11-20 · Food & groceries · ₹1,000",
);

// (19) normalizeHomeChatReply — Sarya's report, 2026-11-21 00:30 IST:
// three consecutive model answers were thrown away by the strict
// reply schema even though each carried a complete instruction:
// a bare edit plan, and {"kind":"action","plan":{...}} with no reply.
// The normaliser salvages all of them; the plan is still strictly
// validated and never executes on a bad shape.
const bareEdit = mod.normalizeHomeChatReply(
  {
    kind: "edit_transaction",
    matchType: "expense",
    matchAmountCents: 500,
    matchCategory: "food",
    matchDescription: "Food expense",
    matchDate: "2026-11-21",
    amountCents: 300,
    category: "food",
    description: "Food expense",
    date: "2026-11-20",
  },
  "2026-11-21",
  fmt,
);
check("bare edit plan salvaged as action", bareEdit.ok, true);
check("bare edit plan kind", bareEdit.kind, "action");
check("bare edit plan kept", bareEdit.plan?.kind, "edit_transaction");
check("bare edit plan reply generated", bareEdit.reply, "Edit the expense on 2026-11-21 · food · ₹5");
const envelopeAdd = mod.normalizeHomeChatReply(
  {
    kind: "action",
    plan: {
      kind: "add_transaction",
      type: "income",
      amountCents: 2100000,
      category: "income",
      description: "Income for the month",
      counterparty: "unknown",
      date: "2026-11-22",
    },
  },
  "2026-11-21",
  fmt,
);
check("envelope add without reply salvaged", envelopeAdd.ok, true);
check("envelope add kind", envelopeAdd.kind, "action");
check(
  "envelope add reply generated",
  envelopeAdd.reply,
  "Add income ₹21,000 · income · Income for the month · 2026-11-22",
);
const envelopeEdit = mod.normalizeHomeChatReply(
  {
    kind: "action",
    plan: {
      kind: "edit_transaction",
      matchType: "expense",
      matchAmountCents: 500,
      matchCategory: "food",
      matchDescription: "Food expense",
      matchDate: "2026-11-21",
      amountCents: 300,
      category: "food",
      description: "Food expense",
      date: "2026-11-21",
    },
  },
  "2026-11-21",
  fmt,
);
check("envelope edit without reply salvaged", envelopeEdit.ok, true);
check("envelope edit kind", envelopeEdit.kind, "action");
check(
  "envelope edit plan kept",
  envelopeEdit.plan,
  {
    kind: "edit_transaction",
    matchType: "expense",
    matchAmountCents: 500,
    matchCategory: "food",
    matchDescription: "Food expense",
    matchDate: "2026-11-21",
    amountCents: 300,
    category: "food",
    description: "Food expense",
    date: "2026-11-21",
  },
);
const envelopeDelete = mod.normalizeHomeChatReply(
  {
    kind: "confirm",
    plan: { kind: "delete_transaction", type: "expense", amountCents: 50000, date: "2026-11-20", description: "food" },
  },
  "2026-11-21",
  fmt,
);
check("envelope delete without reply salvaged", envelopeDelete.ok, true);
check("envelope delete kind", envelopeDelete.kind, "confirm");
check(
  "envelope delete reply is a proposal",
  envelopeDelete.reply,
  "Shall I delete the expense of ₹500 on 2026-11-20 (food)?",
);
check(
  "envelope delete question filled from reply",
  envelopeDelete.question,
  "Shall I delete the expense of ₹500 on 2026-11-20 (food)?",
);
check(
  "double-nested plan in envelope unwraps",
  mod.normalizeHomeChatReply(
    {
      kind: "action",
      plan: {
        add_transaction: {
          kind: "add_transaction",
          type: "expense",
          amountCents: 50000,
          category: "Food",
          date: "2026-11-21",
        },
      },
    },
    "2026-11-21",
    fmt,
  ).plan?.kind,
  "add_transaction",
);
check(
  "reply alias 'answer' used when reply missing",
  mod.normalizeHomeChatReply({ kind: "chat", answer: "You have ₹1,000 left." }, "2026-11-21", fmt).reply,
  "You have ₹1,000 left.",
);
check(
  "one-level answer wrapper unwraps",
  mod.normalizeHomeChatReply({ answer: { kind: "chat", reply: "hi there" } }, "2026-11-21", fmt).reply,
  "hi there",
);
check(
  "normal shape unchanged",
  mod.normalizeHomeChatReply(
    { kind: "chat", reply: "Hello!", question: null, plan: null },
    "2026-11-21",
    fmt,
  ),
  { ok: true, kind: "chat", reply: "Hello!", question: null, plan: null, planError: null },
);
check("null reply rejected", mod.normalizeHomeChatReply(null, "2026-11-21", fmt).ok, false);
check(
  "action without plan downgrades to chat",
  mod.normalizeHomeChatReply({ kind: "action", reply: "Done-ish" }, "2026-11-21", fmt).kind,
  "chat",
);
const badPlan = mod.normalizeHomeChatReply(
  { kind: "action", plan: { kind: "add_transaction", type: "expense", amountCents: 0, category: "Food", date: "2026-11-21" } },
  "2026-11-21",
  fmt,
);
check("invalid plan in envelope is not executed", badPlan.plan, null);
check("invalid plan in envelope reports the error", badPlan.planError, "Transaction needs a positive amount.");

// (20) Forgiving normaliser — Sarya's report, 2026-11-22 13:38 IST:
// "food expense 500" failed twice with "I couldn't pin down the
// details". The model omits the date and sometimes writes the amount
// in rupees ("amount") instead of paise ("amountCents"). A missing
// date now defaults to today and the rupee alias is accepted.
check(
  "add_transaction missing date defaults to today",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: 50000, category: "Food" },
    TODAY,
  ).plan?.date,
  TODAY,
);
check(
  "add_transaction rupee amount alias accepted",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amount: 500, category: "Food", date: "2026-11-20" },
    TODAY,
  ).plan?.amountCents,
  50000,
);
check(
  "add_transaction amountCents wins over amount alias",
  mod.normalizeHomeChatPlan(
    { kind: "add_transaction", type: "expense", amountCents: 30000, amount: 500, category: "Food", date: "2026-11-20" },
    TODAY,
  ).plan?.amountCents,
  30000,
);
check(
  "deposit_savings missing date defaults to today",
  mod.normalizeHomeChatPlan(
    { kind: "deposit_savings", goalName: "Home Fund", amountCents: 100000 },
    TODAY,
  ).plan?.date,
  TODAY,
);
check(
  "add_budget monthlyLimit alias accepted",
  mod.normalizeHomeChatPlan({ kind: "add_budget", category: "Food", monthlyLimit: 5000 }, TODAY).plan
    ?.monthlyLimitCents,
  500000,
);
check(
  "add_savings_goal still needs a real target date",
  mod.normalizeHomeChatPlan(
    { kind: "add_savings_goal", name: "Home Fund", targetCents: 1000000 },
    TODAY,
  ).ok,
  false,
);

// (21) Deterministic rule fallback — same report: when the model
// gives nothing usable, the simplest spoken requests still work.
check(
  "simple 'food expense 500' parses",
  mod.parseSimpleHomeChatCommand("food expense 500", TODAY),
  {
    kind: "add_transaction",
    type: "expense",
    amountCents: 50000,
    category: "Food & groceries",
    description: "food expense 500",
    counterparty: "",
    date: TODAY,
  },
);
check(
  "simple 'food expense 300' parses",
  mod.parseSimpleHomeChatCommand("food expense 300", TODAY)?.amountCents,
  30000,
);
check(
  "simple 'kal income ayegi 21k' is tomorrow's income",
  mod.parseSimpleHomeChatCommand("kal income ayegi 21k", TODAY),
  {
    kind: "add_transaction",
    type: "income",
    amountCents: 2100000,
    category: "General",
    description: "kal income ayegi 21k",
    counterparty: "",
    date: "2026-11-21",
  },
);
check(
  "simple 'kal kharcha 500' is yesterday's expense",
  mod.parseSimpleHomeChatCommand("kal kharcha 500", TODAY)?.date,
  "2026-11-19",
);
check(
  "simple 'Add 1500 for shopping' parses",
  mod.parseSimpleHomeChatCommand("Add ₹1,500 for shopping", TODAY)?.amountCents,
  150000,
);
check("simple question returns null", mod.parseSimpleHomeChatCommand("How much money do I have?", TODAY), null);
check("simple no-amount returns null", mod.parseSimpleHomeChatCommand("food expense", TODAY), null);
check("simple delete returns null", mod.parseSimpleHomeChatCommand("delete the 500 food expense", TODAY), null);
check(
  "simple correction returns null",
  mod.parseSimpleHomeChatCommand("change the 500 food expense to 700", TODAY),
  null,
);
check(
  "simple '1000 nahi, 1500 karo' returns null",
  mod.parseSimpleHomeChatCommand("1000 nahi, 1500 karo", TODAY),
  null,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
