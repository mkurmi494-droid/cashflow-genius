// ---------- Home AI chat — action plans (pure) ----------
// The pinned assistant on the home screen talks like an AI and can
// DO things: add a transaction or a budget, start a savings goal,
// record a lend/borrow, add a note or a recurring bill. The model
// answers with a reply plus, when the user asked for work, a plan.
// This module is pure (no zod, no db, no AI calls): it validates
// whatever plan comes back — from the model or from the client's
// confirm tap — before the server writes anything.
//
// Safety rules, enforced here and never in the prompt alone:
// - delete_transaction and change_currency are CONFIRM-ONLY: the
//   model may propose them, but they never execute without the user
//   tapping "Yes, do it" on the confirm card.
// - Every amount is a positive integer number of paise/cents in the
//   workspace currency, capped like every other money write.
// - Dates are real yyyy-mm-dd dates in IST; the words "aaj"/"kal"/
//   "parson" resolve the same way the Smart Add parser does
//   (aaj = today, kal = yesterday, parson = tomorrow).
// - ADD PLANS EXECUTE IMMEDIATELY (owner's decision, 2026-11-20):
//   add_transaction, add_budget, add_savings_goal, deposit_savings,
//   add_lend_borrow, add_note and add_recurring never wait for a
//   confirm tap — even when the model returns kind "confirm" for
//   them (live, 2026-11-20: it did exactly that for "Add ₹500 for
//   food" in an empty workspace, and the expense never appeared).
//   Only delete_transaction and change_currency wait. If a detail
//   is genuinely missing, the model must use "clarify", not "confirm".
// - CORRECTIONS (owner's report, 2026-11-20): when the owner fixes
//   what they just said ("1000 nahi, 1500 karo"), the model returns
//   edit_transaction — the executor finds the one matching entry and
//   updates it in place. A correction NEVER creates a second entry.

export const HOME_CHAT_MAX_CENTS = 100_000_000_00;

export const HOME_CHAT_CURRENCIES = [
  "INR",
  "USD",
  "EUR",
  "GBP",
  "AED",
  "JPY",
  "AUD",
  "CAD",
  "CHF",
  "SGD",
] as const;

export type HomeChatPlan =
  | {
      kind: "add_transaction";
      type: "income" | "expense";
      amountCents: number;
      category: string;
      description: string;
      counterparty: string;
      date: string;
    }
  | { kind: "add_budget"; category: string; monthlyLimitCents: number }
  | { kind: "add_savings_goal"; name: string; targetCents: number; targetDate: string }
  | { kind: "deposit_savings"; goalName: string; amountCents: number; date: string }
  | {
      kind: "add_lend_borrow";
      direction: "lent" | "borrowed";
      person: string;
      amountCents: number;
      date: string;
      dueDate: string | null;
      note: string;
    }
  | { kind: "add_note"; text: string }
  | {
      kind: "add_recurring";
      type: "income" | "expense";
      category: string;
      description: string;
      amountCents: number;
      frequency: "weekly" | "monthly";
      nextDate: string;
    }
  | {
      kind: "delete_transaction";
      amountCents: number;
      date: string;
      type: "income" | "expense";
      description: string;
    }
  | {
      kind: "edit_transaction";
      matchType: "income" | "expense";
      matchAmountCents: number | null;
      matchCategory: string | null;
      matchDescription: string;
      matchDate: string;
      amountCents: number | null;
      category: string | null;
      description: string | null;
      date: string | null;
    }
  | { kind: "change_currency"; currency: string };

export type HomeChatReplyKind = "chat" | "action" | "confirm" | "clarify";

/** The two plan kinds that never execute without an explicit confirm tap. */
export function planNeedsConfirm(plan: HomeChatPlan): boolean {
  return plan.kind === "delete_transaction" || plan.kind === "change_currency";
}

/**
 * Decides what actually happens with a validated plan, given the
 * kind the model returned. Only delete_transaction and
 * change_currency ever wait for a confirm tap. Every safe add plan
 * executes at once — even when the model hedged with "confirm".
 * A plan attached to a "chat" reply never executes.
 */
export function effectiveReplyKind(
  modelKind: HomeChatReplyKind,
  plan: HomeChatPlan,
): "action" | "confirm" | "chat" {
  if (planNeedsConfirm(plan)) return "confirm";
  if (modelKind === "action" || modelKind === "confirm") return "action";
  return "chat";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asTrimmed(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0 || t.length > max) return null;
  return t;
}

