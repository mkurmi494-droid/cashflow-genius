// Regression test for the Proactive Financial Insights Engine
// (server/lib/insights.ts). Transpiles the real TS source with the
// repo's own TypeScript (transpile-only, no typecheck) and asserts
// each rule fires / does not fire from sample rows — no mocks of the
// rules themselves. "Today" is pinned to 2026-11-18 so month-to-date
// comparisons are deterministic.
// Run: node scripts/insights-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-insights-test-"));

const TODAY = "2026-11-18";
// Amounts in paise. ₹1,000 = 100_000, ₹500 = 50_000, ₹2,000 = 200_000.
const rs = (n) => n * 100;

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};
const checkDeep = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};

try {
  const src = readFileSync(join(repo, "server", "lib", "insights.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "insights.ts",
  }).outputText;
  writeFileSync(join(out, "insights.js"), js);
  const { detectInsights, confidenceLabel, formatINR, todayStrIst, formatDateShort } = require(join(out, "insights.js"));

  const txn = (id, type, category, amount, date, extra = {}) => ({
    id,
    type,
    status: extra.status ?? "posted",
    category,
    description: extra.description ?? category,
    counterparty: extra.counterparty ?? "",
    amountCents: amount,
    date,
  });
  const base = (overrides = {}) => ({
    openingBalanceCents: 0,
    savedCents: 0,
    transactions: [],
    invoices: [],
    recurring: [],
    emiInstalments: [],
    today: TODAY,
    ...overrides,
  });
  const ofType = (insights, type) => insights.find((i) => i.type === type);
  const types = (insights) => insights.map((i) => i.type);

  // ---------- spending_spike ----------
  // Food: Aug ₹9,000 / Sep ₹9,500 / Oct ₹9,700 (MTD, days ≤ 18) → avg ₹9,400.
  // Nov MTD ₹12,400 → +32%, excess ₹3,000 → fires.
  const foodHistory = [
    txn("f1", "expense", "Food", rs(9000), "2026-08-10"),
    txn("f2", "expense", "Food", rs(9500), "2026-09-10"),
    txn("f3", "expense", "Food", rs(9700), "2026-10-10"),
  ];
  let ins = detectInsights(base({ transactions: [...foodHistory, txn("f4", "expense", "Food", rs(12400), "2026-11-10")] }));
  let spike = ofType(ins, "spending_spike");
  check("spike fires", !!spike, true);
  check("spike pctAbove", spike?.evidence.pctAbove, 32);
  check("spike currentMonthCents", spike?.evidence.currentMonthCents, rs(12400));
  check("spike avgMonthCents", spike?.evidence.avgMonthCents, rs(9400));
  check("spike severity", spike?.severity, "warning");
  check("spike key carries month", spike?.insightKey, "spending_spike:Food:2026-11");
  check("spike title has real number", spike?.title.includes("32%"), true);

  // Same history, Nov ₹10,000 → +6% → no spike.
  ins = detectInsights(base({ transactions: [...foodHistory, txn("f4", "expense", "Food", rs(10000), "2026-11-10")] }));
  check("spike does not fire within 30%", ofType(ins, "spending_spike"), undefined);

  // Only one prior month of history → not enough data, no spike.
  ins = detectInsights(base({ transactions: [txn("f3", "expense", "Food", rs(9700), "2026-10-10"), txn("f4", "expense", "Food", rs(12400), "2026-11-10")] }));
  check("spike does not fire with 1 prior month", ofType(ins, "spending_spike"), undefined);

  // Excess below ₹1,000 does not fire even at a high percentage:
  // avg ₹400, current ₹600 → +50% but only ₹200 more.
  ins = detectInsights(base({
    transactions: [
      txn("s1", "expense", "Snacks", rs(400), "2026-08-05"),
      txn("s2", "expense", "Snacks", rs(400), "2026-09-05"),
      txn("s3", "expense", "Snacks", rs(400), "2026-10-05"),
      txn("s4", "expense", "Snacks", rs(600), "2026-11-05"),
    ],
  }));
  check("spike does not fire below ₹1,000 excess", ofType(ins, "spending_spike"), undefined);

  // ---------- income_drop ----------
  const salaryHistory = [
    txn("i1", "income", "Salary", rs(50000), "2026-08-05"),
    txn("i2", "income", "Salary", rs(50000), "2026-09-05"),
    txn("i3", "income", "Salary", rs(50000), "2026-10-05"),
  ];
  ins = detectInsights(base({ transactions: [...salaryHistory, txn("i4", "income", "Salary", rs(30000), "2026-11-05")] }));
  const drop = ofType(ins, "income_drop");
  check("income_drop fires", !!drop, true);
  check("income_drop pctBelow", drop?.evidence.pctBelow, 40);
  check("income_drop shortfallCents", drop?.evidence.shortfallCents, rs(20000));

  ins = detectInsights(base({ transactions: [...salaryHistory, txn("i4", "income", "Salary", rs(48000), "2026-11-05")] }));
  check("income_drop does not fire when normal", ofType(ins, "income_drop"), undefined);

  // Zero income this month against a ₹50,000 average → critical.
  ins = detectInsights(base({ transactions: salaryHistory }));
  const dropZero = ofType(ins, "income_drop");
  check("income_drop zero income fires critical", dropZero?.severity, "critical");

  // ---------- unusual_transaction ----------
  // Grocery history: 8 expenses ₹700–₹1,200 (median ₹900).
  const groceryPeers = [700, 800, 850, 900, 900, 1000, 1100, 1200].map((amt, i) =>
    txn(`g${i}`, "expense", "Groceries", rs(amt), `2026-09-${String(2 + i).padStart(2, "0")}`),
  );
  ins = detectInsights(base({ transactions: [...groceryPeers, txn("g-big", "expense", "Groceries", rs(6500), "2026-11-15", { description: "Big bazaar run" })] }));
  const unusual = ofType(ins, "unusual_transaction");
  check("unusual fires", !!unusual, true);
  check("unusual medianCents", unusual?.evidence.medianCents, rs(900));
  check("unusual multiple", unusual?.evidence.multiple, 7.2);
  check("unusual key is per transaction", unusual?.insightKey, "unusual_transaction:g-big");

  // ₹1,500 is below the ₹2,000 floor → no fire, even at 1.7x median.
  ins = detectInsights(base({ transactions: [...groceryPeers, txn("g-mid", "expense", "Groceries", rs(1500), "2026-11-15")] }));
  check("unusual does not fire below ₹2,000 floor", ofType(ins, "unusual_transaction"), undefined);

  // A normal ₹1,000 grocery run → no fire.
  ins = detectInsights(base({ transactions: [...groceryPeers, txn("g-ok", "expense", "Groceries", rs(1000), "2026-11-15")] }));
  check("unusual does not fire for a normal payment", ofType(ins, "unusual_transaction"), undefined);

  // Fewer than 5 peers → cannot judge, no fire.
  ins = detectInsights(base({ transactions: [
    txn("h1", "expense", "Hardware", rs(800), "2026-10-02"),
    txn("h2", "expense", "Hardware", rs(900), "2026-10-09"),
    txn("h3", "expense", "Hardware", rs(6500), "2026-11-15"),
  ] }));
  check("unusual does not fire with <5 peers", ofType(ins, "unusual_transaction"), undefined);

  // ---------- recurring_payment ----------
  const netflix = (id, date) => txn(id, "expense", "Entertainment", rs(499), date, { counterparty: "Netflix" });
  ins = detectInsights(base({ transactions: [netflix("n1", "2026-09-05"), netflix("n2", "2026-10-05"), netflix("n3", "2026-11-05")] }));
  const rec = ofType(ins, "recurring_payment");
  check("recurring fires for 3 consecutive months", !!rec, true);
  check("recurring months", rec?.evidence.months, 3);
  check("recurring amountCents", rec?.evidence.amountCents, rs(499));
  check("recurring severity is info", rec?.severity, "info");

  // Only 2 months → no fire.
  ins = detectInsights(base({ transactions: [netflix("n2", "2026-10-05"), netflix("n3", "2026-11-05")] }));
  check("recurring does not fire for 2 months", ofType(ins, "recurring_payment"), undefined);

  // Run ended two months ago (Jul–Sep, latest Sep) → stale, no fire.
  ins = detectInsights(base({ transactions: [netflix("n1", "2026-07-05"), netflix("n2", "2026-08-05"), netflix("n3", "2026-09-05")] }));
  check("recurring does not fire for a stale run", ofType(ins, "recurring_payment"), undefined);

  // A gap month breaks the run (Sep + Nov, no Oct) → no fire.
  ins = detectInsights(base({ transactions: [netflix("n1", "2026-09-05"), netflix("n3", "2026-11-05"), netflix("n4", "2026-11-06")] }));
  check("recurring does not fire across a gap month", ofType(ins, "recurring_payment"), undefined);

  // ---------- invoice_risk ----------
  const inv = (id, number, status, dueDate, total) => ({ id, number, customerName: "Acme", status, dueDate, totalCents: total });
  ins = detectInsights(base({
    openingBalanceCents: rs(100000),
    invoices: [
      inv("v1", "INV-1", "sent", "2026-10-20", rs(10000)),
      inv("v2", "INV-2", "sent", "2026-11-25", rs(5000)),
      inv("v3", "INV-3", "paid", "2026-10-01", rs(7000)),
      inv("v4", "INV-4", "draft", "2026-11-30", rs(9000)),
    ],
  }));
  const risk = ofType(ins, "invoice_risk");
  check("invoice_risk fires", !!risk, true);
  check("invoice_risk unpaidCents (sent only)", risk?.evidence.unpaidCents, rs(15000));
  check("invoice_risk unpaidCount", risk?.evidence.unpaidCount, 2);
  check("invoice_risk overdueCount", risk?.evidence.overdueCount, 1);
  check("invoice_risk oldestOverdueDays", risk?.evidence.oldestOverdueDays, 29);
  check("invoice_risk severity critical when overdue", risk?.severity, "critical");

  ins = detectInsights(base({ openingBalanceCents: rs(100000), invoices: [inv("v3", "INV-3", "paid", "2026-10-01", rs(7000))] }));
  check("invoice_risk does not fire when nothing unpaid", ofType(ins, "invoice_risk"), undefined);

  // ---------- cash_shortage ----------
  // ₹10,000 cash, ₹20,000 rent due 25 Nov → min −₹10,000 on 25 Nov.
  ins = detectInsights(base({
    openingBalanceCents: rs(10000),
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
  }));
  const shortage = ofType(ins, "cash_shortage");
  check("cash_shortage fires", !!shortage, true);
  check("cash_shortage minBalanceCents", shortage?.evidence.minBalanceCents, -rs(10000));
  check("cash_shortage minDate", shortage?.evidence.minDate, "2026-11-25");
  check("cash_shortage severity critical below zero", shortage?.severity, "critical");
  check("cash_shortage description says estimate", shortage?.description.includes("estimate"), true);
  check("cash_shortage below-zero title", shortage?.title, "Cash is estimated to go below zero — −₹10,000 on 25 Nov 2026");

  // A real decline above zero still says "fall" — with a readable date:
  // ₹10,000 cash, ₹6,000 rent on 25 Nov → min ₹4,000 on 25 Nov.
  ins = detectInsights(base({
    openingBalanceCents: rs(10000),
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(6000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
  }));
  const fall = ofType(ins, "cash_shortage");
  check("cash_shortage decline title says fall", fall?.title, "Cash is estimated to fall to ₹4,000 on 25 Nov 2026");
  check("cash_shortage decline description keeps estimate", fall?.description.includes("estimate"), true);

  // LIVE SCENARIO (19 Nov 2026, Business): ₹3,440 cash, ₹8,20,000
  // expected in, ₹0 scheduled out. The cash does NOT fall — it sits
  // at ₹3,440 until the collection lands — so the copy must never say
  // "fall", and the low date must be the IST today (19 Nov), never
  // yesterday's UTC date (18 Nov).
  const live = base({
    today: "2026-11-19",
    openingBalanceCents: rs(3440),
    invoices: [inv("v-live", "INV-LIVE", "sent", "2026-11-24", rs(820000))],
  });
  ins = detectInsights(live);
  const liveShortage = ofType(ins, "cash_shortage");
  check("live scenario: cash_shortage fires", !!liveShortage, true);
  check("live scenario: title never says fall", liveShortage?.title.includes("fall"), false);
  check("live scenario: description never says fall", liveShortage?.description.includes("fall"), false);
  check("live scenario: title says stays at", liveShortage?.title, "Cash stays at ₹3,440 until ₹8,20,000 is expected on 24 Nov 2026");
  check("live scenario: low date is the IST today", liveShortage?.evidence.minDate, "2026-11-19");
  check("live scenario: first inflow date recorded", liveShortage?.evidence.firstInflowDate, "2026-11-24");
  check("live scenario: first inflow amount recorded", liveShortage?.evidence.firstInflowCents, rs(820000));
  check("live scenario: expected in/out", `${liveShortage?.evidence.expectedInCents}/${liveShortage?.evidence.expectedOutCents}`, `${rs(820000)}/0`);
  check("live scenario: severity warning", liveShortage?.severity, "warning");

  // Same live scenario with no `today` passed: the engine's default
  // must be the Asia/Kolkata date, not the UTC date. (Kolkata is a
  // fixed +05:30 with no DST, so the expected date is computed here
  // with plain UTC arithmetic, independent of the Intl path.)
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const wantIst = istNow.toISOString().slice(0, 10);
  check("todayStrIst returns the Asia/Kolkata date", todayStrIst(), wantIst);
  check("formatDateShort", formatDateShort("2026-11-18"), "18 Nov 2026");
  const liveNoToday = { ...live };
  delete liveNoToday.today;
  ins = detectInsights(liveNoToday);
  check("live scenario without today: low date is the IST date", ofType(ins, "cash_shortage")?.evidence.minDate, wantIst);

  // Cash below the floor with nothing scheduled at all: no inflow to
  // wait for, so the honest line is that it just stays there.
  ins = detectInsights(base({ openingBalanceCents: rs(3440) }));
  const flat = ofType(ins, "cash_shortage");
  check("flat cash: fires", !!flat, true);
  check("flat cash: title says stays, never fall", flat?.title, "Cash stays at ₹3,440 with nothing scheduled in or out for 30 days");
  check("flat cash: description says nothing scheduled", flat?.description.includes("nothing is scheduled in or out"), true);

  // ₹50,000 cash, same rent → min ₹30,000 → no fire.
  ins = detectInsights(base({
    openingBalanceCents: rs(50000),
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
  }));
  check("cash_shortage does not fire when balance stays above floor", ofType(ins, "cash_shortage"), undefined);

  // An overdue invoice landing in 3 days saves the month:
  // ₹10,000 cash, ₹20,000 rent on 25 Nov, ₹25,000 invoice overdue → +₹25,000 on 21 Nov.
  ins = detectInsights(base({
    openingBalanceCents: rs(10000),
    invoices: [inv("v1", "INV-1", "sent", "2026-10-20", rs(25000))],
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
  }));
  check("cash_shortage clears when an overdue invoice lands first", ofType(ins, "cash_shortage"), undefined);

  // A pending EMI instalment to collect counts as inflow: ₹10,000
  // cash, ₹15,000 rent on 25 Nov would go to −₹5,000 — but a ₹10,000
  // instalment landing on 20 Nov keeps the low at exactly ₹5,000.
  ins = detectInsights(base({
    openingBalanceCents: rs(10000),
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(15000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
    emiInstalments: [{ id: "e1", dueDate: "2026-11-20", amountCents: rs(10000), status: "pending" }],
  }));
  check("cash_shortage counts EMI collection as inflow", ofType(ins, "cash_shortage"), undefined);
  // Same month without the instalment → the shortage fires.
  ins = detectInsights(base({
    openingBalanceCents: rs(10000),
    recurring: [{ id: "r1", type: "expense", category: "Rent", description: "Rent", amountCents: rs(15000), frequency: "monthly", nextDate: "2026-11-25", active: true }],
  }));
  check("cash_shortage fires without the EMI inflow", !!ofType(ins, "cash_shortage"), true);

  // ---------- profit_leak / savings_opportunity ----------
  // Transport: Oct MTD ₹5,000 → Nov MTD ₹7,000 → +40%, +₹2,000 → leak.
  // Dining: Oct MTD ₹8,000 → Nov MTD ₹5,000 → saved ₹3,000 → opportunity.
  ins = detectInsights(base({
    transactions: [
      txn("t1", "expense", "Transport", rs(5000), "2026-10-10"),
      txn("t2", "expense", "Transport", rs(7000), "2026-11-10"),
      txn("d1", "expense", "Dining", rs(8000), "2026-10-10"),
      txn("d2", "expense", "Dining", rs(5000), "2026-11-10"),
    ],
  }));
  const leak = ofType(ins, "profit_leak");
  check("profit_leak fires", !!leak, true);
  check("profit_leak pctIncrease", leak?.evidence.pctIncrease, 40);
  const saving = ofType(ins, "savings_opportunity");
  check("savings_opportunity fires", !!saving, true);
  check("savings_opportunity savedCents", saving?.evidence.savedCents, rs(3000));
  check("savings_opportunity severity is info", saving?.severity, "info");

  // ---------- empty workspace / hygiene ----------
  ins = detectInsights(base({}));
  checkDeep("empty workspace produces zero insights", types(ins), []);
  check("empty workspace: no cash_shortage false alarm", ofType(ins, "cash_shortage"), undefined);

  // Keys are unique within one run (no duplicates).
  ins = detectInsights(base({
    transactions: [
      ...foodHistory,
      txn("f4", "expense", "Food", rs(12400), "2026-11-10"),
      ...groceryPeers,
      txn("g-big", "expense", "Groceries", rs(6500), "2026-11-15"),
    ],
    invoices: [inv("v1", "INV-1", "sent", "2026-10-20", rs(10000))],
  }));
  const keys = ins.map((i) => i.insightKey);
  check("insight keys unique in one run", new Set(keys).size, keys.length);
  check("critical sorts before warning/info", ins[0]?.severity, "critical");

  // ---------- helpers ----------
  check("confidenceLabel 90 → high", confidenceLabel(90), "high");
  check("confidenceLabel 65 → medium", confidenceLabel(65), "medium");
  check("confidenceLabel 30 → low", confidenceLabel(30), "low");
  check("formatINR whole rupees", formatINR(125400), "₹1,254");
  check("formatINR Indian grouping", formatINR(12540000), "₹1,25,400");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  rmSync(out, { recursive: true, force: true });
}
