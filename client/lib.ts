// Shared client helpers: money formatting (Indian numbering by default),
// the deterministic financial engine (mirrors the server copy), CSV and a
// small dependency-free PDF writer.

import type { ApiResponse } from "./api";
import type { api } from "./api";

export type State = ApiResponse<typeof api, "getState">;
export type Txn = State["transactions"][number];
export type Invoice = State["invoices"][number];
export type Note = State["notes"][number];
export type Recurring = State["recurring"][number];
export type EmiPlan = State["emiPlans"][number];
export type EmiInstalment = EmiPlan["instalments"][number];
export type ScamCheck = State["scamChecks"][number];
export type SavingsGoal = State["savingsGoals"][number];
export type SavingsTransfer = SavingsGoal["transfers"][number];

/** Total currently saved across all goals in the (workspace-scoped) state. */
export function totalSavedCents(state: State): number {
  return (state.savingsGoals ?? []).reduce((s, g) => s + g.savedCents, 0);
}

/** Whether the workspace holds any money records at all — used before
 *  a currency conversion, which re-prices every amount in the workspace.
 *  An empty workspace converts without asking. */
export function workspaceHasMoney(state: State): boolean {
  return (
    (state.transactions?.length ?? 0) > 0 ||
    (state.budgets?.length ?? 0) > 0 ||
    (state.invoices?.length ?? 0) > 0 ||
    (state.recurring?.length ?? 0) > 0 ||
    (state.emiPlans?.length ?? 0) > 0 ||
    (state.savingsGoals?.length ?? 0) > 0
  );
}

/** Confirm-dialog wording for a currency conversion, shared by the
 *  top-bar selector, the More sheet and the Settings profile form so
 *  all three ask the same question. */
export function currencyConfirmOptions(from: string, to: string, modeLabel: string) {
  return {
    title: `Change currency to ${to}?`,
    body: `Every amount in ${modeLabel} will convert from ${from} to ${to} at the live exchange rate — transactions, invoices, budgets, recurring bills, EMI plans and savings goals.`,
    detail: `The rate is fetched live when you confirm. Nothing is deleted, but all amounts will be re-priced in ${to}.`,
    confirmLabel: `Convert to ${to}`,
  };
}

export const SAVINGS_STATUS_LABELS: Record<string, string> = {
  completed: "Goal reached 🎉",
  overdue: "Past target date",
  on_track: "On track",
  behind: "Behind pace",
  not_started: "Not started yet",
};

export const INCOME_CATEGORIES = [
  "Customer payments",
  "Sales",
  "Retainers",
  "Other income",
];

export const EXPENSE_CATEGORIES = [
  "Salaries",
  "Rent",
  "Suppliers",
  "Subscriptions",
  "Marketing",
  "Utilities",
  "Travel",
  "Taxes & fees",
  "Equipment",
  "General",
];

// ---------- Money modes = separate workspaces ----------
// Each account has up to four completely separate workspaces, one per
// money mode. The server scopes every record to the active workspace
// (state.activeMode); switching modes never mixes data. Business and
// Creator are "business-like" (invoices, GST, scanner foregrounded);
// Personal and Student are "everyday" modes (daily money wording,
// business tools de-emphasised).

export type AppMode = "business" | "personal" | "creator" | "student";

export const APP_MODES: AppMode[] = ["personal", "business", "creator", "student"];

export const MODE_LABELS: Record<AppMode, string> = {
  personal: "Personal Money",
  business: "Business Money",
  creator: "Creator & Freelancer",
  student: "Student / First Salary",
};

export const MODE_ICONS: Record<AppMode, string> = {
  personal: "☰",
  business: "▤",
  creator: "✦",
  student: "🎓",
};

export function modeOf(state: State): AppMode {
  return state.activeMode ?? state.business.mode;
}

/** Everyday-money modes: daily-spending wording, business tools quieter. */
export function isPersonalLike(mode: AppMode): boolean {
  return mode === "personal" || mode === "student";
}

/** Business-like modes: invoices / GST / scanner presented at full weight. */
export function isBusinessLike(mode: AppMode): boolean {
  return mode === "business" || mode === "creator";
}

export const PERSONAL_INCOME_CATEGORIES = [
  "Salary",
  "Freelance & side work",
  "Family & friends",
  "Refunds",
  "Other income",
];

