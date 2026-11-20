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
    const amountCents = asCents(raw.amountCents);
    const category = asTrimmed(raw.category, 60) ?? "General";
    const description = asOptionalText(raw.description, 200);
    const counterparty = asOptionalText(raw.counterparty, 120);
    const date = typeof raw.date === "string" ? resolveChatDate(raw.date, today) : null;
    if (!type) return fail("Transaction needs income or expense.");
    if (amountCents === null) return fail("Transaction needs a positive amount.");
    if (!date) return fail("Transaction needs a real date.");
    return { ok: true, plan: { kind, type, amountCents, category, description, counterparty, date } };
  }
  if (kind === "add_budget") {
    const category = asTrimmed(raw.category, 60);
    const monthlyLimitCents = asCents(raw.monthlyLimitCents);
    if (!category) return fail("Budget needs a category.");
    if (monthlyLimitCents === null) return fail("Budget needs a positive monthly limit.");
    return { ok: true, plan: { kind, category, monthlyLimitCents } };
  }
  if (kind === "add_savings_goal") {
    const name = asTrimmed(raw.name, 120);
    const targetCents = asCents(raw.targetCents);
    const targetDate = typeof raw.targetDate === "string" ? resolveChatDate(raw.targetDate, today) : null;
    if (!name) return fail("Savings goal needs a name.");
    if (targetCents === null) return fail("Savings goal needs a positive target.");
    if (!targetDate) return fail("Savings goal needs a real target date.");
    return { ok: true, plan: { kind, name, targetCents, targetDate } };
  }
  if (kind === "deposit_savings") {
    const goalName = asTrimmed(raw.goalName, 120);
    const amountCents = asCents(raw.amountCents);
    const date = typeof raw.date === "string" ? resolveChatDate(raw.date, today) : null;
    if (!goalName) return fail("Deposit needs a goal name.");
    if (amountCents === null) return fail("Deposit needs a positive amount.");
    if (!date) return fail("Deposit needs a real date.");
    return { ok: true, plan: { kind, goalName, amountCents, date } };
  }
  if (kind === "add_lend_borrow") {
    const direction = raw.direction === "lent" || raw.direction === "borrowed" ? raw.direction : null;
    const person = asTrimmed(raw.person, 120);
    const amountCents = asCents(raw.amountCents);
    const date = typeof raw.date === "string" ? resolveChatDate(raw.date, today) : null;
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
    if (!date) return fail("Lend/borrow needs a real date.");
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
    const amountCents = asCents(raw.amountCents);
    const frequency = raw.frequency === "weekly" || raw.frequency === "monthly" ? raw.frequency : null;
    const nextDate = typeof raw.nextDate === "string" ? resolveChatDate(raw.nextDate, today) : null;
    if (!type) return fail("Recurring entry needs income or expense.");
    if (!category) return fail("Recurring entry needs a category.");
    if (amountCents === null) return fail("Recurring entry needs a positive amount.");
    if (!frequency) return fail("Recurring entry needs weekly or monthly.");
    if (!nextDate) return fail("Recurring entry needs a real next date.");
    return { ok: true, plan: { kind, type, category, description, amountCents, frequency, nextDate } };
  }
  if (kind === "edit_transaction") {
    const matchType = raw.matchType === "income" || raw.matchType === "expense" ? raw.matchType : null;
    const matchAmountCents =
      raw.matchAmountCents === null || raw.matchAmountCents === undefined
        ? null
        : asCents(raw.matchAmountCents);
    const matchCategory =
      raw.matchCategory === null || raw.matchCategory === undefined
        ? null
        : asTrimmed(raw.matchCategory, 60);
    const matchDescription = asOptionalText(raw.matchDescription, 200);
    const matchDate =
      typeof raw.matchDate === "string" && raw.matchDate.trim().length > 0
        ? resolveChatDate(raw.matchDate, today)
        : today;
    const amountCents =
      raw.amountCents === null || raw.amountCents === undefined ? null : asCents(raw.amountCents);
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
    if (raw.matchAmountCents !== null && raw.matchAmountCents !== undefined && matchAmountCents === null)
      return fail("Edit match amount is not a positive amount.");
    if (!matchAmountCents && !matchCategory && !matchDescription)
      return fail("Edit needs something to match — an amount, a category or a description.");
    if (!matchDate) return fail("Edit match date is not a real date.");
    if (raw.amountCents !== null && raw.amountCents !== undefined && amountCents === null)
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
    const amountCents = asCents(raw.amountCents);
    const date = typeof raw.date === "string" ? resolveChatDate(raw.date, today) : null;
    const description = asOptionalText(raw.description, 200);
    if (!type) return fail("Delete needs income or expense.");
    if (amountCents === null) return fail("Delete needs a positive amount.");
    if (!date) return fail("Delete needs a real date.");
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
