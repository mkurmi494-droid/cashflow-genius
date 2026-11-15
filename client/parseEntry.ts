// Deterministic parsers for fast money entry: spoken phrases (voice
// entry) and pasted bank / UPI messages (SMS import). Both produce a
// DRAFT transaction only — nothing is ever saved from here. The user
// always reviews and edits the draft in Quick Add and confirms before
// the existing saveTransaction action runs. Parsing is plain pattern
// matching over the user's own words: no number is ever invented —
// when something can't be found, the field is left empty and the
// `notes` say so, so the user fills it in by hand.

import { categoriesFor, todayStr, type AppMode } from "./lib";

export interface EntryDraft {
  type: "income" | "expense";
  /** Rupees as a string for the amount field, "" when not found. */
  amount: string;
  /** A category name valid in the active workspace, or "General". */
  category: string;
  description: string;
  counterparty: string;
  /** yyyy-mm-dd */
  date: string;
  paymentMethod: string;
  /** UPI reference / UTR found in a pasted message, if any. */
  upiRef: string | null;
  /** Plain-language notes: what was detected, and what was not. */
  notes: string[];
}

function addDaysStr(base: string, delta: number): string {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** First amount-looking number in the text: "₹1,500", "Rs. 500",
 *  "500 rupees", "500", "2.5k" (→ 2500). Returns rupees or null.
 *
 *  The unit suffix ("k", "thousand", "rupees"…) must be a standalone
 *  token: the `\b` after it stops "₹500 kharcha" from reading the "k"
 *  of "kharcha" as a thousands multiplier (₹500,000) — the same bug
 *  also ate that "k" out of the description. */
export function extractAmountRupees(text: string): number | null {
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
  return Math.round(v * 100) / 100;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** A date inside a bank message: 13-Nov-26, 13/11/2026, 2026-11-13,
 *  "on 13 Nov". Returns yyyy-mm-dd or null. Two-digit years are 20xx. */
export function extractDate(text: string): string | null {
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

// Keyword → category mapping. Keys are matched as substrings against
// the lowercased text; the first hit wins. Values are looked up in the
// active workspace's own category lists, so a name that doesn't exist
// in this mode falls back gracefully instead of inventing a category.
const CATEGORY_HINTS: { words: string[]; expense?: string; income?: string }[] = [
  { words: ["chai", "coffee", "khana", "food", "grocer", "sabzi", "restaurant", "hotel khana", "lunch", "dinner", "breakfast", "snack"], expense: "Food & groceries" },
  { words: ["rent", "kiraya", "makaan"], expense: "Rent" },
  { words: ["bijli", "electricity", "recharge", "bill", "internet", "wifi", "mobile recharge"], expense: "Bills" },
  { words: ["petrol", "diesel", "cab", "auto", "metro", "bus", "train", "travel", "flight", "rickshaw"], expense: "Transport" },
  { words: ["shopping", "kapde", "shoes", "amazon", "flipkart", "myntra"], expense: "Shopping" },
  { words: ["dawai", "doctor", "hospital", "medical", "pharmacy"], expense: "Health" },
  { words: ["movie", "film", "netflix", "entertainment", "game"], expense: "Entertainment" },
  { words: ["subscription", "subscri"], expense: "Subscriptions" },
  { words: ["salary", "tankhwah", "payroll"], expense: "Salaries", income: "Salary" },
  { words: ["emi", "kist", "instalment", "installment"], expense: "EMI" },
  { words: ["loan", "udhaar liya wapas", "loan repayment"], expense: "Loans" },
  { words: ["fees", "fee", "tuition", "course", "books", "padhai", "education"], expense: "Education" },
  { words: ["marketing", "ads", "advertis"], expense: "Marketing" },
  { words: ["supplier", "inventory", "stock kharida"], expense: "Suppliers" },
  { words: ["equipment", "laptop", "machine"], expense: "Equipment" },
  { words: ["tax", "gst"], expense: "Taxes & fees" },
  { words: ["client", "project payment", "invoice payment"], income: "Customer payments" },
  { words: ["refund", "cashback"], income: "Refunds" },
  { words: ["freelance", "side work", "gig"], income: "Freelance & side work" },
  { words: ["brand deal", "sponsor"], income: "Brand deals" },
  { words: ["pocket money", "parents se", "ghar se"], income: "Pocket money" },
];

function pickCategory(
  text: string,
  mode: AppMode,
  type: "income" | "expense",
): string | null {
  const options = categoriesFor(mode, type);
  for (const hint of CATEGORY_HINTS) {
    if (!hint.words.some((w) => text.includes(w))) continue;
    const wanted = type === "income" ? (hint.income ?? hint.expense) : (hint.expense ?? hint.income);
    if (!wanted) continue;
    const found = options.find((c) => c.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
    // Close matches used by several modes ("Rent & home" contains Rent…)
    const close = options.find(
      (c) => c.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(c.toLowerCase()),
    );
    if (close) return close;
  }
  return null;
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

function detectDirection(text: string): "income" | "expense" | null {
  const inc = INCOME_WORDS.some((w) => text.includes(w));
  const exp = EXPENSE_WORDS.some((w) => text.includes(w));
  if (inc && !exp) return "income";
  if (exp && !inc) return "expense";
  if (inc && exp) {
    // Both present — the first-occurring direction word usually frames
    // the sentence ("received 5000 from client" vs "paid … received by").
    const firstInc = Math.min(...INCOME_WORDS.filter((w) => text.includes(w)).map((w) => text.indexOf(w)));
    const firstExp = Math.min(...EXPENSE_WORDS.filter((w) => text.includes(w)).map((w) => text.indexOf(w)));
    return firstInc <= firstExp ? "income" : "expense";
  }
  return null;
}

/** Parse a spoken (or typed-as-spoken) phrase like
 *  "500 rupees kharcha chai" or "received 5000 from client" into a draft. */
export function parseSpokenEntry(raw: string, mode: AppMode): EntryDraft {
  const notes: string[] = [];
  const original = raw.trim();
  const text = ` ${original.toLowerCase()} `;
  const amount = extractAmountRupees(original);
  if (amount == null) notes.push("Amount samajh nahi aaya — amount field mein khud bhar do.");
  let type = detectDirection(text);
  if (!type) {
    type = "expense";
    notes.push("Direction (in/out) clear nahi tha — Money out maan liya hai, draft mein check karke badal sakte ho.");
  }
  // Date words: kal in Hinglish can mean yesterday OR tomorrow; for a
  // spoken money entry the money has almost always already moved, so
  // "kal" is read as yesterday and the note says so honestly.
  let date = todayStr();
  if (/\bparso\b|\bday before yesterday\b/.test(text)) date = addDaysStr(date, -2);
  else if (/\byesterday\b|\bkal\b/.test(text)) {
    date = addDaysStr(date, -1);
    notes.push("“Kal” ko yesterday (beeta hua kal) mana hai — agar kal aane wala tha, to date draft mein badal do.");
  } else if (/\baaj\b|\btoday\b/.test(text)) {
    notes.push("Date: aaj ki rakhi hai.");
  }
  const explicit = extractDate(original);
  if (explicit) date = explicit;

  let counterparty = "";
  const fromMatch = original.match(/\bfrom\s+([a-zA-Z][a-zA-Z .&'-]{1,40})/i);
  if (type === "income" && fromMatch) counterparty = (fromMatch[1] ?? "").trim();
  const seMatch = original.match(/\b([a-zA-Z][a-zA-Z .&'-]{1,30}?)\s+se\s+(?:mila|aaya|received)/i);
  if (type === "income" && !counterparty && seMatch) counterparty = (seMatch[1] ?? "").trim();

  const category = pickCategory(text, mode, type) ?? "General";
  // Description: the spoken phrase itself, minus the amount chunk, so
  // the draft reads like what the user said — they can edit it freely.
  // The `\b` after the unit stops "₹500 kharcha" from stripping the "k"
  // of "kharcha" along with the amount (it used to leave "harcha").
  const description = original
    .replace(/(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|hazaar|rupees?|rupay)?\b/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return {
    type,
    amount: amount == null ? "" : String(amount),
    category,
    description: description || original.slice(0, 120),
    counterparty,
    date,
    paymentMethod: "UPI",
    upiRef: null,
    notes,
  };
}

/** Parse a pasted bank / UPI SMS or message into a draft. A pasted
 *  message is NEVER proof of payment — the draft notes say so, and the
 *  user must verify in their bank/UPI app and confirm before saving. */
export function parseBankMessage(raw: string, mode: AppMode): EntryDraft {
  const notes: string[] = [];
  const original = raw.trim();
  const text = ` ${original.toLowerCase()} `;

  const amount = extractAmountRupees(original);
  if (amount == null) notes.push("Message mein amount nahi mila — draft mein khud bhar do.");

  let type: "income" | "expense" | null = null;
  if (/credit|credited|received|deposited|refund/.test(text)) type = "income";
  if (/debit|debited|spent|paid|sent|withdrawn|purchase/.test(text)) type = type === "income" ? type : "expense";
  if (!type) {
    type = detectDirection(text) ?? "expense";
    notes.push("Message se direction pakka nahi hua — draft mein check karke sahi kar do.");
  }

  const upiRefMatch = original.match(/(?:upi ref(?:erence)?(?: no)?|utr|ref(?:erence)?(?: no)?|txn id)[\s.:#-]*([A-Za-z0-9]{8,22})/i);
  const bareRef = original.match(/\b(\d{12})\b/);
  const upiRef = (upiRefMatch?.[1] ?? bareRef?.[1] ?? null) || null;
  if (upiRef) notes.push(`UPI reference mila: ${upiRef} — apne bank/UPI app mein is UTR ko verify zaroor karo.`);

  // Merchant / counterparty: "at Swiggy", "to Rahul", "from Acme",
  // "VPA name@upi", "Info: UPI/…"
  let counterparty = "";
  const vpa = original.match(/\b([a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,})\b/);
  const merchantMatch =
    original.match(/\b(?:at|to|from|towards)\s+([A-Z][A-Za-z0-9 .&'-]{1,40}?)(?:\s+(?:on|via|using|ref|utr|\d{1,2}[-/])|\.|,|$)/) ??
    original.match(/\b(?:at|to|from)\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40})/);
  if (merchantMatch) counterparty = (merchantMatch[1] ?? "").trim();
  if (!counterparty && vpa) counterparty = vpa[1] ?? "";

  const date = extractDate(original) ?? todayStr();
  if (!extractDate(original)) notes.push("Message mein date nahi mili — aaj ki date rakhi hai, draft mein check kar lo.");

  const paymentMethod = /upi/i.test(original) ? "UPI" : /card/i.test(original) ? "Card" : /neft|imps|rtgs|bank transfer/i.test(original) ? "Bank transfer" : "UPI";
  const category = pickCategory(text, mode, type) ?? "General";
  const description = counterparty
    ? `${type === "income" ? "Received from" : "Paid to"} ${counterparty} (from pasted message)`
    : "From pasted bank/UPI message";

  notes.push("Ye draft sirf pasted message se bana hai — message kabhi payment ka proof nahi hota. Save karne se pehle apne bank/UPI app mein transaction verify karo.");
  return {
    type,
    amount: amount == null ? "" : String(amount),
    category,
    description,
    counterparty,
    date,
    paymentMethod,
    upiRef,
    notes,
  };
}

/** A classic fake UPI message, offered in Scam Shield as a “try a sample” example. */
export const SAMPLE_SCAM_MESSAGE =
  "URGENT!! Dear customer, your UPI payment of Rs 24,999 is ON HOLD. Your account will be BLOCKED in 2 hours. Complete KYC now: https://secure-upi-verify.xyz/kyc and share the OTP sent to your mobile to release your refund of Rs 24,999. Call 98765 43210 immediately!";