function asOptionalText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function asCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v <= 0 || v > HOME_CHAT_MAX_CENTS) return null;
  return v;
}

/** Amount in paise, accepting the rupee alias the model often uses
 *  instead: amountCents (integer paise) first, else amount (rupees,
 *  ×100). A plan must never be lost because the model wrote
 *  "amount": 500 instead of "amountCents": 50000 (live, 2026-11-22). */
function asAmountCents(v: unknown, aliasV: unknown): number | null {
  const direct = asCents(v);
  if (direct !== null) return direct;
  if (typeof aliasV === "number" && Number.isFinite(aliasV) && aliasV > 0) {
    const cents = Math.round(aliasV * 100);
    if (cents > 0 && cents <= HOME_CHAT_MAX_CENTS) return cents;
  }
  return null;
}

/** A plan date, defaulting to today when the model omits it or sends
 *  an unusable value — the prompt already promises the date defaults
 *  to today, so a missing date must not lose the whole plan
 *  (live, 2026-11-22: "food expense 500" failed twice on this). */
function asPlanDate(v: unknown, today: string): string {
  if (typeof v === "string") {
    const d = resolveChatDate(v, today);
    if (d) return d;
  }
  return today;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolves a date the model (or the user, via the model) may give as a
 * word — "today"/"aaj", "yesterday"/"kal", "tomorrow"/"parson" — or as
 * an exact yyyy-mm-dd date. Returns null for anything else, including
 * impossible dates such as 2026-02-30.
 */
export function resolveChatDate(word: string, today: string): string | null {
  const w = word.trim().toLowerCase();
  if (w === "today" || w === "aaj") return today;
  if (w === "yesterday" || w === "kal") return addDays(today, -1);
  if (w === "tomorrow" || w === "parson") return addDays(today, 1);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isRealDate(y, mo, d)) return null;
  return w;
}

type Norm = { ok: true; plan: HomeChatPlan } | { ok: false; error: string };

function fail(error: string): Norm {
  return { ok: false, error };
}

/**
 * Strictly validates a raw plan object (from the model or from the
 * client's confirm tap) and returns the cleaned plan, or the reason
 * it cannot be executed. Never throws.
 *
 * The model sometimes wraps the plan in a key named after its kind —
 * plan: {"add_transaction": {...}} instead of plan: {...} (live,
 * 2026-11-20: both failed calls did exactly this). unwrapNestedPlan
 * unwraps that one-key nesting before validation, so a well-formed
 * plan is never lost to a shape error.
 */
const PLAN_KINDS = new Set([
  "add_transaction",
  "add_budget",
  "add_savings_goal",
  "deposit_savings",
  "add_lend_borrow",
  "add_note",
  "add_recurring",
  "delete_transaction",
  "edit_transaction",
  "change_currency",
]);

function unwrapNestedPlan(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (typeof raw.kind === "string") return raw;
  const keys = Object.keys(raw);
  if (keys.length === 1 && PLAN_KINDS.has(keys[0] as string)) {
    const inner = raw[keys[0] as string];
    if (isRecord(inner)) return inner;
  }
  return raw;
}

