// End-to-end test for currency conversion on updateBusiness.
// Runs against the production build (next start) with a local
// PostgreSQL database — real /api/<action> calls, no mocks. The
// server must already be running with DATABASE_URL pointed at a
// database carrying migrations 0000-0004:
//   set -a; source .env.e2e.local; set +a
//   DATABASE_URL=$DATABASE_URL npx next start -p 3100
// Run: CG_E2E_PG_PASSWORD=$CG_E2E_PG_PASSWORD BASE_URL=http://127.0.0.1:3100 node scripts/currency-e2e-test.mjs
//   (both values live in .env.e2e.local, gitignored — never commit it)
// Exit 1 on any failure. The test user is created fresh each run.
//
// What it proves: converting Business INR → USD converts EVERY money
// column in that workspace (opening balance, transactions, invoice
// items, recurring schedules, budgets, EMI plans + instalments,
// savings goals + transfers) to round(old × live rate) within ±1 minor
// unit, updates the currency label, reports the conversion, drops the
// insights run row (but keeps insight rows), leaves the Personal
// workspace untouched, is a no-op for a same-currency save, and leaves
// everything untouched when the rate cannot be fetched (bad currency).
import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const PG_PW = process.env.CG_E2E_PG_PASSWORD;
if (!PG_PW) {
  console.error("CG_E2E_PG_PASSWORD is not set — see the header of this file for the run command.");
  process.exit(1);
}
const PSQL = `PGPASSWORD=${PG_PW} psql -U cg_e2e -h 127.0.0.1 -d cg_insights`;
const USER_ID = "e2e-currency-user";
const TOKEN = "e2e-currency-token-0123456789abcdef";

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
const checkClose = (name, actual, expected) => {
  // SQL ROUND (halves away from zero) vs JS Math.round (halves toward
  // +∞) can differ by 1 minor unit on an exact .5 — tolerate ±1.
  const ok = Math.abs(actual - expected) <= 1;
  if (ok) {
    pass++;
    console.log(`PASS  ${name} (got ${actual}, want ${expected} ±1)`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${actual}, want ${expected} ±1`);
  }
};
const sql = (q) => execSync(`${PSQL} -c ${JSON.stringify(q)}`, { stdio: "pipe" }).toString();
// Values only, one per line (-t -A): no headers to parse.
const sqlVals = (q) =>
  execSync(`${PSQL} -t -A -c ${JSON.stringify(q)}`, { stdio: "pipe" })
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
const sqlOne = (q) => sqlVals(q)[0];
const call = async (action, body = {}) => {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token: TOKEN }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${action} → ${res.status}: ${data?.error ?? "no error body"}`);
  return data;
};
const callExpectError = async (action, body = {}) => {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token: TOKEN }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, error: data?.error ?? null };
};
// Amounts in paise. ₹1,000 = 100_000.
const rs = (n) => n * 100;

