// One-statement workspace loads (mode-switch speedup, 2026-11-15).
//
// WHY THIS EXISTS: getState used to make ~25 sequential round-trips
// (a 19-query Promise.all that postgres-js with max:1 serialises, plus
// a prelude that re-read the same user_workspace_state row three
// times, plus tourDismissedOf's two more after the batch) and
// getCombinedSummary ~12. Locally that is ~140ms because localhost
// RTT is free, so local timing proves nothing — but live, Vercel ->
// Supabase-pooler RTT is ~600ms-1s per statement, so a mode switch
// cost 15-30s of refetch. Raising the pool (max 1 -> 5, commit
// bcd6255) "fixed" it by parallelising — and then broke the live site
// for ~6 minutes when the Supabase session pooler hit EMAXCONNSESSION
// "max clients reached in session mode" (reverted in b8b0b9e).
// The real fix is FEWER round-trips, never a bigger pool: each load
// below is ONE statement that returns every collection as a JSON
// array (json_agg + row_to_json with camelCase aliases), so getState
// is 3 statements total (auth join + prelude + batch) and
// getCombinedSummary is 2 (auth join + batch).
//
// WHAT IS PRESERVED: the rows fed to the existing mappers are the
// same Drizzle $inferSelect shapes — same columns, same ordering,
// same limits — with timestamp columns revived from their JSON ISO
// strings back to Date objects (the mappers call .toISOString() /
// .getTime() on them). Timestamps are rendered in SQL as
// `created_at at time zone 'UTC'` so the JSON string carries +00:00
// and new Date() recovers the exact instant the driver used to
// return, regardless of the database's TimeZone setting. Money stays
// integer paise (bigint -> JSON number, exact below 2^53, as Drizzle
// already maps bigint columns to number). No session-level features
// are used (no temp tables, no SET, no LISTEN, no advisory locks),
// so this works identically on the session pooler (5432), the
// transaction pooler (6543) and a direct connection.
//
// The prelude (state row + all businesses) is a separate statement
// because the batch needs the active mode first — and because on a
// first visit the active-mode workspace may not exist yet, in which
// case the caller creates it via the existing ensureWorkspace path
// (rare; the normal path never pays for it).
import * as schema from "../schema";
import type { db } from "./db";

type Db = typeof db;

export type BusinessRow = typeof schema.businesses.$inferSelect;
export type TxnRow = typeof schema.transactions.$inferSelect;
export type InvRow = typeof schema.invoices.$inferSelect;
export type ItemRow = typeof schema.invoiceItems.$inferSelect;
export type NoteRow = typeof schema.notes.$inferSelect;
export type ScenarioRow = typeof schema.scenarios.$inferSelect;
export type RecurringRow = typeof schema.recurringCashflows.$inferSelect;
export type EmiPlanRow = typeof schema.emiPlans.$inferSelect;
export type EmiInstRow = typeof schema.emiInstalments.$inferSelect;
export type SavingsGoalRow = typeof schema.savingsGoals.$inferSelect;
export type SavingsTransferRow = typeof schema.savingsTransfers.$inferSelect;
export type ScamCheckRow = typeof schema.scamChecks.$inferSelect;
export type BudgetRow = typeof schema.budgets.$inferSelect;
export type CustomCategoryRow = typeof schema.customCategories.$inferSelect;
export type AiConversationRow = typeof schema.aiConversations.$inferSelect;
export type AiMessageRow = typeof schema.aiMessages.$inferSelect;
export type ActivityRow = typeof schema.activityLogs.$inferSelect;
export type WorkspaceStateRow =
  typeof schema.userWorkspaceState.$inferSelect;

/** Every collection getState returns for one workspace, in the same
 *  row shapes and ordering the old per-table selects produced. */