export function normalizeHomeChatPlan(raw: unknown, today: string): Norm {
  if (!isRecord(raw)) return fail("Plan is not an object.");
  raw = unwrapNestedPlan(raw);
  if (!isRecord(raw)) return fail("Plan is not an object.");
  const kind = raw.kind;
  if (typeof kind !== "string") return fail("Plan has no kind.");
  if (kind === "add_transaction") {
    const type = raw.type === "income" || raw.type === "expense" ? raw.type : null;
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const category = asTrimmed(raw.category, 60) ?? "General";
    const description = asOptionalText(raw.description, 200);
    const counterparty = asOptionalText(raw.counterparty, 120);
    const date = asPlanDate(raw.date, today);
    if (!type) return fail("Transaction needs income or expense.");
    if (amountCents === null) return fail("Transaction needs a positive amount.");
    return { ok: true, plan: { kind, type, amountCents, category, description, counterparty, date } };
  }
  if (kind === "add_budget") {
    const category = asTrimmed(raw.category, 60);
    const monthlyLimitCents = asAmountCents(raw.monthlyLimitCents, raw.monthlyLimit);
    if (!category) return fail("Budget needs a category.");
    if (monthlyLimitCents === null) return fail("Budget needs a positive monthly limit.");
    return { ok: true, plan: { kind, category, monthlyLimitCents } };
  }
  if (kind === "add_savings_goal") {
    const name = asTrimmed(raw.name, 120);
    const targetCents = asAmountCents(raw.targetCents, raw.target);
    const targetDate = typeof raw.targetDate === "string" ? resolveChatDate(raw.targetDate, today) : null;
    if (!name) return fail("Savings goal needs a name.");
    if (targetCents === null) return fail("Savings goal needs a positive target.");
    if (!targetDate) return fail("Savings goal needs a real target date.");
    return { ok: true, plan: { kind, name, targetCents, targetDate } };
  }
  if (kind === "deposit_savings") {
    const goalName = asTrimmed(raw.goalName, 120);
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const date = asPlanDate(raw.date, today);
    if (!goalName) return fail("Deposit needs a goal name.");
    if (amountCents === null) return fail("Deposit needs a positive amount.");
    return { ok: true, plan: { kind, goalName, amountCents, date } };
  }
  if (kind === "add_lend_borrow") {
    const direction = raw.direction === "lent" || raw.direction === "borrowed" ? raw.direction : null;
    const person = asTrimmed(raw.person, 120);
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const date = asPlanDate(raw.date, today);
    const dueDate =
      raw.dueDate === null || raw.dueDate === undefined
        ? null
        : typeof raw.dueDate === "string"
          ? resolveChatDate(raw.dueDate, today)
          : null;
    const note = asOptionalText(raw.note, 500);
    if (!direction) return fail("Lend/borrow needs lent or borrowed.");
    if (!person) return fail("Lend/borrow needs a person.");
    if (amountCents === null) return fail("Lend/borrow needs a positive amount.");
    if (raw.dueDate !== null && raw.dueDate !== undefined && !dueDate)
      return fail("Lend/borrow due date is not a real date.");
    return { ok: true, plan: { kind, direction, person, amountCents, date, dueDate, note } };
  }
  if (kind === "add_note") {
    const text = asTrimmed(raw.text, 2000);
    if (!text) return fail("Note needs some text.");
    return { ok: true, plan: { kind, text } };
  }
  if (kind === "add_recurring") {
    const type = raw.type === "income" || raw.type === "expense" ? raw.type : null;
    const category = asTrimmed(raw.category, 60);
    const description = asOptionalText(raw.description, 200);
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const frequency = raw.frequency === "weekly" || raw.frequency === "monthly" ? raw.frequency : null;
    const nextDate = asPlanDate(raw.nextDate, today);
    if (!type) return fail("Recurring entry needs income or expense.");
    if (!category) return fail("Recurring entry needs a category.");
    if (amountCents === null) return fail("Recurring entry needs a positive amount.");
    if (!frequency) return fail("Recurring entry needs weekly or monthly.");
    return { ok: true, plan: { kind, type, category, description, amountCents, frequency, nextDate } };
  }
  if (kind === "edit_transaction") {
    const matchType = raw.matchType === "income" || raw.matchType === "expense" ? raw.matchType : null;
    const matchAmountProvided =
      (raw.matchAmountCents !== null && raw.matchAmountCents !== undefined) ||
      (raw.matchAmount !== null && raw.matchAmount !== undefined);
    const matchAmountCents = asAmountCents(raw.matchAmountCents, raw.matchAmount);
    const matchCategory =
      raw.matchCategory === null || raw.matchCategory === undefined
        ? null
        : asTrimmed(raw.matchCategory, 60);
    const matchDescription = asOptionalText(raw.matchDescription, 200);
    const matchDate =
      typeof raw.matchDate === "string" && raw.matchDate.trim().length > 0
        ? resolveChatDate(raw.matchDate, today)
        : today;
    const amountProvided =
      (raw.amountCents !== null && raw.amountCents !== undefined) ||
      (raw.amount !== null && raw.amount !== undefined);
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const category =
      raw.category === null || raw.category === undefined ? null : asTrimmed(raw.category, 60);
    const description =
      raw.description === null || raw.description === undefined
        ? null
        : asOptionalText(raw.description, 200) || null;
    const date =
      raw.date === null || raw.date === undefined
        ? null
        : typeof raw.date === "string"
          ? resolveChatDate(raw.date, today)
          : null;
    if (!matchType) return fail("Edit needs income or expense to match.");
    if (matchAmountProvided && matchAmountCents === null)
      return fail("Edit match amount is not a positive amount.");
    if (!matchAmountCents && !matchCategory && !matchDescription)
      return fail("Edit needs something to match — an amount, a category or a description.");
    if (!matchDate) return fail("Edit match date is not a real date.");
    if (amountProvided && amountCents === null)
      return fail("Edit needs a positive new amount.");
    if (raw.category !== null && raw.category !== undefined && !category)
      return fail("Edit category is empty.");
    if (raw.date !== null && raw.date !== undefined && !date)
      return fail("Edit date is not a real date.");
    if (amountCents === null && category === null && description === null && date === null)
      return fail("Edit needs at least one change — a new amount, category, description or date.");
    return {
      ok: true,
      plan: {
        kind,
        matchType,
        matchAmountCents,
        matchCategory,
        matchDescription,
        matchDate,
        amountCents,
        category,
        description,
        date,
      },
    };
  }
  if (kind === "delete_transaction") {
    const type = raw.type === "income" || raw.type === "expense" ? raw.type : null;
    const amountCents = asAmountCents(raw.amountCents, raw.amount);
    const date = asPlanDate(raw.date, today);
    const description = asOptionalText(raw.description, 200);
    if (!type) return fail("Delete needs income or expense.");
    if (amountCents === null) return fail("Delete needs a positive amount.");
    return { ok: true, plan: { kind, amountCents, date, type, description } };
  }
  if (kind === "change_currency") {
    const currency =
      typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
    if (!(HOME_CHAT_CURRENCIES as readonly string[]).includes(currency))
      return fail("Currency is not one of the supported currencies.");
    return { ok: true, plan: { kind, currency } };
  }
  return fail(`Unknown plan kind: ${kind}.`);
}