try {
  // ---- setup: fresh user + session, empty workspaces ----
  for (const q of [
    `DELETE FROM financial_insights WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM financial_insight_runs WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM auth_sessions WHERE user_id = '${USER_ID}'`,
    `DELETE FROM transactions WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_id = '${USER_ID}')`,
    `DELETE FROM invoices WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM recurring_cashflows WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM budgets WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM emi_instalments WHERE plan_id IN (SELECT id FROM emi_plans WHERE owner_id = '${USER_ID}')`,
    `DELETE FROM emi_plans WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM savings_transfers WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM savings_goals WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM activity_logs WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM businesses WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM user_workspace_state WHERE owner_id = '${USER_ID}'`,
    `DELETE FROM auth_users WHERE id = '${USER_ID}'`,
  ]) {
    sql(q);
  }
  sql(
    `INSERT INTO auth_users (id, identifier, channel, password_hash, password_salt, verified) ` +
      `VALUES ('${USER_ID}', 'e2e-currency@cashflow-genius.local', 'email', 'x', 'y', 1)`,
  );
  sql(
    `INSERT INTO auth_sessions (token, user_id, active, expires_at) ` +
      `VALUES ('${TOKEN}', '${USER_ID}', 1, ${Date.now() + 24 * 3600 * 1000})`,
  );
  // First getState creates the Business workspace.
  const state = await call("getState");
  check("getState creates business workspace", state.activeMode, "business");
  check("fresh workspace starts in INR", state.business.currency, "INR");

  // ---- seed Business in INR (same-currency save = no conversion) ----
  let res = await call("updateBusiness", {
    mode: "business", name: "Test Business", industry: "", country: "India", currency: "INR",
    openingBalanceCents: rs(10000), timezone: "Asia/Kolkata", ownerName: "", ownerEmail: "", ownerPhone: "",
    gstRateBp: 1800, gstInclusive: true, eligibleExpensePct: 60, onboarded: true,
  });
  check("same-currency save reports no conversion", res.conversion, undefined);
  await call("saveTransaction", { type: "income", category: "Customer payments", amountCents: rs(50000), date: "2026-11-10", description: "Big payment", counterparty: "", status: "posted", paymentMethod: "UPI" });
  await call("saveTransaction", { type: "expense", category: "Food", amountCents: 123456, date: "2026-11-11", description: "Groceries", counterparty: "", status: "posted", paymentMethod: "UPI" });
  await call("saveInvoice", {
    number: "INV-CUR-001", customerName: "Acme", customerEmail: "", status: "sent",
    issueDate: "2026-11-01", dueDate: "2026-11-24", discountPct: 0, taxPct: 0, notes: "",
    items: [{ description: "Work", qty: 1, unitPriceCents: rs(10000) }],
  });
  await call("saveRecurring", {
    type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000),
    frequency: "monthly", nextDate: "2026-12-01", active: true,
  });
  await call("saveBudget", { category: "Food", monthlyLimitCents: rs(5000) });
  const emi = await call("saveEmiPlan", {
    customerName: "Ravi", customerContact: "", product: "Phone", totalCents: rs(120000),
    downPaymentCents: rs(20000), instalmentCount: 4, frequency: "monthly", firstDueDate: "2026-12-01",
  });
  check("EMI plan created", emi.ok, true);
  const goal = await call("saveSavingsGoal", { name: "Trip", targetCents: rs(100000), targetDate: "2027-06-01" });
  const add = await call("addToSavingsGoal", { goalId: goal.id, amountCents: rs(10000), date: "2026-11-12", note: "" });
  check("savings deposit recorded", add.ok, true);
  // One insight run row + one insight row: the run must be dropped by
  // the conversion, the insight row itself must survive.
  sql(`INSERT INTO financial_insight_runs (owner_id, mode, insight_count) VALUES ('${USER_ID}', 'business', 1)`);
  sql(
    `INSERT INTO financial_insights (id, owner_id, mode, insight_type, severity, title, description, evidence_json, insight_key, status) ` +
      `VALUES ('e2e-cur-keep', '${USER_ID}', 'business', 'cash_shortage', 'warning', 'keep me', 'keep me', '{}', 'currency_e2e_keep', 'active')`,
  );

  // ---- seed Personal (must stay untouched by a Business conversion) ----
  await call("setMode", { mode: "personal" });
  await call("saveTransaction", { type: "income", category: "Salary", amountCents: rs(7777), date: "2026-11-10", description: "Salary", counterparty: "", status: "posted", paymentMethod: "Bank transfer" });
  await call("updateBusiness", {
    mode: "personal", name: "My Money", industry: "", country: "India", currency: "INR",
    openingBalanceCents: rs(5000), timezone: "Asia/Kolkata", ownerName: "", ownerEmail: "", ownerPhone: "",
    gstRateBp: 1800, gstInclusive: true, eligibleExpensePct: 60, onboarded: true,
  });
  await call("setMode", { mode: "business" });

  // ---- capture the INR "before" values ----
  const before = {
    opening: Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)),
    txns: sqlVals(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'business' ORDER BY date`).map(Number),
    items: sqlVals(`SELECT unit_price_cents FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_id = '${USER_ID}' AND mode = 'business')`).map(Number),
    recurring: sqlVals(`SELECT amount_cents FROM recurring_cashflows WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    budgets: sqlVals(`SELECT monthly_limit_cents FROM budgets WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiPlans: sqlVals(`SELECT total_cents FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiDown: sqlVals(`SELECT down_payment_cents FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiInst: sqlVals(`SELECT amount_cents FROM emi_instalments WHERE plan_id IN (SELECT id FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business') ORDER BY seq`).map(Number),
    goals: sqlVals(`SELECT target_cents FROM savings_goals WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    transfers: sqlVals(`SELECT amount_cents FROM savings_transfers WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
  };
  check("before: 2 transactions seeded", before.txns.length, 2);
  check("before: 1 invoice item seeded", before.items.length, 1);
  check("before: 4 EMI instalments seeded", before.emiInst.length, 4);
  check("before: instalments are 250000 each", JSON.stringify(before.emiInst), JSON.stringify([2500000, 2500000, 2500000, 2500000]));

  // ---- convert Business INR → USD at the live rate ----
  const biz = (await call("getState")).business;
  res = await call("updateBusiness", { ...biz, currency: "USD" });
  const conv = res.conversion;
  check("conversion reported", !!conv, true);
  check("conversion from INR", conv?.from, "INR");
  check("conversion to USD", conv?.to, "USD");
  check("conversion rate is finite and positive", typeof conv?.rate === "number" && Number.isFinite(conv.rate) && conv.rate > 0, true);
  check("conversion asOf is a non-empty string", typeof conv?.asOf === "string" && conv.asOf.length > 0, true);
  check("conversion counts", JSON.stringify(conv?.convertedCounts), JSON.stringify({
    transactions: 2, invoiceItems: 1, recurring: 1, budgets: 1,
    emiPlans: 1, emiInstalments: 4, savingsGoals: 1, savingsTransfers: 1,
  }));
  const rate = conv.rate;
  const after = {
    opening: Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)),
    currency: sqlOne(`SELECT currency FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`),
    txns: sqlVals(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'business' ORDER BY date`).map(Number),
    items: sqlVals(`SELECT unit_price_cents FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_id = '${USER_ID}' AND mode = 'business')`).map(Number),
    recurring: sqlVals(`SELECT amount_cents FROM recurring_cashflows WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    budgets: sqlVals(`SELECT monthly_limit_cents FROM budgets WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiPlans: sqlVals(`SELECT total_cents FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiDown: sqlVals(`SELECT down_payment_cents FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    emiInst: sqlVals(`SELECT amount_cents FROM emi_instalments WHERE plan_id IN (SELECT id FROM emi_plans WHERE owner_id = '${USER_ID}' AND mode = 'business') ORDER BY seq`).map(Number),
    goals: sqlVals(`SELECT target_cents FROM savings_goals WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
    transfers: sqlVals(`SELECT amount_cents FROM savings_transfers WHERE owner_id = '${USER_ID}' AND mode = 'business'`).map(Number),
  };
  check("currency label updated to USD", after.currency, "USD");
  checkClose("opening balance converted", after.opening, Math.round(before.opening * rate));
  before.txns.forEach((v, i) => checkClose(`transaction ${i + 1} converted`, after.txns[i], Math.round(v * rate)));
  before.items.forEach((v, i) => checkClose(`invoice item ${i + 1} converted`, after.items[i], Math.round(v * rate)));
  before.recurring.forEach((v, i) => checkClose(`recurring ${i + 1} converted`, after.recurring[i], Math.round(v * rate)));
  before.budgets.forEach((v, i) => checkClose(`budget ${i + 1} converted`, after.budgets[i], Math.round(v * rate)));
  before.emiPlans.forEach((v, i) => checkClose(`EMI plan total ${i + 1} converted`, after.emiPlans[i], Math.round(v * rate)));
  before.emiDown.forEach((v, i) => checkClose(`EMI down payment ${i + 1} converted`, after.emiDown[i], Math.round(v * rate)));
  before.emiInst.forEach((v, i) => checkClose(`EMI instalment ${i + 1} converted`, after.emiInst[i], Math.round(v * rate)));
  before.goals.forEach((v, i) => checkClose(`savings goal ${i + 1} converted`, after.goals[i], Math.round(v * rate)));
  before.transfers.forEach((v, i) => checkClose(`savings transfer ${i + 1} converted`, after.transfers[i], Math.round(v * rate)));
  // The ₹50,000 income must NOT still be 5,000,000 in the new currency.
  check("₹50,000 income is no longer 5,000,000 minor units", after.txns.includes(5000000), false);

  // ---- insights: run row dropped, insight row kept ----
  check("insight run row deleted", Number(sqlOne(`SELECT count(*) FROM financial_insight_runs WHERE owner_id = '${USER_ID}' AND mode = 'business'`)), 0);
  check("insight row itself kept", Number(sqlOne(`SELECT count(*) FROM financial_insights WHERE id = 'e2e-cur-keep'`)), 1);

  // ---- Personal workspace untouched ----
  check("personal txn untouched", Number(sqlOne(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'personal'`)), rs(7777));
  check("personal opening untouched", Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'personal'`)), rs(5000));
  check("personal currency still INR", sqlOne(`SELECT currency FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'personal'`), "INR");

  // ---- same-currency save is a no-op ----
  const bizUsd = (await call("getState")).business;
  res = await call("updateBusiness", { ...bizUsd, currency: "USD" });
  check("same-currency save reports no conversion", res.conversion, undefined);
  check("same-currency save leaves opening alone", Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)), after.opening);
  check("same-currency save leaves txns alone", JSON.stringify(sqlVals(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'business' ORDER BY date`).map(Number)), JSON.stringify(after.txns));

  // ---- invalid target currency: nothing changes at all ----
  const bad = await callExpectError("updateBusiness", { ...bizUsd, currency: "XXX" });
  check("bad currency is rejected", bad.status, 400);
  check("bad currency error mentions the rate", (bad.error ?? "").includes("exchange rate"), true);
  check("bad currency leaves the label at USD", sqlOne(`SELECT currency FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`), "USD");
  check("bad currency leaves opening alone", Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)), after.opening);
  check("bad currency leaves txns alone", JSON.stringify(sqlVals(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'business' ORDER BY date`).map(Number)), JSON.stringify(after.txns));

  // ---- negative opening balance converts on a second conversion ----
  await call("updateBusiness", { ...bizUsd, currency: "USD", openingBalanceCents: -100000 });
  check("negative opening saved in USD", Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)), -100000);
  const bizUsd2 = (await call("getState")).business;
  res = await call("updateBusiness", { ...bizUsd2, currency: "EUR" });
  check("second conversion reported", !!res.conversion, true);
  check("second conversion is USD→EUR", `${res.conversion?.from}→${res.conversion?.to}`, "USD→EUR");
  checkClose(
    "negative opening converted to EUR",
    Number(sqlOne(`SELECT opening_balance_cents FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`)),
    Math.round(-100000 * res.conversion.rate),
  );
  check("currency label now EUR", sqlOne(`SELECT currency FROM businesses WHERE owner_id = '${USER_ID}' AND mode = 'business'`), "EUR");
  checkClose(
    "transaction converts again USD→EUR",
    Number(sqlOne(`SELECT amount_cents FROM transactions WHERE owner_id = '${USER_ID}' AND mode = 'business' ORDER BY date LIMIT 1`)),
    Math.round(after.txns[0] * res.conversion.rate),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
}