export type WorkspaceBatch = {
  transactions: TxnRow[];
  invoices: InvRow[];
  invoiceItems: ItemRow[];
  notes: NoteRow[];
  scenarios: ScenarioRow[];
  recurring: RecurringRow[];
  emiPlans: EmiPlanRow[];
  emiInstalments: EmiInstRow[];
  savingsGoals: SavingsGoalRow[];
  savingsTransfers: SavingsTransferRow[];
  scamChecks: ScamCheckRow[];
  budgets: BudgetRow[];
  customCategories: CustomCategoryRow[];
  aiConversations: AiConversationRow[];
  aiMessages: AiMessageRow[];
  activity: ActivityRow[];
};

/** Every collection getCombinedSummary aggregates, across all modes. */
export type CombinedBatch = {
  businesses: BusinessRow[];
  transactions: TxnRow[];
  invoices: InvRow[];
  invoiceItems: ItemRow[];
  recurring: RecurringRow[];
  budgets: BudgetRow[];
  emiPlans: EmiPlanRow[];
  emiInstalments: EmiInstRow[];
  savingsGoals: SavingsGoalRow[];
  savingsTransfers: SavingsTransferRow[];
};

/** Timestamp columns, per collection, that the JSON round-trip
 *  returns as ISO strings and the mappers need as Date objects. */
const DATE_KEYS: Record<string, readonly string[]> = {
  businesses: ["createdAt", "updatedAt"],
  transactions: ["createdAt", "updatedAt"],
  invoices: ["createdAt", "updatedAt"],
  notes: ["createdAt", "updatedAt"],
  scenarios: ["createdAt", "updatedAt"],
  recurring: ["createdAt"],
  emiPlans: ["createdAt", "updatedAt"],
  savingsGoals: ["createdAt", "updatedAt"],
  savingsTransfers: ["createdAt"],
  scamChecks: ["createdAt"],
  budgets: ["createdAt"],
  customCategories: ["createdAt"],
  aiConversations: ["createdAt"],
  aiMessages: ["createdAt"],
  activity: ["createdAt"],
};

function reviveDates<T extends Record<string, unknown>>(
  rows: T[],
  collection: string,
): T[] {
  const keys = DATE_KEYS[collection] ?? [];
  if (keys.length === 0) return rows;
  for (const row of rows) {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v) {
        (row as Record<string, unknown>)[k] = new Date(v);
      }
    }
  }
  return rows;
}

/** The account's state row (active mode, cursor, Gemini key, tour
 *  flag) plus every businesses row, in ONE statement. The state row
 *  is null for a brand-new account — the caller creates it. */
export async function loadWorkspacePrelude(
  db: Db,
  ownerId: string,
): Promise<{ state: WorkspaceStateRow | null; businesses: BusinessRow[] }> {
  const [row] = (await db.$client`
    select
      (select row_to_json(s) from (
        select owner_id as "ownerId", active_mode as "activeMode",
               cursor_style as "cursorStyle", gemini_api_key as "geminiApiKey",
               tour_dismissed as "tourDismissed"
        from user_workspace_state where owner_id = ${ownerId}
      ) s) as state,
      (select coalesce(json_agg(row_to_json(b)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name, industry, country, currency,
               opening_balance_cents as "openingBalanceCents", timezone,
               owner_name as "ownerName", owner_email as "ownerEmail",
               owner_phone as "ownerPhone", gst_rate_bp as "gstRateBp",
               gst_inclusive as "gstInclusive",
               eligible_expense_pct as "eligibleExpensePct", onboarded,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from businesses where owner_id = ${ownerId}
      ) b) as businesses
  `) as unknown as Array<{
    state: WorkspaceStateRow | null;
    businesses: BusinessRow[];
  }>;
  return {
    state: row?.state ?? null,
    businesses: reviveDates(row?.businesses ?? [], "businesses"),
  };
}

/** All of one workspace's collections, in ONE statement. The
 *  linked-table reads (invoice items, EMI instalments, AI messages)
 *  keep their old owner-scoped subqueries — they are subselects
 *  inside this single statement, not extra round-trips. Ordering and
 *  limits match the old per-table selects exactly. */