export const PERSONAL_EXPENSE_CATEGORIES = [
  "Food & groceries",
  "Rent",
  "Rent & home",
  "Bills",
  "Bills & utilities",
  "EMI",
  "Loans",
  "Shopping",
  "Extra expenses",
  "Transport",
  "Health",
  "Entertainment",
  "Education",
  "Subscriptions",
  "General",
];

export const CREATOR_INCOME_CATEGORIES = [
  "Client payments",
  "Brand deals",
  "Platform payouts",
  "Course & digital sales",
  "Other income",
];

export const CREATOR_EXPENSE_CATEGORIES = [
  "Equipment",
  "Software & subscriptions",
  "Travel",
  "Marketing",
  "Professional services",
  "Taxes & fees",
  "General",
];

export const STUDENT_INCOME_CATEGORIES = [
  "Pocket money",
  "Salary — first job",
  "Part-time & internships",
  "Scholarships",
  "Family & friends",
  "Other income",
];

export const STUDENT_EXPENSE_CATEGORIES = [
  "Food & canteen",
  "Fees & education",
  "Transport",
  "Books & courses",
  "Shopping",
  "Entertainment",
  "Bills & recharge",
  "General",
];

export function incomeCategoriesFor(mode: AppMode): string[] {
  switch (mode) {
    case "personal":
      return PERSONAL_INCOME_CATEGORIES;
    case "creator":
      return CREATOR_INCOME_CATEGORIES;
    case "student":
      return STUDENT_INCOME_CATEGORIES;
    default:
      return INCOME_CATEGORIES;
  }
}

export function expenseCategoriesFor(mode: AppMode): string[] {
  switch (mode) {
    case "personal":
      return PERSONAL_EXPENSE_CATEGORIES;
    case "creator":
      return CREATOR_EXPENSE_CATEGORIES;
    case "student":
      return STUDENT_EXPENSE_CATEGORIES;
    default:
      return EXPENSE_CATEGORIES;
  }
}

export function categoriesFor(
  mode: AppMode,
  type: "income" | "expense",
): string[] {
  return type === "income"
    ? incomeCategoriesFor(mode)
    : expenseCategoriesFor(mode);
}

// ---------- Custom categories ----------
// Picking "Custom" in a category dropdown lets the user type their own
// category name. The name is saved on the record itself and remembered
// server-side per workspace (state.customCategories, scoped by the
// server to the active workspace + direction), so it appears in the
// dropdown next time — in this workspace only, never in the others.
// The sentinel below is only ever a dropdown value, never a stored
// category name.

export const CUSTOM_CATEGORY = "__custom__";
export const CUSTOM_CATEGORY_LABEL = "✎ Custom — type your own";

/** Custom (user-typed) category names for one direction in the active
 *  workspace: the server-remembered list plus any non-built-in name
 *  already used by this workspace's own transactions, recurring
 *  schedules or budgets (covers names that arrived via CSV import or
 *  predate the remembered list). State is workspace-scoped by the
 *  server, so nothing here can leak in from another workspace. */