/** One plain-language line for the confirm card and the done message. */
export function describePlan(plan: HomeChatPlan, fmt: (cents: number) => string): string {  switch (plan.kind) {
    case "add_transaction":
      return `${plan.type === "income" ? "Add income" : "Add expense"} ${fmt(plan.amountCents)} · ${plan.category}${plan.description ? ` · ${plan.description}` : ""} · ${plan.date}`;
    case "add_budget":
      return `Set a monthly budget of ${fmt(plan.monthlyLimitCents)} for ${plan.category}`;
    case "add_savings_goal":
      return `Create savings goal "${plan.name}" · target ${fmt(plan.targetCents)} by ${plan.targetDate}`;
    case "deposit_savings":
      return `Move ${fmt(plan.amountCents)} into savings goal "${plan.goalName}" on ${plan.date}`;
    case "add_lend_borrow":
      return `${plan.direction === "lent" ? "Record lent" : "Record borrowed"} ${fmt(plan.amountCents)} ${plan.direction === "lent" ? "to" : "from"} ${plan.person} · ${plan.date}${plan.dueDate ? ` · due ${plan.dueDate}` : ""}`;
    case "add_note":
      return `Save a note: "${plan.text.slice(0, 80)}${plan.text.length > 80 ? "…" : ""}"`;
    case "add_recurring":
      return `Add a ${plan.frequency} ${plan.type} of ${fmt(plan.amountCents)} · ${plan.category} · from ${plan.nextDate}`;
    case "edit_transaction":
      return `Edit the ${plan.matchType} on ${plan.matchDate}${plan.matchCategory ? ` · ${plan.matchCategory}` : ""}${plan.matchAmountCents ? ` · ${fmt(plan.matchAmountCents)}` : ""}`;
    case "delete_transaction":
      return `Delete the ${plan.type} of ${fmt(plan.amountCents)} on ${plan.date}${plan.description ? ` (${plan.description})` : ""}`;
    case "change_currency":
      return `Change this workspace's currency to ${plan.currency} (every amount converts at the live rate)`;
  }
}

/**
 * Deterministic fallback for the simplest spoken requests, used only
 * when the model gives nothing usable — its call failed, or its plan
 * failed validation (live, 2026-11-22: "food expense 500" failed
 * twice with "I couldn't pin down the details" and "food expense
 * 300" twice with the AI fallback, all while the OpenAI key and
 * quota were fine). Only add_transaction, only when the message
 * carries an amount AND an income/expense word; anything else
 * returns null and the caller keeps the model's reply. It never
 * guesses a direction or an amount, and it never fires on a delete,
 * an edit, a currency change or a question — those stay with the
 * model. Date words follow the app's convention (kal = yesterday,
 * parson = tomorrow), except "kal" with a future-tense verb ("kal
 * income ayegi") which means tomorrow.
 */
