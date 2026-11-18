// Proactive Financial Insights Engine — deterministic rules only.
//
// The AI should notice problems WITHOUT being asked. Every rule here
// is plain SQL-able arithmetic over the user's own rows: no LLM call,
// no extra cost, no invented numbers. A rule fires only from figures
// actually present in the workspace, and every figure it used lands
// in `evidence` so the UI can show its working.
//
// This module is deliberately dependency-free (no imports at all):
// scripts/insights-test.mjs transpiles it with the repo's own
// TypeScript and asserts each rule fires / does not fire, exactly
// like scripts/voice-parse-test.mjs does for the voice parser.
// The server action layer (server/actions.ts) loads the workspace
// rows with loadWorkspaceBatch and feeds them in here.
//
// Month comparisons are month-to-date (MTD): this month's spend so
// far is compared with the same days of earlier months. That matters
// on the 3rd of the month — a full-month average would false-fire
// "income dropped" before the salary has even arrived.
//
// Money is integer paise throughout (never floats). Labels are
// estimates, never predictions: a projection says what the scheduled
// items add up to, not what will happen.
export type InsightType =
  | "spending_spike"
  | "income_drop"
  | "unusual_transaction"
  | "recurring_payment"
  | "invoice_risk"
  | "cash_shortage"
  | "profit_leak"
  | "savings_opportunity";

export type InsightSeverity = "info" | "warning" | "critical";

export interface InsightTxn {
  id: string;
  type: "income" | "expense";
  status: "posted" | "pending";
  category: string;
  description: string;
  counterparty: string;
  amountCents: number;
  date: string; // yyyy-mm-dd
}

export interface InsightInvoice {
  id: string;
  number: string;
  customerName: string;
  status: string; // draft | sent | paid (stored status, not effective)
  dueDate: string; // yyyy-mm-dd
  totalCents: number; // precomputed server-side (invoiceTotals)
}

export interface InsightRecurring {
  id: string;
  type: "income" | "expense";
  category: string;
  description: string;
  amountCents: number;
  frequency: "weekly" | "monthly";
  nextDate: string; // yyyy-mm-dd
  active: boolean;
}

export interface InsightEmiInstalment {
  id: string;
  dueDate: string; // yyyy-mm-dd
  amountCents: number;
  status: "pending" | "paid";
}

export interface InsightInput {
  /** Workspace opening balance, paise. */
  openingBalanceCents: number;
  /** Net money held in this workspace's savings pots, paise —
   *  already excluded from available cash, never counted twice. */
  savedCents: number;
  transactions: InsightTxn[];
  invoices: InsightInvoice[];
  recurring: InsightRecurring[];
  /** Pending instalments of EMI plans in this workspace. In this app
   *  an EMI plan is a product SOLD on instalments, so a pending
   *  instalment is money to COLLECT, not money to pay. */
  emiInstalments: InsightEmiInstalment[];
  /** yyyy-mm-dd; defaults to today in Asia/Kolkata. Tests pass this
   *  in so the rules are deterministic. */
  today?: string;
}

export interface GeneratedInsight {
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  description: string;
  /** The exact figures the rule used — shown in the UI as evidence. */
  evidence: Record<string, number | string>;
  recommendedAction: string;
  /** 0–100. High >= 80, medium 50–79, low < 50 (see confidenceLabel). */
  confidence: number;
  /** Stable per workspace + type + subject, so a re-run upserts
   *  instead of duplicating. Monthly rules carry the month, so a
   *  dismissal silences that month's finding only. */
  insightKey: string;
}

// ---------- thresholds (paise) ----------
// ₹1,000 — a spike / leak / income drop only matters if the money is material.
export const SPIKE_MIN_DIFF_CENTS = 100_000;
export const LEAK_MIN_DIFF_CENTS = 100_000;
export const INCOME_DROP_MIN_DIFF_CENTS = 100_000;
// ₹500 — a saving worth mentioning.
export const SAVINGS_MIN_DIFF_CENTS = 50_000;
// ₹2,000 — a single transaction must clear this to be "unusual".
export const UNUSUAL_MIN_CENTS = 200_000;
// ₹5,000 — the cash floor the shortage projection watches.
export const CASH_SHORTAGE_FLOOR_CENTS = 500_000;
export const CASH_SHORTAGE_HORIZON_DAYS = 30;
export const UNUSUAL_WINDOW_DAYS = 30;
export const MAX_INSIGHTS_PER_RUN = 20;