export function customCategoriesFor(
  state: State | undefined | null,
  mode: AppMode,
  type: "income" | "expense",
): string[] {
  if (!state) return [];
  const builtIn = new Set(categoriesFor(mode, type));
  const out: string[] = [];
  const push = (name: string) => {
    const n = name.trim();
    if (!n || builtIn.has(n)) return;
    if (!out.some((c) => c.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  for (const c of state.customCategories ?? []) {
    if (c.type === type) push(c.name);
  }
  for (const t of state.transactions) {
    if (t.type === type) push(t.category);
  }
  for (const r of state.recurring) {
    if (r.type === type) push(r.category);
  }
  if (type === "expense") {
    for (const b of state.budgets) push(b.category);
  }
  return out;
}

/** The full option list for a category dropdown in one workspace:
 *  the mode's built-in categories, then the user's remembered custom
 *  categories for that direction, then any `extra` names (e.g. the
 *  category of the record being edited) so nothing ever disappears,
 *  and "General" as the long-standing fallback. */
export function categoryOptionsFor(
  state: State | undefined | null,
  mode: AppMode,
  type: "income" | "expense",
  extra: (string | undefined | null)[] = [],
): string[] {
  return [
    ...categoriesFor(mode, type),
    ...customCategoriesFor(state, mode, type),
    ...extra.map((e) => (e ?? "").trim()).filter(Boolean),
    "General",
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/** Mode categories plus every category already used by stored transactions,
 *  so filters and editors keep working for records from either mode. */
export function allKnownCategories(state: State): string[] {
  const used = state.transactions.map((t) => t.category);
  const remembered = (state.customCategories ?? []).map((c) => c.name);
  return [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES, ...PERSONAL_INCOME_CATEGORIES, ...PERSONAL_EXPENSE_CATEGORIES, ...CREATOR_INCOME_CATEGORIES, ...CREATOR_EXPENSE_CATEGORIES, ...STUDENT_INCOME_CATEGORIES, ...STUDENT_EXPENSE_CATEGORIES, ...used, ...remembered]
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** How money moved. UPI is listed first — it is a first-class payment
 *  method here, recorded by the user on each transaction (there is no
 *  automatic bank/UPI sync). */
export const PAYMENT_METHODS = ["UPI", "Cash", "Card", "Bank transfer", "Other"] as const;

export const NOTE_CATEGORIES = [
  "Important",
  "Business Ideas",
  "Financial Plans",
  "Decisions",
  "Meeting Notes",
  "General",
];

/** Reads an uploaded image file as base64 (for AI vision calls). Shared by
 *  Scam Shield and the receipt scanner so the same size/type rules apply. */
export async function fileToBase64(file: File): Promise<{ dataBase64: string; mimeType: string }> {
  const buf = await file.arrayBuffer();
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as unknown as number[]);
  }
  return { dataBase64: btoa(s), mimeType: file.type };
}

export function fmtMoney(cents: number, currency: string, digits = 0): string {
  const v = cents / 100;
  const sym =
    currency === "INR"
      ? "₹"
      : currency === "USD"
        ? "$"
        : currency === "EUR"
          ? "€"
          : currency === "GBP"
            ? "£"
            : `${currency} `;
  const body = Math.abs(v).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${v < 0 ? "−" : ""}${sym}${body}`;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(key: string, delta: number): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function prettyDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function monthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

// ---------- financial engine (client copy of the server engine) ----------

export interface Summary {
  revenueCents: number;
  expensesCents: number;
  profitCents: number;
  cashCents: number;
  savingsCents: number;
  curRevenueCents: number;
  curExpensesCents: number;
  prevRevenueCents: number;
  prevExpensesCents: number;
  avgMonthlyNetCents: number;
  runwayMonths: number | null;
  pendingInCents: number;
  pendingOutCents: number;
}

export function summarise(state: State): Summary {
  const posted = state.transactions.filter((t) => t.status === "posted");
  const revenue = posted
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amountCents, 0);
  const expenses = posted
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amountCents, 0);
  // Savings transfers are not income or expenses: revenue / expenses /
  // profit above ignore them completely. Available cash subtracts the
  // net amount held in this workspace's savings pots exactly once —
  // the money is set aside, not spent, and withdrawing returns it.
  const savings = totalSavedCents(state);
  const cash = state.business.openingBalanceCents + revenue - expenses - savings;
  const cur = monthKey(todayStr());
  const prev = shiftMonth(cur, -1);
  const sumMonth = (type: "income" | "expense", mk: string) =>
    posted
      .filter((t) => t.type === type && monthKey(t.date) === mk)
      .reduce((s, t) => s + t.amountCents, 0);
  let burnSum = 0;
  let burnMonths = 0;
  for (let i = 1; i <= 3; i++) {
    const mk = shiftMonth(cur, -i);
    if (state.transactions.some((t) => monthKey(t.date) === mk)) {
      burnSum += sumMonth("income", mk) - sumMonth("expense", mk);
      burnMonths++;
    }
  }
  const avgNet = burnMonths > 0 ? burnSum / burnMonths : 0;
  const pending = state.transactions.filter((t) => t.status === "pending");
  return {
    revenueCents: revenue,
    expensesCents: expenses,
    profitCents: revenue - expenses,
    cashCents: cash,
    savingsCents: savings,
    curRevenueCents: sumMonth("income", cur),
    curExpensesCents: sumMonth("expense", cur),
    prevRevenueCents: sumMonth("income", prev),
    prevExpensesCents: sumMonth("expense", prev),
    avgMonthlyNetCents: Math.round(avgNet),
    runwayMonths: avgNet < 0 && cash > 0 ? cash / Math.abs(avgNet) : null,
    pendingInCents: pending
      .filter((t) => t.type === "income")
      .reduce((s, t) => s + t.amountCents, 0),
    pendingOutCents: pending
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + t.amountCents, 0),
  };
}

export function healthScore(state: State, s: Summary): number {
  if (state.transactions.length === 0) return 0;
  let score = 50;
  if (s.revenueCents > 0) {
    const margin = s.profitCents / s.revenueCents;
    score += Math.max(-25, Math.min(25, margin * 50));
  }
  if (s.runwayMonths != null) {
    score += s.runwayMonths >= 6 ? 12 : s.runwayMonths >= 3 ? 6 : -10;
  } else if (s.avgMonthlyNetCents >= 0 && s.cashCents > 0) {
    score += 10;
  }
  const overdue = state.invoices.filter(
    (i) => i.effectiveStatus === "overdue",
  ).length;
  score -= Math.min(15, overdue * 5);
  if (s.curExpensesCents > s.prevExpensesCents * 1.3 && s.prevExpensesCents > 0)
    score -= 6;
  if (s.cashCents < 0) score -= 15;
  return Math.max(2, Math.min(98, Math.round(score)));
}

// ---------- forecast ----------

export interface ForecastDay {
  date: string;
  balanceCents: number;
  inflowCents: number;
  outflowCents: number;
}

export function buildForecast(
  state: State,
  horizonDays: number,
): {
  days: ForecastDay[];
  startCash: number;
  expectedIn: number;
  expectedOut: number;
  closing: number;
  minBalance: number;
  minDate: string | null;
  assumptions: string[];
} {
  const s = summarise(state);
  const today = todayStr();
  const end = addDays(today, horizonDays);
  const events = new Map<string, { in: number; out: number }>();
  const add = (date: string, kind: "in" | "out", cents: number) => {
    if (date < today || date > end) return;
    const e = events.get(date) ?? { in: 0, out: 0 };
    e[kind] += cents;
    events.set(date, e);
  };
  let invCount = 0;
  for (const inv of state.invoices) {
    if (inv.status === "sent") {
      add(inv.dueDate < today ? addDays(today, 3) : inv.dueDate, "in", inv.totalCents);
      invCount++;
    }
  }
  let recCount = 0;
  for (const r of state.recurring) {
    if (!r.active) continue;
    let d = r.nextDate;
    let guard = 0;
    while (d <= end && guard < 40) {
      if (d >= today) {
        add(d, r.type === "income" ? "in" : "out", r.amountCents);
        recCount++;
      }
      d =
        r.frequency === "weekly"
          ? addDays(d, 7)
          : (() => {
              const [y = 1970, m = 1, dd = 1] = d.split("-").map(Number);
              const nd = new Date(y, m, dd);
              return `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
            })();
      guard++;
    }
  }
  for (const t of state.transactions) {
    if (t.status === "pending") {
      add(t.date < today ? today : t.date, t.type === "income" ? "in" : "out", t.amountCents);
    }
  }
  const days: ForecastDay[] = [];
  let bal = s.cashCents;
  let expectedIn = 0;
  let expectedOut = 0;
  let minBalance = bal;
  let minDate: string | null = null;
  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i);
    const e = events.get(date) ?? { in: 0, out: 0 };
    bal += e.in - e.out;
    expectedIn += e.in;
    expectedOut += e.out;
    if (bal < minBalance) {
      minBalance = bal;
      minDate = date;
    }
    days.push({ date, balanceCents: bal, inflowCents: e.in, outflowCents: e.out });
  }
  return {
    days,
    startCash: s.cashCents,
    expectedIn,
    expectedOut,
    closing: bal,
    minBalance,
    minDate,
    assumptions: [
      `Starts from today's calculated cash balance, which counts posted transactions only.`,
      `${invCount} unpaid sent invoice(s) are assumed to be paid on their due date (overdue ones within 3 days).`,
      `${recCount} occurrence(s) of your active recurring cashflows fall inside this window.`,
      `Pending transactions are assumed to settle on their recorded date.`,
      `No new sales, one-off costs or late payments are assumed. This is an estimate, never a guarantee.`,
    ],
  };
}