const SIMPLE_INCOME_WORDS = ["income", "kamai", "salary", "mila", "aaya", "received", "credited"];
const SIMPLE_EXPENSE_WORDS = ["expense", "kharcha", "kharch", "spent", "spend", "paid", "bought", "kharid"];
const SIMPLE_FUTURE_WORDS = ["ayegi", "aayegi", "aayega", "ayega", "milega", "milegi", "hoga", "will come", "will get"];
const SIMPLE_SKIP_WORDS = [
  "delete", "remove", "hatao", "cancel", "undo",
  "change", "badlo", "edit", "nahi", "galti", "wrong", "instead",
  "currency", "dollar", "usd", "euro",
];
const SIMPLE_CATEGORY_HINTS: { words: string[]; name: string; kind: "income" | "expense" }[] = [
  { words: ["food", "khana", "chai", "coffee", "grocer", "sabzi", "lunch", "dinner"], name: "Food & groceries", kind: "expense" },
  { words: ["shopping", "kapde", "shoes", "amazon", "flipkart"], name: "Shopping", kind: "expense" },
  { words: ["travel", "petrol", "cab", "auto", "metro", "bus", "train", "flight"], name: "Transport", kind: "expense" },
  { words: ["rent", "kiraya"], name: "Rent", kind: "expense" },
  { words: ["bill", "bijli", "recharge", "internet"], name: "Bills", kind: "expense" },
  { words: ["salary"], name: "Salary", kind: "income" },
  { words: ["client"], name: "Customer payments", kind: "income" },
];

function extractSimpleAmountCents(text: string): number | null {
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
  const cents = Math.round(v * 100);
  if (cents <= 0 || cents > HOME_CHAT_MAX_CENTS) return null;
  return cents;
}

function pickSimpleCategoryHint(lower: string) {
  for (const hint of SIMPLE_CATEGORY_HINTS) {
    if (hint.words.some((w) => lower.includes(w))) return hint;
  }
  return null;
}

function parseSimpleDate(text: string, today: string): string {
  const t = ` ${text.toLowerCase()} `;
  if (/\bkal\b/.test(t) && SIMPLE_FUTURE_WORDS.some((w) => t.includes(w))) return addDays(today, 1);
  if (/\bparson\b/.test(t) || /\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\bkal\b/.test(t) || /\byesterday\b/.test(t)) return addDays(today, -1);
  if (/\baaj\b/.test(t) || /\btoday\b/.test(t)) return today;
  return today;
}

export function parseSimpleHomeChatCommand(message: string, today: string): HomeChatPlan | null {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0 || text.length > 200 || text.includes("?")) return null;
  const lower = text.toLowerCase();
  if (SIMPLE_SKIP_WORDS.some((w) => lower.includes(w))) return null;
  const amountCents = extractSimpleAmountCents(text);
  if (amountCents === null) return null;
  const hasIncome = SIMPLE_INCOME_WORDS.some((w) => lower.includes(w));
  const hasExpense = SIMPLE_EXPENSE_WORDS.some((w) => lower.includes(w));
  const hint = pickSimpleCategoryHint(lower);
  let type: "income" | "expense" | null = null;
  if (hasIncome && !hasExpense) type = "income";
  else if (hasExpense && !hasIncome) type = "expense";
  else if (hasIncome && hasExpense) {
    const firstInc = Math.min(
      ...SIMPLE_INCOME_WORDS.filter((w) => lower.includes(w)).map((w) => lower.indexOf(w)),
    );
    const firstExp = Math.min(
      ...SIMPLE_EXPENSE_WORDS.filter((w) => lower.includes(w)).map((w) => lower.indexOf(w)),
    );
    type = firstInc <= firstExp ? "income" : "expense";
  }
  if (!type && hint) {
    // No explicit income/expense word: the category decides ("Add
    // 1500 for shopping" is an expense; "Add 5000 salary" is income).
    type = hint.kind;
  }
  if (!type) return null;
  return {
    kind: "add_transaction",
    type,
    amountCents,
    category: hint ? hint.name : "General",
    description: text.slice(0, 200),
    counterparty: "",
    date: parseSimpleDate(text, today),
  };
}

