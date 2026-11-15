// Optimistic ledger patching (bug fix, 2026-11-15).
//
// Invalidating ["cg-state"] after a mutation was not enough on live:
// the refetch re-runs the whole getState ledger, which takes ~15–20s
// on a cold start, so every save looked stale until a reload — and a
// refetch that fails (retry: false) silently leaves the old data in
// place. So App's "cg:mutated" listener first patches the cached
// state from the mutation's own arguments + response (this module),
// and only then cancels any in-flight fetch and invalidates for a
// server reconciliation. The patch uses only values the server just
// confirmed (ids from the response, the saved fields from the call),
// so it can never invent a record — and the refetch that follows
// corrects anything it got wrong (e.g. an optimistic item id).
//
// Only the demo-critical flows are patched here (Money, Invoices,
// Scam Shield, mode switch, notes). Everything else (savings, EMI,
// recurring, budgets, scenarios, settings) relies on the refetch,
// which is fast now that getState runs its queries in parallel.

import { todayStr, type Invoice, type State, type Txn } from "./lib";

export interface MutationDetail {
  action: string;
  args: Record<string, unknown>;
  data: unknown;
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function nowIso(): string {
  return new Date().toISOString();
}

const PAYMENT_METHODS = ["UPI", "Cash", "Card", "Bank transfer", "Other"];

/** Same invoice maths as the server (server/actions.ts invoiceTotals):
 *  per-item round(qty × unit price), discount and tax as percentages. */
function invoiceTotals(
  items: { qty: number; unitPriceCents: number }[],
  discountPct: number,
  taxPct: number,
): { subtotal: number; discount: number; tax: number; total: number } {
  const subtotal = items.reduce(
    (s, it) => s + Math.round((Math.round(it.qty * 1000) * it.unitPriceCents) / 1000),
    0,
  );
  const discount = Math.round((subtotal * discountPct) / 100);
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * taxPct) / 100);
  return { subtotal, discount, tax, total: taxable + tax };
}

function effectiveStatus(status: string, dueDate: string): string {
  if (status === "paid") return "paid";
  if (status === "sent" && dueDate < todayStr()) return "overdue";
  return status;
}