// ---------- payment calendar ----------
// One unified list of dated money obligations and expectations, built only
// from the user's own records: recurring cashflow occurrences, unpaid sent
// invoices, unpaid EMI instalments and pending transactions.

export interface CalEvent {
  id: string;
  date: string;
  direction: "pay" | "collect";
  source: "recurring" | "invoice" | "emi" | "pending";
  title: string;
  detail: string;
  amountCents: number;
  overdue: boolean;
  /** EMI instalment id, when the event can be marked collected in place. */
  instalmentId?: string;
}

function stepMonthly(date: string): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const nd = new Date(y, m, d);
  return `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
}

export function buildCalendarEvents(
  state: State,
  from: string,
  to: string,
): CalEvent[] {
  const today = todayStr();
  const out: CalEvent[] = [];
  for (const r of state.recurring) {
    if (!r.active) continue;
    let d = r.nextDate;
    let guard = 0;
    while (d <= to && guard < 80) {
      // Only the recorded next occurrence can be overdue; later occurrences
      // are projections, so past steps between nextDate and today are not
      // multiplied into a pile of phantom missed bills.
      if (d >= from && (d >= today || d === r.nextDate)) {
        out.push({
          id: `rec-${r.id}-${d}`,
          date: d,
          direction: r.type === "income" ? "collect" : "pay",
          source: "recurring",
          title: r.description || r.category,
          detail: `Recurring ${r.frequency} · ${r.category}`,
          amountCents: r.amountCents,
          overdue: d < today,
        });
      }
      d = r.frequency === "weekly" ? addDays(d, 7) : stepMonthly(d);
      guard++;
    }
  }
  for (const inv of state.invoices) {
    if (inv.status !== "sent") continue;
    if (inv.dueDate < from || inv.dueDate > to) continue;
    out.push({
      id: `inv-${inv.id}`,
      date: inv.dueDate,
      direction: "collect",
      source: "invoice",
      title: `Invoice ${inv.number} — ${inv.customerName}`,
      detail: inv.effectiveStatus === "overdue" ? "Invoice overdue" : "Invoice due",
      amountCents: inv.totalCents,
      overdue: inv.effectiveStatus === "overdue",
    });
  }
  for (const plan of state.emiPlans) {
    for (const inst of plan.instalments) {
      if (inst.status === "paid") continue;
      if (inst.dueDate < from || inst.dueDate > to) continue;
      out.push({
        id: `emi-${inst.id}`,
        date: inst.dueDate,
        direction: "collect",
        source: "emi",
        title: `EMI ${inst.seq} of ${plan.instalmentCount} — ${plan.customerName}`,
        detail: `${plan.product}${inst.effectiveStatus === "overdue" ? " · overdue" : ""}`,
        amountCents: inst.amountCents,
        overdue: inst.effectiveStatus === "overdue",
        instalmentId: inst.id,
      });
    }
  }
  for (const t of state.transactions) {
    if (t.status !== "pending") continue;
    if (t.date < from || t.date > to) continue;
    out.push({
      id: `txn-${t.id}`,
      date: t.date,
      direction: t.type === "income" ? "collect" : "pay",
      source: "pending",
      title: t.description || t.category,
      detail: `Pending transaction · ${t.category}${t.counterparty ? ` · ${t.counterparty}` : ""}`,
      amountCents: t.amountCents,
      overdue: t.date < today,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

// ---------- CSV ----------

export function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function txnsToCsv(txns: Txn[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = "date,type,status,category,description,counterparty,amount,payment_method";
  const lines = txns.map((t) =>
    [
      t.date,
      t.type,
      t.status,
      esc(t.category),
      esc(t.description),
      esc(t.counterparty),
      (t.amountCents / 100).toFixed(2),
      esc(t.paymentMethod ?? ""),
    ].join(","),
  );
  return [head, ...lines].join("\n");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

// ---------- minimal PDF writer (real, valid PDF files) ----------

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(title: string, lines: string[]): Blob {
  const perPage = 46;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([]);
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font, then per page: page obj + content obj
  pages.forEach((pageLines, pi) => {
    const pageId = 4 + pi * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    let content = `BT /F1 16 Tf 56 780 Td (${pdfEscape(title)}) Tj ET\n`;
    content += `BT /F1 10 Tf 56 756 Td 15 TL `;
    content += pageLines
      .map((l) => `(${pdfEscape(l.slice(0, 110))}) Tj T* `)
      .join("");
    content += "ET";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  const maxId = 3 + pages.length * 2;
  for (let id = 1; id <= maxId; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id] ?? ""}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

export function downloadPdf(name: string, title: string, lines: string[]) {
  const blob = makePdf(title, lines);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