export function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 80) return "high";
  if (confidence >= 50) return "medium";
  return "low";
}

// ---------- date helpers (yyyy-mm-dd strings) ----------
// Every helper below works on yyyy-mm-dd CALENDAR strings — the
// arithmetic is timezone-free (Date.UTC on the string itself), so
// month windows and month boundaries cannot drift. The ONE place an
// instant becomes a date is todayStrIst: "today" is the
// Asia/Kolkata calendar date, because the app is India-first and the
// display is IST. Vercel runs in UTC, so a UTC "today" is a day
// behind IST for the first 5½ hours of every day — that shipped a
// cash_shortage dated yesterday (2026-11-18 on 19 Nov 00:17 IST).

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

export function dayOfMonthOf(date: string): number {
  return Number(date.slice(8, 10));
}

export function shiftMonthKey(key: string, delta: number): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** Today's calendar date in Asia/Kolkata (UTC+05:30, no DST), via
 *  Intl so the server's own timezone never leaks in. formatToParts
 *  is used instead of locale formatting so the yyyy-mm-dd shape does
 *  not depend on any locale's ordering. */
export function todayStrIst(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const at = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")}`;
}

/** Next monthly occurrence on/after `from`, keeping the day-of-month
 *  clamped to the target month's length (31 Jan -> 28 Feb, not 3 Mar). */
function stepMonthly(date: string): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m, 1)); // first of next month
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** "2026-11-18" → "18 Nov 2026" (same shape as the client's
 *  prettyDate, built from the date string so no timezone can shift
 *  it). Used in cash_shortage copy so a date reads as a date, not a
 *  database key. */