export async function loadWorkspaceBatch(
  db: Db,
  ownerId: string,
  mode: string,
): Promise<WorkspaceBatch> {
  const [row] = (await db.$client`
    select
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, type, status, category,
               description, counterparty, amount_cents as "amountCents",
               date, payment_method as "paymentMethod",
               invoice_id as "invoiceId", emi_instalment_id as "emiInstalmentId",
               demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from transactions
        where owner_id = ${ownerId} and mode = ${mode}
        order by date desc, created_at desc
      ) t) as transactions,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, number,
               customer_name as "customerName", customer_email as "customerEmail",
               status, issue_date as "issueDate", due_date as "dueDate",
               discount_bp as "discountBp", tax_bp as "taxBp", notes, demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from invoices
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
      ) t) as invoices,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, invoice_id as "invoiceId", description,
               qty_milli as "qtyMilli", unit_price_cents as "unitPriceCents", sort
        from invoice_items
        where invoice_id in (
          select id from invoices
          where owner_id = ${ownerId} and mode = ${mode}
        )
      ) t) as "invoiceItems",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, title, content, category, tags,
               pinned, source_module as "sourceModule", source_id as "sourceId",
               demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from notes
        where owner_id = ${ownerId} and mode = ${mode}
        order by pinned desc, updated_at desc
      ) t) as notes,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name, params, demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from scenarios
        where owner_id = ${ownerId} and mode = ${mode}
        order by updated_at desc
      ) t) as scenarios,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, type, category, description,
               amount_cents as "amountCents", frequency,
               next_date as "nextDate", active, demo,
               created_at at time zone 'UTC' as "createdAt"
        from recurring_cashflows
        where owner_id = ${ownerId} and mode = ${mode}
      ) t) as recurring,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode,
               customer_name as "customerName", customer_contact as "customerContact",
               product, total_cents as "totalCents",
               down_payment_cents as "downPaymentCents",
               instalment_count as "instalmentCount", frequency,
               first_due_date as "firstDueDate", demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from emi_plans
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
      ) t) as "emiPlans",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, plan_id as "planId", seq, due_date as "dueDate",
               amount_cents as "amountCents", status,
               paid_date as "paidDate", transaction_id as "transactionId"
        from emi_instalments
        where plan_id in (
          select id from emi_plans
          where owner_id = ${ownerId} and mode = ${mode}
        )
      ) t) as "emiInstalments",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name,
               target_cents as "targetCents", target_date as "targetDate", demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from savings_goals
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
      ) t) as "savingsGoals",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, goal_id as "goalId", owner_id as "ownerId", mode,
               direction, amount_cents as "amountCents", date, note,
               created_at at time zone 'UTC' as "createdAt"
        from savings_transfers
        where owner_id = ${ownerId} and mode = ${mode}
      ) t) as "savingsTransfers",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, kind, excerpt, verdict,
               risk_score as "riskScore", reasons_json as "reasonsJson",
               created_at at time zone 'UTC' as "createdAt"
        from scam_checks
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
        limit 10
      ) t) as "scamChecks",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, category,
               monthly_limit_cents as "monthlyLimitCents",
               created_at at time zone 'UTC' as "createdAt"
        from budgets
        where owner_id = ${ownerId} and mode = ${mode}
      ) t) as budgets,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name, type,
               created_at at time zone 'UTC' as "createdAt"
        from custom_categories
        where owner_id = ${ownerId} and mode = ${mode}
        order by name asc
      ) t) as "customCategories",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, title,
               created_at at time zone 'UTC' as "createdAt"
        from ai_conversations
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
      ) t) as "aiConversations",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, conversation_id as "conversationId", role, content,
               created_at at time zone 'UTC' as "createdAt"
        from ai_messages
        where conversation_id in (
          select id from ai_conversations
          where owner_id = ${ownerId} and mode = ${mode}
        )
        order by created_at asc
      ) t) as "aiMessages",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, action, detail,
               created_at at time zone 'UTC' as "createdAt"
        from activity_logs
        where owner_id = ${ownerId} and mode = ${mode}
        order by id desc
        limit 25
      ) t) as activity
  `) as unknown as Array<Record<string, unknown[]>>;
  const doc = row ?? {};
  const take = <T extends Record<string, unknown>>(
    key: string,
  ): T[] =>
    reviveDates(((doc[key] ?? []) as T[]), key);
  return {
    transactions: take<TxnRow>("transactions"),
    invoices: take<InvRow>("invoices"),
    invoiceItems: take<ItemRow>("invoiceItems"),
    notes: take<NoteRow>("notes"),
    scenarios: take<ScenarioRow>("scenarios"),
    recurring: take<RecurringRow>("recurring"),
    emiPlans: take<EmiPlanRow>("emiPlans"),
    emiInstalments: take<EmiInstRow>("emiInstalments"),
    savingsGoals: take<SavingsGoalRow>("savingsGoals"),
    savingsTransfers: take<SavingsTransferRow>("savingsTransfers"),
    scamChecks: take<ScamCheckRow>("scamChecks"),
    budgets: take<BudgetRow>("budgets"),
    customCategories: take<CustomCategoryRow>("customCategories"),
    aiConversations: take<AiConversationRow>("aiConversations"),
    aiMessages: take<AiMessageRow>("aiMessages"),
    activity: take<ActivityRow>("activity"),
  };
}

