// Lend / Borrow ledger — pure record logic (harness-covered in
// scripts/lend-borrow-test.mjs). Tracks money lent to someone
// ("owed to me") and money borrowed from someone ("I owe"): person,
// amount, date, optional due date, optional note, open/settled.
// Settling an open record closes it AND records the money actually
// moving — exactly one linked Money Flow transaction, the EMI rule
// applied to lend/borrow (owner's decision, 2026-11-21: "Settle pe
// entry banao — EMI jaisa"). At most one transaction per entry, ever:
// settleTransactionFor returns null when the entry is already
// settled or a linked transaction already exists, so settling twice
// (or reopening and settling again) never creates a second one.
// Dates are yyyy-mm-dd strings and compared as strings, which is
// exact for that format; "today" is IST, like the rest of the app.
export type LendBorrowDirection = "lent" | "borrowed";
export type LendBorrowStatus = "open" | "settled";

export interface LendBorrowRecord {
  person: string;
  direction: LendBorrowDirection;
  amountCents: number;
  date: string;
  dueDate: string | null;
  note: string;
  status: LendBorrowStatus;
  settledDate: string | null;
}

/** Same amount ceiling as receipts: ₹10,00,00,000 in paise. */
export const MAX_LEND_BORROW_CENTS = 100_000_000_00;

export function isLendBorrowDirection(v: string): v is LendBorrowDirection {
  return v === "lent" || v === "borrowed";
}

export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export type NormalizeLendBorrowResult =
  | { ok: true; record: LendBorrowRecord }
  | { ok: false; reason: string };

/** Validate and clean a lend/borrow draft. Never throws. */
export function normalizeLendBorrow(raw: unknown): NormalizeLendBorrowResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const person = typeof r.person === "string" ? r.person.trim() : "";
  if (!person) return { ok: false, reason: "Add the person's name." };
  if (person.length > 120) return { ok: false, reason: "The name is too long (120 characters max)." };
  if (typeof r.direction !== "string" || !isLendBorrowDirection(r.direction)) {
    return { ok: false, reason: "Choose whether you lent the money or borrowed it." };
  }
  const amountCents = r.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: "Enter an amount above zero." };
  }
  if (amountCents > MAX_LEND_BORROW_CENTS) {
    return { ok: false, reason: "That amount is too large for one entry." };
  }
  if (typeof r.date !== "string" || !isValidDateStr(r.date)) {
    return { ok: false, reason: "Enter a valid date (for example 2026-11-20)." };
  }
  const dueRaw = r.dueDate;
  const dueDate =
    dueRaw === null || dueRaw === undefined || dueRaw === "" ? null : typeof dueRaw === "string" ? dueRaw : null;
  if (dueDate !== null && !isValidDateStr(dueDate)) {
    return { ok: false, reason: "Enter a valid due date, or leave it empty." };
  }
  const note = typeof r.note === "string" ? r.note.trim().slice(0, 500) : "";
  const status: LendBorrowStatus = r.status === "settled" ? "settled" : "open";
  const settledRaw = r.settledDate;
  const settledDate =
    settledRaw === null || settledRaw === undefined || settledRaw === ""
      ? null
      : typeof settledRaw === "string" && isValidDateStr(settledRaw)
        ? settledRaw
        : null;
  return {
    ok: true,
    record: {
      person,
      direction: r.direction,
      amountCents,
      date: r.date,
      dueDate,
      note,
      status,
      settledDate: status === "settled" ? settledDate : null,
    },
  };
}

/** True when an open record's due date has passed. Due today is not overdue. */
export function isOverdue(record: LendBorrowRecord, today: string): boolean {
  return (
    record.status === "open" &&
    record.dueDate !== null &&
    isValidDateStr(today) &&
    record.dueDate < today
  );
}

export interface LendBorrowTotals {
  owedToMeCents: number;
  iOweCents: number;
  netCents: number;
  openCount: number;
  overdueCount: number;
  settledCount: number;
}

/** Open lent minus open borrowed is the net position: positive means
 *  more is owed to you than you owe. Settled records never count. */
export function lendBorrowTotals(records: LendBorrowRecord[], today: string): LendBorrowTotals {
  let owedToMeCents = 0;
  let iOweCents = 0;
  let openCount = 0;
  let overdueCount = 0;
  let settledCount = 0;
  for (const rec of records) {
    if (rec.status === "settled") {
      settledCount++;
      continue;
    }
    openCount++;
    if (rec.direction === "lent") owedToMeCents += rec.amountCents;
    else iOweCents += rec.amountCents;
    if (isOverdue(rec, today)) overdueCount++;
  }
  return {
    owedToMeCents,
    iOweCents,
    netCents: owedToMeCents - iOweCents,
    openCount,
    overdueCount,
    settledCount,
  };
}

export interface LendBorrowFilter {
  direction: "all" | LendBorrowDirection;
  hideCompleted: boolean;
}

export function filterLendBorrow(records: LendBorrowRecord[], filter: LendBorrowFilter): LendBorrowRecord[] {
  return records.filter(
    (rec) =>
      (filter.direction === "all" || rec.direction === filter.direction) &&
      (!filter.hideCompleted || rec.status === "open"),
  );
}

/** Overdue first, then earliest due date (no due date last), then
 *  newest first. Stable enough for a short ledger list. */
export function sortLendBorrow<T extends LendBorrowRecord>(records: T[], today: string): T[] {
  return [...records].sort((a, b) => {
    const ao = isOverdue(a, today) ? 0 : 1;
    const bo = isOverdue(b, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.dueDate ?? "9999-12-31";
    const bd = b.dueDate ?? "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    return 0;
  });
}

export interface SettleTransactionDraft {
  type: "income" | "expense";
  category: string;
  description: string;
  counterparty: string;
  amountCents: number;
  date: string;
}

/**
 * The Money Flow transaction a settle creates, or null when none is
 * due. The money that moves is the entry's own amount, dated today:
 * someone repaying her is income, her repaying someone is an
 * expense. The description says what happened (repayment received /
 * repayment made); the counterparty is the person, exactly like the
 * EMI collect transaction names its customer — so the name appears
 * once on the Money Flow row, not twice (the description must not
 * repeat it, or the row reads "Rohan paid back Rohan"). Categories
 * match the app's own forms: a repayment to her is "Other income",
 * a repayment by her is "Loans". No transaction is due when the
 * entry is already settled — rows settled before this rule existed
 * never get one retroactively — or when a linked transaction already
 * exists, so settling twice can never double-record the money.
 * Never throws.
 */
export function settleTransactionFor(
  entry: Pick<LendBorrowRecord, "direction" | "person" | "amountCents" | "status">,
  existingTransactionId: string | null,
  today: string,
): SettleTransactionDraft | null {
  if (entry.status !== "open") return null;
  if (existingTransactionId) return null;
  if (entry.direction === "lent") {
    return {
      type: "income",
      category: "Other income",
      description: `Lend/borrow settled — repayment received`,
      counterparty: entry.person,
      amountCents: entry.amountCents,
      date: today,
    };
  }
  return {
    type: "expense",
    category: "Loans",
    description: `Lend/borrow settled — repayment made`,
    counterparty: entry.person,
    amountCents: entry.amountCents,
    date: today,
  };
}