export function formatDateShort(date: string): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[(m - 1 + 12) % 12] ?? ""} ${y}`;
}

/** ₹1,25,400 — Indian grouping, whole rupees when exact, two
 *  decimals only when paise are present. */
export function formatINR(cents: number): string {
  const rupees = cents / 100;
  return `₹${Math.abs(rupees).toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function pctChange(now: number, before: number): number {
  if (before <= 0) return 0;
  return Math.round(((now - before) / before) * 100);
}

// ---------- the rules ----------

/**
 * Runs every rule over one workspace's rows and returns the insights
 * that fire, most severe first. Never invents a number: an empty
 * workspace returns an empty list.
 */
export function detectInsights(input: InsightInput): GeneratedInsight[] {
  const today = input.today ?? todayStrIst();
  const curMonth = monthKeyOf(today);
  const dayCutoff = dayOfMonthOf(today);
  const posted = input.transactions.filter((t) => t.status === "posted");
  const out: GeneratedInsight[] = [];

  // Month-to-date sum for a type + category in a month, counting only
  // days up to the current day-of-month (fair comparison across months).
  const sumMtd = (
    type: "income" | "expense",
    category: string,
    month: string,
  ): { total: number; count: number } => {
    let total = 0;
    let count = 0;
    for (const t of posted) {
      if (
        t.type === type &&
        t.category === category &&
        monthKeyOf(t.date) === month &&
        dayOfMonthOf(t.date) <= dayCutoff
      ) {
        total += t.amountCents;
        count++;
      }
    }
    return { total, count };
  };

  // --- spending_spike: a category's spend so far this month is >30%
  // above its 3-month month-to-date average, and the excess is material.
  {
    const categories = [...new Set(posted.filter((t) => t.type === "expense").map((t) => t.category))];
    for (const category of categories) {
      const cur = sumMtd("expense", category, curMonth);
      if (cur.count === 0) continue;
      const priors = [1, 2, 3].map((d) => sumMtd("expense", category, shiftMonthKey(curMonth, -d)));
      const withData = priors.filter((p) => p.count > 0);
      if (withData.length < 2) continue; // not enough history to call it a spike
      const avg = Math.round(
        withData.reduce((s, p) => s + p.total, 0) / withData.length,
      );
      if (avg <= 0) continue;
      const excess = cur.total - avg;
      const pct = pctChange(cur.total, avg);
      if (pct > 30 && excess > SPIKE_MIN_DIFF_CENTS) {
        out.push({
          type: "spending_spike",
          severity: pct >= 100 ? "critical" : "warning",
          title: `${category} spending is ${pct}% above usual`,
          description:
            `So far this month you have spent ${formatINR(cur.total)} on ${category}, against a usual ${formatINR(avg)} for the same days of the month. ` +
            `That is ${formatINR(excess)} more than usual — an estimate from your recorded transactions.`,
          evidence: {
            category,
            currentMonthCents: cur.total,
            avgMonthCents: avg,
            pctAbove: pct,
            excessCents: excess,
            monthsUsed: withData.length,
          },
          recommendedAction: `Review ${category} spending in Money Flow and check whether a budget would help.`,
          confidence: withData.length >= 3 ? 90 : 70,
          insightKey: `spending_spike:${category}:${curMonth}`,
        });
      }
    }
  }

  // --- income_drop: this month's income so far is >20% below the
  // 3-month month-to-date average, and the shortfall is material.
  {
    const sumIncomeMtd = (month: string): { total: number; count: number } => {
      let total = 0;
      let count = 0;
      for (const t of posted) {
        if (
          t.type === "income" &&
          monthKeyOf(t.date) === month &&
          dayOfMonthOf(t.date) <= dayCutoff
        ) {
          total += t.amountCents;
          count++;
        }
      }
      return { total, count };
    };
    const curInc = sumIncomeMtd(curMonth);
    const priors = [1, 2, 3].map((d) => sumIncomeMtd(shiftMonthKey(curMonth, -d)));
    const withData = priors.filter((p) => p.count > 0);
    if (withData.length >= 2) {
      const avg = Math.round(
        withData.reduce((s, p) => s + p.total, 0) / withData.length,
      );
      if (avg > 0) {
        const shortfall = avg - curInc.total;
        // Percent below the usual average (divide by the average —
        // never by this month's income, which may legitimately be 0).
        const pct = Math.round(((avg - curInc.total) / avg) * 100);
        if (pct > 20 && shortfall > INCOME_DROP_MIN_DIFF_CENTS) {
          out.push({
            type: "income_drop",
            severity: curInc.total === 0 && avg > 500_000 ? "critical" : "warning",
            title: `Income is ${pct}% below your usual so far this month`,
            description:
              curInc.total === 0
                ? `No income has been recorded yet this month, against a usual ${formatINR(avg)} for the same days. If a payment is simply late, this will clear when it lands.`
                : `So far this month you have recorded ${formatINR(curInc.total)} of income, against a usual ${formatINR(avg)} for the same days — ${formatINR(shortfall)} less.`,
            evidence: {
              currentMonthCents: curInc.total,
              avgMonthCents: avg,
              pctBelow: pct,
              shortfallCents: shortfall,
              monthsUsed: withData.length,
            },
            recommendedAction: "Check whether an expected payment or invoice is late, and follow it up.",
            confidence: withData.length >= 3 ? 90 : 70,
            insightKey: `income_drop:${curMonth}`,
          });
        }
      }
    }
  }

  // --- unusual_transaction: one expense in the last 30 days that is
  // more than 3x the median expense of its own category (median, not
  // mean, so one big past payment cannot hide the next one).
  {
    const windowStart = addDaysStr(today, -UNUSUAL_WINDOW_DAYS);
    const recent = posted.filter(
      (t) =>
        t.type === "expense" &&
        t.date >= windowStart &&
        t.date <= today &&
        t.amountCents > UNUSUAL_MIN_CENTS,
    );
    for (const txn of recent) {
      const peers = posted
        .filter((t) => t.type === "expense" && t.category === txn.category && t.id !== txn.id)
        .map((t) => t.amountCents);
      if (peers.length < 5) continue; // not enough history to judge
      const med = median(peers);
      if (med <= 0) continue;
      if (txn.amountCents > 3 * med) {
        const multiple = Math.round((txn.amountCents / med) * 10) / 10;
        out.push({
          type: "unusual_transaction",
          severity: "warning",
          title: `Unusually large ${txn.category} payment: ${formatINR(txn.amountCents)}`,
          description:
            `“${txn.description || txn.category}” on ${txn.date} is ${multiple}x your usual ${txn.category} payment (median ${formatINR(med)}). ` +
            `It may be perfectly fine — this is a nudge to check it, not a fraud claim.`,
          evidence: {
            transactionId: txn.id,
            description: txn.description || txn.category,
            date: txn.date,
            category: txn.category,
            amountCents: txn.amountCents,
            medianCents: med,
            multiple,
          },
          recommendedAction: "Open Money Flow and check this payment — if it was expected, mark this insight as expected.",
          confidence: peers.length >= 10 ? 85 : 65,
          insightKey: `unusual_transaction:${txn.id}`,
        });
      }
    }
  }

  // --- recurring_payment: the same payee, about the same amount, in
  // 3+ consecutive months ending this month or last month.
  {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const byPayee = new Map<string, InsightTxn[]>();
    for (const t of posted) {
      if (t.type !== "expense") continue;
      const payee = norm(t.counterparty || t.description);
      if (!payee) continue;
      const arr = byPayee.get(payee) ?? [];
      arr.push(t);
      byPayee.set(payee, arr);
    }
    for (const [payee, txns] of byPayee) {
      if (txns.length < 3) continue;
      const medAmount = median(txns.map((t) => t.amountCents));
      if (medAmount <= 0) continue;
      // Keep only payments within ±5% of the group's median amount.
      const same = txns.filter(
        (t) => Math.abs(t.amountCents - medAmount) <= medAmount * 0.05,
      );
      if (same.length < 3) continue;
      const months = [...new Set(same.map((t) => monthKeyOf(t.date)))].sort();
      const latest = months[months.length - 1] as string;
      // The run must be current: its latest month is this month or last.
      if (latest !== curMonth && latest !== shiftMonthKey(curMonth, -1)) continue;
      // Walk back from the latest month counting consecutive months.
      let run = 1;
      let cursor = latest;
      for (;;) {
        const prev = shiftMonthKey(cursor, -1);
        if (months.includes(prev)) {
          run++;
          cursor = prev;
        } else break;
      }
      if (run < 3) continue;
      const display = (same[0]?.counterparty || same[0]?.description || payee).trim();
      out.push({
        type: "recurring_payment",
        severity: "info",
        title: `${formatINR(medAmount)} to ${display} — ${run} months in a row`,
        description:
          `You have paid about ${formatINR(medAmount)} to ${display} every month for ${run} consecutive months. ` +
          `Worth a look if you no longer use it — otherwise this is expected.`,
        evidence: {
          payee: display,
          amountCents: medAmount,
          months: run,
          monthKeys: months.slice(-run).join(","),
        },
        recommendedAction: "If you no longer use this, cancel it; if it is expected, mark this insight as expected.",
        confidence: 90,
        insightKey: `recurring_payment:${payee}:${medAmount}`,
      });
    }
  }

  // --- invoice_risk: unpaid (sent, not yet paid) invoices, with the
  // oldest overdue age. Drafts are not owed; paid invoices are done.
  {
    const unpaid = input.invoices.filter((inv) => inv.status === "sent");
    if (unpaid.length > 0) {
      const unpaidCents = unpaid.reduce((s, inv) => s + inv.totalCents, 0);
      const overdue = unpaid.filter((inv) => inv.dueDate < today);
      const overdueCents = overdue.reduce((s, inv) => s + inv.totalCents, 0);
      const oldestOverdueDays =
        overdue.length > 0
          ? Math.max(...overdue.map((inv) => daysBetween(inv.dueDate, today)))
          : 0;
      out.push({
        type: "invoice_risk",
        severity: overdue.length > 0 ? "critical" : "warning",
        title:
          overdue.length > 0
            ? `${formatINR(unpaidCents)} unpaid across ${unpaid.length} invoice(s) — ${overdue.length} overdue`
            : `${formatINR(unpaidCents)} unpaid across ${unpaid.length} invoice(s)`,
        description:
          overdue.length > 0
            ? `${formatINR(unpaidCents)} is still to be collected from ${unpaid.length} unpaid invoice(s); ` +
              `${overdue.length} of them are overdue${oldestOverdueDays > 0 ? `, the oldest by ${oldestOverdueDays} day(s)` : ""}. ` +
              `Unpaid invoices are not counted as available cash.`
            : `${formatINR(unpaidCents)} is still to be collected from ${unpaid.length} unpaid invoice(s). None is overdue yet.`,
        evidence: {
          unpaidCents,
          unpaidCount: unpaid.length,
          overdueCount: overdue.length,
          overdueCents,
          oldestOverdueDays,
        },
        recommendedAction: "Open Invoices and follow up on the unpaid ones, starting with the oldest overdue.",
        confidence: 95,
        insightKey: "invoice_risk",
      });
    }
  }

  // --- cash_shortage: project the next 30 days from scheduled items
  // only (same assumptions as Future Lens): sent invoices land on
  // their due date, active recurring schedules repeat, pending
  // transactions settle, pending EMI instalments are collected.
  // A workspace with no financial history at all (no opening
  // balance, no transactions, no invoices, no schedules) has nothing
  // to project — it must produce no insight, not a "₹0 cash" alarm.
  const hasActivity =
    input.openingBalanceCents !== 0 ||
    posted.length > 0 ||
    input.invoices.length > 0 ||
    input.recurring.some((r) => r.active) ||
    input.emiInstalments.length > 0;
  if (hasActivity) {
    const end = addDaysStr(today, CASH_SHORTAGE_HORIZON_DAYS);
    const events = new Map<string, { in: number; out: number }>();
    const add = (date: string, kind: "in" | "out", cents: number) => {
      if (date < today || date > end) return;
      const e = events.get(date) ?? { in: 0, out: 0 };
      e[kind] += cents;
      events.set(date, e);
    };
    let expectedIn = 0;
    let expectedOut = 0;
    for (const inv of input.invoices) {
      if (inv.status === "sent") {
        const when = inv.dueDate < today ? addDaysStr(today, 3) : inv.dueDate;
        add(when, "in", inv.totalCents);
      }
    }
    for (const r of input.recurring) {
      if (!r.active) continue;
      let d = r.nextDate;
      let guard = 0;
      while (d <= end && guard < 40) {
        if (d >= today) add(d, r.type === "income" ? "in" : "out", r.amountCents);
        d = r.frequency === "weekly" ? addDaysStr(d, 7) : stepMonthly(d);
        guard++;
      }
    }
    for (const t of input.transactions) {
      if (t.status === "pending") {
        add(t.date < today ? today : t.date, t.type === "income" ? "in" : "out", t.amountCents);
      }
    }
    for (const inst of input.emiInstalments) {
      if (inst.status === "pending") add(inst.dueDate, "in", inst.amountCents);
    }
    const startCash =
      input.openingBalanceCents +
      posted.filter((t) => t.type === "income").reduce((s, t) => s + t.amountCents, 0) -
      posted.filter((t) => t.type === "expense").reduce((s, t) => s + t.amountCents, 0) -
      input.savedCents;
    let balance = startCash;
    let minBalance = balance;
    let minDate: string | null = null;
    // First day money is expected in, and how much lands that day —
    // the honest "until when" for a cash level that never falls.
    let firstInflowDate: string | null = null;
    let firstInflowCents = 0;
    for (let i = 0; i <= CASH_SHORTAGE_HORIZON_DAYS; i++) {
      const date = addDaysStr(today, i);
      const e = events.get(date) ?? { in: 0, out: 0 };
      balance += e.in - e.out;
      expectedIn += e.in;
      expectedOut += e.out;
      if (e.in > 0 && firstInflowDate === null) {
        firstInflowDate = date;
        firstInflowCents = e.in;
      }
      if (balance < minBalance) {
        minBalance = balance;
        minDate = date;
      }
    }
    if (minBalance < CASH_SHORTAGE_FLOOR_CENTS) {
      // If the balance never drops below its starting point, the low
      // IS today's balance — the date is today, not the window end —
      // and "fall" is a lie: the cash does not fall at all. Say what
      // actually happens instead: it stays at today's level until the
      // first expected payment lands (or, with nothing scheduled at
      // all, for the whole window). Shortage/warning language is
      // reserved for a real decline below today's balance.
      const lowDate = minDate ?? today;
      const declined = minBalance < startCash;
      if (!declined && firstInflowDate !== null) {
        out.push({
          type: "cash_shortage",
          severity: minBalance < 0 ? "critical" : "warning",
          title: `Cash stays at ${formatINR(startCash)} until ${formatINR(firstInflowCents)} is expected on ${formatDateShort(firstInflowDate)}`,
          description:
            `From ${formatINR(startCash)} today, scheduled bills, EMIs and expected payments over the next 30 days ` +
            `(${formatINR(expectedIn)} expected in, ${formatINR(expectedOut)} scheduled out) never take your cash below ${formatINR(startCash)} — ` +
            `it stays at that level until the first expected payment lands. This is an estimate from your scheduled items — never a guarantee.`,
          evidence: {
            startCashCents: startCash,
            minBalanceCents: minBalance,
            minDate: lowDate,
            expectedInCents: expectedIn,
            expectedOutCents: expectedOut,
            firstInflowDate,
            firstInflowCents,
          },
          recommendedAction: "Check the Payment Calendar for what is due, and chase the expected payment so it lands on time.",
          confidence: 80,
          insightKey: "cash_shortage",
        });
      } else if (!declined) {
        out.push({
          type: "cash_shortage",
          severity: minBalance < 0 ? "critical" : "warning",
          title: `Cash stays at ${formatINR(startCash)} with nothing scheduled in or out for 30 days`,
          description:
            `From ${formatINR(startCash)} today, nothing is scheduled in or out over the next 30 days, so your cash stays at ${formatINR(startCash)} — ` +
            `below the ₹5,000 level this check watches. This is an estimate from your scheduled items — never a guarantee.`,
          evidence: {
            startCashCents: startCash,
            minBalanceCents: minBalance,
            minDate: lowDate,
            expectedInCents: expectedIn,
            expectedOutCents: expectedOut,
          },
          recommendedAction: "Check the Payment Calendar — if income is expected but not scheduled, add it so the picture stays honest.",
          confidence: 80,
          insightKey: "cash_shortage",
        });
      } else {
        out.push({
          type: "cash_shortage",
          severity: minBalance < 0 ? "critical" : "warning",
          title:
            minBalance < 0
              ? `Cash is estimated to go below zero — −${formatINR(minBalance)} on ${formatDateShort(lowDate)}`
              : `Cash is estimated to fall to ${formatINR(minBalance)} on ${formatDateShort(lowDate)}`,
          description:
            `From ${formatINR(startCash)} today, scheduled bills, EMIs and expected payments over the next 30 days ` +
            `(${formatINR(expectedIn)} expected in, ${formatINR(expectedOut)} scheduled out) leave an estimated low of ` +
            `${formatINR(minBalance)} on ${formatDateShort(lowDate)}. This is an estimate from your scheduled items — never a guarantee.`,
          evidence: {
            startCashCents: startCash,
            minBalanceCents: minBalance,
            minDate: lowDate,
            expectedInCents: expectedIn,
            expectedOutCents: expectedOut,
          },
          recommendedAction: "Check the Payment Calendar for what is due, and chase any overdue invoice before that date.",
          confidence: 80,
          insightKey: "cash_shortage",
        });
      }
    }
  }

  // --- profit_leak: a category's spend so far this month is >20%
  // above the same days of last month, and the rise is material.
  // --- savings_opportunity: a category's spend so far this month is
  // at least ₹500 below the same days of last month.
  {
    const prevMonth = shiftMonthKey(curMonth, -1);
    const categories = [...new Set(posted.filter((t) => t.type === "expense").map((t) => t.category))];
    for (const category of categories) {
      const cur = sumMtd("expense", category, curMonth);
      const prev = sumMtd("expense", category, prevMonth);
      if (prev.total <= 0 || prev.count === 0) continue;
      const diff = cur.total - prev.total;
      const pct = pctChange(cur.total, prev.total);
      if (pct > 20 && diff > LEAK_MIN_DIFF_CENTS) {
        out.push({
          type: "profit_leak",
          severity: "warning",
          title: `${category} spending is up ${pct}% vs last month`,
          description:
            `So far this month you have spent ${formatINR(cur.total)} on ${category}, against ${formatINR(prev.total)} ` +
            `for the same days last month — ${formatINR(diff)} more. If nothing changed on purpose, this is a leak worth a look.`,
          evidence: {
            category,
            currentMonthCents: cur.total,
            previousMonthCents: prev.total,
            pctIncrease: pct,
            diffCents: diff,
          },
          recommendedAction: `Open Money Flow, filter ${category}, and check what changed since last month.`,
          confidence: 85,
          insightKey: `profit_leak:${category}:${curMonth}`,
        });
      } else if (prev.total - cur.total > SAVINGS_MIN_DIFF_CENTS) {
        const saved = prev.total - cur.total;
        out.push({
          type: "savings_opportunity",
          severity: "info",
          title: `You spent ${formatINR(saved)} less on ${category} than last month`,
          description:
            `So far this month you have spent ${formatINR(cur.total)} on ${category}, against ${formatINR(prev.total)} ` +
            `for the same days last month. That ${formatINR(saved)} stayed in your pocket.`,
          evidence: {
            category,
            currentMonthCents: cur.total,
            previousMonthCents: prev.total,
            savedCents: saved,
          },
          recommendedAction: "Consider moving the saving into a savings goal while it is still unspent.",
          confidence: 85,
          insightKey: `savings_opportunity:${category}:${curMonth}`,
        });
      }
    }
  }

  // Most severe first, then the order the rules ran in; cap the list
  // so one unusual month cannot flood the dashboard.
  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  const seen = new Set<string>();
  return out
    .filter((i) => {
      if (seen.has(i.insightKey)) return false;
      seen.add(i.insightKey);
      return true;
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, MAX_INSIGHTS_PER_RUN);
}