/** The three collections getBriefing needs (transactions, invoices,
 *  savings transfers for one workspace), in ONE statement — it used
 *  to read them as three sequential selects plus a state-row read
 *  for the Gemini key, 7 statements in all, while holding the
 *  dashboard's third parallel connection. */
export async function loadBriefingBatch(
  db: Db,
  ownerId: string,
  mode: string,
): Promise<{
  transactions: TxnRow[];
  invoices: InvRow[];
  savingsTransfers: SavingsTransferRow[];
}> {
  const [row] = (await db.$client`
    select
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, type, status, category,
               description, counterparty, amount_cents as "amountCents",
               date, payment_method as "paymentMethod",
               invoice_id as "invoiceId", emi_instalment_id as "emiInstalmentId",
               demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from transactions
        where owner_id = ${ownerId} and mode = ${mode}
        order by date desc, created_at desc
      ) t) as transactions,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, number,
               customer_name as "customerName", customer_email as "customerEmail",
               status, issue_date as "issueDate", due_date as "dueDate",
               discount_bp as "discountBp", tax_bp as "taxBp", notes, demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from invoices
        where owner_id = ${ownerId} and mode = ${mode}
        order by created_at desc
      ) t) as invoices,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, goal_id as "goalId", owner_id as "ownerId", mode,
               direction, amount_cents as "amountCents", date, note,
               created_at at time zone 'UTC' as "createdAt"
        from savings_transfers
        where owner_id = ${ownerId} and mode = ${mode}
      ) t) as "savingsTransfers"
  `) as unknown as Array<Record<string, unknown[]>>;
  const doc = row ?? {};
  return {
    transactions: reviveDates(((doc.transactions ?? []) as TxnRow[]), "transactions"),
    invoices: reviveDates(((doc.invoices ?? []) as InvRow[]), "invoices"),
    savingsTransfers: reviveDates(
      ((doc.savingsTransfers ?? []) as SavingsTransferRow[]),
      "savingsTransfers",
    ),
  };
}

/** All of every workspace's collections, in ONE statement — the
 *  state row rides along so the caller need not re-read it. */