const REPLY_KINDS = new Set(["chat", "action", "confirm", "clarify"]);
const REPLY_WRAPPER_KEYS = ["answer", "response", "result", "data"];
const REPLY_TEXT_KEYS = ["reply", "answer", "message", "response", "result", "summary"];

export type NormalizedHomeChatReply =
  | {
      ok: true;
      kind: HomeChatReplyKind;
      reply: string;
      question: string | null;
      plan: HomeChatPlan | null;
      planError: string | null;
    }
  | { ok: false; error: string };

/**
 * Salvages the model's whole reply object into the shape askHomeChat
 * works with. The model does NOT reliably return the shape the
 * prompt asks for — live, 2026-11-21, three consecutive answers were
 * thrown away by a strict schema check even though every one of them
 * carried a complete, usable instruction:
 *   1. a BARE plan as the whole answer — {"kind":"edit_transaction",...}
 *      (no "reply", no "plan" key at all);
 *   2. an envelope with no reply — {"kind":"action","plan":{...}};
 *   3. the same envelope around an edit_transaction.
 * All three failed only because "reply" was required and "kind" had
 * to be a reply kind. This normaliser accepts all of them:
 * - a plan in "plan", or the whole object being a plan;
 * - a missing "reply" (generated from the plan via describePlan, or
 *   from "question" for a chat/clarify);
 * - reply text under an alias key (answer/message/response/result/
 *   summary) and one level of {"answer": {...}} wrapping.
 * The plan itself is still strictly validated by
 * normalizeHomeChatPlan — a bad plan is never executed, it only
 * changes what the reply says. Never throws.
 */
export function normalizeHomeChatReply(
  raw: unknown,
  today: string,
  fmt: (cents: number) => string,
): NormalizedHomeChatReply {
  if (!isRecord(raw)) return { ok: false, error: "The AI's answer was not an object." };
  let obj = raw;
  const keys = Object.keys(obj);
  if (keys.length === 1 && REPLY_WRAPPER_KEYS.includes(keys[0]) && isRecord(obj[keys[0]])) {
    obj = obj[keys[0]] as Record<string, unknown>;
  }
  // The plan, if any: in "plan", or the whole object IS the plan.
  let planRaw: unknown | null = null;
  if (isRecord(obj.plan)) planRaw = obj.plan;
  else if (typeof obj.kind === "string" && PLAN_KINDS.has(obj.kind)) planRaw = obj;
  // The reply kind: the model's, or "action" for a bare plan.
  let kind: HomeChatReplyKind = "chat";
  if (typeof obj.kind === "string" && REPLY_KINDS.has(obj.kind))
    kind = obj.kind as HomeChatReplyKind;
  else if (planRaw !== null) kind = "action";
  // The reply text: "reply" first, then the aliases the model uses.
  let reply: string | null = null;
  for (const k of REPLY_TEXT_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) {
      reply = v.trim();
      break;
    }
  }
  let question: string | null = null;
  if (typeof obj.question === "string" && obj.question.trim().length > 0)
    question = obj.question.trim();
  // Validate the plan now, so a generated reply can describe it.
  let plan: HomeChatPlan | null = null;
  let planError: string | null = null;
  if (planRaw !== null) {
    const norm = normalizeHomeChatPlan(planRaw, today);
    if (norm.ok) plan = norm.plan;
    else planError = norm.error;
  }
  if (reply === null) {
    if (plan !== null) {
      const line = describePlan(plan, fmt);
      reply = planNeedsConfirm(plan)
        ? `Shall I ${line.charAt(0).toLowerCase()}${line.slice(1)}?`
        : line;
    } else if (question !== null) {
      reply = question;
    } else if (planError !== null) {
      // A plan was present but invalid, and the model gave no reply
      // text at all: the caller reports the plan error, so any short
      // line works as the reply here.
      reply = "I couldn't pin down the details.";
    } else {
      return { ok: false, error: "The AI's answer had no reply text." };
    }
  }
  if (plan !== null && planNeedsConfirm(plan) && question === null) question = reply;
  if (plan === null && (kind === "action" || kind === "confirm")) kind = "chat";
  return { ok: true, kind, reply, question, plan, planError };
}
