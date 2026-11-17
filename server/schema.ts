// Cashflow Genius schema — PostgreSQL (Supabase) edition.
// Money is stored as integer minor units (paise/cents)
// so every calculation is exact decimal arithmetic — never floats.

import { bigint, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ---------- accounts (local workspace authentication) ----------
// Account rows live here with salted PBKDF2 password hashes and
// server-side sessions, while identity proof runs through the
// connected Supabase Auth project: Google OAuth sign-in, and email
// sign-up verification via a confirmation link that Supabase emails
// to the user's own inbox (never generated or shown by this app).
// The auth_codes table below is legacy from the retired local-code
// flow — its rows are historical and never read. Every user-owned
// row carries owner_id; all reads and writes are scoped to the
// signed-in account.

export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(), // email or +phone, lowercased
  channel: text("channel", { enum: ["email", "phone"] })
    .notNull()
    .default("email"),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  verified: integer("verified").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const authCodes = pgTable("auth_codes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  purpose: text("purpose", { enum: ["verify", "reset"] })
    .notNull()
    .default("verify"),
  codeHash: text("code_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(), // epoch ms
  consumed: integer("consumed").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  active: integer("active").notNull().default(1),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(), // epoch ms
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const businesses = pgTable("businesses", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  // How this account uses the app: "business" turns on the business money
  // management modules; "personal" focuses on daily spending. Saved per
  // account on the workspace row; switching never touches transactions.
  mode: text("mode", { enum: ["business", "personal", "creator", "student"] })
    .notNull()
    .default("business"),
  name: text("name").notNull().default(""),
  industry: text("industry").notNull().default(""),
  country: text("country").notNull().default("India"),
  currency: text("currency").notNull().default("INR"),
  openingBalanceCents: bigint("opening_balance_cents", { mode: "number" }).notNull().default(0),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  ownerName: text("owner_name").notNull().default(""),
  ownerEmail: text("owner_email").notNull().default(""),
  // Optional contact phone kept ONLY as a profile detail for the
  // workspace (shown on the profile, handy on invoices). It is never
  // a sign-in identifier and no SMS/OTP is ever sent to it — phone
  // sign-up/login were removed because SMS OTP is never free.
  ownerPhone: text("owner_phone").notNull().default(""),
  gstRateBp: integer("gst_rate_bp").notNull().default(1800), // 18.00%
  gstInclusive: integer("gst_inclusive").notNull().default(1),
  eligibleExpensePct: integer("eligible_expense_pct").notNull().default(60),
  onboarded: integer("onboarded").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  type: text("type", { enum: ["income", "expense"] }).notNull(),
  status: text("status", { enum: ["posted", "pending"] })
    .notNull()
    .default("posted"),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  counterparty: text("counterparty").notNull().default(""),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  date: text("date").notNull(), // yyyy-mm-dd, the transaction's own day
  // How the money moved: "UPI" | "Cash" | "Card" | "Bank transfer" |
  // "Other" | "" (not recorded — older rows). UPI is a first-class
  // option throughout the UI; this is the user's own record of the
  // method, never an automatic bank/UPI sync (none is connected).
  paymentMethod: text("payment_method").notNull().default(""),
  invoiceId: text("invoice_id").unique(),
  emiInstalmentId: text("emi_instalment_id").unique(),
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  number: text("number").notNull(),
  customerName: text("customer_name").notNull().default(""),
  customerEmail: text("customer_email").notNull().default(""),
  status: text("status", { enum: ["draft", "sent", "paid"] })
    .notNull()
    .default("draft"),
  issueDate: text("issue_date").notNull(),
  dueDate: text("due_date").notNull(),
  discountBp: integer("discount_bp").notNull().default(0),
  taxBp: integer("tax_bp").notNull().default(1800),
  notes: text("notes").notNull().default(""),
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
}, (t) => [
  // One invoice number per workspace: two invoices with the same
  // number in the same owner's workspace are a duplicate, full stop.
  // (2026-11-14 live test: the stale UI made a save look like it did
  // nothing, so the same INV-2026-001 was saved twice and both rows
  // persisted — there was no guard at all. The server-side check in
  // saveInvoice gives the plain-language error; this index is the
  // race-proof backstop, and it also blocks duplicates from any
  // other path, e.g. a restored backup.)
  uniqueIndex("invoices_owner_mode_number_unique").on(t.ownerId, t.mode, t.number),
]);

export const invoiceItems = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull(),
  description: text("description").notNull().default(""),
  qtyMilli: integer("qty_milli").notNull().default(1000), // quantity x1000
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull().default(0),
  sort: integer("sort").notNull().default(0),
});

