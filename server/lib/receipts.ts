// Receipt scanning (server/lib/receipts.ts) — pure functions, no AI calls.
// The AI vision model reads a bill/receipt photo and returns line items;
// this module normalises whatever the model (or the honest fallback)
// returns into paise amounts the app can save. The zod shape the model
// must return lives next to imageOutShape in server/actions.ts.
// NOTHING here invents an item or an amount: an unreadable photo, a
// failed AI call or a bad model answer all normalise to zero items, and
// the client says so instead of recording anything.

// Categories the model may pick from. Custom categories are still fine:
// an unknown name is kept as-is (the app remembers custom categories per
// workspace), so this list guides the model, it does not restrict it.
export const RECEIPT_CATEGORIES = [
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
  "Equipment",
  "Software & subscriptions",
  "Travel",
  "Marketing",
  "Professional services",
  "Taxes & fees",
  "General",
];

export type ReceiptItem = {
  name: string;
  amountCents: number;
  category: string;
};

export type NormalisedReceipt = {
  readable: boolean;
  merchantName: string | null;
  receiptDate: string | null;
  currencyCode: string;
  items: ReceiptItem[];
  itemsTotalCents: number;
  receiptTotalCents: number | null;
  totalMismatch: boolean;
  note: string;
};

const MAX_ITEMS = 50;
const MAX_AMOUNT_CENTS = 100_000_000_00; // same ceiling as transaction inputs

function cleanDate(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates the regex lets through (e.g. 2026-02-30).
  if (
    date.getUTCFullYear() !== Number(m[1]) ||
    date.getUTCMonth() + 1 !== Number(m[2]) ||
    date.getUTCDate() !== Number(m[3])
  )
    return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function cleanCurrency(code: unknown): string {
  if (typeof code !== "string") return "INR";
  const c = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "INR";
}

/** Normalise any model/fallback result into a safe draft. Never invents. */
export function normalizeReceipt(raw: unknown): NormalisedReceipt {
  const empty = (readable: boolean, note: string): NormalisedReceipt => ({
    readable,
    merchantName: null,
    receiptDate: null,
    currencyCode: "INR",
    items: [],
    itemsTotalCents: 0,
    receiptTotalCents: null,
    totalMismatch: false,
    note,
  });
  if (!raw || typeof raw !== "object") {
    return empty(false, "The receipt could not be read.");
  }
  const r = raw as Record<string, unknown>;
  const readable = r.readable === true;
  const items: ReceiptItem[] = [];
  if (readable && Array.isArray(r.items)) {
    for (const it of r.items.slice(0, MAX_ITEMS)) {
      if (!it || typeof it !== "object") continue;
      const row = it as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim().slice(0, 200) : "";
      const amount =
        typeof row.amount === "number" && Number.isFinite(row.amount)
          ? Math.round(row.amount * 100)
          : -1;
      if (!name || amount <= 0 || amount > MAX_AMOUNT_CENTS) continue;
      const category =
        typeof row.category === "string" && row.category.trim()
          ? row.category.trim().slice(0, 60)
          : "General";
      items.push({ name, amountCents: amount, category });
    }
  }
  const itemsTotalCents = items.reduce((a, i) => a + i.amountCents, 0);
  const totalAmount =
    typeof r.totalAmount === "number" && Number.isFinite(r.totalAmount)
      ? Math.round(r.totalAmount * 100)
      : null;
  const receiptTotalCents =
    totalAmount !== null && totalAmount > 0 && totalAmount <= MAX_AMOUNT_CENTS
      ? totalAmount
      : null;
  // Totals disagree by more than one smallest unit: flag it, never
  // silently adjust an item to force a match.
  const totalMismatch =
    receiptTotalCents !== null &&
    Math.abs(itemsTotalCents - receiptTotalCents) > 1;
  const note =
    typeof r.notes === "string" ? r.notes.trim().slice(0, 300) : "";
  return {
    readable,
    merchantName:
      typeof r.merchantName === "string" && r.merchantName.trim()
        ? r.merchantName.trim().slice(0, 120)
        : null,
    receiptDate: cleanDate(r.receiptDate),
    currencyCode: cleanCurrency(r.currencyCode),
    items,
    itemsTotalCents,
    receiptTotalCents,
    totalMismatch,
    note:
      !readable && !note
        ? "The receipt could not be read — try a clearer photo."
        : note,
  };
}

/** The honest empty result: used when the AI call fails or the photo is
 *  not a readable receipt. Zero items, so nothing can be recorded. */
export function emptyReceipt(note?: string): NormalisedReceipt {
  return {
    readable: false,
    merchantName: null,
    receiptDate: null,
    currencyCode: "INR",
    items: [],
    itemsTotalCents: 0,
    receiptTotalCents: null,
    totalMismatch: false,
    note: note ?? "The receipt could not be read — try a clearer photo.",
  };
}
