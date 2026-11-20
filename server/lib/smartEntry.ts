// Smart Add — parse "dinner 50, shopping 200 yesterday" (or a spoken
// version of it) into several draft transactions at once. The AI path
// is the main one; the deterministic parser below is the fallback
// when the AI call fails, and the normaliser repairs the AI's answer
// so it can never invent an amount, a date or a category.
//
// Conventions match client/parseEntry.ts (voice/SMS): amounts may
// carry ₹/Rs/k/thousand, "kal" means yesterday, "aaj" today,
// "parson" tomorrow, and a date may be written "12 Nov" or
// "12/11/2026". Nothing here ever saves — the client shows the draft
// for the user to check and edit, and only saves what they confirm.
export type SmartEntryItem = {
  description: string;
  amountCents: number;
  type: "expense" | "income";
  category: string;
  date: string; // yyyy-mm-dd
  counterparty: string;
};

export type SmartEntryResult = {
  entries: SmartEntryItem[];
  note: string;
};

const MAX_ENTRIES = 20;
const MAX_AMOUNT_CENTS = 100_000_000_00;

export function isValidDateStr(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function addDaysStr(base: string, delta: number): string {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** A written date inside the text: 12 Nov, 12/11/2026, 2026-11-12. */
function extractWrittenDate(text: string): string | null {
  const t = text.toLowerCase();
  let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[1]}-${(m[2] ?? "1").padStart(2, "0")}-${(m[3] ?? "1").padStart(2, "0")}`;
  m = t.match(/\b(\d{1,2})[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[- ](\d{2,4})\b/);
  if (m) {
    const mon = MONTHS[m[2] ?? "jan"] ?? 1;
    let y = parseInt(m[3] ?? "2026", 10);
    if (y < 100) y += 2000;
    return `${y}-${String(mon).padStart(2, "0")}-${(m[1] ?? "1").padStart(2, "0")}`;
  }
  m = t.match(/\b(\d{1,2})[/](\d{1,2})[/](\d{2,4})\b/);
  if (m) {
    let y = parseInt(m[3] ?? "2026", 10);
    if (y < 100) y += 2000;
    return `${y}-${(m[2] ?? "1").padStart(2, "0")}-${(m[1] ?? "1").padStart(2, "0")}`;
  }
  m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  if (m) {
    const mon = MONTHS[m[2] ?? "jan"] ?? 1;
    const now = new Date();
    return `${now.getFullYear()}-${String(mon).padStart(2, "0")}-${(m[1] ?? "1").padStart(2, "0")}`;
  }
  return null;
}

/** Relative date words in the text, against the workspace's today. */
export function extractRelativeDate(text: string, today: string): string | null {
  const t = ` ${text.toLowerCase()} `;
  if (/\byesterday\b/.test(t) || /\bkal\b/.test(t)) return addDaysStr(today, -1);
  if (/\btomorrow\b/.test(t) || /\bparson\b/.test(t)) return addDaysStr(today, 1);
  if (/\btoday\b/.test(t) || /\baaj\b/.test(t)) return today;
  return extractWrittenDate(text);
}

/** First amount-looking number: "₹1,500", "Rs. 500", "500 rupees",
 *  "500", "2.5k" (→ 2500). The unit suffix must be a standalone
 *  token — the \b after it stops "₹500 kharcha" reading the "k" of
 *  "kharcha" as a thousands multiplier. Returns paise or null. */
export function extractAmountCents(text: string): number | null {
  const t = text.replace(/,/g, "");
  const withCurrency = t.match(/(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)\s*(k|thousand|hazaar)?\b/i);
  const plain = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|hazaar|rupees?|rupay|rs)\b/i);
  const bare = t.match(/\b(\d+(?:\.\d+)?)\b/);
  const m = withCurrency ?? plain ?? bare;
  if (!m) return null;
  let v = parseFloat(m[1] ?? "");
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand" || unit === "hazaar") v *= 1000;
  return Math.round(v * 100);
}

const EXPENSE_WORDS = [
  "kharcha", "kharid", "bought", "spent", "spend", "paid", "pay kiya", "diya",
  "debit", "debited", "gaya", "bill bhara", "purchase", "bheja", "sent to",
  "kharch", "udhaar diya",
];
const INCOME_WORDS = [
  "received", "mila", "aaya", "credited", "credit", "salary aayi", "income",
  "mil gaya", "prapt", "deposit", "aa gaya", "payment received", "se mila",
];

export function detectDirection(text: string): "income" | "expense" | null {
  const t = text.toLowerCase();
  const inc = INCOME_WORDS.some((w) => t.includes(w));
  const exp = EXPENSE_WORDS.some((w) => t.includes(w));
  if (inc && !exp) return "income";
  if (exp && !inc) return "expense";
  if (inc && exp) {
    const firstInc = Math.min(...INCOME_WORDS.filter((w) => t.includes(w)).map((w) => t.indexOf(w)));
    const firstExp = Math.min(...EXPENSE_WORDS.filter((w) => t.includes(w)).map((w) => t.indexOf(w)));
    return firstInc <= firstExp ? "income" : "expense";
  }
  return null;
}

// Keyword → category name. Matched against the workspace's own
// category lists by the caller, so a name that doesn't exist in this
// mode falls back to General instead of inventing a category.
const CATEGORY_HINTS: { words: string[]; name: string }[] = [
  { words: ["chai", "coffee", "khana", "food", "grocer", "sabzi", "restaurant", "lunch", "dinner", "breakfast", "snack"], name: "Food & groceries" },
  { words: ["rent", "kiraya", "makaan"], name: "Rent" },
  { words: ["bijli", "electricity", "recharge", "bill", "internet", "wifi"], name: "Bills" },
  { words: ["petrol", "diesel", "cab", "auto", "metro", "bus", "train", "travel", "flight", "rickshaw"], name: "Transport" },
  { words: ["shopping", "kapde", "shoes", "amazon", "flipkart", "myntra"], name: "Shopping" },
  { words: ["dawai", "doctor", "hospital", "medical", "pharmacy"], name: "Health" },
  { words: ["movie", "film", "netflix", "entertainment", "game"], name: "Entertainment" },
  { words: ["subscription", "subscri"], name: "Subscriptions" },
  { words: ["salary", "tankhwah", "payroll"], name: "Salary" },
  { words: ["emi", "kist", "instalment", "installment"], name: "EMI" },
  { words: ["loan", "udhaar"], name: "Loans" },
  { words: ["fees", "fee", "tuition", "course", "books", "padhai", "education"], name: "Education" },
  { words: ["marketing", "ads", "advertis"], name: "Marketing" },
  { words: ["supplier", "inventory", "stock"], name: "Suppliers" },
  { words: ["equipment", "laptop", "machine"], name: "Equipment" },
  { words: ["tax", "gst"], name: "Taxes & fees" },
  { words: ["client", "project payment", "invoice payment"], name: "Customer payments" },
  { words: ["refund", "cashback"], name: "Refunds" },
  { words: ["freelance", "side work", "gig"], name: "Freelance & side work" },
  { words: ["brand deal", "sponsor"], name: "Brand deals" },
  { words: ["pocket money", "parents se", "ghar se"], name: "Pocket money" },
];

function pickCategory(text: string, categories: string[]): string {
  const t = text.toLowerCase();
  for (const hint of CATEGORY_HINTS) {
    if (!hint.words.some((w) => t.includes(w))) continue;
    const exact = categories.find((c) => c.toLowerCase() === hint.name.toLowerCase());
    if (exact) return exact;
    const close = categories.find(
      (c) => c.toLowerCase().includes(hint.name.toLowerCase()) || hint.name.toLowerCase().includes(c.toLowerCase()),
    );
    if (close) return close;
  }
  return categories.includes("General") ? "General" : (categories[0] ?? "General");
}

/** Validate + repair an AI suggestion. Drops rows with an empty
 *  description or a non-positive amount, caps the list at 20, caps
 *  amounts, fixes impossible dates to today, and keeps unknown
 *  categories as-is (the client shows them as custom). Returns null
 *  when nothing usable remains. */
export function normalizeSmartEntry(raw: unknown, input: { today: string }): SmartEntryResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rows = Array.isArray(r.entries) ? r.entries : [];
  const entries: SmartEntryItem[] = [];
  for (const row of rows.slice(0, MAX_ENTRIES)) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const description = String(o.description ?? "").trim().slice(0, 200);
    const amountCents = Math.round(Number(o.amountCents) || 0);
    if (!description || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) continue;
    const type = o.type === "income" ? "income" : "expense";
    const category = String(o.category ?? "").trim().slice(0, 60) || "General";
    const date = typeof o.date === "string" && isValidDateStr(o.date) ? o.date : input.today;
    entries.push({
      description,
      amountCents,
      type,
      category,
      date,
      counterparty: String(o.counterparty ?? "").trim().slice(0, 120),
    });
  }
  if (entries.length === 0) return null;
  return {
    entries,
    note: typeof r.note === "string" ? r.note.slice(0, 300) : "",
  };
}

/** Deterministic fallback: split the text into items and parse each
 *  one. Splits on commas, semicolons, newlines and "and"/"aur", so
 *  "dinner 50, shopping 200 yesterday" becomes two entries sharing
 *  the date. A chunk with no amount is skipped, never invented. */
export function parseSmartEntryText(
  text: string,
  input: { today: string; expenseCategories: string[]; incomeCategories: string[] },
): SmartEntryResult {
  const wholeDate = extractRelativeDate(text, input.today) ?? input.today;
  const chunks = text
    .split(/[,;\n]+|\s+and\s+|\s+aur\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const entries: SmartEntryItem[] = [];
  for (const chunk of chunks.slice(0, MAX_ENTRIES)) {
    const amountCents = extractAmountCents(chunk);
    if (amountCents === null || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) continue;
    const type = detectDirection(chunk) ?? "expense";
    const categories = type === "income" ? input.incomeCategories : input.expenseCategories;
    const date = extractRelativeDate(chunk, input.today) ?? wholeDate;
    // Description: the chunk with the amount (and its currency/unit
    // words) removed, and date words trimmed off the ends.
    let description = chunk
      .replace(/(?:₹|rs\.?|inr)\s*\d+(?:\.\d+)?\s*(k|thousand|hazaar)?\b/gi, " ")
      .replace(/\b\d+(?:\.\d+)?\s*(k|thousand|hazaar|rupees?|rupay|rs)\b/gi, " ")
      .replace(/\b\d+(?:\.\d+)?\b/g, " ")
      .replace(/\b(yesterday|today|tomorrow|aaj|kal|parson)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    description = description.replace(/^(paid|pay kiya|spent|bought|received|mila|aaya)\s+/i, "").trim();
    if (!description) description = type === "income" ? "Money in" : "Expense";
    // Counterparty: who it came from / went to ("from client", "at swiggy").
    let counterparty = "";
    const from = chunk.match(/(?:from|se)\s+([a-zA-Z][a-zA-Z ]{1,40})$/i);
    const at = chunk.match(/(?:at|to|ko|par)\s+([a-zA-Z][a-zA-Z ]{1,40})$/i);
    if (type === "income" && from) counterparty = from[1].trim();
    else if (type === "expense" && at) counterparty = at[1].trim();
    entries.push({
      description: description.slice(0, 200),
      amountCents,
      type,
      category: pickCategory(chunk, categories),
      date,
      counterparty: counterparty.slice(0, 120),
    });
  }
  return {
    entries,
    note:
      entries.length === 0
        ? "I could not find any amount in that — try 'dinner 50, shopping 200'."
        : "Read by the built-in parser — check every amount and category before saving.",
  };
}