export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  title: text("title").notNull().default("Untitled note"),
  content: text("content").notNull().default(""),
  category: text("category").notNull().default("General"),
  tags: text("tags").notNull().default(""),
  pinned: integer("pinned").notNull().default(0),
  sourceModule: text("source_module").notNull().default(""),
  sourceId: text("source_id").notNull().default(""),
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const noteVersions = pgTable("note_versions", {
  id: text("id").primaryKey(),
  noteId: text("note_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const scenarios = pgTable("scenarios", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  name: text("name").notNull(),
  params: text("params").notNull().default("{}"), // JSON of simulation inputs
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const recurringCashflows = pgTable("recurring_cashflows", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  type: text("type", { enum: ["income", "expense"] }).notNull(),
  category: text("category").notNull().default("General"),
  description: text("description").notNull().default(""),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  frequency: text("frequency", { enum: ["weekly", "monthly"] })
    .notNull()
    .default("monthly"),
  nextDate: text("next_date").notNull(),
  active: integer("active").notNull().default(1),
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const budgets = pgTable("budgets", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  category: text("category").notNull(), // unique per owner, enforced in actions (see migration 0003)
  monthlyLimitCents: bigint("monthly_limit_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const aiConversations = pgTable("ai_conversations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  title: text("title").notNull().default("Conversation"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const aiMessages = pgTable("ai_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

// ---------- EMI plans (products sold on instalments) ----------
// A plan belongs to one customer and one product. Its instalments are
// generated once, server-side, from the total, down payment, count,
// frequency and first due date. Collecting an instalment creates exactly
// one income transaction linked by transactions.emi_instalment_id (unique),
// mirroring the invoice-payment duplicate guard.

export const emiPlans = pgTable("emi_plans", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  customerName: text("customer_name").notNull().default(""),
  customerContact: text("customer_contact").notNull().default(""),
  product: text("product").notNull().default(""),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  downPaymentCents: bigint("down_payment_cents", { mode: "number" }).notNull().default(0),
  instalmentCount: integer("instalment_count").notNull(),
  frequency: text("frequency", { enum: ["monthly", "weekly"] })
    .notNull()
    .default("monthly"),
  firstDueDate: text("first_due_date").notNull(),
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const emiInstalments = pgTable("emi_instalments", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull(),
  seq: integer("seq").notNull(), // 1-based instalment number
  dueDate: text("due_date").notNull(), // yyyy-mm-dd
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  status: text("status", { enum: ["pending", "paid"] })
    .notNull()
    .default("pending"),
  paidDate: text("paid_date"), // yyyy-mm-dd, set when collected
  transactionId: text("transaction_id").unique(),
});

// ---------- Scam Shield check history ----------
// One row per analysis the user runs. Only the pasted text excerpt and the
// findings are kept (never the uploaded image bytes), so history stays
// small and the user can re-check what was flagged before.

export const scamChecks = pgTable("scam_checks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this record belongs to
  kind: text("kind", { enum: ["text", "screenshot", "both"] })
    .notNull()
    .default("text"),
  excerpt: text("excerpt").notNull().default(""),
  verdict: text("verdict").notNull(), // high_risk | suspicious | no_strong_signs
  riskScore: integer("risk_score").notNull().default(0),
  reasonsJson: text("reasons_json").notNull().default("[]"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

// ---------- per-account active workspace ----------
// Each account has up to four fully separate workspaces, one per money
// mode (business / personal / creator / student). Every record table
// carries a `mode` column naming its workspace; this row remembers which
// workspace the account is currently looking at. Switching modes only
// changes this pointer — records are never moved or mixed.

export const userWorkspaceState = pgTable("user_workspace_state", {
  ownerId: text("owner_id").primaryKey(),
  activeMode: text("active_mode").notNull().default("business"),
  // The account's chosen mouse cursor style for the custom desktop
  // cursor: "blue" | "gradient" | "minimal" | "mint" | "off". It is
  // per ACCOUNT (not per workspace), so it follows the user across all
  // four money-mode workspaces, survives logout/login, and defaults to
  // "blue" (the Blue Particle cursor) for existing accounts.
  cursorStyle: text("cursor_style").notNull().default("blue"),
  // Whether the account has finished the onboarding app tour or ticked
  // "Don't show this tour again": 1 = never auto-open the tour again.
  // Per ACCOUNT, like the cursor style; accounts created before the
  // tour existed keep 0 but are only auto-shown the tour right after
  // their first workspace setup, and can open it from Settings anyway.
  tourDismissed: integer("tour_dismissed").notNull().default(0),
  // The account's own Gemini API key, IF they choose to save one in
  // Settings for a future Gemini connection. It is stored server-side
  // only: actions never return the key itself to the browser (only
  // whether one is saved, and its last 4 characters), and saving a key
  // does NOT make Gemini "live" — the Live connections status stays
  // "Not connected" until a Gemini call is actually wired and verified.
  geminiApiKey: text("gemini_api_key"),
  // Which AI engine answers the AI CFO: "gemini" (default — Google AI
  // Studio key, gemini-3.8-flash) or "openrouter" (OpenRouter key, any
  // model id, defaulting to a free :free model). Per ACCOUNT, like the
  // cursor style. Switching provider never touches records — only
  // which engine the CFO calls — and it clears the verified flag
  // below, so the new provider must prove itself with a real call.
  aiProvider: text("ai_provider").notNull().default("gemini"),
  // The account's own OpenRouter API key, IF they choose to save one
  // in Settings. Same server-side-only rule as geminiApiKey: never
  // returned to the browser, only saved + last 4 characters.
  openRouterApiKey: text("openrouter_api_key"),
  // The OpenRouter model id used when OpenRouter is the provider.
  // Default is a free model (google/gemma-4-31b-it:free); the free
  // roster rotates, so the user can change this in Settings — any
  // :free model costs nothing (capped at 50 requests/day without
  // credits), and a paid model id such as openai/gpt-4o-mini works
  // through the same endpoint when the account has credits.
  openRouterModel: text("openrouter_model")
    .notNull()
    .default("google/gemma-4-31b-it:free"),
  // When a real AI call last succeeded, and with which provider. The
  // Live connections probe shows an engine "Live" only when this flag
  // names the currently selected provider — a saved key alone is never
  // enough. Cleared whenever the provider, key or model changes, so a
  // new configuration must prove itself again.
  aiVerifiedAt: timestamp("ai_verified_at", { mode: "date" }),
  aiVerifiedProvider: text("ai_verified_provider"),
});

// ---------- custom categories (user-typed, remembered per workspace) ----------
// When a user picks "Custom" in a category dropdown and types their own
// name, that name is remembered here — scoped to the account (owner_id)
// and to the one workspace (mode) it was typed in, plus the money
// direction (income / expense) it was used for. It then appears in that
// workspace's category dropdowns next time. Uniqueness per
// owner+mode+type+name (case-insensitive) is enforced in the actions
// (see rememberCustomCategory), mirroring how budgets enforce their
// per-owner uniqueness. Built-in category names are never stored here.

// ---------- CSV import batches (undo support) ----------
// Each CSV import records the exact transaction ids it created, in the
// workspace it imported into, so "Undo last import" can remove precisely
// those rows — and nothing the user recorded by hand.

export const importBatches = pgTable("import_batches", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"),
  txnIdsJson: text("txn_ids_json").notNull().default("[]"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

// ---------- Savings Goals / Savings Pots ----------
// A goal belongs to exactly one workspace (mode). Money moves in and out
// only through savings_transfers: a deposit moves money from that
// workspace's available cash into the pot, a withdrawal moves it back.
// Transfers are NOT income or expense — they never enter revenue /
// expense totals — they are counted exactly once, as a change in the
// workspace's available cash (cash = opening + income − expenses −
// net saved). Every transfer row carries owner_id + mode, so savings
// in one workspace can never leak into or be counted in another.

export const savingsGoals = pgTable("savings_goals", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this goal belongs to
  name: text("name").notNull().default(""),
  targetCents: bigint("target_cents", { mode: "number" }).notNull(),
  targetDate: text("target_date").notNull(), // yyyy-mm-dd
  demo: integer("demo").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const savingsTransfers = pgTable("savings_transfers", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this transfer belongs to
  direction: text("direction", { enum: ["deposit", "withdraw"] })
    .notNull()
    .default("deposit"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // always positive; direction says which way
  date: text("date").notNull(), // yyyy-mm-dd, the transfer's own day
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

// ---------- Trash / undo snapshots ----------
// Every delete (transaction, invoice, budget, note, recurring schedule,
// scenario, EMI plan, savings goal, custom category, a whole CSV import
// being undone, or the demo dataset being cleared) first writes one row
// here holding the full deleted record(s) as JSON — including linked
// rows (invoice items, EMI instalments, savings transfers, note
// versions). restoreDeletedItem re-inserts exactly those rows (same
// ids, same workspace), so Undo after a delete really brings the item
// and its linked data back. Snapshots are scoped to owner + workspace
// and are consumed (removed) when restored.

export const trashItems = pgTable("trash_items", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  mode: text("mode").notNull().default("business"), // workspace the item was deleted from
  kind: text("kind").notNull(), // transaction | invoice | budget | note | recurring | scenario | emi_plan | savings_goal | custom_category | transactions_bulk | demo_bulk
  label: text("label").notNull().default(""),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export const customCategories = pgTable("custom_categories", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("legacy"),
  mode: text("mode").notNull().default("business"), // workspace this category belongs to
  name: text("name").notNull(),
  type: text("type", { enum: ["income", "expense"] })
    .notNull()
    .default("expense"),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});