function sortTxns(txns: Txn[]): Txn[] {
  return [...txns].sort((a, b) =>
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
}

function buildInvoice(
  prev: Invoice | undefined,
  args: Record<string, unknown>,
  id: string,
): Invoice {
  const items = (Array.isArray(args.items) ? args.items : []) as {
    description?: unknown;
    qty?: unknown;
    unitPriceCents?: unknown;
  }[];
  const discountPct = asNum(args.discountPct);
  const taxPct = asNum(args.taxPct);
  const totals = invoiceTotals(
    items.map((it) => ({ qty: asNum(it.qty, 1), unitPriceCents: asNum(it.unitPriceCents) })),
    discountPct,
    taxPct,
  );
  const status = asStr(args.status, "draft");
  const dueDate = asStr(args.dueDate, todayStr());
  const now = nowIso();
  return {
    id,
    number: asStr(args.number),
    customerName: asStr(args.customerName),
    customerEmail: asStr(args.customerEmail),
    status,
    effectiveStatus: effectiveStatus(status, dueDate),
    issueDate: asStr(args.issueDate, todayStr()),
    dueDate,
    discountPct,
    taxPct,
    notes: asStr(args.notes),
    items: items.map((it, i) => ({
      id: prev?.items[i]?.id ?? `optimistic-item-${i}`,
      description: asStr(it.description),
      qty: asNum(it.qty, 1),
      unitPriceCents: asNum(it.unitPriceCents),
    })),
    subtotalCents: totals.subtotal,
    discountCents: totals.discount,
    taxCents: totals.tax,
    totalCents: totals.total,
    demo: prev?.demo ?? false,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Patch the cached getState result for one successful mutation.
 *  Returns the previous state unchanged when there is nothing safe
 *  to patch (unknown action, missing record, no cached state yet). */
export function patchStateAfterMutation(
  prev: State | undefined,
  detail: MutationDetail,
): State | undefined {
  if (!prev) return prev;
  const { action, args, data } = detail;
  const d = (data ?? {}) as Record<string, unknown>;
  const now = nowIso();

  switch (action) {
    case "saveTransaction": {
      const id = asStr(d.id);
      if (!id) return prev;
      const method = asStr(args.paymentMethod);
      const category = asStr(args.category).trim() || "General";
      const existing = prev.transactions.find((t) => t.id === id);
      if (existing) {
        return {
          ...prev,
          transactions: prev.transactions.map((t) =>
            t.id === id
              ? {
                  ...t,
                  type: asStr(args.type, t.type),
                  status: asStr(args.status, t.status),
                  category,
                  description: asStr(args.description, t.description),
                  counterparty: asStr(args.counterparty, t.counterparty),
                  amountCents: asNum(args.amountCents, t.amountCents),
                  date: asStr(args.date, t.date),
                  paymentMethod: PAYMENT_METHODS.includes(method) ? method : "",
                  updatedAt: now,
                }
              : t,
          ),
        };
      }
      const txn: Txn = {
        id,
        type: asStr(args.type, "expense"),
        status: asStr(args.status, "posted"),
        category,
        description: asStr(args.description),
        counterparty: asStr(args.counterparty),
        amountCents: asNum(args.amountCents),
        date: asStr(args.date, todayStr()),
        paymentMethod: PAYMENT_METHODS.includes(method) ? method : "",
        invoiceId: null,
        demo: false,
        createdAt: now,
        updatedAt: now,
      };
      return { ...prev, transactions: sortTxns([...prev.transactions, txn]) };
    }

    case "deleteTransaction": {
      const id = asStr(args.id);
      if (!id) return prev;
      return { ...prev, transactions: prev.transactions.filter((t) => t.id !== id) };
    }

    case "saveInvoice": {
      const id = asStr(d.id);
      if (!id) return prev;
      const existing = prev.invoices.find((i) => i.id === id);
      const inv = buildInvoice(existing, args, id);
      const invoices = existing
        ? prev.invoices.map((i) => (i.id === id ? inv : i))
        : [inv, ...prev.invoices];
      return { ...prev, invoices };
    }

    case "setInvoiceStatus": {
      const id = asStr(args.id);
      const status = asStr(args.status);
      if (!id || !status) return prev;
      return {
        ...prev,
        invoices: prev.invoices.map((i) =>
          i.id === id
            ? { ...i, status, effectiveStatus: effectiveStatus(status, i.dueDate), updatedAt: now }
            : i,
        ),
      };
    }

    case "markInvoicePaid": {
      const id = asStr(args.id);
      const inv = prev.invoices.find((i) => i.id === id);
      if (!inv) return prev;
      const invoices = prev.invoices.map((i) =>
        i.id === id ? { ...i, status: "paid", effectiveStatus: "paid", updatedAt: now } : i,
      );
      // The server creates exactly one linked income transaction; mirror
      // it so Money Flow shows it at once. If this was a repeat call
      // (alreadyPaid) the transaction already exists — only add it when
      // the response says a new one was created and it isn't cached.
      const txnId = asStr(d.transactionId);
      let transactions = prev.transactions;
      if (d.ok === true && txnId && !prev.transactions.some((t) => t.id === txnId)) {
        const linked: Txn = {
          id: txnId,
          type: "income",
          status: "posted",
          category: "Customer payments",
          description: `Payment received for invoice ${inv.number}`,
          counterparty: inv.customerName,
          amountCents: inv.totalCents,
          date: todayStr(),
          paymentMethod: "",
          invoiceId: inv.id,
          demo: inv.demo,
          createdAt: now,
          updatedAt: now,
        };
        transactions = sortTxns([...prev.transactions, linked]);
      }
      return { ...prev, invoices, transactions };
    }

    case "deleteInvoice": {
      const id = asStr(args.id);
      if (!id) return prev;
      return { ...prev, invoices: prev.invoices.filter((i) => i.id !== id) };
    }

    case "analyseScamText": {
      const verdict = asStr(d.verdict);
      const riskScore = asNum(d.riskScore, -1);
      if (!verdict || riskScore < 0) return prev;
      const text = asStr(args.text);
      const hasImage = typeof args.imageBase64 === "string" && args.imageBase64.length > 0;
      const reasons = Array.isArray(d.reasons)
        ? (d.reasons as { code?: unknown; title?: unknown; detail?: unknown; severity?: unknown }[])
            .filter((r) => typeof r.title === "string" && typeof r.detail === "string")
            .map((r) => ({
              code: asStr(r.code),
              title: asStr(r.title),
              detail: asStr(r.detail),
              severity: (["critical", "high", "medium", "info"].includes(asStr(r.severity))
                ? asStr(r.severity)
                : "medium") as "critical" | "high" | "medium" | "info",
            }))
        : [];
      const check = {
        id: `optimistic-scam-${Date.now()}`,
        kind: hasImage && text ? "both" : hasImage ? "screenshot" : "text",
        excerpt: (text || "Screenshot check").slice(0, 140),
        verdict,
        riskScore,
        reasons,
        createdAt: now,
      };
      return { ...prev, scamChecks: [check, ...prev.scamChecks].slice(0, 10) };
    }

    case "saveNote": {
      const id = asStr(d.id);
      if (!id) return prev;
      const existing = prev.notes.find((n) => n.id === id);
      const note = {
        id,
        title: asStr(args.title),
        content: asStr(args.content),
        category: asStr(args.category, "Financial Plans"),
        tags: asStr(args.tags),
        pinned: asBool(args.pinned),
        sourceModule: asStr(args.sourceModule),
        sourceId: asStr(args.sourceId),
        demo: existing?.demo ?? false,
        createdAt: existing?.createdAt ?? asStr(d.updatedAt, now),
        updatedAt: asStr(d.updatedAt, now),
      };
      const notes = existing
        ? prev.notes.map((n) => (n.id === id ? note : n))
        : [note, ...prev.notes];
      return { ...prev, notes };
    }

    case "setMode": {
      const mode = asStr(args.mode);
      if (!["business", "personal", "creator", "student"].includes(mode)) return prev;
      // The other workspace's records are unknown until the refetch
      // lands — never show the old workspace's lists under the new
      // mode's name. Empty lists render the empty states, then the
      // refetch fills them (fast now that getState is parallel).
      return {
        ...prev,
        activeMode: mode as State["activeMode"],
        transactions: [],
        invoices: [],
        emiPlans: [],
        savingsGoals: [],
        scamChecks: [],
        notes: [],
        scenarios: [],
        recurring: [],
        budgets: [],
        customCategories: [],
        conversations: [],
        activity: [],
      };
    }

    default:
      return prev;
  }
}
