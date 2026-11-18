// End-to-end test for the Proactive Financial Insights Engine.
// Runs against the production build (next start) with a local
// PostgreSQL database — real /api/<action> calls, no mocks.
// The server must already be running with DATABASE_URL pointed at a
// database carrying migrations 0000-0004:
//   DATABASE_URL=postgresql://cgtest:cgtest@127.0.0.1:5432/cg_insights PORT=3100 npm run start
// Run: BASE_URL=http://127.0.0.1:3100 node scripts/insights-e2e-test.mjs
// Exit 1 on any failure. The test user is created fresh each run.
import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const PSQL = "PGPASSWORD=cgtest psql -h 127.0.0.1 -U cgtest -d cg_insights -v ON_ERROR_STOP=1";
const USER_ID = "e2e-insights-user";
const TOKEN = "e2e-insights-token-0123456789abcdef";

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
const sql = (q) => execSync(`${PSQL} -c ${JSON.stringify(q)}`, { stdio: "pipe" }).toString();
const sqlOne = (q) => sql(q).trim().split("\n")[2]?.trim();
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
  sql(`DELETE FROM financial_insights WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM financial_insight_runs WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM auth_sessions WHERE user_id = '${USER_ID}'`);
  sql(`DELETE FROM transactions WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM invoices WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_id = '${USER_ID}')`);
  sql(`DELETE FROM recurring_cashflows WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM businesses WHERE owner_id = '${USER_ID}'`);
  sql(`DELETE FROM auth_users WHERE id = '${USER_ID}'`);
  sql(
    `INSERT INTO auth_users (id, identifier, channel, password_hash, password_salt, verified) ` +
      `VALUES ('${USER_ID}', 'e2e-insights@cashflow-genius.local', 'email', 'x', 'y', 1)`,
  );
  sql(
    `INSERT INTO auth_sessions (token, user_id, active, expires_at) ` +
      `VALUES ('${TOKEN}', '${USER_ID}', 1, ${Date.now() + 24 * 3600 * 1000})`,
  );
  // First getState creates the Business workspace.
  const state = await call("getState");
  check("getState creates business workspace", state.activeMode, "business");
  sql(`UPDATE businesses SET opening_balance_cents = ${rs(10000)} WHERE owner_id = '${USER_ID}' AND mode = 'business'`);

  // ---- seed Business: spike + income drop + recurring + unusual + invoice risk ----
  const saveTxn = (type, category, amount, date, extra = {}) =>
    call("saveTransaction", { type, category, amountCents: amount, date, description: extra.description ?? category, counterparty: extra.counterparty ?? "", status: "posted", paymentMethod: "UPI" });
  // Food: Aug 9,000 / Sep 9,500 / Oct 9,700 → Nov 12,400 (spike + leak).
  await saveTxn("expense", "Food", rs(9000), "2026-08-10");
  await saveTxn("expense", "Food", rs(9500), "2026-09-10");
  await saveTxn("expense", "Food", rs(9700), "2026-10-10");
  const novFood = await saveTxn("expense", "Food", rs(12400), "2026-11-10");
  // Salary: 50,000 x3 → Nov 30,000 (income drop).
  await saveTxn("income", "Salary", rs(50000), "2026-08-05");
  await saveTxn("income", "Salary", rs(50000), "2026-09-05");
  await saveTxn("income", "Salary", rs(50000), "2026-10-05");
  const novSalary = await saveTxn("income", "Salary", rs(30000), "2026-11-05");
  // Netflix ₹499 x3 consecutive months (recurring).
  for (const d of ["2026-09-05", "2026-10-05", "2026-11-05"]) {
    await saveTxn("expense", "Entertainment", rs(499), d, { counterparty: "Netflix", description: "Netflix" });
  }
  // Grocery peers + one ₹6,500 run (unusual).
  for (const [i, amt] of [700, 800, 850, 900, 900, 1000, 1100, 1200].entries()) {
    await saveTxn("expense", "Groceries", rs(amt), `2026-09-${String(2 + i).padStart(2, "0")}`);
  }
  await saveTxn("expense", "Groceries", rs(6500), "2026-11-15", { description: "Big bazaar run" });
  // Sent invoice ₹10,000 overdue since 20 Oct (invoice risk).
  await call("saveInvoice", {
    number: "INV-E2E-001", customerName: "Acme", customerEmail: "", status: "sent",
    issueDate: "2026-10-01", dueDate: "2026-10-20", discountPct: 0, taxPct: 0, notes: "",
    items: [{ description: "Work", qty: 1, unitPriceCents: rs(10000) }],
  });
  // Rent ₹20,000 due 25 Nov — with ₹10,000 opening + ₹1,80,000 income
  // the projection stays healthy, so no cash_shortage should fire.
  await call("saveRecurring", {
    type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000),
    frequency: "monthly", nextDate: "2026-11-25", active: true,
  });

  // ---- getInsights: lazy generation on first load ----
  let res = await call("getInsights");
  check("getInsights generated fresh on first load", res.generatedFresh, true);
  const types = res.insights.map((i) => i.insightType);
  // Food Nov ₹12,400 vs Oct ₹9,700 is also +28% vs last month, so the
  // profit-leak rule fires alongside the spike — both are real.
  for (const t of ["spending_spike", "profit_leak", "income_drop", "recurring_payment", "unusual_transaction", "invoice_risk"]) {
    check(`business insight present: ${t}`, types.includes(t), true);
  }
  const firstCount = res.insights.length;
  check("first load lists 6 insights", firstCount, 6);
  check("no cash_shortage when healthy", types.includes("cash_shortage"), false);
  check("insights carry real evidence", res.insights.find((i) => i.insightType === "spending_spike")?.evidenceJson.pctAbove, 32);
  check("invoice_risk is critical", res.insights.find((i) => i.insightType === "invoice_risk")?.severity, "critical");
  const spikeId = res.insights.find((i) => i.insightType === "spending_spike")?.id;
  const riskId = res.insights.find((i) => i.insightType === "invoice_risk")?.id;
  const recId = res.insights.find((i) => i.insightType === "recurring_payment")?.id;
  const dropId = res.insights.find((i) => i.insightType === "income_drop")?.id;
  const activeCount = sqlOne(`SELECT count(*) FROM financial_insights WHERE owner_id = '${USER_ID}' AND mode = 'business' AND status = 'active'`);
  check("DB active rows match listed insights", Number(activeCount), res.insights.length);

  // ---- immediate regeneration is debounced (60s guard) ----
  res = await call("generateInsights");
  check("generateInsights debounced within 60s", res.skipped, true);
  check("debounced run reports same active count", res.active, firstCount);
  const dupCount = sqlOne(`SELECT count(*) FROM (SELECT insight_key FROM financial_insights WHERE owner_id = '${USER_ID}' AND mode = 'business' AND status = 'active' GROUP BY insight_key HAVING count(*) > 1) d`);
  check("no duplicate active keys after re-run", Number(dupCount), 0);
  res = await call("getInsights");
  check("second getInsights is not fresh", res.generatedFresh, false);
  check("second getInsights lists same ids", JSON.stringify(res.insights.map((i) => i.id).sort()), JSON.stringify(
    (await call("getInsights")).insights.map((i) => i.id).sort(),
  ));

  // ---- dismiss / snooze / expected ----
  await call("dismissInsight", { id: spikeId });
  res = await call("getInsights");
  check("dismissed insight leaves the list", res.insights.some((i) => i.id === spikeId), false);
  const again = await callExpectError("dismissInsight", { id: spikeId });
  check("dismissing twice is rejected", again.status, 400);
  await call("snoozeInsight", { id: riskId });
  await call("markInsightExpected", { id: recId });
  res = await call("getInsights");
  check("snoozed + expected leave the list", res.insights.length, 3); // income_drop + unusual + profit_leak remain
  check("remaining are drop + leak + unusual", JSON.stringify(res.insights.map((i) => i.insightType).sort()), JSON.stringify(["income_drop", "profit_leak", "unusual_transaction"]));

  // ---- 6h staleness: time-travel the run row, snooze/dismiss must survive ----
  sql(`UPDATE financial_insight_runs SET generated_at = now() - interval '7 hours' WHERE owner_id = '${USER_ID}' AND mode = 'business'`);
  res = await call("getInsights");
  check("stale run regenerates on dashboard load", res.generatedFresh, true);
  check("dismissed spike stays dismissed after regen", res.insights.some((i) => i.id === spikeId), false);
  check("snoozed risk stays snoozed after regen", res.insights.some((i) => i.id === riskId), false);
  check("expected recurring stays expected after regen", res.insights.some((i) => i.id === recId), false);

  // ---- resolve: top the income back up, then regenerate ----
  await saveTxn("income", "Salary", rs(25000), "2026-11-16");
  sql(`UPDATE financial_insight_runs SET generated_at = now() - interval '7 hours' WHERE owner_id = '${USER_ID}' AND mode = 'business'`);
  res = await call("generateInsights");
  check("regen after income top-up runs", res.skipped, false);
  const dropStatus = sqlOne(`SELECT status FROM financial_insights WHERE id = '${dropId}'`);
  check("cleared income_drop resolves in DB", dropStatus, "resolved");
  res = await call("getInsights");
  check("resolved insight leaves the list", res.insights.some((i) => i.id === dropId), false);

  // ---- snooze expiry: move the snooze deadline to the past, regen wakes it ----
  sql(`UPDATE financial_insights SET expires_at = now() - interval '1 day' WHERE id = '${riskId}'`);
  sql(`UPDATE financial_insight_runs SET generated_at = now() - interval '7 hours' WHERE owner_id = '${USER_ID}' AND mode = 'business'`);
  await call("generateInsights");
  const riskStatus = sqlOne(`SELECT status FROM financial_insights WHERE id = '${riskId}'`);
  check("expired snooze reactivates", riskStatus, "active");
  res = await call("getInsights");
  check("reactivated risk is listed again", res.insights.some((i) => i.id === riskId), true);

  // ---- mode isolation: Personal starts empty, gets its own insight ----
  await call("setMode", { mode: "personal" });
  res = await call("getInsights");
  check("personal workspace starts with zero insights", res.insights.length, 0);
  // Personal: ₹10,000 opening, ₹20,000 rent due 25 Nov → cash shortage.
  await call("updateBusiness", {
    mode: "personal", name: "My Money", industry: "", country: "India", currency: "INR",
    openingBalanceCents: rs(10000), timezone: "Asia/Kolkata", ownerName: "", ownerEmail: "", ownerPhone: "",
    gstRateBp: 1800, gstInclusive: true, eligibleExpensePct: 60, onboarded: true,
  });
  await call("saveRecurring", {
    type: "expense", category: "Rent", description: "Rent", amountCents: rs(20000),
    frequency: "monthly", nextDate: "2026-11-25", active: true,
  });
  sql(`UPDATE financial_insight_runs SET generated_at = now() - interval '7 hours' WHERE owner_id = '${USER_ID}' AND mode = 'personal'`);
  res = await call("getInsights");
  check("personal cash_shortage fires", res.insights.some((i) => i.insightType === "cash_shortage"), true);
  check("personal has only its own insight", res.insights.length, 1);
  // Back to Business: personal's insight must not leak in.
  await call("setMode", { mode: "business" });
  res = await call("getInsights");
  check("business list has no personal cash_shortage", res.insights.some((i) => i.insightType === "cash_shortage"), false);
  check("business list keeps its own insights", res.insights.some((i) => i.insightType === "unusual_transaction"), true);

  // ---- guards: another user's id, and the partial unique index ----
  const wrong = await callExpectError("dismissInsight", { id: "00000000-0000-0000-0000-000000000000" });
  check("unknown insight id is rejected", wrong.status, 400);
  const idx = await (async () => {
    try {
      sql(`INSERT INTO financial_insights (id, owner_id, mode, insight_type, severity, title, description, evidence_json, insight_key, status) VALUES ('e2e-dup', '${USER_ID}', 'business', 'invoice_risk', 'critical', 'x', 'x', '{}', 'invoice_risk', 'active')`);
      return "inserted";
    } catch (e) {
      const msg = String(e.message ?? e);
      return msg.includes("duplicate key value violates unique constraint") ? "23505" : msg;
    }
  })();
  check("partial unique index blocks a second active row per key", idx, "23505");
  void novFood;
  void novSalary;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
}