export async function loadCombinedBatch(
  db: Db,
  ownerId: string,
): Promise<CombinedBatch & { state: WorkspaceStateRow | null }> {
  const [row] = (await db.$client`
    select
      (select row_to_json(s) from (
        select owner_id as "ownerId", active_mode as "activeMode",
               cursor_style as "cursorStyle", gemini_api_key as "geminiApiKey",
               tour_dismissed as "tourDismissed"
        from user_workspace_state where owner_id = ${ownerId}
      ) s) as state,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name, industry, country, currency,
               opening_balance_cents as "openingBalanceCents", timezone,
               owner_name as "ownerName", owner_email as "ownerEmail",
               owner_phone as "ownerPhone", gst_rate_bp as "gstRateBp",
               gst_inclusive as "gstInclusive",
               eligible_expense_pct as "eligibleExpensePct", onboarded,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from businesses where owner_id = ${ownerId}
      ) t) as businesses,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, type, status, category,
               description, counterparty, amount_cents as "amountCents",
               date, payment_method as "paymentMethod",
               invoice_id as "invoiceId", emi_instalment_id as "emiInstalmentId",
               demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from transactions where owner_id = ${ownerId}
      ) t) as transactions,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, number,
               customer_name as "customerName", customer_email as "customerEmail",
               status, issue_date as "issueDate", due_date as "dueDate",
               discount_bp as "discountBp", tax_bp as "taxBp", notes, demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from invoices where owner_id = ${ownerId}
      ) t) as invoices,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, invoice_id as "invoiceId", description,
               qty_milli as "qtyMilli", unit_price_cents as "unitPriceCents", sort
        from invoice_items
        where invoice_id in (
          select id from invoices where owner_id = ${ownerId}
        )
      ) t) as "invoiceItems",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, type, category, description,
               amount_cents as "amountCents", frequency,
               next_date as "nextDate", active, demo,
               created_at at time zone 'UTC' as "createdAt"
        from recurring_cashflows where owner_id = ${ownerId}
      ) t) as recurring,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, category,
               monthly_limit_cents as "monthlyLimitCents",
               created_at at time zone 'UTC' as "createdAt"
        from budgets where owner_id = ${ownerId}
      ) t) as budgets,
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode,
               customer_name as "customerName", customer_contact as "customerContact",
               product, total_cents as "totalCents",
               down_payment_cents as "downPaymentCents",
               instalment_count as "instalmentCount", frequency,
               first_due_date as "firstDueDate", demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from emi_plans where owner_id = ${ownerId}
      ) t) as "emiPlans",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, plan_id as "planId", seq, due_date as "dueDate",
               amount_cents as "amountCents", status,
               paid_date as "paidDate", transaction_id as "transactionId"
        from emi_instalments
        where plan_id in (
          select id from emi_plans where owner_id = ${ownerId}
        )
      ) t) as "emiInstalments",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, owner_id as "ownerId", mode, name,
               target_cents as "targetCents", target_date as "targetDate", demo,
               created_at at time zone 'UTC' as "createdAt",
               updated_at at time zone 'UTC' as "updatedAt"
        from savings_goals where owner_id = ${ownerId}
      ) t) as "savingsGoals",
      (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select id, goal_id as "goalId", owner_id as "ownerId", mode,
               direction, amount_cents as "amountCents", date, note,
               created_at at time zone 'UTC' as "createdAt"
        from savings_transfers where owner_id = ${ownerId}
      ) t) as "savingsTransfers"
  `) as unknown as Array<Record<string, unknown>>;
  const doc = row ?? {};
  const take = <T extends Record<string, unknown>>(key: string): T[] =>
    reviveDates(((doc[key] ?? []) as T[]), key);
  return {
    state: (doc.state as WorkspaceStateRow | null) ?? null,
    businesses: take<BusinessRow>("businesses"),
    transactions: take<TxnRow>("transactions"),
    invoices: take<InvRow>("invoices"),
    invoiceItems: take<ItemRow>("invoiceItems"),
    recurring: take<RecurringRow>("recurring"),
    budgets: take<BudgetRow>("budgets"),
    emiPlans: take<EmiPlanRow>("emiPlans"),
    emiInstalments: take<EmiInstRow>("emiInstalments"),
    savingsGoals: take<SavingsGoalRow>("savingsGoals"),
    savingsTransfers: take<SavingsTransferRow>("savingsTransfers"),
  };
}
