// Cashflow Genius server actions.
//
// Persistence: Supabase Postgres (Drizzle pg-core). All money is integer
// minor units (paise) so calculations are exact. AI CFO answers are
// produced by Gemini (free tier) when a key is configured — the account's
// saved key or the server GEMINI_API_KEY — grounded in figures computed
// here from the stored records. With no key, the AI CFO answers with an
// honest rule-based fallback built from the same figures, and the UI
// states plainly that no AI model is connected rather than pretending
// otherwise.

import { defineAction, z, type ActionsModule } from "./lib/actions";
import { and, asc, desc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import * as schema from "./schema";
import { db, checkDatabase, dbErrorCode } from "./lib/db";
import { convertMinor, fetchRate } from "./lib/rates";
import { aiComplete, getAiSettings, aiExtrasFromRow, DEFAULT_OPENAI_MODEL } from "./lib/ai";
import {
  loadBriefingBatch,
  loadCombinedBatch,
  loadWorkspaceBatch,
  loadWorkspacePrelude,
} from "./lib/batch";
import {
  detectInsights,
  confidenceLabel,
  type GeneratedInsight,
  type InsightInput,
} from "./lib/insights";
import { imageReasons, scoreReasons } from "./lib/scamShield";

type Db = typeof db;

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- money modes = separate workspaces ----------
// Every account has up to four fully separate workspaces, one per money
// mode. Each record row carries the `mode` of its workspace; all reads
// and writes are scoped to the account's ACTIVE workspace, so data is
// never mixed between modes. Switching modes only moves the pointer in
// user_workspace_state — it never creates, moves or deletes a record.

export const APP_MODES = ["business", "personal", "creator", "student"] as const;
export type AppModeT = (typeof APP_MODES)[number];

export const MODE_LABELS: Record<AppModeT, string> = {
  business: "Business Money",
  personal: "Personal Money",
  creator: "Creator & Freelancer",
  student: "Student / First Salary",
};

const MODE_DEFAULT_NAMES: Record<AppModeT, string> = {
  business: "My Business",
  personal: "My Money",
  creator: "My Creator Studio",
  student: "My Student Budget",
};

function asMode(v: string): AppModeT {
  return (APP_MODES as readonly string[]).includes(v) ? (v as AppModeT) : "business";
}

/** The account's currently active workspace mode. Derived (and stored)
 *  on first use from the account's original workspace row, so accounts
 *  created before separate workspaces open exactly where they left off. */
async function activeMode(db: Db, ownerId: string): Promise<AppModeT> {
  const st = await db
    .select()
    .from(schema.userWorkspaceState)
    .where(eq(schema.userWorkspaceState.ownerId, ownerId))
    .limit(1);
  if (st[0]) return asMode(st[0].activeMode);
  const biz = await db
    .select()
    .from(schema.businesses)
    .where(eq(schema.businesses.ownerId, ownerId))
    .limit(1);
  const derived = asMode(biz[0]?.mode ?? "business");
  await db
    .insert(schema.userWorkspaceState)
    .values({ ownerId, activeMode: derived })
    .onConflictDoNothing();
  return derived;
}

async function setActiveMode(db: Db, ownerId: string, mode: AppModeT): Promise<void> {
  await db
    .insert(schema.userWorkspaceState)
    .values({ ownerId, activeMode: mode })
    .onConflictDoUpdate({
      target: schema.userWorkspaceState.ownerId,
      set: { activeMode: mode },
    });
}

// ---------- cursor style preference (per account) ----------
// The custom desktop cursor is a per-account preference, stored on the
// user_workspace_state row (one row per account). It is NOT per
// workspace: the same cursor follows the user through every money-mode
// workspace. Existing accounts have no row value yet and read as the
// default "blue" (Blue Particle — the cursor the app already shipped).

export const CURSOR_STYLES = ["blue", "gradient", "minimal", "mint", "off"] as const;
export type CursorStyleT = (typeof CURSOR_STYLES)[number];

export const CURSOR_STYLE_LABELS: Record<CursorStyleT, string> = {
  blue: "Blue Particle",
  gradient: "Gradient",
  minimal: "Minimal",
  mint: "Mint",
  off: "Off / Default",
};

function asCursorStyle(v: string | null | undefined): CursorStyleT {
  return (CURSOR_STYLES as readonly string[]).includes(v ?? "")
    ? (v as CursorStyleT)
    : "blue";
}

/** The account's user_workspace_state row (active mode + cursor style),
 *  creating it on first use. getState's prelude already ensures the row
 *  exists via activeMode, so in the normal path this is exactly one
 *  select. The per-setting readers used to call activeMode() first and
 *  then select this same row again — two sequential round-trips each,
 *  hidden inside getState's "parallel" batch. */
async function workspaceStateRow(db: Db, ownerId: string) {
  const rows = await db
    .select()
    .from(schema.userWorkspaceState)
    .where(eq(schema.userWorkspaceState.ownerId, ownerId))
    .limit(1);
  if (rows[0]) return rows[0];
  await db
    .insert(schema.userWorkspaceState)
    .values({ ownerId, activeMode: "business" })
    .onConflictDoNothing();
  const again = await db
    .select()
    .from(schema.userWorkspaceState)
    .where(eq(schema.userWorkspaceState.ownerId, ownerId))
    .limit(1);
  return again[0] ?? null;
}

/** The account's saved cursor style, defaulting to "blue". */
async function cursorStyleOf(db: Db, ownerId: string): Promise<CursorStyleT> {
  const row = await workspaceStateRow(db, ownerId);
  return asCursorStyle(row?.cursorStyle);
}

async function setCursorStyleRow(
  db: Db,
  ownerId: string,
  style: CursorStyleT,
): Promise<void> {
  const mode = await activeMode(db, ownerId);
  await db
    .insert(schema.userWorkspaceState)
    .values({ ownerId, activeMode: mode, cursorStyle: style })
    .onConflictDoUpdate({
      target: schema.userWorkspaceState.ownerId,
      set: { cursorStyle: style },
    });
}

// ---------- app tour preference (per account) ----------
// The onboarding app tour auto-opens once for a brand-new account
// right after its first workspace setup. Finishing the tour — or
// closing it with “Don't show this tour again” ticked — saves
// tour_dismissed = 1 on the account's state row, so it never
// auto-opens again on any device. The tour stays re-openable any time
// from Settings regardless of this flag.

async function tourDismissedOf(db: Db, ownerId: string): Promise<boolean> {
  await activeMode(db, ownerId);
  const rows = await db
    .select()
    .from(schema.userWorkspaceState)
    .where(eq(schema.userWorkspaceState.ownerId, ownerId))
    .limit(1);
  return rows[0]?.tourDismissed === 1;
}

async function setTourDismissedRow(db: Db, ownerId: string): Promise<void> {
  const mode = await activeMode(db, ownerId);
  await db
    .insert(schema.userWorkspaceState)
    .values({ ownerId, activeMode: mode, tourDismissed: 1 })
    .onConflictDoUpdate({
      target: schema.userWorkspaceState.ownerId,
      set: { tourDismissed: 1 },
    });
}

async function ensureBusiness(db: Db, ownerId: string, mode: AppModeT = "business") {
  const rows = await db
    .select()
    .from(schema.businesses)
    .where(and(eq(schema.businesses.ownerId, ownerId), eq(schema.businesses.mode, mode)))
    .limit(1);
  if (rows[0]) return rows[0];
  const all = await db.select().from(schema.businesses);
  const nextId = all.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  await db.insert(schema.businesses).values({ id: nextId, ownerId, mode });
  const created = await db
    .select()
    .from(schema.businesses)
    .where(and(eq(schema.businesses.ownerId, ownerId), eq(schema.businesses.mode, mode)))
    .limit(1);
  return created[0]!;
}

/** Ensures the workspace row for `mode` exists. A brand-new secondary
 *  workspace inherits the account's profile basics (owner, currency,
 *  country, timezone, GST settings) from an existing onboarded workspace
 *  so switching is smooth — but its records always start empty and stay
 *  separate. The account's very first workspace is left un-onboarded so
 *  the Welcome setup runs for it. */
async function ensureWorkspace(db: Db, ownerId: string, mode: AppModeT) {
  const existing = await db
    .select()
    .from(schema.businesses)
    .where(and(eq(schema.businesses.ownerId, ownerId), eq(schema.businesses.mode, mode)))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await ensureBusiness(db, ownerId, mode);
  const all = await db
    .select()
    .from(schema.businesses)
    .where(eq(schema.businesses.ownerId, ownerId));
  const donor =
    all.find((b) => b.id !== created.id && b.onboarded === 1) ??
    all.find((b) => b.id !== created.id);
  if (!donor) return created;
  await db
    .update(schema.businesses)
    .set({
      name: MODE_DEFAULT_NAMES[mode],
      country: donor.country,
      currency: donor.currency,
      timezone: donor.timezone,
      ownerName: donor.ownerName,
      ownerEmail: donor.ownerEmail,
      ownerPhone: donor.ownerPhone,
      gstRateBp: donor.gstRateBp,
      gstInclusive: donor.gstInclusive,
      eligibleExpensePct: donor.eligibleExpensePct,
      onboarded: 1,
      updatedAt: new Date(),
    })
    .where(eq(schema.businesses.id, created.id));
  const refreshed = await db
    .select()
    .from(schema.businesses)
    .where(eq(schema.businesses.id, created.id))
    .limit(1);
  return refreshed[0]!;
}

async function log(
  db: Db,
  action: string,
  detail: string,
  ownerId = "legacy",
  mode?: string,
) {
  // Activity entries belong to the workspace that was active when they
  // happened, so each workspace keeps its own history. Callers that
  // already know the mode pass it, so this does not spend another
  // round-trip re-reading it (setMode's handler already knows it).
  let m: string = mode ?? "business";
  if (!mode) {
    try {
      m = await activeMode(db, ownerId);
    } catch {
      m = "business";
    }
  }
  await db.insert(schema.activityLogs).values({ action, detail, ownerId, mode: m });
}

/** Throws a plain-language error when another invoice in this
 *  owner's workspace already uses this number. `exceptId` lets an
 *  edit keep its own number. This is the user-facing guard; the
 *  unique index on (owner_id, mode, number) is the race-proof
 *  backstop for two saves landing at the same instant. */
async function assertInvoiceNumberFree(
  db: Db,
  ownerId: string,
  mode: string,
  number: string,
  exceptId?: string,
) {
  const clash = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.ownerId, ownerId),
        eq(schema.invoices.mode, mode),
        eq(schema.invoices.number, number),
      ),
    )
    .limit(1);
  if (clash[0] && clash[0].id !== exceptId)
    throw new Error(
      `An invoice with number ${number} already exists in this workspace. Change the number and try again.`,
    );
}

// ---------- custom categories ----------
// Every built-in category name across all four modes (mirrors the client
// lists in lib.ts). A saved category matching one of these (any case) is
// a built-in and is never stored as a custom category.
const BUILTIN_CATEGORY_NAMES = new Set(
  [
    "Customer payments", "Sales", "Retainers", "Other income",
    "Salaries", "Rent", "Suppliers", "Subscriptions", "Marketing",
    "Utilities", "Travel", "Taxes & fees", "Equipment", "General",
    "Salary", "Freelance & side work", "Family & friends", "Refunds",
    "Food & groceries", "Rent & home", "Transport", "Bills & utilities",
    "Bills", "EMI", "Loans", "Extra expenses",
    "Shopping", "Health", "Entertainment", "Education",
    "Client payments", "Brand deals", "Platform payouts",
    "Course & digital sales", "Software & subscriptions",
    "Professional services",
    "Pocket money", "Salary — first job", "Part-time & internships",
    "Scholarships", "Food & canteen", "Fees & education",
    "Books & courses", "Bills & recharge",
  ].map((n) => n.toLowerCase()),
);

/** Remembers a user-typed category for one workspace + direction, so it
 *  appears in that workspace's dropdowns next time. No-ops for blank
 *  names, built-in names, and names already remembered (case-insensitive
 *  — the first casing typed is the one kept). Never touches another
 *  workspace: the row is stamped with the active workspace's mode. */
async function rememberCustomCategory(
  db: Db,
  ownerId: string,
  mode: AppModeT,
  type: "income" | "expense",
  rawName: string,
): Promise<void> {
  const name = rawName.trim();
  if (!name) return;
  if (BUILTIN_CATEGORY_NAMES.has(name.toLowerCase())) return;
  const existing = await db
    .select()
    .from(schema.customCategories)
    .where(
      and(
        eq(schema.customCategories.ownerId, ownerId),
        eq(schema.customCategories.mode, mode),
        eq(schema.customCategories.type, type),
      ),
    );
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
  await db.insert(schema.customCategories).values({
    id: uid(),
    ownerId,
    mode,
    name,
    type,
  });
}

// ---------- authentication ----------
// Two real sign-in paths, both ending in this database's server-side
// session tokens:
//  - Email + password: the account row lives in this database (salted
//    PBKDF2 password hash; login and all records stay here), but the
//    email address itself is verified by Supabase Auth: sign-up calls
//    Supabase's /auth/v1/signup, Supabase emails the user a REAL
//    confirmation LINK through its built-in free email sender, and
//    opening the link signs the account in (confirmEmailLink verifies
//    the returned Supabase token server-side). A 6-digit code is only
//    a fallback: if an email also carries one, verifyAccount checks
//    the code the user types against Supabase's /auth/v1/otp endpoint
//    before the local account is marked verified and a session
//    starts. The link and code are never generated, stored or shown
//    by this app — they exist only in the user's inbox and inside
//    Supabase. Free-tier honesty: Supabase's built-in sender allows
//    only a few auth emails per HOUR for the whole project, so
//    sign-ups can hit its rate limit; when that happens the actions
//    say so plainly instead of pretending an email went out. Phone/mobile sign-up and login were removed (no SMS OTP —
//    SMS is never free); a phone number can only be an optional
//    profile detail, never a sign-in method. Accounts created with a
//    mobile number before the removal keep working with their number
//    + password (they were verified back then); no NEW phone account
//    can be created, and an unverified phone account can no longer be
//    verified — it has no workspace data, and its owner can sign up
//    fresh with an email address instead.
//  - Google: Supabase Auth with the Google provider enabled (project
//    constants below). The browser runs the real OAuth flow against
//    Supabase; the returned Supabase access token is verified HERE,
//    server-side, against Supabase's /auth/v1/user endpoint before
//    any local account is opened — a token Supabase does not vouch
//    for is rejected. A verified Google email maps to that person's
//    own local account (created empty on first Google sign-in).
// Every data action requires a verified session and scopes every
// read and write to that account's owner_id.

// ---------- Supabase (Google sign-in + email verification) ----------
// The project the app owner created for Cashflow Genius. The
// publishable (anon) key is a PUBLIC client key: it identifies the
// project and is safe in client code. No secret / service-role key
// and no Google Client Secret is used or stored anywhere in this
// artifact — those live only in the Supabase / Google dashboards.
// Supabase provides identity only (Google OAuth + email verification); all
// records stay in this workspace's own database, scoped by owner_id.

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://zfngqppwmyizlnrzhrjc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_6D9rlSGsbPzqkMVyWdrZ3w_60JseEvy";

type SupabaseProbe = {
  reachable: boolean;
  googleEnabled: boolean;
  emailEnabled: boolean;
  checkedAtMs: number;
};
let supabaseProbeCache: SupabaseProbe | null = null;

/** fetch() with a hard timeout: a slow or unreachable Supabase must
 *  degrade to "not verified" in seconds, never hang an action. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 6000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Real live check against Supabase Auth: GET /auth/v1/settings with
 *  the publishable key. `googleEnabled` / `emailEnabled` are true only
 *  when Supabase itself reports those providers enabled — never
 *  assumed. Cached for 60s so status polling stays cheap. */
async function probeSupabase(): Promise<SupabaseProbe> {
  if (
    supabaseProbeCache &&
    Date.now() - supabaseProbeCache.checkedAtMs < 60_000
  )
    return supabaseProbeCache;
  let probe: SupabaseProbe = {
    reachable: false,
    googleEnabled: false,
    emailEnabled: false,
    checkedAtMs: Date.now(),
  };
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        external?: { google?: boolean; email?: boolean };
      } | null;
      probe = {
        reachable: true,
        googleEnabled: data?.external?.google === true,
        emailEnabled: data?.external?.email === true,
        checkedAtMs: Date.now(),
      };
    }
  } catch {
    /* Supabase unreachable from the server right now — reported as such */
  }
  supabaseProbeCache = probe;
  return probe;
}

/** Verifies a Supabase access token by asking Supabase who it belongs
 *  to (GET /auth/v1/user). Returns the Google identity only when
 *  Supabase vouches for the token AND the user has an email (Google
 *  sign-ins always do); anything else returns null. */
async function supabaseUserForToken(
  accessToken: string,
): Promise<{ id: string; email: string; name: string } | null> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as {
      id?: string;
      email?: string;
      user_metadata?: { full_name?: string; name?: string };
    } | null;
    if (!u?.id || !u?.email) return null;
    return {
      id: u.id,
      email: u.email.toLowerCase(),
      name: u.user_metadata?.full_name ?? u.user_metadata?.name ?? "",
    };
  } catch {
    return null;
  }
}

// ---------- Supabase email verification (sign-up) ----------
// Email verification runs on Supabase Auth's email provider with
// Supabase's built-in (free) email sender: this server calls the
// Supabase Auth REST API with the publishable key, Supabase emails a
// confirmation LINK to the user's own address (the live test of
// 2026-11-14 proved the email carries a link, not a 6-digit code,
// despite the sign-up page once promising a code), and opening the
// link signs the account in via confirmEmailLink. A code is only a
// fallback: if an email also carries one, verifyAccount checks it
// against Supabase — this app never sees, stores or shows the link
// or the code. The built-in sender is rate-limited to a few auth
// emails per hour for the whole project (free tier), so every helper
// maps Supabase's `over_email_send_rate_limit` answer to a plain
// message instead of pretending an email was sent.

type SupabaseAuthResult =
  | { ok: true; alreadyRegistered: boolean; emailConfirmed: boolean }
  | { ok: false; error: string };

function supabaseAuthErrorMessage(
  status: number,
  data: { error_code?: string; msg?: string; error_description?: string } | null,
  fallback: string,
): string {
  const code = data?.error_code ?? "";
  const raw = data?.msg ?? data?.error_description ?? "";
  if (code === "over_email_send_rate_limit" || status === 429)
    return "Supabase's free email sender has reached its limit for now — it only allows a few verification emails per hour. Please wait a little and try again, or use “Continue with Google” (free, no email limit).";
  if (code === "email_address_invalid")
    return "That email address was rejected as invalid. Please check it and try again.";
  if (code === "weak_password")
    return "That password is too weak for Supabase's sign-up rules — please choose a longer one with a mix of letters and numbers.";
  if (code === "otp_expired" || code === "otp_disabled")
    return "That code is incorrect or has expired. Codes from the email last 1 hour — use “Send a new link” below and tap the newest one.";
  if (raw) return raw;
  return fallback;
}

async function supabaseAuthCall(
  path: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  data: {
    id?: string;
    email?: string;
    email_confirmed_at?: string;
    identities?: unknown[];
    access_token?: string;
    user?: { id?: string; email?: string; email_confirmed_at?: string };
    error_code?: string;
    msg?: string;
    error_description?: string;
  } | null;
}> {
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1${path}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      10_000,
    );
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      email?: string;
      email_confirmed_at?: string;
      identities?: unknown[];
      access_token?: string;
      user?: { id?: string; email?: string; email_confirmed_at?: string };
      error_code?: string;
      msg?: string;
      error_description?: string;
    } | null;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

/** Starts a Supabase email sign-up: Supabase creates the (unconfirmed)
 *  Auth user and emails the confirmation link. `alreadyRegistered` is true
 *  when Supabase reports the email is already registered (it answers
 *  with a user whose identities list is empty, to avoid leaking which
 *  emails exist) — no fresh email is sent in that case, so the caller
 *  follows up with a resend. */
async function supabaseEmailSignup(
  email: string,
  password: string,
): Promise<SupabaseAuthResult> {
  const { status, data } = await supabaseAuthCall("/signup", {
    email,
    password,
  });
  if (status === 0)
    return {
      ok: false,
      error:
        "Supabase could not be reached just now, so no verification email was sent. Please try again in a moment — or use “Continue with Google”.",
    };
  if (status >= 200 && status < 300 && data) {
    const alreadyRegistered =
      Array.isArray(data.identities) && data.identities.length === 0;
    return {
      ok: true,
      alreadyRegistered,
      emailConfirmed: !!data.email_confirmed_at,
    };
  }
  return {
    ok: false,
    error: supabaseAuthErrorMessage(
      status,
      data,
      "Supabase could not start that sign-up, so no verification email was sent.",
    ),
  };
}

/** Asks Supabase to email a fresh sign-up confirmation link for an
 *  unconfirmed address. Supabase answers {} whether or not the
 *  address exists, so a 2xx here means "request accepted", never
 *  proof of an account. */
async function supabaseResendSignupEmail(
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { status, data } = await supabaseAuthCall("/resend", {
    type: "signup",
    email,
  });
  if (status === 0)
    return {
      ok: false,
      error:
        "Supabase could not be reached just now, so no new code was sent. Please try again in a moment.",
    };
  if (status >= 200 && status < 300) return { ok: true };
  return {
    ok: false,
    error: supabaseAuthErrorMessage(
      status,
      data,
      "Supabase could not send a new confirmation link just now.",
    ),
  };
}

/** Checks the 6-digit code the user typed against Supabase
 *  (POST /auth/v1/otp, type "signup", falling back to type "email"
 *  for codes Supabase issued as a generic email OTP). This is only
 *  the fallback path — the email Supabase actually sends carries a
 *  confirmation link, handled by confirmEmailLink. Success returns
 *  a Supabase session whose user must carry the same email address —
 *  anything else is rejected. */
async function supabaseVerifySignupOtp(
  email: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const type of ["signup", "email"] as const) {
    const { status, data } = await supabaseAuthCall("/otp", {
      email,
      token: code,
      type,
    });
    if (status === 0)
      return {
        ok: false,
        error:
          "Supabase could not be reached just now, so the code couldn't be checked. Please try again in a moment.",
      };
    if (status >= 200 && status < 300 && data?.access_token) {
      const verifiedEmail = (data.user?.email ?? "").toLowerCase();
      if (verifiedEmail !== email)
        return {
          ok: false,
          error:
            "Supabase verified a different email address than the one entered, so this sign-in was stopped. Please start again.",
        };
      return { ok: true };
    }
    if (type === "signup") {
      // A wrong / expired code answers otp_expired — retrying it as a
      // generic email OTP cannot succeed either; report it directly.
      if (data?.error_code === "otp_expired")
        return {
          ok: false,
          error: supabaseAuthErrorMessage(status, data, "That code is incorrect or has expired."),
        };
      if (status === 429)
        return {
          ok: false,
          error: supabaseAuthErrorMessage(status, data, "Too many attempts just now."),
        };
    }
  }
  return {
    ok: false,
    error:
      "That code is incorrect or has expired. Codes from the email last 1 hour — use “Send a new link” and tap the newest one.",
  };
}

type AuthUser = typeof schema.authUsers.$inferSelect;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function derivePasswordBits(
  password: string,
  salt: string,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashPassword(
  password: string,
): Promise<{ salt: string; hash: string }> {
  const salt = randomHex(16);
  const hash = await derivePasswordBits(password, salt);
  return { salt, hash };
}

async function checkPassword(
  password: string,
  salt: string,
  stored: string,
): Promise<boolean> {
  const calc = await derivePasswordBits(password, salt);
  if (calc.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++)
    diff |= calc.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

// (The old locally-generated verification codes — issueCode /
// consumeCode over the auth_codes table — are retired: email codes
// are now generated, emailed and checked by Supabase Auth, so this
// app never holds a code. The auth_codes table itself is left in
// place; existing rows are historical and are never read.)

// ---------- the removed demo account ----------
// The fictional demo account (demo@cashflow-genius.local, "Demo Studio")
// was removed at the owner's request: every sign-in path and all demo UI
// are gone. Its account row was initially left orphaned in the database,
// which left any still-live demo session valid — a phone that had entered
// the demo kept reopening straight into the fictional workspace, with no
// Exit demo button left to leave by. The purge below finishes the
// removal: it deletes the demo account and every record it owns (the
// same deletion set as deleteAccount), and currentUser runs it the
// moment a surviving demo session is presented, so a stuck device signs
// itself out and lands on the normal login / Google sign-in screen. It
// only ever touches this one hard-coded identifier — no real account
// can match it (it is a .local address, never a Google or user email).

const DEMO_IDENTIFIER = "demo@cashflow-genius.local";

async function purgeDemoAccountRows(db: Db): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.authUsers)
    .where(eq(schema.authUsers.identifier, DEMO_IDENTIFIER))
    .limit(1);
  const demo = rows[0];
  if (!demo) return false;
  const owner = demo.id;
  const invs = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.ownerId, owner));
  for (const inv of invs) await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
  const plans = await db.select({ id: schema.emiPlans.id }).from(schema.emiPlans).where(eq(schema.emiPlans.ownerId, owner));
  for (const p of plans) await db.delete(schema.emiInstalments).where(eq(schema.emiInstalments.planId, p.id));
  const noteRows = await db.select({ id: schema.notes.id }).from(schema.notes).where(eq(schema.notes.ownerId, owner));
  for (const n of noteRows) await db.delete(schema.noteVersions).where(eq(schema.noteVersions.noteId, n.id));
  const convs = await db.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(eq(schema.aiConversations.ownerId, owner));
  for (const c of convs) await db.delete(schema.aiMessages).where(eq(schema.aiMessages.conversationId, c.id));
  await db.delete(schema.savingsTransfers).where(eq(schema.savingsTransfers.ownerId, owner));
  await db.delete(schema.savingsGoals).where(eq(schema.savingsGoals.ownerId, owner));
  await db.delete(schema.transactions).where(eq(schema.transactions.ownerId, owner));
  await db.delete(schema.invoices).where(eq(schema.invoices.ownerId, owner));
  await db.delete(schema.emiPlans).where(eq(schema.emiPlans.ownerId, owner));
  await db.delete(schema.notes).where(eq(schema.notes.ownerId, owner));
  await db.delete(schema.scenarios).where(eq(schema.scenarios.ownerId, owner));
  await db.delete(schema.recurringCashflows).where(eq(schema.recurringCashflows.ownerId, owner));
  await db.delete(schema.budgets).where(eq(schema.budgets.ownerId, owner));
  await db.delete(schema.aiConversations).where(eq(schema.aiConversations.ownerId, owner));
  await db.delete(schema.activityLogs).where(eq(schema.activityLogs.ownerId, owner));
  await db.delete(schema.scamChecks).where(eq(schema.scamChecks.ownerId, owner));
  await db.delete(schema.customCategories).where(eq(schema.customCategories.ownerId, owner));
  await db.delete(schema.importBatches).where(eq(schema.importBatches.ownerId, owner));
  await db.delete(schema.trashItems).where(eq(schema.trashItems.ownerId, owner));
  await db.delete(schema.userWorkspaceState).where(eq(schema.userWorkspaceState.ownerId, owner));
  await db.delete(schema.businesses).where(eq(schema.businesses.ownerId, owner));
  await db.delete(schema.authCodes).where(eq(schema.authCodes.userId, owner));
  await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, owner));
  await db.delete(schema.authUsers).where(eq(schema.authUsers.id, owner));
  return true;
}

async function currentUser(
  db: Db,
  token: string | undefined,
): Promise<AuthUser | null> {
  if (!token) return null;
  // One round-trip, not two: the session and its user used to be
  // fetched in two sequential selects, which cost an extra
  // cross-region round-trip on EVERY action call (getState's prelude
  // included) — the same serialisation that made the live mode-switch
  // refetch take 15–30s. The join returns exactly the same rows.
  const rows = await db
    .select({ session: schema.authSessions, user: schema.authUsers })
    .from(schema.authSessions)
    .innerJoin(schema.authUsers, eq(schema.authSessions.userId, schema.authUsers.id))
    .where(eq(schema.authSessions.token, token))
    .limit(1);
  const sess = rows[0]?.session;
  if (!sess || sess.active !== 1 || sess.expiresAt < Date.now()) return null;
  const u = rows[0]?.user ?? null;
  if (u && u.identifier === DEMO_IDENTIFIER) {
    // A surviving session of the removed demo account: finish the
    // removal (account + all its records + this session) and report
    // signed-out, so the device lands on the login screen instead of
    // the fictional demo workspace.
    await purgeDemoAccountRows(db);
    return null;
  }
  return u;
}

async function requireUser(
  db: Db,
  token: string | undefined,
): Promise<AuthUser> {
  const u = await currentUser(db, token);
  if (!u)
    throw new Error(
      "Please log in to continue. Your session may have expired.",
    );
  if (u.verified !== 1)
    throw new Error("Please verify your account before continuing.");
  return u;
}

async function startSession(db: Db, userId: string): Promise<string> {
  const token = randomHex(32);
  await db
    .update(schema.authSessions)
    .set({ active: 0 })
    .where(eq(schema.authSessions.userId, userId));
  await db.insert(schema.authSessions).values({
    token,
    userId,
    active: 1,
    expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  });
  return token;
}

function identifierOf(
  raw: string,
): { channel: "email" | "phone"; identifier: string } | null {
  const v = raw.trim();
  if (v.includes("@")) return { channel: "email", identifier: v.toLowerCase() };
  const digits = v.replace(/[\s()-]/g, "");
  if (/^\+\d{10,15}$/.test(digits))
    return { channel: "phone", identifier: digits };
  return null;
}

// ---------- shared financial engine (server copy) ----------

type TxnRow = typeof schema.transactions.$inferSelect;
type InvRow = typeof schema.invoices.$inferSelect;
type ItemRow = typeof schema.invoiceItems.$inferSelect;

export function invoiceTotals(inv: InvRow, items: ItemRow[]) {
  const subtotal = items.reduce(
    (s, it) => s + Math.round((it.qtyMilli * it.unitPriceCents) / 1000),
    0,
  );
  const discount = Math.round((subtotal * inv.discountBp) / 10000);
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * inv.taxBp) / 10000);
  return { subtotal, discount, tax, total: taxable + tax };
}

export function effectiveStatus(inv: InvRow): string {
  if (inv.status === "paid") return "paid";
  if (inv.status === "sent" && inv.dueDate < todayStr()) return "overdue";
  return inv.status;
}

// ---------- EMI helpers ----------

type EmiPlanRow = typeof schema.emiPlans.$inferSelect;
type EmiInstRow = typeof schema.emiInstalments.$inferSelect;

/** Steps a yyyy-mm-dd date forward by one EMI period (monthly keeps the
 *  day-of-month, clamped to the target month's length). */
function stepEmiDate(date: string, frequency: "monthly" | "weekly"): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  if (frequency === "weekly") {
    const nd = new Date(Date.UTC(y, m - 1, d + 7));
    return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
  }
  const target = new Date(Date.UTC(y, m, 1)); // first of next month
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Splits (total − down payment) into `count` instalments; the rounding
 *  remainder lands on the final instalment so the parts sum exactly. */
function emiSchedule(
  totalCents: number,
  downPaymentCents: number,
  count: number,
  frequency: "monthly" | "weekly",
  firstDueDate: string,
): { seq: number; dueDate: string; amountCents: number }[] {
  const financed = totalCents - downPaymentCents;
  const base = Math.floor(financed / count);
  const out: { seq: number; dueDate: string; amountCents: number }[] = [];
  let date = firstDueDate;
  for (let i = 0; i < count; i++) {
    out.push({
      seq: i + 1,
      dueDate: date,
      amountCents: i === count - 1 ? financed - base * (count - 1) : base,
    });
    date = stepEmiDate(date, frequency);
  }
  return out;
}

function emiInstEffectiveStatus(inst: EmiInstRow): string {
  if (inst.status === "paid") return "paid";
  if (inst.dueDate < todayStr()) return "overdue";
  return "pending";
}

function emiPlanOut(
  plan: EmiPlanRow,
  instalments: EmiInstRow[],
) {
  const sorted = [...instalments].sort((a, b) => a.seq - b.seq);
  const collectedCents = sorted
    .filter((i) => i.status === "paid")
    .reduce((s, i) => s + i.amountCents, 0);
  return {
    id: plan.id,
    customerName: plan.customerName,
    customerContact: plan.customerContact,
    product: plan.product,
    totalCents: plan.totalCents,
    downPaymentCents: plan.downPaymentCents,
    instalmentCount: plan.instalmentCount,
    frequency: plan.frequency,
    firstDueDate: plan.firstDueDate,
    collectedCents,
    remainingCents: plan.totalCents - plan.downPaymentCents - collectedCents,
    paidCount: sorted.filter((i) => i.status === "paid").length,
    demo: plan.demo === 1,
    createdAt: plan.createdAt.toISOString(),
    instalments: sorted.map((i) => ({
      id: i.id,
      seq: i.seq,
      dueDate: i.dueDate,
      amountCents: i.amountCents,
      status: i.status,
      effectiveStatus: emiInstEffectiveStatus(i),
      paidDate: i.paidDate ?? null,
      transactionId: i.transactionId ?? null,
    })),
  };
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(key: string, delta: number): string {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function summarise(
  business: typeof schema.businesses.$inferSelect,
  txns: TxnRow[],
  netSavingsCents = 0,
) {
  const posted = txns.filter((t) => t.status === "posted");
  const revenue = posted
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amountCents, 0);
  const expenses = posted
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amountCents, 0);
  // Savings transfers are neither revenue nor expenses: money in a pot is
  // still the user's money, just set aside. Available cash therefore
  // subtracts the net amount currently held in this workspace's pots
  // (deposits − withdrawals) exactly once. Revenue, expenses and profit
  // above are untouched by savings, so nothing double-counts.
  const cash = business.openingBalanceCents + revenue - expenses - netSavingsCents;
  const cur = monthKey(todayStr());
  const prev = shiftMonth(cur, -1);
  const sumMonth = (type: "income" | "expense", mk: string) =>
    posted
      .filter((t) => t.type === type && monthKey(t.date) === mk)
      .reduce((s, t) => s + t.amountCents, 0);
  // Average monthly net burn over the last 3 complete months (for runway).
  let burnSum = 0;
  let burnMonths = 0;
  for (let i = 1; i <= 3; i++) {
    const mk = shiftMonth(cur, -i);
    const net = sumMonth("income", mk) - sumMonth("expense", mk);
    if (txns.some((t) => monthKey(t.date) === mk)) {
      burnSum += net;
      burnMonths++;
    }
  }
  const avgMonthlyNet = burnMonths > 0 ? burnSum / burnMonths : 0;
  const runwayMonths =
    avgMonthlyNet < 0 && cash > 0 ? cash / Math.abs(avgMonthlyNet) : null;
  return {
    revenueCents: revenue,
    expensesCents: expenses,
    profitCents: revenue - expenses,
    cashCents: cash,
    savingsCents: netSavingsCents,
    curRevenueCents: sumMonth("income", cur),
    curExpensesCents: sumMonth("expense", cur),
    prevRevenueCents: sumMonth("income", prev),
    prevExpensesCents: sumMonth("expense", prev),
    avgMonthlyNetCents: Math.round(avgMonthlyNet),
    runwayMonths,
    txnCount: txns.length,
  };
}

// ---------- Savings Goals helpers ----------

type SavingsGoalRow = typeof schema.savingsGoals.$inferSelect;
type SavingsTransferRow = typeof schema.savingsTransfers.$inferSelect;

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/** Net saved in one goal: deposits − withdrawals (transfers for that goal only). */
function savedForGoal(transfers: SavingsTransferRow[]): number {
  return transfers.reduce(
    (s, t) => s + (t.direction === "deposit" ? t.amountCents : -t.amountCents),
    0,
  );
}

/** On-track assessment for one goal, from its real dates and saved amount.
 *  Linear pace: if you had saved evenly from the day saving started to
 *  the target date, `expectedCents` is what would be saved by today.
 *  Saved ≥ expected → on track. This is an estimate from the goal's own
 *  dates, never a guarantee.
 *
 *  The pace clock starts on the EARLIER of the goal's creation date and
 *  its first transfer date. A goal whose deposits were
 *  recorded with earlier dates starts with backdated deposits while the
 *  goal row itself is created today — measuring from creation alone
 *  made "expected by today" come out as ₹0 next to a healthy saved
 *  balance, which read as nonsense. The first real deposit is when
 *  saving actually began, so that is the honest start line. */
function savingsAssessment(
  goal: SavingsGoalRow,
  savedCents: number,
  transfers: SavingsTransferRow[],
) {
  const today = todayStr();
  const createdDate = goal.createdAt.toISOString().slice(0, 10);
  const firstTransferDate = transfers.reduce<string | null>(
    (min, t) => (min === null || t.date < min ? t.date : min),
    null,
  );
  const startDate =
    firstTransferDate !== null && firstTransferDate < createdDate
      ? firstTransferDate
      : createdDate;
  const remainingCents = Math.max(0, goal.targetCents - savedCents);
  const progressPct =
    goal.targetCents > 0
      ? Math.min(100, Math.max(0, Math.round((savedCents / goal.targetCents) * 1000) / 10))
      : 100;
  const daysRemaining = daysBetween(today, goal.targetDate);
  const totalDays = Math.max(1, daysBetween(startDate, goal.targetDate));
  const elapsedDays = Math.min(totalDays, Math.max(0, daysBetween(startDate, today)));
  const expectedCents = Math.round((goal.targetCents * elapsedDays) / totalDays);
  let status: "completed" | "overdue" | "on_track" | "behind" | "not_started";
  if (savedCents >= goal.targetCents && goal.targetCents > 0) status = "completed";
  else if (goal.targetDate < today) status = "overdue";
  else if (transfers.length === 0 || savedCents <= 0) status = "not_started";
  else if (savedCents >= expectedCents) status = "on_track";
  else status = "behind";
  const monthsRemaining = daysRemaining > 0 ? Math.max(1, Math.ceil(daysRemaining / 30)) : 0;
  const requiredPerMonthCents =
    remainingCents > 0 && monthsRemaining > 0
      ? Math.ceil(remainingCents / monthsRemaining)
      : 0;
  return {
    savedCents,
    remainingCents,
    progressPct,
    status,
    daysRemaining,
    expectedCents,
    requiredPerMonthCents,
  };
}

function savingsGoalOut(
  goal: SavingsGoalRow,
  transfers: SavingsTransferRow[],
) {
  const sorted = [...transfers].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const a = savingsAssessment(goal, savedForGoal(transfers), transfers);
  return {
    id: goal.id,
    name: goal.name,
    targetCents: goal.targetCents,
    targetDate: goal.targetDate,
    mode: goal.mode,
    savedCents: a.savedCents,
    remainingCents: a.remainingCents,
    progressPct: a.progressPct,
    status: a.status,
    daysRemaining: a.daysRemaining,
    expectedCents: a.expectedCents,
    requiredPerMonthCents: a.requiredPerMonthCents,
    demo: goal.demo === 1,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
    transfers: sorted.map((t) => ({
      id: t.id,
      direction: t.direction,
      amountCents: t.amountCents,
      date: t.date,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

// ---------- zod shapes ----------

const businessShape = z.object({
  mode: z.enum(["business", "personal", "creator", "student"]),
  name: z.string(),
  industry: z.string(),
  country: z.string(),
  currency: z.string(),
  openingBalanceCents: z.number(),
  timezone: z.string(),
  ownerName: z.string(),
  ownerEmail: z.string(),
  ownerPhone: z.string(),
  gstRateBp: z.number(),
  gstInclusive: z.boolean(),
  eligibleExpensePct: z.number(),
  onboarded: z.boolean(),
});

const txnShape = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  category: z.string(),
  description: z.string(),
  counterparty: z.string(),
  amountCents: z.number(),
  date: z.string(),
  paymentMethod: z.string(),
  invoiceId: z.string().nullable(),
  demo: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const itemShape = z.object({
  id: z.string(),
  description: z.string(),
  qty: z.number(),
  unitPriceCents: z.number(),
});

const invoiceShape = z.object({
  id: z.string(),
  number: z.string(),
  customerName: z.string(),
  customerEmail: z.string(),
  status: z.string(),
  effectiveStatus: z.string(),
  issueDate: z.string(),
  dueDate: z.string(),
  discountPct: z.number(),
  taxPct: z.number(),
  notes: z.string(),
  items: z.array(itemShape),
  subtotalCents: z.number(),
  discountCents: z.number(),
  taxCents: z.number(),
  totalCents: z.number(),
  demo: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const noteShape = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  tags: z.string(),
  pinned: z.boolean(),
  sourceModule: z.string(),
  sourceId: z.string(),
  demo: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const emiInstalmentShape = z.object({
  id: z.string(),
  seq: z.number(),
  dueDate: z.string(),
  amountCents: z.number(),
  status: z.string(),
  effectiveStatus: z.string(),
  paidDate: z.string().nullable(),
  transactionId: z.string().nullable(),
});

const emiPlanShape = z.object({
  id: z.string(),
  customerName: z.string(),
  customerContact: z.string(),
  product: z.string(),
  totalCents: z.number(),
  downPaymentCents: z.number(),
  instalmentCount: z.number(),
  frequency: z.string(),
  firstDueDate: z.string(),
  collectedCents: z.number(),
  remainingCents: z.number(),
  paidCount: z.number(),
  demo: z.boolean(),
  createdAt: z.string(),
  instalments: z.array(emiInstalmentShape),
});

const scamReasonShape = z.object({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["critical", "high", "medium", "info"]),
});

const scamCheckShape = z.object({
  id: z.string(),
  kind: z.string(),
  excerpt: z.string(),
  verdict: z.string(),
  riskScore: z.number(),
  reasons: z.array(scamReasonShape),
  createdAt: z.string(),
});

// What the vision model may extract from an uploaded payment screenshot.
// Every field is "what the image appears to show" — never proof of payment.
// imageDescription is a one-phrase plain-English description of what the
// image actually shows, so a photo of a car can be judged as a car.
const imageOutShape = z.object({
  readable: z.boolean(),
  appearsToBePaymentScreenshot: z.boolean(),
  // Defaulted, not required: if the model ever omits the description, the
  // parse must still succeed (empty description) instead of failing the
  // whole vision result into "unreadable".
  imageDescription: z.string().default(""),
  visibleText: z.string(),
  senderOrReceiverName: z.string().nullable(),
  upiId: z.string().nullable(),
  amountText: z.string().nullable(),
  dateText: z.string().nullable(),
  statusWording: z.string().nullable(),
  editingSigns: z.string(),
});

const savingsTransferShape = z.object({
  id: z.string(),
  direction: z.string(),
  amountCents: z.number(),
  date: z.string(),
  note: z.string(),
  createdAt: z.string(),
});

const savingsGoalShape = z.object({
  id: z.string(),
  name: z.string(),
  targetCents: z.number(),
  targetDate: z.string(),
  mode: z.string(),
  savedCents: z.number(),
  remainingCents: z.number(),
  progressPct: z.number(),
  status: z.string(),
  daysRemaining: z.number(),
  expectedCents: z.number(),
  requiredPerMonthCents: z.number(),
  demo: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  transfers: z.array(savingsTransferShape),
});

const okShape = z.object({ ok: z.literal(true) });

// updateBusiness also reports a currency conversion, when one happened:
// the live rate used and how many rows were converted in each table.
// Optional, so callers that ignore it keep working unchanged.
const updateBusinessResponseShape = z.object({
  ok: z.literal(true),
  conversion: z
    .object({
      from: z.string(),
      to: z.string(),
      rate: z.number(),
      asOf: z.string(),
      convertedCounts: z.object({
        transactions: z.number().int(),
        invoiceItems: z.number().int(),
        recurring: z.number().int(),
        budgets: z.number().int(),
        emiPlans: z.number().int(),
        emiInstalments: z.number().int(),
        savingsGoals: z.number().int(),
        savingsTransfers: z.number().int(),
      }),
    })
    .optional(),
});

// Delete responses that carry an undo snapshot id: the client shows an
// Undo button after the delete, which calls restoreDeletedItem with
// this trashId to bring the exact record (and its linked rows) back.
const okTrashShape = z.object({ ok: z.literal(true), trashId: z.string().nullable() });

/** Snapshots a record (plus any linked rows, already gathered by the
 *  caller) into trash_items BEFORE it is deleted, and returns the
 *  snapshot id the client can undo with. The payload is the raw DB rows
 *  serialised as JSON; Dates become ISO strings and restoreDeletedItem
 *  revives timestamp fields back into Dates on the way in. */
async function pushTrash(
  db: Db,
  ownerId: string,
  mode: string,
  kind: string,
  label: string,
  payload: unknown,
): Promise<string> {
  const id = uid();
  await db.insert(schema.trashItems).values({
    id,
    ownerId,
    mode,
    kind,
    label,
    payloadJson: JSON.stringify(payload),
  });
  return id;
}

function bizOut(b: typeof schema.businesses.$inferSelect) {
  return {
    mode: b.mode,
    name: b.name,
    industry: b.industry,
    country: b.country,
    currency: b.currency,
    openingBalanceCents: b.openingBalanceCents,
    timezone: b.timezone,
    ownerName: b.ownerName,
    ownerEmail: b.ownerEmail,
    ownerPhone: b.ownerPhone,
    gstRateBp: b.gstRateBp,
    gstInclusive: b.gstInclusive === 1,
    eligibleExpensePct: b.eligibleExpensePct,
    onboarded: b.onboarded === 1,
  };
}

function txnOut(t: TxnRow) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    category: t.category,
    description: t.description,
    counterparty: t.counterparty,
    amountCents: t.amountCents,
    date: t.date,
    paymentMethod: t.paymentMethod ?? "",
    invoiceId: t.invoiceId ?? null,
    demo: t.demo === 1,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ---------- Proactive Financial Insights (helpers) ----------
// Pure shape for the dashboard: severity is coerced to the known
// enum (a row with anything else degrades to "info" instead of
// failing the response validation), evidence is a plain object.
type InsightRow = typeof schema.financialInsights.$inferSelect;

function insightOut(row: InsightRow) {
  const severity: "info" | "warning" | "critical" =
    row.severity === "critical" || row.severity === "warning" ? row.severity : "info";
  const evidence =
    typeof row.evidenceJson === "object" && row.evidenceJson !== null && !Array.isArray(row.evidenceJson)
      ? (row.evidenceJson as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    insightType: row.insightType,
    severity,
    title: row.title,
    description: row.description,
    evidenceJson: evidence,
    recommendedAction: row.recommendedAction,
    confidence: row.confidence,
    confidenceLabel: confidenceLabel(row.confidence),
    status: row.status,
    insightKey: row.insightKey,
    generatedAt: row.generatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/** Moves one ACTIVE insight to a new status. Only the row's own
 *  owner, in the workspace it belongs to, may do it — the id alone
 *  is never trusted. Anything not active anymore is left alone with
 *  a plain message instead of a silent no-op. */
async function setInsightStatus(
  db: Db,
  ownerId: string,
  mode: AppModeT,
  id: string,
  status: "dismissed" | "expected" | "snoozed",
  expiresAt: Date | null,
): Promise<void> {
  const rows = await db
    .select()
    .from(schema.financialInsights)
    .where(eq(schema.financialInsights.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.ownerId !== ownerId || row.mode !== mode)
    throw new Error("Insight not found.");
  if (row.status !== "active")
    throw new Error("This insight is no longer active.");
  await db
    .update(schema.financialInsights)
    .set({ status, expiresAt, updatedAt: new Date() })
    .where(eq(schema.financialInsights.id, id));
}

/**
 * Runs the deterministic insight rules for one workspace and syncs
 * the findings into financial_insights:
 *   - new finding        → insert as active
 *   - still firing       → refresh figures, keep its status
 *     (a snoozed one whose 7 days are up wakes back to active)
 *   - dismissed          → never touched, never resurrected
 *   - condition cleared  → active/expected/snoozed → resolved
 * A 60-second guard keeps a burst of mutations from re-running the
 * rules over and over — the caller (dashboard load, mutation hook)
 * may call this freely. One batch load + a handful of upserts; no
 * LLM, no extra cost.
 */
async function runInsightGeneration(
  db: Db,
  ownerId: string,
  mode: AppModeT,
): Promise<{ skipped: boolean; generated: number; active: number }> {
  const now = new Date();
  const runs = await db
    .select()
    .from(schema.financialInsightRuns)
    .where(
      and(
        eq(schema.financialInsightRuns.ownerId, ownerId),
        eq(schema.financialInsightRuns.mode, mode),
      ),
    )
    .limit(1);
  if (runs[0] && Date.now() - runs[0].generatedAt.getTime() < 60_000) {
    const actives = await db
      .select({ id: schema.financialInsights.id })
      .from(schema.financialInsights)
      .where(
        and(
          eq(schema.financialInsights.ownerId, ownerId),
          eq(schema.financialInsights.mode, mode),
          eq(schema.financialInsights.status, "active"),
        ),
      );
    return { skipped: true, generated: 0, active: actives.length };
  }

  // One statement for every collection in the workspace, plus the
  // state row + workspace rows for the opening balance (same batch
  // loaders getState uses — 2 statements, pool-friendly).
  const { businesses: workspaceRows } = await loadWorkspacePrelude(db, ownerId);
  const business = workspaceRows.find((b) => asMode(b.mode) === mode);
  const {
    transactions: txns,
    invoices: invs,
    invoiceItems: items,
    recurring: rec,
    emiInstalments: emiInstRows,
    savingsTransfers: savingsTransferRows,
  } = await loadWorkspaceBatch(db, ownerId, mode);
  const itemsByInv = new Map<string, ItemRow[]>();
  for (const it of items) {
    const arr = itemsByInv.get(it.invoiceId) ?? [];
    arr.push(it);
    itemsByInv.set(it.invoiceId, arr);
  }
  const savedCents = savingsTransferRows.reduce(
    (s, tr) => s + (tr.direction === "deposit" ? tr.amountCents : -tr.amountCents),
    0,
  );
  const input: InsightInput = {
    openingBalanceCents: business?.openingBalanceCents ?? 0,
    savedCents,
    transactions: txns.map((t) => ({
      id: t.id,
      type: t.type as "income" | "expense",
      status: t.status as "posted" | "pending",
      category: t.category,
      description: t.description,
      counterparty: t.counterparty,
      amountCents: t.amountCents,
      date: t.date,
    })),
    invoices: invs.map((inv) => ({
      id: inv.id,
      number: inv.number,
      customerName: inv.customerName,
      status: inv.status,
      dueDate: inv.dueDate,
      totalCents: invoiceTotals(inv, itemsByInv.get(inv.id) ?? []).total,
    })),
    recurring: rec.map((r) => ({
      id: r.id,
      type: r.type as "income" | "expense",
      category: r.category,
      description: r.description,
      amountCents: r.amountCents,
      frequency: r.frequency as "weekly" | "monthly",
      nextDate: r.nextDate,
      active: r.active === 1,
    })),
    // EMI instalments of this workspace's plans only: the batch
    // already scopes instalments to the workspace's plans.
    emiInstalments: emiInstRows.map((inst) => ({
      id: inst.id,
      dueDate: inst.dueDate,
      amountCents: inst.amountCents,
      status: inst.status as "pending" | "paid",
    })),
  };
  const candidates: GeneratedInsight[] = detectInsights(input);
  const candidateKeys = new Set(candidates.map((c) => c.insightKey));

  const existing = await db
    .select()
    .from(schema.financialInsights)
    .where(
      and(
        eq(schema.financialInsights.ownerId, ownerId),
        eq(schema.financialInsights.mode, mode),
      ),
    );
  const byKey = new Map(existing.map((row) => [row.insightKey, row]));

  for (const c of candidates) {
    const row = byKey.get(c.insightKey);
    const values = {
      insightType: c.type,
      severity: c.severity,
      title: c.title,
      description: c.description,
      evidenceJson: c.evidence as Record<string, unknown>,
      recommendedAction: c.recommendedAction,
      confidence: c.confidence,
      generatedAt: now,
      updatedAt: now,
    };
    if (!row) {
      // Fresh finding — insert as active. (The partial unique index
      // on active keys is the backstop; the select above is the
      // normal guard, so a duplicate insert cannot happen here.)
      await db.insert(schema.financialInsights).values({
        id: uid(),
        ownerId,
        mode,
        insightKey: c.insightKey,
        status: "active",
        expiresAt: null,
        ...values,
      });
      continue;
    }
    if (row.status === "dismissed") continue; // the user said no — frozen
    if (row.status === "expected") {
      // Marked "this is expected": refresh the figures so the record
      // stays current, but NEVER show it as active again for this key.
      await db
        .update(schema.financialInsights)
        .set(values)
        .where(eq(schema.financialInsights.id, row.id));
      continue;
    }
    if (row.status === "snoozed" && row.expiresAt && row.expiresAt.getTime() > now.getTime()) {
      // Still snoozed: refresh the figures, stay hidden.
      await db
        .update(schema.financialInsights)
        .set(values)
        .where(eq(schema.financialInsights.id, row.id));
      continue;
    }
    // Active, resolved, or an expired snooze: refresh the figures
    // and (re)activate, clearing any old snooze deadline.
    await db
      .update(schema.financialInsights)
      .set({ ...values, status: "active", expiresAt: null })
      .where(eq(schema.financialInsights.id, row.id));
  }

  // Conditions that no longer hold resolve — except dismissed rows,
  // which stay dismissed forever for their key.
  for (const row of existing) {
    if (
      (row.status === "active" || row.status === "expected" || row.status === "snoozed") &&
      !candidateKeys.has(row.insightKey)
    ) {
      await db
        .update(schema.financialInsights)
        .set({ status: "resolved", expiresAt: null, updatedAt: now })
        .where(eq(schema.financialInsights.id, row.id));
    }
  }

  const actives = await db
    .select({ id: schema.financialInsights.id })
    .from(schema.financialInsights)
    .where(
      and(
        eq(schema.financialInsights.ownerId, ownerId),
        eq(schema.financialInsights.mode, mode),
        eq(schema.financialInsights.status, "active"),
      ),
    );
  await db
    .insert(schema.financialInsightRuns)
    .values({ ownerId, mode, generatedAt: now, insightCount: actives.length })
    .onConflictDoUpdate({
      target: [schema.financialInsightRuns.ownerId, schema.financialInsightRuns.mode],
      set: { generatedAt: now, insightCount: actives.length },
    });
  return { skipped: false, generated: candidates.length, active: actives.length };
}

// One insight row in API shape, shared by getInsights and
// generateInsights so both responses carry exactly the same objects.
const insightShape = z.object({
  id: z.string(),
  insightType: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  description: z.string(),
  evidenceJson: z.record(z.string(), z.unknown()),
  recommendedAction: z.string(),
  confidence: z.number(),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  status: z.string(),
  insightKey: z.string(),
  generatedAt: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});

// The active findings for a workspace, severity-first, plus the last
// run's timestamp — the read half of getInsights, shared with
// generateInsights so a Re-check can hand the panel its fresh card
// without waiting on a refetch.
async function listActiveInsights(db: Db, ownerId: string, mode: AppModeT) {
  const rows = await db
    .select()
    .from(schema.financialInsights)
    .where(
      and(
        eq(schema.financialInsights.ownerId, ownerId),
        eq(schema.financialInsights.mode, mode),
        eq(schema.financialInsights.status, "active"),
      ),
    );
  const rank: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  rows.sort(
    (a, b) =>
      (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) ||
      b.generatedAt.getTime() - a.generatedAt.getTime(),
  );
  const runRow = (
    await db
      .select()
      .from(schema.financialInsightRuns)
      .where(
        and(
          eq(schema.financialInsightRuns.ownerId, ownerId),
          eq(schema.financialInsightRuns.mode, mode),
        ),
      )
      .limit(1)
  )[0];
  return {
    insights: rows.map(insightOut),
    generatedAt: runRow?.generatedAt.toISOString() ?? null,
  };
}

export const Actions = {
  getState: defineAction({
    description:
      "Loads the full Cashflow Genius workspace: business profile, transactions, invoices, notes, scenarios, recurring cashflows, budgets, AI conversations and recent activity.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      business: businessShape,
      activeMode: z.enum(["business", "personal", "creator", "student"]),
      cursorStyle: z.enum(["blue", "gradient", "minimal", "mint", "off"]),
      workspaces: z.array(
        z.object({
          mode: z.enum(["business", "personal", "creator", "student"]),
          name: z.string(),
          onboarded: z.boolean(),
        }),
      ),
      transactions: z.array(txnShape),
      invoices: z.array(invoiceShape),
      emiPlans: z.array(emiPlanShape),
      savingsGoals: z.array(savingsGoalShape),
      scamChecks: z.array(scamCheckShape),
      notes: z.array(noteShape),
      scenarios: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          params: z.string(),
          demo: z.boolean(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
      recurring: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          category: z.string(),
          description: z.string(),
          amountCents: z.number(),
          frequency: z.string(),
          nextDate: z.string(),
          active: z.boolean(),
          demo: z.boolean(),
        }),
      ),
      budgets: z.array(
        z.object({
          id: z.string(),
          category: z.string(),
          monthlyLimitCents: z.number(),
        }),
      ),
      customCategories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
        }),
      ),
      conversations: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          createdAt: z.string(),
          messages: z.array(
            z.object({
              id: z.string(),
              role: z.string(),
              content: z.string(),
              createdAt: z.string(),
            }),
          ),
        }),
      ),
      activity: z.array(
        z.object({
          id: z.number(),
          action: z.string(),
          detail: z.string(),
          createdAt: z.string(),
        }),
      ),
      tourDismissed: z.boolean(),
      authUser: z.object({
        identifier: z.string(),
        channel: z.string(),
        verified: z.boolean(),
      }),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      // ONE statement for the state row + all workspace rows, then ONE
      // statement for every collection in the active workspace (see
      // server/lib/batch.ts) — 3 statements total including the auth
      // join above, down from ~25. The old code ran a 19-query
      // Promise.all that max:1 serialised into 15-30s live; raising
      // the pool instead exhausted the session pooler (bcd6255 ->
      // b8b0b9e). Fewer round-trips is the fix; the pool stays at 1.
      let { state, businesses: workspaceRows } = await loadWorkspacePrelude(
        db,
        user.id,
      );
      // Brand-new account (no state row yet): derive the mode exactly
      // as activeMode() did, and create the row so later reads find it.
      let wsMode = state
        ? asMode(state.activeMode)
        : asMode(workspaceRows[0]?.mode ?? "business");
      let business = workspaceRows.find((b) => asMode(b.mode) === wsMode);
      if (!business) {
        // First visit to this workspace: create it exactly as before,
        // then re-read the workspace list. Rare path only.
        business = await ensureWorkspace(db, user.id, wsMode);
        workspaceRows = (await loadWorkspacePrelude(db, user.id)).businesses;
      }
      const cursorStyle = state ? asCursorStyle(state.cursorStyle) : "blue";
      const tourDismissed = state?.tourDismissed === 1;
      if (!state) {
        await db
          .insert(schema.userWorkspaceState)
          .values({ ownerId: user.id, activeMode: wsMode })
          .onConflictDoNothing();
      }
      const {
        transactions: txns,
        invoices: invs,
        invoiceItems: items,
        notes: notesRows,
        scenarios: scen,
        recurring: rec,
        emiPlans: emiPlanRows,
        emiInstalments: emiInstRows,
        savingsGoals: savingsGoalRows,
        savingsTransfers: savingsTransferRows,
        scamChecks: scamRows,
        budgets: buds,
        customCategories: customCats,
        aiConversations: convs,
        aiMessages: msgs,
        activity: acts,
      } = await loadWorkspaceBatch(db, user.id, wsMode);
      const itemsByInv = new Map<string, ItemRow[]>();
      for (const it of items) {
        const arr = itemsByInv.get(it.invoiceId) ?? [];
        arr.push(it);
        itemsByInv.set(it.invoiceId, arr);
      }
      const instByPlan = new Map<string, EmiInstRow[]>();
      for (const inst of emiInstRows) {
        const arr = instByPlan.get(inst.planId) ?? [];
        arr.push(inst);
        instByPlan.set(inst.planId, arr);
      }
      const transfersByGoal = new Map<string, SavingsTransferRow[]>();
      for (const tr of savingsTransferRows) {
        const arr = transfersByGoal.get(tr.goalId) ?? [];
        arr.push(tr);
        transfersByGoal.set(tr.goalId, arr);
      }
      return {
        business: bizOut(business),
        activeMode: wsMode,
        cursorStyle,
        workspaces: workspaceRows.map((w) => ({
          mode: w.mode,
          name: w.name,
          onboarded: w.onboarded === 1,
        })),
        transactions: txns.map(txnOut),
        invoices: invs.map((inv) => {
          const its = (itemsByInv.get(inv.id) ?? []).sort(
            (a, b) => a.sort - b.sort,
          );
          const totals = invoiceTotals(inv, its);
          return {
            id: inv.id,
            number: inv.number,
            customerName: inv.customerName,
            customerEmail: inv.customerEmail,
            status: inv.status,
            effectiveStatus: effectiveStatus(inv),
            issueDate: inv.issueDate,
            dueDate: inv.dueDate,
            discountPct: inv.discountBp / 100,
            taxPct: inv.taxBp / 100,
            notes: inv.notes,
            items: its.map((it) => ({
              id: it.id,
              description: it.description,
              qty: it.qtyMilli / 1000,
              unitPriceCents: it.unitPriceCents,
            })),
            subtotalCents: totals.subtotal,
            discountCents: totals.discount,
            taxCents: totals.tax,
            totalCents: totals.total,
            demo: inv.demo === 1,
            createdAt: inv.createdAt.toISOString(),
            updatedAt: inv.updatedAt.toISOString(),
          };
        }),
        emiPlans: emiPlanRows.map((p) => emiPlanOut(p, instByPlan.get(p.id) ?? [])),
        savingsGoals: savingsGoalRows.map((g) => savingsGoalOut(g, transfersByGoal.get(g.id) ?? [])),
        scamChecks: scamRows.map((c) => {
          let reasons: z.infer<typeof scamReasonShape>[] = [];
          try {
            const parsed = JSON.parse(c.reasonsJson) as unknown;
            if (Array.isArray(parsed)) {
              reasons = parsed.filter(
                (r): r is z.infer<typeof scamReasonShape> =>
                  typeof r === "object" && r !== null &&
                  typeof (r as { title?: unknown }).title === "string" &&
                  typeof (r as { detail?: unknown }).detail === "string",
              );
            }
          } catch {
            reasons = [];
          }
          return {
            id: c.id,
            kind: c.kind,
            excerpt: c.excerpt,
            verdict: c.verdict,
            riskScore: c.riskScore,
            reasons,
            createdAt: c.createdAt.toISOString(),
          };
        }),
        notes: notesRows.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          category: n.category,
          tags: n.tags,
          pinned: n.pinned === 1,
          sourceModule: n.sourceModule,
          sourceId: n.sourceId,
          demo: n.demo === 1,
          createdAt: n.createdAt.toISOString(),
          updatedAt: n.updatedAt.toISOString(),
        })),
        scenarios: scen.map((s) => ({
          id: s.id,
          name: s.name,
          params: s.params,
          demo: s.demo === 1,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        recurring: rec.map((r) => ({
          id: r.id,
          type: r.type,
          category: r.category,
          description: r.description,
          amountCents: r.amountCents,
          frequency: r.frequency,
          nextDate: r.nextDate,
          active: r.active === 1,
          demo: r.demo === 1,
        })),
        budgets: buds.map((b) => ({
          id: b.id,
          category: b.category,
          monthlyLimitCents: b.monthlyLimitCents,
        })),
        customCategories: customCats.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        })),
        conversations: convs.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt.toISOString(),
          messages: msgs
            .filter((m) => m.conversationId === c.id)
            .map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt.toISOString(),
            })),
        })),
        activity: acts.map((a) => ({
          id: a.id,
          action: a.action,
          detail: a.detail,
          createdAt: a.createdAt.toISOString(),
        })),
        tourDismissed,
        authUser: {
          identifier: user.identifier,
          channel: user.channel,
          verified: user.verified === 1,
        },
      };
    },
  }),

  updateBusiness: defineAction({
    description:
      "Saves the active workspace's profile and preferences (name, industry, country, currency, opening balance, timezone, owner, GST settings). When a mode is given, that mode's workspace is the one saved and made active. When the currency changes, every amount in that workspace is first converted to the new currency at the live exchange rate — if the rate cannot be fetched, nothing is changed at all.",
    request: z.object({
      token: z.string().max(200).optional(),
      mode: z.enum(["business", "personal", "creator", "student"]).optional(),
      name: z.string().max(120),
      industry: z.string().max(80),
      country: z.string().max(60),
      currency: z.string().max(8),
      openingBalanceCents: z.number().int(),
      timezone: z.string().max(60),
      ownerName: z.string().max(120),
      ownerEmail: z.string().max(160),
      ownerPhone: z.string().max(32).optional(),
      gstRateBp: z.number().int().min(0).max(10000),
      gstInclusive: z.boolean(),
      eligibleExpensePct: z.number().int().min(0).max(100),
      onboarded: z.boolean(),
    }),
    response: updateBusinessResponseShape,
    async handler(ctx, args): Promise<z.infer<typeof updateBusinessResponseShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const target = args.mode ?? (await activeMode(db, user.id));
      const business = await ensureBusiness(db, user.id, target);
      const fromCurrency = business.currency;
      const converting = args.currency !== fromCurrency;
      // The live rate is fetched FIRST: if it fails, this throws before
      // any write, so the currency label can never change without the
      // amounts converting with it. No fallback rate is ever used.
      const rateInfo = converting ? await fetchRate(fromCurrency, args.currency) : null;
      const rate = rateInfo?.rate ?? 1;
      // args.openingBalanceCents arrives in the OLD currency (both
      // callers send the stored / form value shown in old units), so it
      // is converted here like every other amount.
      const newOpeningBalanceCents = converting
        ? convertMinor(args.openingBalanceCents, rate)
        : args.openingBalanceCents;
      // Decided inside the transaction, after the row lock below: a
      // concurrent request may already have converted this workspace.
      let effectiveConverting = converting;
      let effectiveFrom = fromCurrency;
      const convertedCounts = await db.transaction(async (tx) => {
        // Lock this workspace's row FIRST. A concurrent conversion for
        // the same workspace waits here; when it proceeds it re-reads
        // the currency AFTER the first conversion committed, so it can
        // never convert the same amounts twice (the 2026-11-19 incident:
        // two overlapping requests both read INR and both converted
        // INR → EUR, shrinking every amount ~100x).
        const [locked] = await tx
          .select()
          .from(schema.businesses)
          .where(eq(schema.businesses.id, business.id))
          .for("update");
        const lockedCurrency = locked.currency;
        if (lockedCurrency === args.currency) {
          // Already in the target currency — another request converted
          // first (or this is a plain same-currency save). Skip the
          // conversion entirely; the log and the response below report
          // a plain profile save, not a conversion.
          effectiveConverting = false;
          effectiveFrom = lockedCurrency;
        } else if (lockedCurrency !== fromCurrency) {
          // The currency moved under this request after the rate was
          // fetched, so the fetched rate is for the wrong pair. Abort
          // without writing anything rather than converting at a stale
          // rate or relabelling amounts without converting them.
          throw new Error(
            `The workspace currency changed while this request was running (it is now ${lockedCurrency}). Nothing was changed — please try again.`,
          );
        }
        // Opening balance: a conversion stores the converted value;
        // a plain save stores the form value; a skipped conversion
        // (another request already converted) must keep the stored
        // value, because args.openingBalanceCents is still in the OLD
        // currency and writing it would overwrite the converted one.
        const openingToStore = effectiveConverting
          ? newOpeningBalanceCents
          : fromCurrency === args.currency
            ? args.openingBalanceCents
            : locked.openingBalanceCents;
        await tx
          .update(schema.businesses)
          .set({
            name: args.name,
            industry: args.industry,
            country: args.country,
            currency: args.currency,
            openingBalanceCents: openingToStore,
            timezone: args.timezone,
            ownerName: args.ownerName,
            ownerEmail: args.ownerEmail,
            ownerPhone: args.ownerPhone ?? locked.ownerPhone,
            gstRateBp: args.gstRateBp,
            gstInclusive: args.gstInclusive ? 1 : 0,
            eligibleExpensePct: args.eligibleExpensePct,
            onboarded: args.onboarded ? 1 : 0,
            updatedAt: new Date(),
          })
          .where(eq(schema.businesses.id, business.id));
        const counts = {
          transactions: 0,
          invoiceItems: 0,
          recurring: 0,
          budgets: 0,
          emiPlans: 0,
          emiInstalments: 0,
          savingsGoals: 0,
          savingsTransfers: 0,
        };
        if (effectiveConverting) {
          // One SQL fragment per column: ROUND(col * rate) as bigint.
          // The rate is bound as its shortest decimal string and cast
          // to numeric, so the multiply is exact decimal arithmetic.
          // Postgres ROUND rounds halves away from zero while JS
          // Math.round rounds halves toward +∞, so a value landing
          // exactly on .5 can differ by 1 minor unit between the two
          // — the harness tolerates ±1.
          const conv = (col: SQLWrapper) =>
            sql`round(${col} * ${String(rate)}::numeric)::bigint`;
          const owned = (ownerId: SQLWrapper, mode: SQLWrapper) =>
            and(eq(ownerId, user.id), eq(mode, target));
          counts.transactions = (
            await tx
              .update(schema.transactions)
              .set({ amountCents: conv(schema.transactions.amountCents) })
              .where(owned(schema.transactions.ownerId, schema.transactions.mode))
              .returning({ id: schema.transactions.id })
          ).length;
          const invoiceIds = tx
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(owned(schema.invoices.ownerId, schema.invoices.mode));
          counts.invoiceItems = (
            await tx
              .update(schema.invoiceItems)
              .set({ unitPriceCents: conv(schema.invoiceItems.unitPriceCents) })
              .where(inArray(schema.invoiceItems.invoiceId, invoiceIds))
              .returning({ id: schema.invoiceItems.id })
          ).length;
          counts.recurring = (
            await tx
              .update(schema.recurringCashflows)
              .set({ amountCents: conv(schema.recurringCashflows.amountCents) })
              .where(owned(schema.recurringCashflows.ownerId, schema.recurringCashflows.mode))
              .returning({ id: schema.recurringCashflows.id })
          ).length;
          counts.budgets = (
            await tx
              .update(schema.budgets)
              .set({ monthlyLimitCents: conv(schema.budgets.monthlyLimitCents) })
              .where(owned(schema.budgets.ownerId, schema.budgets.mode))
              .returning({ id: schema.budgets.id })
          ).length;
          counts.emiPlans = (
            await tx
              .update(schema.emiPlans)
              .set({
                totalCents: conv(schema.emiPlans.totalCents),
                downPaymentCents: conv(schema.emiPlans.downPaymentCents),
              })
              .where(owned(schema.emiPlans.ownerId, schema.emiPlans.mode))
              .returning({ id: schema.emiPlans.id })
          ).length;
          const planIds = tx
            .select({ id: schema.emiPlans.id })
            .from(schema.emiPlans)
            .where(owned(schema.emiPlans.ownerId, schema.emiPlans.mode));
          counts.emiInstalments = (
            await tx
              .update(schema.emiInstalments)
              .set({ amountCents: conv(schema.emiInstalments.amountCents) })
              .where(inArray(schema.emiInstalments.planId, planIds))
              .returning({ id: schema.emiInstalments.id })
          ).length;
          counts.savingsGoals = (
            await tx
              .update(schema.savingsGoals)
              .set({ targetCents: conv(schema.savingsGoals.targetCents) })
              .where(owned(schema.savingsGoals.ownerId, schema.savingsGoals.mode))
              .returning({ id: schema.savingsGoals.id })
          ).length;
          counts.savingsTransfers = (
            await tx
              .update(schema.savingsTransfers)
              .set({ amountCents: conv(schema.savingsTransfers.amountCents) })
              .where(owned(schema.savingsTransfers.ownerId, schema.savingsTransfers.mode))
              .returning({ id: schema.savingsTransfers.id })
          ).length;
          // Genius Insights are priced in the old currency — drop the
          // last-run marker so getInsights regenerates them in the new
          // currency on the next load. The insight rows themselves stay.
          await tx
            .delete(schema.financialInsightRuns)
            .where(
              and(
                eq(schema.financialInsightRuns.ownerId, user.id),
                eq(schema.financialInsightRuns.mode, target),
              ),
            );
        }
        // tx is the transaction client; log() only needs insert/select,
        // so the cast is safe — and keeping the log inside the
        // transaction means a logging failure rolls the conversion back
        // instead of leaving a half-reported change.
        await log(
          tx as unknown as Db,
          effectiveConverting ? "Currency converted" : "Business profile updated",
          effectiveConverting
            ? `${effectiveFrom} → ${args.currency} at ${rate}`
            : args.name || "Workspace",
          user.id,
          target,
        );
        return counts;
      });
      if (args.mode) await setActiveMode(db, user.id, target);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return effectiveConverting && rateInfo
        ? {
            ok: true as const,
            conversion: {
              from: effectiveFrom,
              to: args.currency,
              rate: rateInfo.rate,
              asOf: rateInfo.asOf,
              convertedCounts,
            },
          }
        : { ok: true as const };
    },
  }),

  setMode: defineAction({
    description:
      "Switches the account's active money-mode workspace (Business Money, Personal Money, Creator & Freelancer, or Student / First Salary). Each mode is a completely separate workspace with its own records and settings; switching only changes which workspace is open — no record is ever moved, merged or deleted.",
    request: z.object({
      token: z.string().max(200).optional(),
      mode: z.enum(["business", "personal", "creator", "student"]),
    }),
    response: z.object({ ok: z.literal(true), mode: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; mode: string }> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const current = await activeMode(db, user.id);
      // Make sure the target workspace exists (a first visit creates it,
      // inheriting the account's profile basics; its records start empty).
      await ensureWorkspace(db, user.id, args.mode);
      if (current !== args.mode) {
        await setActiveMode(db, user.id, args.mode);
        await log(db, "Mode switched", `${MODE_LABELS[args.mode]} workspace`, user.id, args.mode);
      }
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, mode: args.mode };
    },
  }),

  setCursorStyle: defineAction({
    description:
      "Saves the signed-in account's mouse cursor style (Blue Particle, Gradient, Minimal, Mint, or Off / Default system cursor). The choice is per account — it applies across every page and every money-mode workspace, and is remembered across logout, login and reloads. Defaults to Blue Particle for accounts that never chose one.",
    request: z.object({
      token: z.string().max(200).optional(),
      style: z.enum(["blue", "gradient", "minimal", "mint", "off"]),
    }),
    response: z.object({
      ok: z.literal(true),
      style: z.enum(["blue", "gradient", "minimal", "mint", "off"]),
    }),
    async handler(ctx, args): Promise<{
      ok: true;
      style: "blue" | "gradient" | "minimal" | "mint" | "off";
    }> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      await setCursorStyleRow(db, user.id, args.style);
      await log(
        db,
        "Cursor style changed",
        CURSOR_STYLE_LABELS[args.style],
        user.id,
      );
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, style: args.style };
    },
  }),

  dismissTour: defineAction({
    description:
      "Records that the signed-in account has finished the onboarding app tour, or closed it with “Don't show this tour again” ticked: the tour will never auto-open for this account again (it stays re-openable from Settings → App tour & help). Per account, not per workspace.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      await setTourDismissedRow(db, user.id);
      await log(db, "App tour dismissed", "Tour will not auto-open again; re-openable from Settings", user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  getCombinedSummary: defineAction({
    description:
      "Returns per-workspace totals for every money mode (Personal, Business, Creator, Student) plus a combined overview, without changing the active workspace. Each workspace is read separately — records are never merged; the combined figures are only the sum of the separate totals for display.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      activeMode: z.enum(["business", "personal", "creator", "student"]),
      currency: z.string(),
      workspaces: z.array(
        z.object({
          mode: z.enum(["business", "personal", "creator", "student"]),
          label: z.string(),
          name: z.string(),
          exists: z.boolean(),
          onboarded: z.boolean(),
          incomeCents: z.number(),
          expenseCents: z.number(),
          netCents: z.number(),
          cashCents: z.number(),
          curIncomeCents: z.number(),
          curExpenseCents: z.number(),
          curNetCents: z.number(),
          txnCount: z.number(),
          budgetCount: z.number(),
          recurringCount: z.number(),
          savedCents: z.number(),
          savingsGoalCount: z.number(),
          upcomingPayCents: z.number(),
          upcomingCollectCents: z.number(),
          upcomingCount: z.number(),
          overdueCount: z.number(),
          overdueCents: z.number(),
        }),
      ),
      combined: z.object({
        incomeCents: z.number(),
        expenseCents: z.number(),
        netCents: z.number(),
        cashCents: z.number(),
        savedCents: z.number(),
        curIncomeCents: z.number(),
        curExpenseCents: z.number(),
        curNetCents: z.number(),
        txnCount: z.number(),
        upcomingPayCents: z.number(),
        upcomingCollectCents: z.number(),
        upcomingCount: z.number(),
        overdueCount: z.number(),
        overdueCents: z.number(),
      }),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      // ONE statement for the state row + every collection across all
      // modes (see server/lib/batch.ts) — 2 statements total including
      // the auth join, down from ~12.
      const combined = await loadCombinedBatch(db, user.id);
      const current = combined.state
        ? asMode(combined.state.activeMode)
        : asMode(combined.businesses[0]?.mode ?? "business");
      const {
        businesses: bizRows,
        transactions: allTxns,
        invoices: allInvs,
        invoiceItems: allItems,
        recurring: allRec,
        budgets: allBuds,
        emiPlans: allPlans,
        emiInstalments: allInst,
        savingsGoals: allSavingsGoals,
        savingsTransfers: allSavingsTransfers,
      } = combined;
      const today = todayStr();
      const in30 = (() => {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 30);
        return d.toISOString().slice(0, 10);
      })();
      const itemsByInv = new Map<string, ItemRow[]>();
      for (const it of allItems) {
        const arr = itemsByInv.get(it.invoiceId) ?? [];
        arr.push(it);
        itemsByInv.set(it.invoiceId, arr);
      }
      const instByPlan = new Map<string, EmiInstRow[]>();
      for (const inst of allInst) {
        const arr = instByPlan.get(inst.planId) ?? [];
        arr.push(inst);
        instByPlan.set(inst.planId, arr);
      }
      const activeBiz = bizRows.find((b) => asMode(b.mode) === current) ?? bizRows[0];
      const workspaces = APP_MODES.map((mode) => {
        const biz = bizRows.find((b) => asMode(b.mode) === mode);
        const txns = allTxns.filter((t) => asMode(t.mode) === mode);
        const modeTransfers = allSavingsTransfers.filter((t) => asMode(t.mode) === mode);
        const netSaved = modeTransfers.reduce(
          (s, t) => s + (t.direction === "deposit" ? t.amountCents : -t.amountCents),
          0,
        );
        const s = biz
          ? summarise(biz, txns, netSaved)
          : {
              revenueCents: 0,
              expensesCents: 0,
              profitCents: 0,
              cashCents: 0,
              savingsCents: 0,
              curRevenueCents: 0,
              curExpensesCents: 0,
            };
        let upcomingPay = 0;
        let upcomingCollect = 0;
        let upcomingCount = 0;
        let overdueCount = 0;
        let overdueCents = 0;
        const addDue = (date: string, cents: number, dir: "pay" | "collect") => {
          if (date < today) {
            overdueCount++;
            overdueCents += cents;
          } else if (date <= in30) {
            upcomingCount++;
            if (dir === "pay") upcomingPay += cents;
            else upcomingCollect += cents;
          }
        };
        for (const r of allRec.filter((x) => asMode(x.mode) === mode && x.active === 1)) {
          // Next occurrence only for overdue; expand forward occurrences
          // inside the 30-day window for the upcoming totals.
          if (r.nextDate < today) {
            addDue(r.nextDate, r.amountCents, r.type === "income" ? "collect" : "pay");
          } else {
            let d = r.nextDate;
            let guard = 0;
            while (d <= in30 && guard < 10) {
              addDue(d, r.amountCents, r.type === "income" ? "collect" : "pay");
              if (r.frequency === "weekly") {
                const nd = new Date(`${d}T00:00:00Z`);
                nd.setUTCDate(nd.getUTCDate() + 7);
                d = nd.toISOString().slice(0, 10);
              } else {
                d = stepEmiDate(d, "monthly");
              }
              guard++;
            }
          }
        }
        for (const inv of allInvs.filter((x) => asMode(x.mode) === mode && x.status === "sent")) {
          const total = invoiceTotals(inv, itemsByInv.get(inv.id) ?? []).total;
          addDue(inv.dueDate, total, "collect");
        }
        for (const plan of allPlans.filter((x) => asMode(x.mode) === mode)) {
          for (const inst of instByPlan.get(plan.id) ?? []) {
            if (inst.status === "paid") continue;
            addDue(inst.dueDate, inst.amountCents, "collect");
          }
        }
        for (const t of txns.filter((x) => x.status === "pending")) {
          addDue(t.date, t.amountCents, t.type === "income" ? "collect" : "pay");
        }
        return {
          mode,
          label: MODE_LABELS[mode],
          name: biz?.name ?? MODE_DEFAULT_NAMES[mode],
          exists: !!biz,
          onboarded: biz ? biz.onboarded === 1 : false,
          incomeCents: s.revenueCents,
          expenseCents: s.expensesCents,
          netCents: s.profitCents,
          cashCents: s.cashCents,
          curIncomeCents: s.curRevenueCents,
          curExpenseCents: s.curExpensesCents,
          curNetCents: s.curRevenueCents - s.curExpensesCents,
          txnCount: txns.length,
          budgetCount: allBuds.filter((b) => asMode(b.mode) === mode).length,
          recurringCount: allRec.filter((r) => asMode(r.mode) === mode && r.active === 1).length,
          savedCents: netSaved,
          savingsGoalCount: allSavingsGoals.filter((g) => asMode(g.mode) === mode).length,
          upcomingPayCents: upcomingPay,
          upcomingCollectCents: upcomingCollect,
          upcomingCount,
          overdueCount,
          overdueCents,
        };
      });
      const sum = (k: keyof (typeof workspaces)[number]) =>
        workspaces.reduce((a, w) => a + (typeof w[k] === "number" ? (w[k] as number) : 0), 0);
      return {
        activeMode: current,
        currency: activeBiz?.currency ?? "INR",
        workspaces,
        combined: {
          incomeCents: sum("incomeCents"),
          expenseCents: sum("expenseCents"),
          netCents: sum("netCents"),
          cashCents: sum("cashCents"),
          savedCents: sum("savedCents"),
          curIncomeCents: sum("curIncomeCents"),
          curExpenseCents: sum("curExpenseCents"),
          curNetCents: sum("curNetCents"),
          txnCount: sum("txnCount"),
          upcomingPayCents: sum("upcomingPayCents"),
          upcomingCollectCents: sum("upcomingCollectCents"),
          upcomingCount: sum("upcomingCount"),
          overdueCount: sum("overdueCount"),
          overdueCents: sum("overdueCents"),
        },
      };
    },
  }),

  saveSavingsGoal: defineAction({
    description:
      "Creates or edits a Savings Goal / Pot in one workspace (Personal, Business, Creator or Student). The goal stores only its name, target amount and target date; money in the pot is tracked separately as transfers, so editing a goal never moves or double-counts money.",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      name: z.string().min(1).max(120),
      targetCents: z.number().int().positive().max(100_000_000_00),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      mode: z.enum(["business", "personal", "creator", "student"]).optional(),
    }),
    response: z.object({ id: z.string(), mode: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const active = await activeMode(db, user.id);
      const name = args.name.trim();
      if (!name) throw new Error("Give your savings goal a name.");
      if (args.id) {
        // Editing stays inside the goal's own workspace — a goal can
        // never be moved between workspaces by editing it.
        const rows = await db
          .select()
          .from(schema.savingsGoals)
          .where(and(eq(schema.savingsGoals.id, args.id), eq(schema.savingsGoals.ownerId, user.id)))
          .limit(1);
        const goal = rows[0];
        if (!goal) throw new Error("Savings goal not found.");
        const goalMode = asMode(goal.mode);
        // If the goal's workspace is not the active one, it cannot be
        // edited from here — the user opens that workspace first. This
        // keeps every write scoped to one workspace.
        if (goalMode !== active)
          throw new Error(`This goal belongs to the ${MODE_LABELS[goalMode]} workspace. Open that workspace to edit it — goals never move between workspaces.`);
        const transfers = await db
          .select()
          .from(schema.savingsTransfers)
          .where(eq(schema.savingsTransfers.goalId, goal.id));
        const saved = savedForGoal(transfers);
        if (args.targetCents < saved)
          throw new Error(`The target can't be less than the ${saved > 0 ? "amount already saved in this pot" : "target"} — withdraw money first or choose a target at or above what's saved.`);
        await db
          .update(schema.savingsGoals)
          .set({ name, targetCents: args.targetCents, targetDate: args.targetDate, updatedAt: new Date() })
          .where(eq(schema.savingsGoals.id, goal.id));
        await log(db, "Savings goal updated", name, user.id);
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: goal.id, mode: goalMode };
      }
      const targetMode = args.mode ?? active;
      // Creating for another workspace is allowed: the goal is stamped
      // with that workspace and will only appear there. Its workspace
      // row is ensured (profile inherited, records still separate).
      await ensureWorkspace(db, user.id, targetMode);
      const id = uid();
      await db.insert(schema.savingsGoals).values({
        id,
        ownerId: user.id,
        mode: targetMode,
        name,
        targetCents: args.targetCents,
        targetDate: args.targetDate,
      });
      // Log in the goal's own workspace history when it is the active
      // one; log() stamps the active workspace, so only log directly
      // for the active workspace to avoid cross-workspace history.
      if (targetMode === active) await log(db, "Savings goal created", `${name} — ${MODE_LABELS[targetMode]}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id, mode: targetMode };
    },
  }),

  deleteSavingsGoal: defineAction({
    description:
      "Deletes a Savings Goal in the active workspace and returns any money held in it to that workspace's available cash by removing its transfers with it. Only that goal and its own transfers are removed — no other goal, transaction or workspace is touched.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: z.object({ ok: z.boolean(), returnedCents: z.number(), error: z.string().nullable(), trashId: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.savingsGoals)
        .where(and(eq(schema.savingsGoals.id, args.id), eq(schema.savingsGoals.ownerId, user.id), eq(schema.savingsGoals.mode, wsMode)))
        .limit(1);
      const goal = rows[0];
      if (!goal) return { ok: false, returnedCents: 0, error: "Savings goal not found in this workspace.", trashId: null };
      const transfers = await db
        .select()
        .from(schema.savingsTransfers)
        .where(eq(schema.savingsTransfers.goalId, goal.id));
      const returned = savedForGoal(transfers);
      const trashId = await pushTrash(db, user.id, wsMode, "savings_goal", goal.name, { goal, transfers });
      const statements = [
        db.delete(schema.savingsTransfers).where(eq(schema.savingsTransfers.goalId, goal.id)),
        db.delete(schema.savingsGoals).where(eq(schema.savingsGoals.id, goal.id)),
      ];
      const [first, ...rest] = statements;
      if (first) await Promise.all([first, ...rest]);
      await log(db, "Savings goal deleted", goal.name, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, returnedCents: returned, error: null, trashId };
    },
  }),

  addToSavingsGoal: defineAction({
    description:
      "Adds money to a Savings Goal as a real transfer: the amount leaves the active workspace's available cash and enters the pot, recorded once as a deposit transfer. It is never recorded as income or an expense, so revenue, spending and profit do not change — only available cash and the pot's saved total move, by the same amount, in this workspace only.",
    request: z.object({
      token: z.string().max(200).optional(),
      goalId: z.string(),
      amountCents: z.number().int().positive().max(100_000_000_00),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(200).optional(),
    }),
    response: z.object({ ok: z.boolean(), transferId: z.string().nullable(), savedCents: z.number(), error: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.savingsGoals)
        .where(and(eq(schema.savingsGoals.id, args.goalId), eq(schema.savingsGoals.ownerId, user.id), eq(schema.savingsGoals.mode, wsMode)))
        .limit(1);
      const goal = rows[0];
      if (!goal) return { ok: false, transferId: null, savedCents: 0, error: "Savings goal not found in this workspace." };
      const id = uid();
      await db.insert(schema.savingsTransfers).values({
        id,
        goalId: goal.id,
        ownerId: user.id,
        mode: wsMode,
        direction: "deposit",
        amountCents: args.amountCents,
        date: args.date ?? todayStr(),
        note: (args.note ?? "").trim(),
      });
      const transfers = await db.select().from(schema.savingsTransfers).where(eq(schema.savingsTransfers.goalId, goal.id));
      await log(db, "Added to savings", `${goal.name}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, transferId: id, savedCents: savedForGoal(transfers), error: null };
    },
  }),

  withdrawFromSavingsGoal: defineAction({
    description:
      "Withdraws money from a Savings Goal as a real transfer back: the amount leaves the pot and returns to the active workspace's available cash, recorded once as a withdrawal transfer. It is never recorded as income, so it cannot double-count money that was already counted when it was first earned. Withdrawals cannot exceed what is saved in that pot.",
    request: z.object({
      token: z.string().max(200).optional(),
      goalId: z.string(),
      amountCents: z.number().int().positive().max(100_000_000_00),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(200).optional(),
    }),
    response: z.object({ ok: z.boolean(), transferId: z.string().nullable(), savedCents: z.number(), error: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.savingsGoals)
        .where(and(eq(schema.savingsGoals.id, args.goalId), eq(schema.savingsGoals.ownerId, user.id), eq(schema.savingsGoals.mode, wsMode)))
        .limit(1);
      const goal = rows[0];
      if (!goal) return { ok: false, transferId: null, savedCents: 0, error: "Savings goal not found in this workspace." };
      const before = await db.select().from(schema.savingsTransfers).where(eq(schema.savingsTransfers.goalId, goal.id));
      const saved = savedForGoal(before);
      if (args.amountCents > saved)
        return { ok: false, transferId: null, savedCents: saved, error: `You can withdraw at most what's saved in this pot — it currently holds less than that amount.` };
      const id = uid();
      await db.insert(schema.savingsTransfers).values({
        id,
        goalId: goal.id,
        ownerId: user.id,
        mode: wsMode,
        direction: "withdraw",
        amountCents: args.amountCents,
        date: args.date ?? todayStr(),
        note: (args.note ?? "").trim(),
      });
      const after = await db.select().from(schema.savingsTransfers).where(eq(schema.savingsTransfers.goalId, goal.id));
      await log(db, "Withdrew from savings", `${goal.name}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, transferId: id, savedCents: savedForGoal(after), error: null };
    },
  }),

  saveTransaction: defineAction({
    description:
      "Creates or updates a transaction (income or expense, posted or pending).",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      type: z.enum(["income", "expense"]),
      status: z.enum(["posted", "pending"]),
      category: z.string().min(1).max(60),
      description: z.string().max(200),
      counterparty: z.string().max(120),
      amountCents: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      paymentMethod: z.string().max(20).optional(),
    }),
    response: z.object({ id: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      // A custom category typed by the user is stored trimmed, exactly as
      // typed (first casing wins in the remembered list).
      const category = args.category.trim() || "General";
      const paymentMethod = ["UPI", "Cash", "Card", "Bank transfer", "Other"].includes(args.paymentMethod ?? "")
        ? (args.paymentMethod as string)
        : "";
      if (args.id) {
        const existing = await db
          .select()
          .from(schema.transactions)
          .where(and(eq(schema.transactions.id, args.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))))
          .limit(1);
        if (!existing[0]) throw new Error("Transaction not found.");
        if (existing[0].invoiceId)
          throw new Error(
            "This transaction is linked to an invoice payment and cannot be edited directly.",
          );
        await db
          .update(schema.transactions)
          .set({
            type: args.type,
            status: args.status,
            category,
            description: args.description,
            counterparty: args.counterparty,
            amountCents: args.amountCents,
            date: args.date,
            paymentMethod,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.transactions.id, args.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))));
        await rememberCustomCategory(db, user.id, wsMode, args.type, category);
        await log(db, "Transaction updated", args.description, user.id);
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: args.id };
      }
      const id = uid();
      await db.insert(schema.transactions).values({
        id,
        ownerId: user.id,
        mode: wsMode,
        type: args.type,
        status: args.status,
        category,
        description: args.description,
        counterparty: args.counterparty,
        amountCents: args.amountCents,
        date: args.date,
        paymentMethod,
      });
      await rememberCustomCategory(db, user.id, wsMode, args.type, category);
      await log(
        db,
        args.type === "income" ? "Income recorded" : "Expense recorded",
        args.description, user.id
      );
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id };
    },
  }),

  deleteTransaction: defineAction({
    description: "Deletes a transaction by id, after snapshotting it so the delete can be undone with restoreDeletedItem.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.id, args.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))))
        .limit(1);
      if (!rows[0]) throw new Error("Transaction not found.");
      if (rows[0].invoiceId)
        throw new Error(
          "This transaction is an invoice payment. Un-pay the invoice instead of deleting it.",
        );
      const trashId = await pushTrash(db, user.id, wsMode, "transaction", rows[0].description || rows[0].category, { row: rows[0] });
      await db
        .delete(schema.transactions)
        .where(and(eq(schema.transactions.id, args.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))));
      await log(db, "Transaction deleted", rows[0].description, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  importTransactions: defineAction({
    description:
      "Bulk-imports validated CSV transaction rows, skipping exact duplicates and reporting invalid rows.",
    request: z.object({
      token: z.string().max(200).optional(),
      rows: z
        .array(
          z.object({
            type: z.string(),
            status: z.string(),
            category: z.string(),
            description: z.string(),
            counterparty: z.string(),
            amountCents: z.number(),
            date: z.string(),
            paymentMethod: z.string().max(20).optional(),
          }),
        )
        .max(2000),
    }),
    response: z.object({
      imported: z.number(),
      duplicates: z.number(),
      errors: z.array(z.string()),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const existing = await db.select().from(schema.transactions).where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode)));
      const seen = new Set(
        existing.map(
          (t) => `${t.date}|${t.amountCents}|${t.description.toLowerCase()}|${t.type}`,
        ),
      );
      let imported = 0;
      let duplicates = 0;
      const errors: string[] = [];
      const toInsert: (typeof schema.transactions.$inferInsert)[] = [];
      args.rows.forEach((r, i) => {
        const line = `Row ${i + 2}`;
        if (r.type !== "income" && r.type !== "expense") {
          errors.push(`${line}: type must be income or expense.`);
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) {
          errors.push(`${line}: invalid date "${r.date}".`);
          return;
        }
        if (!Number.isInteger(r.amountCents) || r.amountCents <= 0) {
          errors.push(`${line}: amount must be a positive number.`);
          return;
        }
        const key = `${r.date}|${r.amountCents}|${r.description.toLowerCase()}|${r.type}`;
        if (seen.has(key)) {
          duplicates++;
          return;
        }
        seen.add(key);
        toInsert.push({
          id: uid(),
          ownerId: user.id,
          mode: wsMode,
          type: r.type,
          status: r.status === "pending" ? "pending" : "posted",
          category: r.category || "General",
          description: r.description,
          counterparty: r.counterparty,
          amountCents: r.amountCents,
          date: r.date,
          paymentMethod: ["UPI", "Cash", "Card", "Bank transfer", "Other"].includes(r.paymentMethod ?? "")
            ? (r.paymentMethod as string)
            : "",
        });
        imported++;
      });
      if (toInsert.length > 0) {
        await db.insert(schema.transactions).values(toInsert);
        // Record the batch so the user can undo exactly this import —
        // bulk edits should never be a one-way door.
        await db.insert(schema.importBatches).values({
          id: uid(),
          ownerId: user.id,
          mode: wsMode,
          txnIdsJson: JSON.stringify(toInsert.map((t) => t.id)),
        });
        // Remember any non-built-in categories the import brought in, so
        // they appear in this workspace's dropdowns like typed customs.
        const seenCats = new Set<string>();
        for (const row of toInsert) {
          const catName = row.category ?? "General";
          const catType = row.type === "income" ? "income" : "expense";
          const key = `${catType}|${catName.toLowerCase()}`;
          if (seenCats.has(key)) continue;
          seenCats.add(key);
          await rememberCustomCategory(db, user.id, wsMode, catType, catName);
        }
      }
      await log(db, "CSV import", `${imported} imported, ${duplicates} duplicates skipped`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { imported, duplicates, errors: errors.slice(0, 50) };
    },
  }),

  undoLastImport: defineAction({
    description:
      "Undoes the most recent CSV import in the active workspace: deletes exactly the transactions that import created (invoice-linked rows are never touched) and reports how many were removed.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({ removed: z.number(), found: z.boolean(), trashId: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const batches = await db
        .select()
        .from(schema.importBatches)
        .where(and(eq(schema.importBatches.ownerId, user.id), eq(schema.importBatches.mode, wsMode)))
        .orderBy(desc(schema.importBatches.createdAt))
        .limit(1);
      const batch = batches[0];
      if (!batch) return { removed: 0, found: false, trashId: null };
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(batch.txnIdsJson) as unknown;
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        ids = [];
      }
      let removed = 0;
      const removedRows: (typeof schema.transactions.$inferSelect)[] = [];
      for (const id of ids) {
        const rows = await db
          .select()
          .from(schema.transactions)
          .where(and(eq(schema.transactions.id, id), eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode)))
          .limit(1);
        if (!rows[0] || rows[0].invoiceId || rows[0].emiInstalmentId) continue;
        removedRows.push(rows[0]);
        await db.delete(schema.transactions).where(eq(schema.transactions.id, id));
        removed++;
      }
      const trashId = removedRows.length > 0
        ? await pushTrash(db, user.id, wsMode, "transactions_bulk", `CSV import (${removedRows.length} transaction(s))`, { rows: removedRows, batchRow: batch })
        : null;
      await db.delete(schema.importBatches).where(eq(schema.importBatches.id, batch.id));
      await log(db, "CSV import undone", `${removed} imported transaction(s) removed`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { removed, found: true, trashId };
    },
  }),

  renameCustomCategory: defineAction({
    description:
      "Renames a user-created custom category in the active workspace: the remembered entry and every transaction, recurring schedule and budget using the old name in this workspace are updated. Built-in categories and other workspaces are untouched.",
    request: z.object({
      token: z.string().max(200).optional(),
      type: z.enum(["income", "expense"]),
      oldName: z.string().min(1).max(60),
      newName: z.string().min(1).max(60),
    }),
    response: z.object({ updated: z.number() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const oldName = args.oldName.trim();
      const newName = args.newName.trim();
      if (!newName) throw new Error("Type the new category name.");
      if (oldName.toLowerCase() === newName.toLowerCase()) return { updated: 0 };
      if (BUILTIN_CATEGORY_NAMES.has(oldName.toLowerCase()))
        throw new Error("Built-in categories can't be renamed — but you can create your own with Custom.");
      const clash = await db
        .select()
        .from(schema.customCategories)
        .where(and(eq(schema.customCategories.ownerId, user.id), eq(schema.customCategories.mode, wsMode), eq(schema.customCategories.type, args.type)));
      if (clash.some((c) => c.name.toLowerCase() === newName.toLowerCase()))
        throw new Error(`You already have a custom category called “${newName}” in this workspace.`);
      let updated = 0;
      const catRows = clash.filter((c) => c.name.toLowerCase() === oldName.toLowerCase());
      for (const c of catRows) {
        await db.update(schema.customCategories).set({ name: newName }).where(eq(schema.customCategories.id, c.id));
        updated++;
      }
      const txns = await db
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode), eq(schema.transactions.type, args.type), eq(schema.transactions.category, oldName)));
      for (const t of txns) {
        await db.update(schema.transactions).set({ category: newName, updatedAt: new Date() }).where(eq(schema.transactions.id, t.id));
        updated++;
      }
      const recs = await db
        .select()
        .from(schema.recurringCashflows)
        .where(and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, wsMode), eq(schema.recurringCashflows.type, args.type), eq(schema.recurringCashflows.category, oldName)));
      for (const r of recs) {
        await db.update(schema.recurringCashflows).set({ category: newName }).where(eq(schema.recurringCashflows.id, r.id));
        updated++;
      }
      if (args.type === "expense") {
        const buds = await db
          .select()
          .from(schema.budgets)
          .where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode), eq(schema.budgets.category, oldName)));
        for (const b of buds) {
          await db.update(schema.budgets).set({ category: newName }).where(eq(schema.budgets.id, b.id));
          updated++;
        }
      }
      await rememberCustomCategory(db, user.id, wsMode, args.type, newName);
      await log(db, "Custom category renamed", `${oldName} → ${newName}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { updated };
    },
  }),

  deleteCustomCategory: defineAction({
    description:
      "Removes a user-created custom category from the active workspace's remembered list. Records already using the name keep it — nothing is deleted from the ledger.",
    request: z.object({
      token: z.string().max(200).optional(),
      type: z.enum(["income", "expense"]),
      name: z.string().min(1).max(60),
    }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.customCategories)
        .where(and(eq(schema.customCategories.ownerId, user.id), eq(schema.customCategories.mode, wsMode), eq(schema.customCategories.type, args.type)));
      let trashId: string | null = null;
      for (const r of rows) {
        if (r.name.toLowerCase() === args.name.trim().toLowerCase()) {
          trashId = await pushTrash(db, user.id, wsMode, "custom_category", r.name, { row: r });
          await db.delete(schema.customCategories).where(eq(schema.customCategories.id, r.id));
        }
      }
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  exportBackup: defineAction({
    description:
      "Exports a full backup of every workspace of the signed-in account as structured data (not CSV-only): each workspace's profile, transactions with categories, payees and payment methods, invoices with items, notes, recurring schedules, budgets, custom categories, scenarios, EMI plans and savings goals with their transfers — so a phone change or restore never loses structure.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      version: z.literal(1),
      exportedAt: z.string(),
      workspaces: z.array(
        z.object({
          mode: z.enum(["business", "personal", "creator", "student"]),
          business: businessShape,
          transactions: z.array(txnShape.extend({ emiInstalmentId: z.string().nullable() })),
          invoices: z.array(invoiceShape),
          notes: z.array(noteShape),
          recurring: z.array(
            z.object({
              id: z.string(), type: z.string(), category: z.string(), description: z.string(),
              amountCents: z.number(), frequency: z.string(), nextDate: z.string(), active: z.boolean(), demo: z.boolean(),
            }),
          ),
          budgets: z.array(z.object({ id: z.string(), category: z.string(), monthlyLimitCents: z.number() })),
          customCategories: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
          scenarios: z.array(z.object({ id: z.string(), name: z.string(), params: z.string(), demo: z.boolean() })),
          emiPlans: z.array(emiPlanShape),
          savingsGoals: z.array(savingsGoalShape),
        }),
      ),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const bizRows = await db.select().from(schema.businesses).where(eq(schema.businesses.ownerId, user.id));
      const items = await db.select().from(schema.invoiceItems);
      const itemsByInv = new Map<string, ItemRow[]>();
      for (const it of items) {
        const arr = itemsByInv.get(it.invoiceId) ?? [];
        arr.push(it);
        itemsByInv.set(it.invoiceId, arr);
      }
      const allInst = await db.select().from(schema.emiInstalments);
      const instByPlan = new Map<string, EmiInstRow[]>();
      for (const inst of allInst) {
        const arr = instByPlan.get(inst.planId) ?? [];
        arr.push(inst);
        instByPlan.set(inst.planId, arr);
      }
      const workspaces = [];
      for (const biz of bizRows) {
        const mode = asMode(biz.mode);
        const txns = await db.select().from(schema.transactions).where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, mode)));
        const invs = await db.select().from(schema.invoices).where(and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, mode)));
        const noteRows = await db.select().from(schema.notes).where(and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, mode)));
        const rec = await db.select().from(schema.recurringCashflows).where(and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, mode)));
        const buds = await db.select().from(schema.budgets).where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, mode)));
        const cats = await db.select().from(schema.customCategories).where(and(eq(schema.customCategories.ownerId, user.id), eq(schema.customCategories.mode, mode)));
        const scen = await db.select().from(schema.scenarios).where(and(eq(schema.scenarios.ownerId, user.id), eq(schema.scenarios.mode, mode)));
        const plans = await db.select().from(schema.emiPlans).where(and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, mode)));
        const sGoals = await db.select().from(schema.savingsGoals).where(and(eq(schema.savingsGoals.ownerId, user.id), eq(schema.savingsGoals.mode, mode)));
        const sTransfers = await db.select().from(schema.savingsTransfers).where(and(eq(schema.savingsTransfers.ownerId, user.id), eq(schema.savingsTransfers.mode, mode)));
        const sByGoal = new Map<string, SavingsTransferRow[]>();
        for (const tr of sTransfers) {
          const arr = sByGoal.get(tr.goalId) ?? [];
          arr.push(tr);
          sByGoal.set(tr.goalId, arr);
        }
        workspaces.push({
          mode,
          business: bizOut(biz),
          transactions: txns.map((t) => ({ ...txnOut(t), emiInstalmentId: t.emiInstalmentId ?? null })),
          invoices: invs.map((inv) => {
            const its = (itemsByInv.get(inv.id) ?? []).sort((a, b) => a.sort - b.sort);
            const totals = invoiceTotals(inv, its);
            return {
              id: inv.id, number: inv.number, customerName: inv.customerName, customerEmail: inv.customerEmail,
              status: inv.status, effectiveStatus: effectiveStatus(inv), issueDate: inv.issueDate, dueDate: inv.dueDate,
              discountPct: inv.discountBp / 100, taxPct: inv.taxBp / 100, notes: inv.notes,
              items: its.map((it) => ({ id: it.id, description: it.description, qty: it.qtyMilli / 1000, unitPriceCents: it.unitPriceCents })),
              subtotalCents: totals.subtotal, discountCents: totals.discount, taxCents: totals.tax, totalCents: totals.total,
              demo: inv.demo === 1, createdAt: inv.createdAt.toISOString(), updatedAt: inv.updatedAt.toISOString(),
            };
          }),
          notes: noteRows.map((n) => ({
            id: n.id, title: n.title, content: n.content, category: n.category, tags: n.tags,
            pinned: n.pinned === 1, sourceModule: n.sourceModule, sourceId: n.sourceId, demo: n.demo === 1,
            createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(),
          })),
          recurring: rec.map((r) => ({
            id: r.id, type: r.type, category: r.category, description: r.description, amountCents: r.amountCents,
            frequency: r.frequency, nextDate: r.nextDate, active: r.active === 1, demo: r.demo === 1,
          })),
          budgets: buds.map((b) => ({ id: b.id, category: b.category, monthlyLimitCents: b.monthlyLimitCents })),
          customCategories: cats.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          scenarios: scen.map((s) => ({ id: s.id, name: s.name, params: s.params, demo: s.demo === 1 })),
          emiPlans: plans.map((p) => emiPlanOut(p, instByPlan.get(p.id) ?? [])),
          savingsGoals: sGoals.map((g) => savingsGoalOut(g, sByGoal.get(g.id) ?? [])),
        });
      }
      return { version: 1 as const, exportedAt: new Date().toISOString(), workspaces };
    },
  }),

  restoreBackup: defineAction({
    description:
      "Restores a full backup produced by exportBackup into the signed-in account. It is a careful merge: any record whose id already exists is skipped, existing records are never overwritten or deleted, and each workspace's records go back into that same workspace. Returns how many records were restored and skipped.",
    request: z.object({
      token: z.string().max(200).optional(),
      backup: z.object({
        version: z.number(),
        workspaces: z.array(
          z.object({
            mode: z.enum(["business", "personal", "creator", "student"]),
            transactions: z.array(txnShape.extend({ emiInstalmentId: z.string().nullable().optional() })).max(5000),
            invoices: z.array(invoiceShape).max(1000),
            notes: z.array(noteShape).max(2000),
            recurring: z.array(
              z.object({
                id: z.string(), type: z.string(), category: z.string(), description: z.string(),
                amountCents: z.number(), frequency: z.string(), nextDate: z.string(), active: z.boolean(), demo: z.boolean(),
              }),
            ).max(1000),
            budgets: z.array(z.object({ id: z.string(), category: z.string(), monthlyLimitCents: z.number() })).max(500),
            customCategories: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })).max(500),
            scenarios: z.array(z.object({ id: z.string(), name: z.string(), params: z.string(), demo: z.boolean() })).max(500),
            emiPlans: z.array(emiPlanShape).max(500),
            savingsGoals: z.array(savingsGoalShape).max(500).optional(),
          }),
        ).max(4),
      }),
    }),
    response: z.object({ restored: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      if (args.backup.version !== 1) throw new Error("That backup file is from an unsupported version.");
      let restored = 0;
      let skipped = 0;
      const exists = async (table: typeof schema.transactions | typeof schema.invoices | typeof schema.notes | typeof schema.recurringCashflows | typeof schema.scenarios | typeof schema.emiPlans | typeof schema.savingsGoals, id: string) => {
        const rows = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
        return !!rows[0];
      };
      for (const ws of args.backup.workspaces) {
        await ensureWorkspace(db, user.id, ws.mode);
        for (const c of ws.customCategories) {
          await rememberCustomCategory(db, user.id, ws.mode, c.type === "income" ? "income" : "expense", c.name);
        }
        for (const inv of ws.invoices) {
          if (await exists(schema.invoices, inv.id)) { skipped++; continue; }
          try {
            await db.insert(schema.invoices).values({
              id: inv.id, ownerId: user.id, mode: ws.mode, number: inv.number, customerName: inv.customerName,
              customerEmail: inv.customerEmail, status: inv.status === "paid" ? "paid" : inv.status === "sent" ? "sent" : "draft",
              issueDate: inv.issueDate, dueDate: inv.dueDate, discountBp: Math.round(inv.discountPct * 100),
              taxBp: Math.round(inv.taxPct * 100), notes: inv.notes, demo: inv.demo ? 1 : 0,
            });
            for (const [i, it] of inv.items.entries()) {
              await db.insert(schema.invoiceItems).values({
                id: it.id, invoiceId: inv.id, description: it.description,
                qtyMilli: Math.round(it.qty * 1000), unitPriceCents: it.unitPriceCents, sort: i,
              });
            }
            restored++;
          } catch { skipped++; }
        }
        for (const plan of ws.emiPlans) {
          if (await exists(schema.emiPlans, plan.id)) { skipped++; continue; }
          try {
            await db.insert(schema.emiPlans).values({
              id: plan.id, ownerId: user.id, mode: ws.mode, customerName: plan.customerName,
              customerContact: plan.customerContact, product: plan.product, totalCents: plan.totalCents,
              downPaymentCents: plan.downPaymentCents, instalmentCount: plan.instalmentCount,
              frequency: plan.frequency === "weekly" ? "weekly" : "monthly", firstDueDate: plan.firstDueDate, demo: plan.demo ? 1 : 0,
            });
            for (const inst of plan.instalments) {
              await db.insert(schema.emiInstalments).values({
                id: inst.id, planId: plan.id, seq: inst.seq, dueDate: inst.dueDate, amountCents: inst.amountCents,
                status: inst.status === "paid" ? "paid" : "pending", paidDate: inst.paidDate, transactionId: inst.transactionId,
              });
            }
            restored++;
          } catch { skipped++; }
        }
        for (const t of ws.transactions) {
          if (await exists(schema.transactions, t.id)) { skipped++; continue; }
          try {
            await db.insert(schema.transactions).values({
              id: t.id, ownerId: user.id, mode: ws.mode,
              type: t.type === "income" ? "income" : "expense",
              status: t.status === "pending" ? "pending" : "posted",
              category: t.category, description: t.description, counterparty: t.counterparty,
              amountCents: t.amountCents, date: t.date, paymentMethod: t.paymentMethod ?? "",
              invoiceId: t.invoiceId, emiInstalmentId: t.emiInstalmentId ?? null, demo: t.demo ? 1 : 0,
            });
            restored++;
          } catch { skipped++; }
        }
        for (const n of ws.notes) {
          if (await exists(schema.notes, n.id)) { skipped++; continue; }
          try {
            await db.insert(schema.notes).values({
              id: n.id, ownerId: user.id, mode: ws.mode, title: n.title, content: n.content, category: n.category,
              tags: n.tags, pinned: n.pinned ? 1 : 0, sourceModule: n.sourceModule, sourceId: n.sourceId, demo: n.demo ? 1 : 0,
            });
            restored++;
          } catch { skipped++; }
        }
        for (const r of ws.recurring) {
          if (await exists(schema.recurringCashflows, r.id)) { skipped++; continue; }
          try {
            await db.insert(schema.recurringCashflows).values({
              id: r.id, ownerId: user.id, mode: ws.mode, type: r.type === "income" ? "income" : "expense",
              category: r.category, description: r.description, amountCents: r.amountCents,
              frequency: r.frequency === "weekly" ? "weekly" : "monthly", nextDate: r.nextDate,
              active: r.active ? 1 : 0, demo: r.demo ? 1 : 0,
            });
            restored++;
          } catch { skipped++; }
        }
        for (const b of ws.budgets) {
          const existingBud = await db.select().from(schema.budgets).where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, ws.mode), eq(schema.budgets.category, b.category))).limit(1);
          if (existingBud[0]) { skipped++; continue; }
          await db.insert(schema.budgets).values({ id: b.id, ownerId: user.id, mode: ws.mode, category: b.category, monthlyLimitCents: b.monthlyLimitCents });
          restored++;
        }
        for (const s of ws.scenarios) {
          if (await exists(schema.scenarios, s.id)) { skipped++; continue; }
          try {
            await db.insert(schema.scenarios).values({ id: s.id, ownerId: user.id, mode: ws.mode, name: s.name, params: s.params, demo: s.demo ? 1 : 0 });
            restored++;
          } catch { skipped++; }
        }
        for (const g of ws.savingsGoals ?? []) {
          if (await exists(schema.savingsGoals, g.id)) { skipped++; continue; }
          try {
            await db.insert(schema.savingsGoals).values({
              id: g.id, ownerId: user.id, mode: ws.mode, name: g.name,
              targetCents: g.targetCents, targetDate: g.targetDate, demo: g.demo ? 1 : 0,
            });
            for (const tr of g.transfers) {
              const dup = await db.select({ id: schema.savingsTransfers.id }).from(schema.savingsTransfers).where(eq(schema.savingsTransfers.id, tr.id)).limit(1);
              if (dup[0]) continue;
              await db.insert(schema.savingsTransfers).values({
                id: tr.id, goalId: g.id, ownerId: user.id, mode: ws.mode,
                direction: tr.direction === "withdraw" ? "withdraw" : "deposit",
                amountCents: tr.amountCents, date: tr.date, note: tr.note,
              });
            }
            restored++;
          } catch { skipped++; }
        }
      }
      await log(db, "Backup restored", `${restored} record(s) restored, ${skipped} already present`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { restored, skipped };
    },
  }),

  changeIdentifier: defineAction({
    description:
      "Changes the signed-in account's login email address, after verifying the current password. The new login must be an email address (mobile numbers are no longer a sign-in method) and must not belong to another account. Sessions stay signed in; all records are untouched.",
    request: z.object({
      token: z.string().max(200).optional(),
      newIdentifier: z.string().min(3).max(160),
      password: z.string().min(1).max(200),
    }),
    response: z.object({ ok: z.literal(true), identifier: z.string(), channel: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; identifier: string; channel: string }> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const okPw = await checkPassword(args.password, user.passwordSalt, user.passwordHash);
      if (!okPw) throw new Error("That password doesn't match this account — nothing was changed.");
      const parsed = identifierOf(args.newIdentifier);
      if (!parsed || parsed.channel !== "email") throw new Error("Enter a valid email address — mobile numbers are no longer a sign-in method, so your login must be an email address.");
      if (parsed.identifier === DEMO_IDENTIFIER)
        throw new Error("That address belonged to the removed demo account and can't be used. Please pick your own email address.");
      const clash = await db.select().from(schema.authUsers).where(eq(schema.authUsers.identifier, parsed.identifier)).limit(1);
      if (clash[0] && clash[0].id !== user.id)
        throw new Error("That email address is already used by another account.");
      await db.update(schema.authUsers).set({ identifier: parsed.identifier, channel: parsed.channel, updatedAt: new Date() }).where(eq(schema.authUsers.id, user.id));
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, identifier: parsed.identifier, channel: parsed.channel };
    },
  }),

  deleteAccount: defineAction({
    description:
      "Permanently deletes the signed-in account and every record it owns across all workspaces, after verifying the password and an explicit DELETE confirmation. This cannot be undone — the UI directs users to download a full backup first.",
    request: z.object({
      token: z.string().max(200).optional(),
      password: z.string().min(1).max(200),
      confirm: z.string().max(10),
    }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      if (args.confirm !== "DELETE")
        throw new Error("Type DELETE to confirm permanent deletion.");
      const okPw = await checkPassword(args.password, user.passwordSalt, user.passwordHash);
      if (!okPw) throw new Error("That password doesn't match this account — nothing was deleted.");
      const owner = user.id;
      const invs = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.ownerId, owner));
      for (const inv of invs) await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
      const plans = await db.select({ id: schema.emiPlans.id }).from(schema.emiPlans).where(eq(schema.emiPlans.ownerId, owner));
      for (const p of plans) await db.delete(schema.emiInstalments).where(eq(schema.emiInstalments.planId, p.id));
      const noteRows = await db.select({ id: schema.notes.id }).from(schema.notes).where(eq(schema.notes.ownerId, owner));
      for (const n of noteRows) await db.delete(schema.noteVersions).where(eq(schema.noteVersions.noteId, n.id));
      const convs = await db.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(eq(schema.aiConversations.ownerId, owner));
      for (const c of convs) await db.delete(schema.aiMessages).where(eq(schema.aiMessages.conversationId, c.id));
      await db.delete(schema.savingsTransfers).where(eq(schema.savingsTransfers.ownerId, owner));
      await db.delete(schema.savingsGoals).where(eq(schema.savingsGoals.ownerId, owner));
      await db.delete(schema.transactions).where(eq(schema.transactions.ownerId, owner));
      await db.delete(schema.invoices).where(eq(schema.invoices.ownerId, owner));
      await db.delete(schema.emiPlans).where(eq(schema.emiPlans.ownerId, owner));
      await db.delete(schema.notes).where(eq(schema.notes.ownerId, owner));
      await db.delete(schema.scenarios).where(eq(schema.scenarios.ownerId, owner));
      await db.delete(schema.recurringCashflows).where(eq(schema.recurringCashflows.ownerId, owner));
      await db.delete(schema.budgets).where(eq(schema.budgets.ownerId, owner));
      await db.delete(schema.aiConversations).where(eq(schema.aiConversations.ownerId, owner));
      await db.delete(schema.activityLogs).where(eq(schema.activityLogs.ownerId, owner));
      await db.delete(schema.scamChecks).where(eq(schema.scamChecks.ownerId, owner));
      await db.delete(schema.customCategories).where(eq(schema.customCategories.ownerId, owner));
      await db.delete(schema.importBatches).where(eq(schema.importBatches.ownerId, owner));
      await db.delete(schema.trashItems).where(eq(schema.trashItems.ownerId, owner));
      await db.delete(schema.userWorkspaceState).where(eq(schema.userWorkspaceState.ownerId, owner));
      await db.delete(schema.businesses).where(eq(schema.businesses.ownerId, owner));
      await db.delete(schema.authCodes).where(eq(schema.authCodes.userId, owner));
      await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, owner));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, owner));
      return { ok: true as const };
    },
  }),

  saveInvoice: defineAction({
    description:
      "Creates or updates an invoice with line items; totals are recalculated server-side.",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      number: z.string().min(1).max(40),
      customerName: z.string().min(1).max(120),
      customerEmail: z.string().max(160),
      status: z.enum(["draft", "sent"]),
      issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      discountPct: z.number().min(0).max(100),
      taxPct: z.number().min(0).max(100),
      notes: z.string().max(500),
      items: z
        .array(
          z.object({
            description: z.string().max(200),
            qty: z.number().positive().max(100000),
            unitPriceCents: z.number().int().min(0),
          }),
        )
        .min(1)
        .max(50),
    }),
    response: z.object({ id: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const itemValues = (invoiceId: string) =>
        args.items.map((it, i) => ({
          id: uid(),
          invoiceId,
          description: it.description,
          qtyMilli: Math.round(it.qty * 1000),
          unitPriceCents: it.unitPriceCents,
          sort: i,
        }));
      if (args.id) {
        const existing = await db
          .select()
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))))
          .limit(1);
        if (!existing[0]) throw new Error("Invoice not found.");
        if (existing[0].status === "paid")
          throw new Error("Paid invoices cannot be edited.");
        // Renaming to a number another invoice in this workspace
        // already uses is a duplicate — stop it here with a plain
        // message instead of letting the database reject it.
        // (Keeping the same number on THIS invoice is fine.)
        if (args.number !== existing[0].number) {
          await assertInvoiceNumberFree(db, user.id, wsMode, args.number, args.id);
        }
        try {
          await db
            .update(schema.invoices)
            .set({
              number: args.number,
              customerName: args.customerName,
              customerEmail: args.customerEmail,
              status: args.status,
              issueDate: args.issueDate,
              dueDate: args.dueDate,
              discountBp: Math.round(args.discountPct * 100),
              taxBp: Math.round(args.taxPct * 100),
              notes: args.notes,
              updatedAt: new Date(),
            })
            .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))));
        } catch (e) {
          if (dbErrorCode(e) === "23505")
            throw new Error(
              `An invoice with number ${args.number} already exists in this workspace. Change the number and try again.`,
            );
          throw e;
        }
        await db
          .delete(schema.invoiceItems)
          .where(eq(schema.invoiceItems.invoiceId, args.id));
        await db.insert(schema.invoiceItems).values(itemValues(args.id));
        await log(db, "Invoice updated", args.number, user.id);
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: args.id };
      }
      // A second invoice with the same number in the same workspace
      // is a duplicate: the live test (2026-11-14) ended up with two
      // identical INV-2026-001 rows because the first save looked
      // like it did nothing (stale UI) and was saved again — and
      // nothing stopped it. Check first for a plain-language error,
      // and the unique index on (owner_id, mode, number) is the
      // race-proof backstop below.
      await assertInvoiceNumberFree(db, user.id, wsMode, args.number);
      const id = uid();
      try {
        await db.insert(schema.invoices).values({
          id,
          ownerId: user.id,
          mode: wsMode,
          number: args.number,
          customerName: args.customerName,
          customerEmail: args.customerEmail,
          status: args.status,
          issueDate: args.issueDate,
          dueDate: args.dueDate,
          discountBp: Math.round(args.discountPct * 100),
          taxBp: Math.round(args.taxPct * 100),
          notes: args.notes,
        });
      } catch (e) {
        if (dbErrorCode(e) === "23505")
          throw new Error(
            `An invoice with number ${args.number} already exists in this workspace. Change the number and try again.`,
          );
        throw e;
      }
      await db.insert(schema.invoiceItems).values(itemValues(id));
      await log(db, "Invoice created", args.number, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id };
    },
  }),

  setInvoiceStatus: defineAction({
    description:
      "Moves an invoice between draft and sent (overdue is derived from the due date).",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string(),
      status: z.enum(["draft", "sent"]),
    }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))))
        .limit(1);
      if (!rows[0]) throw new Error("Invoice not found.");
      if (rows[0].status === "paid")
        throw new Error("Paid invoices cannot change status.");
      await db
        .update(schema.invoices)
        .set({ status: args.status, updatedAt: new Date() })
        .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))));
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  markInvoicePaid: defineAction({
    description:
      "Marks an invoice paid and creates exactly one linked income transaction; repeat calls are safely rejected because the payment already exists.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: z.object({
      ok: z.boolean(),
      alreadyPaid: z.boolean(),
      transactionId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))))
        .limit(1);
      const inv = rows[0];
      if (!inv)
        return { ok: false, alreadyPaid: false, transactionId: null, error: "Invoice not found." };
      const existingPayment = await db
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.invoiceId, inv.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))))
        .limit(1);
      if (existingPayment[0]) {
        return {
          ok: false,
          alreadyPaid: true,
          transactionId: existingPayment[0].id,
          error: "This invoice already has a linked payment transaction, so no duplicate was created.",
        };
      }
      const items = await db
        .select()
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, inv.id));
      const totals = invoiceTotals(inv, items);
      const txnId = uid();
      await Promise.all([
        db.insert(schema.transactions).values({
          id: txnId,
          ownerId: user.id,
          mode: wsMode,
          type: "income",
          status: "posted",
          category: "Customer payments",
          description: `Payment received for invoice ${inv.number}`,
          counterparty: inv.customerName,
          amountCents: totals.total,
          date: todayStr(),
          invoiceId: inv.id,
          demo: inv.demo,
        }),
        db
          .update(schema.invoices)
          .set({ status: "paid", updatedAt: new Date() })
          .where(and(eq(schema.invoices.id, inv.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode)))),
      ]);
      await log(db, "Invoice paid", inv.number, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, alreadyPaid: false, transactionId: txnId, error: null };
    },
  }),

  deleteInvoice: defineAction({
    description: "Deletes a draft invoice and its line items.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), trashId: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode))))
        .limit(1);
      if (!rows[0]) return { ok: false, error: "Invoice not found.", trashId: null };
      if (rows[0].status !== "draft")
        return { ok: false, error: "Only draft invoices can be deleted.", trashId: null };
      const invItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, args.id));
      const trashId = await pushTrash(db, user.id, wsMode, "invoice", rows[0].number, { row: rows[0], items: invItems });
      await Promise.all([
        db
          .delete(schema.invoiceItems)
          .where(eq(schema.invoiceItems.invoiceId, args.id)),
        db.delete(schema.invoices).where(and(eq(schema.invoices.id, args.id), and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode)))),
      ]);
      await log(db, "Invoice deleted", rows[0].number, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, error: null, trashId };
    },
  }),

  saveEmiPlan: defineAction({
    description:
      "Creates an EMI plan for a product sold on instalments (customer, product, total, down payment, instalment count, first due date) and generates its full instalment schedule server-side.",
    request: z.object({
      token: z.string().max(200).optional(),
      customerName: z.string().min(1).max(120),
      customerContact: z.string().max(120).optional(),
      product: z.string().min(1).max(200),
      totalCents: z.number().int().positive().max(100_000_000_00),
      downPaymentCents: z.number().int().min(0).max(100_000_000_00).optional(),
      instalmentCount: z.number().int().min(1).max(60),
      frequency: z.enum(["monthly", "weekly"]).optional(),
      firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const down = args.downPaymentCents ?? 0;
      if (down >= args.totalCents)
        return {
          ok: false,
          id: null,
          error: "The down payment must be smaller than the total price — the rest is what the instalments cover.",
        };
      const frequency = args.frequency ?? "monthly";
      const planId = uid();
      const schedule = emiSchedule(args.totalCents, down, args.instalmentCount, frequency, args.firstDueDate);
      const statements = [
        db.insert(schema.emiPlans).values({
          id: planId,
          ownerId: user.id,
          mode: wsMode,
          customerName: args.customerName.trim(),
          customerContact: (args.customerContact ?? "").trim(),
          product: args.product.trim(),
          totalCents: args.totalCents,
          downPaymentCents: down,
          instalmentCount: args.instalmentCount,
          frequency,
          firstDueDate: args.firstDueDate,
        }),
        ...schedule.map((s) =>
          db.insert(schema.emiInstalments).values({
            id: uid(),
            planId,
            seq: s.seq,
            dueDate: s.dueDate,
            amountCents: s.amountCents,
          }),
        ),
      ];
      const [first, ...rest] = statements;
      if (first) await Promise.all([first, ...rest]);
      await log(db, "EMI plan created", `${args.product} — ${args.customerName}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, id: planId, error: null };
    },
  }),

  deleteEmiPlan: defineAction({
    description:
      "Deletes an EMI plan and its instalments, but only while no instalment has been collected — collected instalments are part of the ledger and are never erased.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), trashId: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.emiPlans)
        .where(and(eq(schema.emiPlans.id, args.id), and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, wsMode))))
        .limit(1);
      const plan = rows[0];
      if (!plan) return { ok: false, error: "EMI plan not found.", trashId: null };
      const insts = await db
        .select()
        .from(schema.emiInstalments)
        .where(eq(schema.emiInstalments.planId, plan.id));
      if (insts.some((i) => i.status === "paid"))
        return {
          ok: false,
          error: "This plan already has collected instalments linked to income transactions, so it can't be deleted.",
          trashId: null,
        };
      const trashId = await pushTrash(db, user.id, wsMode, "emi_plan", plan.product, { row: plan, instalments: insts });
      await Promise.all([
        db.delete(schema.emiInstalments).where(eq(schema.emiInstalments.planId, plan.id)),
        db.delete(schema.emiPlans).where(and(eq(schema.emiPlans.id, plan.id), and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, wsMode)))),
      ]);
      await log(db, "EMI plan deleted", plan.product, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, error: null, trashId };
    },
  }),

  collectEmiInstalment: defineAction({
    description:
      "Marks one EMI instalment as collected and creates exactly one linked income transaction; repeat calls are safely rejected because the collection already exists.",
    request: z.object({ token: z.string().max(200).optional(), instalmentId: z.string() }),
    response: z.object({
      ok: z.boolean(),
      alreadyCollected: z.boolean(),
      transactionId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const instRows = await db
        .select()
        .from(schema.emiInstalments)
        .where(eq(schema.emiInstalments.id, args.instalmentId))
        .limit(1);
      const inst = instRows[0];
      if (!inst)
        return { ok: false, alreadyCollected: false, transactionId: null, error: "Instalment not found." };
      const planRows = await db
        .select()
        .from(schema.emiPlans)
        .where(and(eq(schema.emiPlans.id, inst.planId), and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, wsMode))))
        .limit(1);
      const plan = planRows[0];
      if (!plan)
        return { ok: false, alreadyCollected: false, transactionId: null, error: "Instalment not found." };
      const existing = await db
        .select()
        .from(schema.transactions)
        .where(and(eq(schema.transactions.emiInstalmentId, inst.id), and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode))))
        .limit(1);
      if (existing[0]) {
        return {
          ok: false,
          alreadyCollected: true,
          transactionId: existing[0].id,
          error: "This instalment already has a linked income transaction, so no duplicate was created.",
        };
      }
      if (inst.status === "paid") {
        return {
          ok: false,
          alreadyCollected: true,
          transactionId: inst.transactionId ?? null,
          error: "This instalment is already marked collected.",
        };
      }
      const txnId = uid();
      const today = todayStr();
      await Promise.all([
        db.insert(schema.transactions).values({
          id: txnId,
          ownerId: user.id,
          mode: wsMode,
          type: "income",
          status: "posted",
          category: "Customer payments",
          description: `EMI instalment ${inst.seq} of ${plan.instalmentCount} collected — ${plan.product}`,
          counterparty: plan.customerName,
          amountCents: inst.amountCents,
          date: today,
          emiInstalmentId: inst.id,
          demo: plan.demo,
        }),
        db
          .update(schema.emiInstalments)
          .set({ status: "paid", paidDate: today, transactionId: txnId })
          .where(eq(schema.emiInstalments.id, inst.id)),
      ]);
      await log(db, "EMI instalment collected", `${plan.product} #${inst.seq} — ${plan.customerName}`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, alreadyCollected: false, transactionId: txnId, error: null };
    },
  }),

  analyseScamText: defineAction({
    description:
      "Scam Shield: analyses a pasted suspicious UPI/phishing message and/or an uploaded payment screenshot for scam signals and returns a verdict with reasons. It never confirms a payment — final verification must happen in the bank/UPI app.",
    request: z.object({
      token: z.string().max(200).optional(),
      text: z.string().max(6000).optional(),
      claimedFrom: z.string().max(120).optional(),
      claimedAmountCents: z.number().int().min(0).max(100_000_000_00).optional(),
      imageBase64: z.string().max(9_000_000).optional(),
      imageMimeType: z.enum(["image/jpeg", "image/png"]).optional(),
    }),
    response: z.object({
      verdict: z.enum(["high_risk", "suspicious", "no_strong_signs"]),
      riskScore: z.number(),
      reasons: z.array(scamReasonShape),
      checksPerformed: z.array(z.string()),
      foundUpiIds: z.array(z.string()),
      foundLinks: z.array(z.string()),
      imageFindings: z
        .object({
          readable: z.boolean(),
          appearsToBePaymentScreenshot: z.boolean(),
          imageDescription: z.string(),
          visibleText: z.string(),
          senderOrReceiverName: z.string().nullable(),
          upiId: z.string().nullable(),
          amountText: z.string().nullable(),
          dateText: z.string().nullable(),
          statusWording: z.string().nullable(),
          editingSigns: z.string(),
        })
        .nullable(),
      disclaimer: z.string(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const text = (args.text ?? "").trim();
      const hasImage = !!args.imageBase64;
      if (!text && !hasImage)
        throw new Error("Paste a suspicious message or upload a payment screenshot first.");

      // The user's own known counterparties — a sender/UPI ID matching one
      // of these is weaker evidence of a stranger scam (never proof either).
      const txns = await db.select().from(schema.transactions).where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode)));
      const invs = await db.select().from(schema.invoices).where(and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode)));
      const plans = await db.select().from(schema.emiPlans).where(and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, wsMode)));
      const knownNames = new Set<string>();
      for (const t of txns) if (t.counterparty.trim()) knownNames.add(t.counterparty.trim().toLowerCase());
      for (const i of invs) if (i.customerName.trim()) knownNames.add(i.customerName.trim().toLowerCase());
      for (const p of plans) if (p.customerName.trim()) knownNames.add(p.customerName.trim().toLowerCase());
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const knownNorm = new Set([...knownNames].map(norm).filter((s) => s.length >= 3));
      const matchesKnown = (candidate: string): boolean => {
        const c = norm(candidate);
        if (c.length < 3) return false;
        for (const k of knownNorm) {
          if (c.includes(k) || k.includes(c)) return true;
        }
        return false;
      };

      type Reason = z.infer<typeof scamReasonShape>;
      const reasons: Reason[] = [];
      const checks: string[] = [];
      const addReason = (r: Reason) => {
        if (!reasons.some((x) => x.code === r.code)) reasons.push(r);
      };

      const lower = text.toLowerCase();
      const upiIds = [...new Set([...text.matchAll(/[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}[a-zA-Z0-9]*/g)].map((m) => m[0].toLowerCase()))];
      const links = [...new Set([...text.matchAll(/https?:\/\/[^\s)]+|www\.[^\s)]+/gi)].map((m) => m[0]))];

      if (text) {
        checks.push("Scanned the pasted text for OTP/PIN requests, urgency pressure, threats, links, UPI IDs and payment-claim wording.");
        if (/\b(otp|one[\s-]?time password|upi pin|m-?pin|cvv|atm pin|card pin|password)\b/.test(lower) &&
            /(share|send|enter|tell|provide|batao|bhejo|enter karo)/.test(lower)) {
          addReason({
            code: "otp_pin_request",
            title: "Asks for an OTP, PIN or password",
            detail: "No bank, UPI app or genuine customer ever needs your OTP, UPI PIN or password to SEND you money. Anyone asking for one is trying to take money out of your account, not put money in.",
            severity: "critical",
          });
        }
        if (/(anydesk|teamviewer|quicksupport|screen[\s-]?shar|remote access)/.test(lower)) {
          addReason({
            code: "remote_access",
            title: "Pushes a screen-sharing / remote-access app",
            detail: "Scammers use apps like AnyDesk or TeamViewer to watch your screen while you bank. No genuine payment or refund needs remote access to your phone.",
            severity: "critical",
          });
        }
        if (/(account (will be|is being|has been) (blocked|suspended|closed|frozen)|kyc (expired|update|pending)|sim (will be|is) (blocked|deactivated)|legal action|police complaint|arrest)/.test(lower)) {
          addReason({
            code: "threat",
            title: "Threatens account blocking, KYC expiry or legal action",
            detail: "Fear of losing the account is the classic pressure trick. Banks do not block accounts over a chat message or a link — check inside the official app or branch instead.",
            severity: "high",
          });
        }
        if (/\b(urgent|act now|hurry|last chance)\b/.test(lower) ||
            /within \d+\s?(minute|hour|min|hr)s?\b/.test(lower) ||
            /expire[sd]?\s(today|soon|in)\b/.test(lower)) {
          addReason({
            code: "urgency",
            title: "Creates urgency pressure",
            detail: "The message pushes you to act fast so you don't stop to verify. Real payments and real bank notices never expire in minutes.",
            severity: "high",
          });
        }
        if (/(lottery|you (have )?won|prize|cashback offer|double your money|refund (of|amount)|processing fee|pay .* to (receive|claim|unlock))/.test(lower)) {
          addReason({
            code: "prize_refund",
            title: "Prize, lottery or refund bait",
            detail: "Unexpected winnings or refunds that ask you to pay a fee, scan a QR code or approve a request first are a well-known UPI scam pattern.",
            severity: "high",
          });
        }
        if (/(approve|accept) (the )?(collect request|payment request)|scan (the )?(qr|code) to (receive|get|collect)/.test(lower)) {
          addReason({
            code: "collect_trick",
            title: "Tries to make you approve a collect request or scan to 'receive'",
            detail: "Receiving money never needs a PIN, a QR scan or approving a collect request. Approving one sends money OUT of your account.",
            severity: "critical",
          });
        }
        if (links.length > 0) {
          const shortener = links.some((l) => /(bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|shorturl|t\.me\/|is\.gd|rebrand\.ly)/i.test(l));
          const lookalike = links.some((l) => /(upi|paytm|phonepe|gpay|bank|kyc|refund)/i.test(l) && !/(paytm\.com|phonepe\.com|google\.com|npci\.org\.in|sbi\.co\.in|hdfcbank\.com|icicibank\.com|axisbank\.com|kotak\.com)/i.test(l));
          const ipLink = links.some((l) => /https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(l));
          addReason({
            code: "suspicious_link",
            title: shortener || ipLink ? "Contains a shortened or raw-IP link" : lookalike ? "Contains a lookalike payment/bank link" : "Contains a link",
            detail: `Link(s) found: ${links.slice(0, 3).join(", ")}. Genuine UPI payments happen inside the UPI app — never through a link in a message. Do not open it; open your bank/UPI app directly instead.`,
            severity: shortener || lookalike || ipLink ? "high" : "medium",
          });
        }
        // A payment claim need not have the verb next to "payment":
        // "payment of Rs 5,000 received" is the classic fake-payment
        // wording, and the old adjacent-only pattern missed it entirely
        // (0/100). The [^.;]{0,50}? span allows an amount in between,
        // but stops at a sentence end so it can't reach across the text.
        const paymentClaim =
          /(payment[^.;]{0,50}?(successful|received|done|sent|credited)|amount[^.;]{0,50}?(credited|received)|i have (paid|sent)|paid successfully|money (sent|transferred))/.test(lower);
        if (paymentClaim) {
          addReason({
            code: "payment_claim",
            title: "Claims a payment was made — a claim is not proof",
            detail: "Anyone can type 'payment successful' or forward a fake confirmation. A payment is real only when it appears in your own bank/UPI app history with a matching UTR/reference number.",
            severity: "medium",
          });
        }
        // A payment claim whose only "sender" is a bare 10-digit mobile
        // number, with no UPI ID or UTR/reference anywhere: real
        // bank/UPI notices come from a registered sender ID, never from
        // a stranger's mobile number.
        if (paymentClaim && upiIds.length === 0 && /\bfrom\s+\d{5}[\s-]?\d{5}\b/.test(lower)) {
          addReason({
            code: "unverified_sender_phone",
            title: "Payment is claimed from a bare mobile number",
            detail: "The message says the payment came from a 10-digit mobile number, with no UPI ID or reference number to check. Real payment notices come from your bank/UPI app under a registered sender — a stranger's number claiming to have paid you is a classic fake-payment pattern. Verify in your bank/UPI app before believing it.",
            severity: "medium",
          });
        }
        if (args.claimedFrom && text) {
          const claimed = args.claimedFrom.trim().toLowerCase();
          if (claimed && !lower.includes(claimed) && !matchesKnown(args.claimedFrom)) {
            addReason({
              code: "sender_mismatch",
              title: "Claimed sender does not match the message",
              detail: `The message does not mention "${args.claimedFrom}", and that name is not among your saved customers or counterparties either. Treat the sender as unverified.`,
              severity: "medium",
            });
          }
        }
      }
      if (upiIds.length > 0) {
        checks.push(`Checked ${upiIds.length} UPI ID(s) in the text against your saved customers and counterparties.`);
        for (const id of upiIds) {
          const handle = id.split("@")[0] ?? id;
          if (!matchesKnown(handle) && !(args.claimedFrom && matchesKnown(args.claimedFrom) && norm(handle).includes(norm(args.claimedFrom)))) {
            addReason({
              code: "unknown_upi",
              title: "UPI ID is not in your records",
              detail: `"${id}" does not match any customer, supplier or counterparty name in your Cashflow Genius records. That does not prove it is fake — but never rely on a name shown in a message; verify the ID inside your UPI app, where the registered bank name is shown before you pay.`,
              severity: "medium",
            });
            break;
          }
        }
      }
      if (text && args.claimedAmountCents != null) {
        const amountsInText = [...text.matchAll(/(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/gi)]
          .map((m) => Math.round(parseFloat((m[1] ?? "0").replace(/,/g, "")) * 100))
          .filter((n) => n > 0);
        checks.push("Compared any amounts mentioned in the text with the amount you expected.");
        if (amountsInText.length > 0 && !amountsInText.includes(args.claimedAmountCents)) {
          addReason({
            code: "amount_mismatch",
            title: "Amount in the message differs from what you expected",
            detail: `The message mentions ${amountsInText.map((c) => `₹${(c / 100).toLocaleString("en-IN")}`).join(", ")}, but you expected ₹${(args.claimedAmountCents / 100).toLocaleString("en-IN")}. Do not act until your bank/UPI app shows the exact amount.`,
            severity: "high",
          });
        }
      }

      // ---- screenshot (vision) ----
      let imageFindings: z.infer<typeof imageOutShape> | null = null;
      if (hasImage) {
        checks.push("Read the uploaded screenshot with the AI vision model and compared what it shows with what you were told.");
        try {
          imageFindings = await aiComplete(
            `You are examining an image a user uploaded to a scam-checking app. First describe in one short phrase what the image actually shows (for example 'a photo of a red car parked on a street' or 'a UPI payment success screen'). Then extract ONLY what is visibly readable in the image — never guess or invent. If a field is not visible, return null for it. Also describe any visible signs the image may have been edited or fabricated (mismatched fonts, misaligned text, blurred or pasted areas, inconsistent amounts or names). Your extraction will be used for a scam-risk check; you are NOT confirming the payment is real. If the image is not a payment screenshot at all, say so — a photo of a car, a person or anything else is not a scam by itself.`,
            {
              images: [{ dataBase64: args.imageBase64!, mimeType: args.imageMimeType ?? "image/jpeg", caption: "Uploaded image for scam check" }],
              schema: imageOutShape,
            },
            await getAiSettings(user.id),
          );
        } catch {
          imageFindings = null;
        }
        // Image scoring lives in server/lib/scamShield.ts: the AI judges
        // what the image actually is, so a photo of a car ends at
        // no_strong_signs instead of high_risk, and an unreadable image
        // caps at suspicious. Payment-looking screenshots keep the
        // strict treatment below.
        for (const r of imageReasons(imageFindings, {
          claimedFrom: args.claimedFrom,
          claimedAmountCents: args.claimedAmountCents,
          matchesKnown,
          norm,
        })) addReason(r);
      }

      // Verdict/score math lives in server/lib/scamShield.ts so the
      // harness can prove the image cases without calling the AI.
      const { riskScore, verdict } = scoreReasons(reasons);
      const kind: "text" | "screenshot" | "both" = hasImage && text ? "both" : hasImage ? "screenshot" : "text";
      const excerpt = (text || (hasImage ? "Screenshot check" : "")).slice(0, 140);
      await db.insert(schema.scamChecks).values({
        id: uid(),
        ownerId: user.id,
        mode: wsMode,
        kind,
        excerpt,
        verdict,
        riskScore,
        reasonsJson: JSON.stringify(reasons),
      });
      await log(db, "Scam Shield check", `${verdict} (${riskScore}/100)`, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return {
        verdict,
        riskScore,
        reasons,
        checksPerformed: checks,
        foundUpiIds: upiIds,
        foundLinks: links,
        imageFindings,
        disclaimer:
          "Scam Shield checks for known scam patterns only — it cannot confirm or deny that a payment happened, and a clean result is not a guarantee of safety. Final verification must be done in your bank / UPI app itself: check your transaction history and the UTR/reference number there. Cashflow Genius will never ask for your OTP, UPI PIN or password.",
      };
    },
  }),

  saveNote: defineAction({
    description:
      "Creates or updates a Memory Vault note. Every content change first stores the previous version so it can be recovered.",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      title: z.string().max(200),
      content: z.string().max(100000),
      category: z.string().max(60),
      tags: z.string().max(200),
      pinned: z.boolean(),
      sourceModule: z.string().max(60).optional(),
      sourceId: z.string().max(80).optional(),
    }),
    response: z.object({ id: z.string(), updatedAt: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      if (args.id) {
        const rows = await db
          .select()
          .from(schema.notes)
          .where(and(eq(schema.notes.id, args.id), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))))
          .limit(1);
        const note = rows[0];
        if (!note) throw new Error("Note not found.");
        if (note.title !== args.title || note.content !== args.content) {
          await db.insert(schema.noteVersions).values({
            id: uid(),
            noteId: note.id,
            title: note.title,
            content: note.content,
          });
        }
        const now = new Date();
        await db
          .update(schema.notes)
          .set({
            title: args.title,
            content: args.content,
            category: args.category,
            tags: args.tags,
            pinned: args.pinned ? 1 : 0,
            updatedAt: now,
          })
          .where(and(eq(schema.notes.id, args.id), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))));
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: args.id, updatedAt: now.toISOString() };
      }
      const id = uid();
      const now = new Date();
      await db.insert(schema.notes).values({
        id,
        ownerId: user.id,
        mode: wsMode,
        title: args.title || "Untitled note",
        content: args.content,
        category: args.category,
        tags: args.tags,
        pinned: args.pinned ? 1 : 0,
        sourceModule: args.sourceModule ?? "",
        sourceId: args.sourceId ?? "",
      });
      await log(db, "Note created", args.title || "Untitled note", user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id, updatedAt: now.toISOString() };
    },
  }),

  deleteNote: defineAction({
    description: "Deletes a note and its version history, after snapshotting both so the delete can be undone with restoreDeletedItem.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const owned = await db
        .select()
        .from(schema.notes)
        .where(and(eq(schema.notes.id, args.id), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))))
        .limit(1);
      if (!owned[0]) throw new Error("Note not found.");
      const versions = await db.select().from(schema.noteVersions).where(eq(schema.noteVersions.noteId, args.id));
      const trashId = await pushTrash(db, user.id, wsMode, "note", owned[0].title, { row: owned[0], versions });
      await Promise.all([
        db.delete(schema.noteVersions).where(eq(schema.noteVersions.noteId, args.id)),
        db.delete(schema.notes).where(and(eq(schema.notes.id, args.id), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode)))),
      ]);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  listNoteVersions: defineAction({
    description: "Lists saved previous versions of a note, newest first.",
    request: z.object({ token: z.string().max(200).optional(), noteId: z.string() }),
    response: z.object({
      versions: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          content: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const noteRows = await db
        .select()
        .from(schema.notes)
        .where(and(eq(schema.notes.id, args.noteId), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))))
        .limit(1);
      if (!noteRows[0]) return { versions: [] };
      const rows = await db
        .select()
        .from(schema.noteVersions)
        .where(eq(schema.noteVersions.noteId, args.noteId))
        .orderBy(desc(schema.noteVersions.createdAt))
        .limit(50);
      return {
        versions: rows.map((v) => ({
          id: v.id,
          title: v.title,
          content: v.content,
          createdAt: v.createdAt.toISOString(),
        })),
      };
    },
  }),

  restoreNoteVersion: defineAction({
    description:
      "Restores a note to a previous version, keeping the current content as a new version first.",
    request: z.object({ token: z.string().max(200).optional(), noteId: z.string(), versionId: z.string() }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const noteRows = await db
        .select()
        .from(schema.notes)
        .where(and(eq(schema.notes.id, args.noteId), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))))
        .limit(1);
      const verRows = await db
        .select()
        .from(schema.noteVersions)
        .where(eq(schema.noteVersions.id, args.versionId))
        .limit(1);
      if (!noteRows[0] || !verRows[0] || verRows[0].noteId !== args.noteId) throw new Error("Note or version not found.");
      await db.insert(schema.noteVersions).values({
        id: uid(),
        noteId: noteRows[0].id,
        title: noteRows[0].title,
        content: noteRows[0].content,
      });
      await db
        .update(schema.notes)
        .set({
          title: verRows[0].title,
          content: verRows[0].content,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.notes.id, args.noteId), and(eq(schema.notes.ownerId, user.id), eq(schema.notes.mode, wsMode))));
      await log(db, "Note version restored", noteRows[0].title, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  saveScenario: defineAction({
    description: "Saves or renames a What-if Lab scenario with its simulation inputs.",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      name: z.string().min(1).max(120),
      params: z.string().max(4000),
    }),
    response: z.object({ id: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      if (args.id) {
        await db
          .update(schema.scenarios)
          .set({ name: args.name, params: args.params, updatedAt: new Date() })
          .where(and(eq(schema.scenarios.id, args.id), and(eq(schema.scenarios.ownerId, user.id), eq(schema.scenarios.mode, wsMode))));
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: args.id };
      }
      const id = uid();
      await db.insert(schema.scenarios).values({
        id,
        ownerId: user.id,
        mode: wsMode,
        name: args.name,
        params: args.params,
      });
      await log(db, "Scenario saved", args.name, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id };
    },
  }),

  deleteScenario: defineAction({
    description: "Deletes a saved What-if scenario, after snapshotting it so the delete can be undone with restoreDeletedItem.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db.select().from(schema.scenarios).where(and(eq(schema.scenarios.id, args.id), and(eq(schema.scenarios.ownerId, user.id), eq(schema.scenarios.mode, wsMode)))).limit(1);
      const trashId = rows[0] ? await pushTrash(db, user.id, wsMode, "scenario", rows[0].name, { row: rows[0] }) : null;
      await db.delete(schema.scenarios).where(and(eq(schema.scenarios.id, args.id), and(eq(schema.scenarios.ownerId, user.id), eq(schema.scenarios.mode, wsMode))));
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  saveRecurring: defineAction({
    description:
      "Creates or updates a scheduled recurring cashflow used by Future Lens forecasts.",
    request: z.object({
      token: z.string().max(200).optional(),
      id: z.string().optional(),
      type: z.enum(["income", "expense"]),
      category: z.string().min(1).max(60),
      description: z.string().max(200),
      amountCents: z.number().int().positive(),
      frequency: z.enum(["weekly", "monthly"]),
      nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      active: z.boolean(),
    }),
    response: z.object({ id: z.string() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const category = args.category.trim() || "General";
      if (args.id) {
        await db
          .update(schema.recurringCashflows)
          .set({
            type: args.type,
            category,
            description: args.description,
            amountCents: args.amountCents,
            frequency: args.frequency,
            nextDate: args.nextDate,
            active: args.active ? 1 : 0,
          })
          .where(and(eq(schema.recurringCashflows.id, args.id), and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, wsMode))));
        await rememberCustomCategory(db, user.id, wsMode, args.type, category);
        /* no query invalidation on Vercel — the client refetches after mutations */
        return { id: args.id };
      }
      const id = uid();
      await db.insert(schema.recurringCashflows).values({
        id,
        ownerId: user.id,
        mode: wsMode,
        type: args.type,
        category,
        description: args.description,
        amountCents: args.amountCents,
        frequency: args.frequency,
        nextDate: args.nextDate,
        active: args.active ? 1 : 0,
      });
      await rememberCustomCategory(db, user.id, wsMode, args.type, category);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { id };
    },
  }),

  deleteRecurring: defineAction({
    description: "Deletes a recurring cashflow schedule, after snapshotting it so the delete can be undone with restoreDeletedItem.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db.select().from(schema.recurringCashflows).where(and(eq(schema.recurringCashflows.id, args.id), and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, wsMode)))).limit(1);
      const trashId = rows[0] ? await pushTrash(db, user.id, wsMode, "recurring", rows[0].description || rows[0].category, { row: rows[0] }) : null;
      await db
        .delete(schema.recurringCashflows)
        .where(and(eq(schema.recurringCashflows.id, args.id), and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, wsMode))));
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  saveBudget: defineAction({
    description: "Sets a monthly spending budget for an expense category.",
    request: z.object({
      token: z.string().max(200).optional(),
      category: z.string().min(1).max(60),
      monthlyLimitCents: z.number().int().positive(),
    }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const category = args.category.trim() || "General";
      const rows = await db
        .select()
        .from(schema.budgets)
        .where(and(eq(schema.budgets.category, category), and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode))))
        .limit(1);
      if (rows[0]) {
        await db
          .update(schema.budgets)
          .set({ monthlyLimitCents: args.monthlyLimitCents })
          .where(and(eq(schema.budgets.id, rows[0].id), and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode))));
      } else {
        await db.insert(schema.budgets).values({
          id: uid(),
          ownerId: user.id,
          mode: wsMode,
          category,
          monthlyLimitCents: args.monthlyLimitCents,
        });
      }
      await rememberCustomCategory(db, user.id, wsMode, "expense", category);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  deleteBudget: defineAction({
    description: "Removes a category budget, after snapshotting it so the delete can be undone with restoreDeletedItem.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okTrashShape,
    async handler(ctx, args): Promise<z.infer<typeof okTrashShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db.select().from(schema.budgets).where(and(eq(schema.budgets.id, args.id), and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode)))).limit(1);
      const trashId = rows[0] ? await pushTrash(db, user.id, wsMode, "budget", rows[0].category, { row: rows[0] }) : null;
      await db.delete(schema.budgets).where(and(eq(schema.budgets.id, args.id), and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode))));
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const, trashId };
    },
  }),

  runScan: defineAction({
    description:
      "Runs the deterministic Profit Leak Scanner over stored transactions: possible duplicates, category spikes, repeated subscriptions, recurring costs and budget overspends.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      findings: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          severity: z.string(),
          title: z.string(),
          amountCents: z.number(),
          dates: z.array(z.string()),
          evidence: z.string(),
          explanation: z.string(),
          suggestion: z.string(),
        }),
      ),
      scannedCount: z.number(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const txns = await db.select().from(schema.transactions).where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode)));
      const budgets = await db.select().from(schema.budgets).where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode)));
      const findings: {
        id: string;
        kind: string;
        severity: string;
        title: string;
        amountCents: number;
        dates: string[];
        evidence: string;
        explanation: string;
        suggestion: string;
      }[] = [];
      const expenses = txns.filter(
        (t) => t.type === "expense" && t.status === "posted",
      );
      // Possible duplicates: same amount + similar description within 14 days.
      const dupGroups = new Map<string, TxnRow[]>();
      for (const t of expenses) {
        const key = `${t.amountCents}|${t.description.trim().toLowerCase()}`;
        const arr = dupGroups.get(key) ?? [];
        arr.push(t);
        dupGroups.set(key, arr);
      }
      for (const [, group] of dupGroups) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1]!;
          const b = sorted[i]!;
          const gap =
            (Date.parse(b.date) - Date.parse(a.date)) / 86400000;
          if (gap <= 14) {
            findings.push({
              id: uid(),
              kind: "duplicate",
              severity: "high",
              title: `Possible duplicate expense: ${b.description || b.category}`,
              amountCents: b.amountCents,
              dates: [a.date, b.date],
              evidence: `Two posted expenses of the same amount on ${a.date} and ${b.date} with the same description.`,
              explanation:
                "Matching amount and description within 14 days often means the same payment was recorded twice. This is a possible anomaly, not confirmed fraud.",
              suggestion:
                "Open both entries in Money Flow and delete one if they are the same payment.",
            });
            break;
          }
        }
      }
      // Repeated subscriptions / recurring costs: same description in 3+ months.
      const byDesc = new Map<string, TxnRow[]>();
      for (const t of expenses) {
        const key = t.description.trim().toLowerCase() || t.category.toLowerCase();
        const arr = byDesc.get(key) ?? [];
        arr.push(t);
        byDesc.set(key, arr);
      }
      for (const [, group] of byDesc) {
        const months = new Set(group.map((t) => monthKey(t.date)));
        if (months.size >= 3) {
          const total = group.reduce((s, t) => s + t.amountCents, 0);
          const sample = group[0]!;
          findings.push({
            id: uid(),
            kind: "recurring",
            severity: "medium",
            title: `Recurring cost detected: ${sample.description || sample.category}`,
            amountCents: total,
            dates: group.map((t) => t.date).sort().slice(0, 6),
            evidence: `${group.length} payments across ${months.size} different months in category ${sample.category}.`,
            explanation:
              "A cost that repeats every month behaves like a subscription. Reviewing these regularly is the fastest way to find services you no longer use.",
            suggestion:
              "Confirm you still need this service; if not, cancel it and record the saving as a scenario in What-if Lab.",
          });
        }
      }
      // Category spikes: this month vs average of previous 3 months.
      const cur = monthKey(todayStr());
      const catCur = new Map<string, number>();
      const catPrev = new Map<string, number[]>();
      for (const t of expenses) {
        const mk = monthKey(t.date);
        if (mk === cur) {
          catCur.set(t.category, (catCur.get(t.category) ?? 0) + t.amountCents);
        } else {
          const arr = catPrev.get(t.category) ?? [0, 0, 0];
          for (let i = 1; i <= 3; i++) {
            if (mk === shiftMonth(cur, -i)) arr[i - 1]! += t.amountCents;
          }
          catPrev.set(t.category, arr);
        }
      }
      for (const [cat, curAmt] of catCur) {
        const prev = catPrev.get(cat) ?? [0, 0, 0];
        const prevMonthsWithData = prev.filter((v) => v > 0).length;
        if (prevMonthsWithData === 0) continue;
        const avg = prev.reduce((s, v) => s + v, 0) / 3;
        if (avg > 0 && curAmt > avg * 1.4 && curAmt - avg > 100000) {
          findings.push({
            id: uid(),
            kind: "spike",
            severity: "medium",
            title: `Unusual increase in ${cat} spending`,
            amountCents: curAmt - Math.round(avg),
            dates: [todayStr()],
            evidence: `${cat} spending this month is already above the average of the previous three months by more than 40%.`,
            explanation:
              "A sharp category increase can be a one-off purchase, a price rise, or the start of a new recurring cost.",
            suggestion: `Review this month's ${cat} entries in Money Flow and set a budget for the category if the increase will continue.`,
          });
        }
      }
      // Budget overspend.
      for (const b of budgets) {
        const spent = catCur.get(b.category) ?? 0;
        if (spent > b.monthlyLimitCents) {
          findings.push({
            id: uid(),
            kind: "budget",
            severity: "high",
            title: `Budget exceeded: ${b.category}`,
            amountCents: spent - b.monthlyLimitCents,
            dates: [todayStr()],
            evidence: `Spending in ${b.category} this month has passed the monthly budget you set.`,
            explanation:
              "Overspending a category budget reduces the cash available for upcoming committed payments.",
            suggestion:
              "Pause discretionary spending in this category or raise the budget deliberately in the scanner settings.",
          });
        }
      }
      await log(db, "Profit scan run", `${findings.length} findings from ${txns.length} transactions`, user.id);
      return { findings, scannedCount: txns.length };
    },
  }),

  // ---------- Proactive Financial Insights (Genius Insights) ----------
  // The AI noticing problems WITHOUT being asked. All detection is
  // deterministic SQL + TypeScript rules (server/lib/insights.ts) —
  // zero LLM calls, zero extra cost. Generation runs lazily (see
  // getInsights, 6-hour staleness) and after ledger mutations (the
  // client fires generateInsights from the cg:mutated listener in
  // App.tsx). It upserts by insight_key, so a re-run never
  // duplicates a finding; findings whose condition cleared resolve.
  getInsights: defineAction({
    description:
      "Lists the active Genius Insights for the signed-in workspace, regenerating them first when the last run is older than 6 hours.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      insights: z.array(insightShape),
      generatedAt: z.string().nullable(),
      generatedFresh: z.boolean(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      try {
        const runs = await db
          .select()
          .from(schema.financialInsightRuns)
          .where(
            and(
              eq(schema.financialInsightRuns.ownerId, user.id),
              eq(schema.financialInsightRuns.mode, wsMode),
            ),
          )
          .limit(1);
        const lastRun = runs[0]?.generatedAt ?? null;
        const stale =
          !lastRun || Date.now() - lastRun.getTime() > 6 * 3600 * 1000;
        let generatedFresh = false;
        if (stale) {
          const res = await runInsightGeneration(db, user.id, wsMode);
          generatedFresh = !res.skipped;
        }
        const { insights, generatedAt } = await listActiveInsights(db, user.id, wsMode);
        return {
          insights,
          generatedAt,
          generatedFresh,
        };
      } catch (e) {
        // The code can ship before migration 0004 is applied: until
        // the financial_insights tables exist, report an honest empty
        // list (the dashboard shows its "nothing needs attention"
        // state) instead of breaking the whole dashboard. The missing
        // migration is logged server-side so it cannot hide.
        if (dbErrorCode(e) === "42P01") {
          console.error(
            "[cashflow-genius] getInsights: financial_insights tables missing — apply drizzle/0004_financial_insights.sql",
          );
          return { insights: [], generatedAt: null, generatedFresh: false };
        }
        throw e;
      }
    },
  }),

  generateInsights: defineAction({
    description:
      "Re-runs the deterministic insight rules for the signed-in workspace now (upserts findings, resolves stale ones). Returns the fresh findings with the run, so the panel can show them without waiting on a refetch.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      generated: z.number(),
      active: z.number(),
      skipped: z.boolean(),
      insights: z.array(insightShape),
      generatedAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const res = await runInsightGeneration(db, user.id, wsMode);
      const fresh = await listActiveInsights(db, user.id, wsMode);
      return { ...res, ...fresh };
    },
  }),

  dismissInsight: defineAction({
    description:
      "Dismisses one active insight in the signed-in workspace. Dismissed insights are never resurrected by a later generation run.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      await setInsightStatus(db, user.id, wsMode, args.id, "dismissed", null);
      return { ok: true as const };
    },
  }),

  markInsightExpected: defineAction({
    description:
      "Marks one active insight as expected in the signed-in workspace: it stays out of the active list and is never shown as a new finding, but its figures keep refreshing.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      await setInsightStatus(db, user.id, wsMode, args.id, "expected", null);
      return { ok: true as const };
    },
  }),

  snoozeInsight: defineAction({
    description:
      "Snoozes one active insight for 7 days in the signed-in workspace. It hides until the snooze expires, when the next generation reactivates it if the condition still holds.",
    request: z.object({ token: z.string().max(200).optional(), id: z.string() }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const until = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      await setInsightStatus(db, user.id, wsMode, args.id, "snoozed", until);
      return { ok: true as const };
    },
  }),

  getBriefing: defineAction({
    description:
      "Generates today's AI daily briefing from the calculated financial summary (never from invented figures).",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      headline: z.string(),
      points: z.array(z.string()),
      generatedAt: z.string(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      // Prelude + one batch statement (3 statements total with the
      // auth join, down from 7): getBriefing is the dashboard's
      // third parallel read, so every statement it saves is one less
      // connection held during a mode-switch burst.
      const { state, businesses: briefingBusinesses } =
        await loadWorkspacePrelude(db, user.id);
      const wsMode = state
        ? asMode(state.activeMode)
        : asMode(briefingBusinesses[0]?.mode ?? "business");
      let business = briefingBusinesses.find((b) => asMode(b.mode) === wsMode);
      if (!business) business = await ensureWorkspace(db, user.id, wsMode);
      const {
        transactions: txns,
        invoices: invs,
        savingsTransfers: briefingTransfers,
      } = await loadBriefingBatch(db, user.id, wsMode);
      const briefingSaved = briefingTransfers.reduce((s, t) => s + (t.direction === "deposit" ? t.amountCents : -t.amountCents), 0);
      const s = summarise(business, txns, briefingSaved);
      const overdue = invs.filter((i) => effectiveStatus(i) === "overdue");
      const fmt = (c: number) =>
        `${business.currency} ${(c / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
      const personal = business.mode === "personal" || business.mode === "student";
      const modeNote =
        business.mode === "personal"
          ? " — this is a Personal Money workspace, so speak about everyday money: income, daily spending and what is left over, not business profit"
          : business.mode === "student"
            ? " — this is a Student / First Salary workspace, so speak simply about a student's money: pocket money or first salary coming in, fees and daily spending, and small savings, not business profit"
            : business.mode === "creator"
              ? " — this is a Creator & Freelancer workspace, so speak about creator/freelance money: client payments, brand deals, platform payouts, project expenses and money set aside for tax"
              : "";
      const result = await aiComplete(
        `You are the AI CFO of "${business.name || (personal ? "a personal daily-spending workspace" : "a small business")}"${modeNote}. Write a short daily briefing using ONLY these calculated figures: available cash ${fmt(s.cashCents)} (this already excludes money set aside in savings pots), total saved in savings goals ${fmt(s.savingsCents)}, total ${personal ? "income" : "revenue"} ${fmt(s.revenueCents)}, total ${personal ? "spending" : "expenses"} ${fmt(s.expensesCents)}, net ${personal ? "left over" : "profit"} ${fmt(s.profitCents)}, this month ${personal ? "income" : "revenue"} ${fmt(s.curRevenueCents)} vs last month ${fmt(s.prevRevenueCents)}, this month ${personal ? "spending" : "expenses"} ${fmt(s.curExpensesCents)} vs last month ${fmt(s.prevExpensesCents)}, average monthly net over the last three months ${fmt(s.avgMonthlyNetCents)}, cash runway ${s.runwayMonths != null ? `${s.runwayMonths.toFixed(1)} months` : "not applicable (spending is not exceeding income on average)"}, overdue invoices: ${overdue.length}. Give a one-line headline and 3-4 short, concrete briefing points. Do not invent any numbers beyond these.`,
        {
          schema: z.object({
            headline: z.string(),
            points: z.array(z.string()).min(1).max(5),
          }),
        },
        aiExtrasFromRow(state, user.id),
      );
      return {
        headline: result.headline,
        points: result.points,
        generatedAt: new Date().toISOString(),
      };
    },
  }),

  askCfo: defineAction({
    description:
      "Asks the AI CFO a question, in English or Hinglish (language toggle). The answer is generated server-side from a deep calculated figure pack — cash, runway, overdue invoices with amounts and dates, biggest leaks (top categories, duplicate charges, budget overruns), savings pace per goal, and next-30-days dues — and saved to conversation history. The response also carries deterministic `sources`: the exact figures and dates the answer was grounded in, computed in code (never by the model), so the user can always see what the AI used.",
    request: z.object({
      token: z.string().max(200).optional(),
      conversationId: z.string().nullable(),
      question: z.string().min(2).max(1000),
      language: z.enum(["en", "hinglish"]).optional(),
    }),
    response: z.object({
      conversationId: z.string(),
      answer: z.object({
        directAnswer: z.string(),
        numbers: z.array(z.object({ label: z.string(), value: z.string() })),
        explanation: z.string(),
        supportingData: z.array(z.string()),
        options: z.array(z.string()),
        assumptions: z.string(),
        sources: z.array(z.string()),
        language: z.string(),
      }),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const business = await ensureWorkspace(db, user.id, wsMode);
      const language = args.language ?? "en";
      const txns = await db.select().from(schema.transactions).where(and(eq(schema.transactions.ownerId, user.id), eq(schema.transactions.mode, wsMode)));
      const invs = await db.select().from(schema.invoices).where(and(eq(schema.invoices.ownerId, user.id), eq(schema.invoices.mode, wsMode)));
      const items = await db.select().from(schema.invoiceItems);
      const cfoTransfers = await db.select().from(schema.savingsTransfers).where(and(eq(schema.savingsTransfers.ownerId, user.id), eq(schema.savingsTransfers.mode, wsMode)));
      const cfoSaved = cfoTransfers.reduce((s, t) => s + (t.direction === "deposit" ? t.amountCents : -t.amountCents), 0);
      const s = summarise(business, txns, cfoSaved);
      const fmt = (c: number) =>
        `${business.currency} ${(c / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
      const today = todayStr();
      const in30 = (() => {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 30);
        return d.toISOString().slice(0, 10);
      })();
      const invTotal = (i: (typeof invs)[number]) =>
        invoiceTotals(i, items.filter((it) => it.invoiceId === i.id)).total;
      const overdueRows = invs.filter((i) => effectiveStatus(i) === "overdue");
      const overdueList = overdueRows.map(
        (i) => `${i.number} (${i.customerName}) ${fmt(invTotal(i))} due ${i.dueDate}`,
      );
      const overdueTotal = overdueRows.reduce((sum, i) => sum + invTotal(i), 0);
      const sentRows = invs.filter((i) => i.status === "sent");
      const outstanding = sentRows.reduce((sum, i) => sum + invTotal(i), 0);
      const catTotals = new Map<string, number>();
      for (const t of txns) {
        if (t.type === "expense" && t.status === "posted") {
          catTotals.set(t.category, (catTotals.get(t.category) ?? 0) + t.amountCents);
        }
      }
      const catText = [...catTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([c, v]) => `${c}: ${fmt(v)}`)
        .join("; ");
      // ---- Biggest leaks: duplicate charges this month + budget overruns ----
      const curMonth = monthKey(today);
      const dupGroups = new Map<string, { count: number; cents: number; label: string }>();
      for (const t of txns) {
        if (t.type !== "expense" || t.status !== "posted" || monthKey(t.date) !== curMonth) continue;
        const key = `${t.category}|${t.counterparty}|${t.amountCents}`;
        const g = dupGroups.get(key) ?? {
          count: 0,
          cents: 0,
          label: `${t.description || t.category}${t.counterparty ? ` (${t.counterparty})` : ""} ${fmt(t.amountCents)}`,
        };
        g.count++;
        g.cents += t.amountCents;
        dupGroups.set(key, g);
      }
      const dupLines = [...dupGroups.values()]
        .filter((g) => g.count >= 2)
        .map((g) => `Possible duplicate: ${g.label} charged ${g.count} times this month (${fmt(g.cents)} total)`);
      const budgetRows = await db.select().from(schema.budgets).where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, wsMode)));
      const spentThisMonth = new Map<string, number>();
      for (const t of txns) {
        if (t.type === "expense" && t.status === "posted" && monthKey(t.date) === curMonth) {
          spentThisMonth.set(t.category, (spentThisMonth.get(t.category) ?? 0) + t.amountCents);
        }
      }
      const budgetLines = budgetRows.map((b) => {
        const spent = spentThisMonth.get(b.category) ?? 0;
        const pct = b.monthlyLimitCents > 0 ? Math.round((spent / b.monthlyLimitCents) * 100) : 0;
        return `${b.category}: spent ${fmt(spent)} of ${fmt(b.monthlyLimitCents)} budget this month (${pct}%)${spent > b.monthlyLimitCents ? " — OVER BUDGET" : ""}`;
      });
      // ---- Savings pace per goal ----
      const goalRows = await db.select().from(schema.savingsGoals).where(and(eq(schema.savingsGoals.ownerId, user.id), eq(schema.savingsGoals.mode, wsMode)));
      const goalLines = goalRows.map((g) => {
        const out = savingsGoalOut(g, cfoTransfers.filter((t) => t.goalId === g.id));
        return `${g.name}: saved ${fmt(out.savedCents)} of ${fmt(out.targetCents)} (${out.progressPct}%), status ${out.status}, target date ${g.targetDate}${out.requiredPerMonthCents > 0 ? `, needs about ${fmt(out.requiredPerMonthCents)}/month from here` : ""}`;
      });
      // ---- Next 30 days dues (recurring + invoices + EMI + pending) ----
      const recRows = await db.select().from(schema.recurringCashflows).where(and(eq(schema.recurringCashflows.ownerId, user.id), eq(schema.recurringCashflows.mode, wsMode)));
      const emiPlanRows = await db.select().from(schema.emiPlans).where(and(eq(schema.emiPlans.ownerId, user.id), eq(schema.emiPlans.mode, wsMode)));
      const emiInstRows = await db.select().from(schema.emiInstalments);
      const dues: { date: string; kind: "pay" | "collect"; label: string; cents: number }[] = [];
      for (const r of recRows) {
        if (!r.active) continue;
        let d = r.nextDate;
        let guard = 0;
        while (d <= in30 && guard < 40) {
          if (d >= today || d === r.nextDate) {
            dues.push({ date: d, kind: r.type === "income" ? "collect" : "pay", label: `Recurring: ${r.description || r.category}`, cents: r.amountCents });
          }
          if (r.frequency === "weekly") {
            const nd = new Date(`${d}T00:00:00Z`);
            nd.setUTCDate(nd.getUTCDate() + 7);
            d = nd.toISOString().slice(0, 10);
          } else {
            d = stepEmiDate(d, "monthly");
          }
          guard++;
        }
      }
      for (const i of sentRows) {
        if (i.dueDate <= in30) {
          dues.push({ date: i.dueDate, kind: "collect", label: `Invoice ${i.number} — ${i.customerName}${effectiveStatus(i) === "overdue" ? " (overdue)" : ""}`, cents: invTotal(i) });
        }
      }
      for (const p of emiPlanRows) {
        for (const inst of emiInstRows) {
          if (inst.planId !== p.id || inst.status === "paid" || inst.dueDate > in30) continue;
          dues.push({ date: inst.dueDate, kind: "collect", label: `EMI ${inst.seq} of ${p.instalmentCount} — ${p.customerName} (${p.product})`, cents: inst.amountCents });
        }
      }
      for (const t of txns) {
        if (t.status === "pending" && t.date <= in30) {
          dues.push({ date: t.date, kind: t.type === "income" ? "collect" : "pay", label: `Pending: ${t.description || t.category}`, cents: t.amountCents });
        }
      }
      dues.sort((a, b) => a.date.localeCompare(b.date));
      const duePayTotal = dues.filter((d) => d.kind === "pay").reduce((a, d) => a + d.cents, 0);
      const dueCollectTotal = dues.filter((d) => d.kind === "collect").reduce((a, d) => a + d.cents, 0);
      const duesLines = dues.slice(0, 10).map(
        (d) => `${d.date} · ${d.kind === "pay" ? "PAY" : "COLLECT"} ${fmt(d.cents)} · ${d.label}`,
      );
      const projected30 = s.cashCents + dueCollectTotal - duePayTotal;
      // ---- Deterministic sources: exactly what the answer is grounded in.
      // Built in code from the same rows, never by the model, so the UI can
      // show the user the precise figures and dates behind every answer.
      const sources: string[] = [
        `Available cash ${fmt(s.cashCents)} = opening ${fmt(business.openingBalanceCents)} + income ${fmt(s.revenueCents)} − expenses ${fmt(s.expensesCents)} − saved in pots ${fmt(s.savingsCents)} (posted records only, ${s.txnCount} transactions on record, as of ${today})`,
        `This month: income ${fmt(s.curRevenueCents)}, expenses ${fmt(s.curExpensesCents)} · Last month: income ${fmt(s.prevRevenueCents)}, expenses ${fmt(s.prevExpensesCents)} · Average monthly net (last 3 months): ${fmt(s.avgMonthlyNetCents)}`,
        s.runwayMonths != null
          ? `Cash runway ≈ ${s.runwayMonths.toFixed(1)} months at the recent average monthly burn`
          : `Cash runway: not burning cash on average, so no runway limit applies`,
        overdueRows.length > 0
          ? `Overdue invoices (${overdueRows.length}, total ${fmt(overdueTotal)}): ${overdueList.join("; ")}`
          : `Overdue invoices: none`,
        `Outstanding sent invoices total: ${fmt(outstanding)} across ${sentRows.length} invoice(s)`,
        catText ? `Biggest expense categories (all time): ${catText}` : `Expense categories: none recorded`,
        ...(dupLines.length > 0 ? dupLines : ["Possible duplicate charges this month: none detected"]),
        ...(budgetLines.length > 0 ? budgetLines : ["Category budgets: none set in this workspace"]),
        ...(goalLines.length > 0 ? goalLines : ["Savings goals: none in this workspace"]),
        `Next 30 days (to ${in30}): pay ${fmt(duePayTotal)}, collect ${fmt(dueCollectTotal)} across ${dues.length} dated item(s) — projected cash if all settle: ${fmt(projected30)}`,
        ...duesLines,
      ];
      const personalMode = business.mode === "personal" || business.mode === "student";
      const cfoFraming =
        business.mode === "personal"
          ? "This workspace is Personal Money: frame answers around everyday money — income, daily spending, budgets and what is left over — rather than business profit, while still using the exact figures below."
          : business.mode === "student"
            ? "This workspace is Student / First Salary: frame answers simply around a student's money — pocket money, part-time or first salary income, fees, daily spending and small savings — while still using the exact figures below."
            : business.mode === "creator"
              ? "This workspace is Creator & Freelancer: frame answers around creator/freelance money — client payments, brand deals, platform payouts, project expenses and tax set-aside — while still using the exact figures below."
              : "";
      const langInstruction =
        language === "hinglish"
          ? `LANGUAGE: The owner is using Hinglish mode. Write EVERY field of the answer in natural Hinglish — Hindi and English mixed in Roman script, the way people in India actually speak (for example: "Aapka cash abhi … hai, lekin next 30 days mein … dena hai, isliye …"). The owner may ask in Hindi, Hinglish or English — understand all three. Keep every number, amount and date EXACTLY as given in the figures below — never change, round differently, or translate a figure. Field labels stay as they are; only the prose is Hinglish.`
          : `LANGUAGE: Answer in clear, plain English. The owner may ask in Hindi or Hinglish — understand it, but reply in English. Keep every number, amount and date EXACTLY as given below.`;
      const rawAnswer = await aiComplete(
        `You are the AI CFO for "${business.name || (personalMode ? "a personal daily-spending workspace" : "a small business")}" (${business.industry || "industry not specified"}, ${business.country}, currency ${business.currency}). ${cfoFraming} ${langInstruction} Answer the owner's question using ONLY the calculated figures below. Never invent numbers. If the data cannot answer the question, say so in the direct answer and explain what record is missing.

CALCULATED FIGURES (computed in code from the ${personalMode ? "account's" : "business's"} own stored records in the ACTIVE workspace only, as of ${today}):
- Opening balance: ${fmt(business.openingBalanceCents)}
- Available cash: ${fmt(s.cashCents)} (already excludes savings pots — savings transfers are not income or expenses)
- Total saved in savings goals: ${fmt(s.savingsCents)}
- Total revenue (posted income): ${fmt(s.revenueCents)}
- Total expenses (posted): ${fmt(s.expensesCents)}
- Net profit: ${fmt(s.profitCents)}
- This month: revenue ${fmt(s.curRevenueCents)}, expenses ${fmt(s.curExpensesCents)}
- Last month: revenue ${fmt(s.prevRevenueCents)}, expenses ${fmt(s.prevExpensesCents)}
- Average monthly net (last 3 months): ${fmt(s.avgMonthlyNetCents)}
- Cash runway: ${s.runwayMonths != null ? `${s.runwayMonths.toFixed(1)} months at the recent average burn` : "not applicable — recent average monthly net is not negative"}
- Outstanding (sent, unpaid) invoices total: ${fmt(outstanding)}
- Overdue invoices: ${overdueList.length > 0 ? overdueList.join("; ") : "none"}
- Expense totals by category: ${catText || "no expenses recorded"}
- Possible leaks — duplicate charges this month: ${dupLines.length > 0 ? dupLines.join("; ") : "none detected"}
- Budgets this month: ${budgetLines.length > 0 ? budgetLines.join("; ") : "no budgets set"}
- Savings pace: ${goalLines.length > 0 ? goalLines.join("; ") : "no savings goals"}
- Next 30 days dues (to ${in30}): pay ${fmt(duePayTotal)}, collect ${fmt(dueCollectTotal)}; projected cash if everything settles: ${fmt(projected30)}
- Next 30 days items: ${duesLines.length > 0 ? duesLines.join("; ") : "nothing dated in the next 30 days"}
- Transactions on record: ${s.txnCount}

QUESTION: ${args.question}

Structure the reply as: a direct answer, the key numbers relied on (label + formatted value), a plain explanation, supporting data points quoted from the figures above, suggested options for the owner, and the assumptions and limitations of the answer.`,
        {
          schema: z.object({
            directAnswer: z.string(),
            numbers: z.array(z.object({ label: z.string(), value: z.string() })),
            explanation: z.string(),
            supportingData: z.array(z.string()),
            options: z.array(z.string()),
            assumptions: z.string(),
          }),
        },
        await getAiSettings(user.id),
      );
      const answer = { ...rawAnswer, sources, language };
      let convId = args.conversationId;
      if (convId) {
        const convRows = await db
          .select()
          .from(schema.aiConversations)
          .where(and(eq(schema.aiConversations.id, convId), and(eq(schema.aiConversations.ownerId, user.id), eq(schema.aiConversations.mode, wsMode))))
          .limit(1);
        if (!convRows[0]) convId = null;
      }
      if (!convId) {
        convId = uid();
        await db.insert(schema.aiConversations).values({
          id: convId,
          ownerId: user.id,
          mode: wsMode,
          title: args.question.slice(0, 60),
        });
      }
      // The two rows of one turn are inserted in a single statement,
      // so they would share one created_at (now() is constant inside
      // a statement) — and ordering by created_at could then tie and
      // return the answer before its question, which history pairing
      // used to drop. Give the answer an explicit timestamp one second
      // after the question so history order is deterministic.
      const askedAt = new Date();
      await db.insert(schema.aiMessages).values([
        {
          id: uid(),
          conversationId: convId,
          role: "user",
          content: args.question,
          createdAt: askedAt,
        },
        {
          id: uid(),
          conversationId: convId,
          role: "assistant",
          content: JSON.stringify(answer),
          createdAt: new Date(askedAt.getTime() + 1000),
        },
      ]);
      await log(db, "AI CFO question", args.question.slice(0, 60), user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { conversationId: convId, answer };
    },
  }),

  deleteConversation: defineAction({
    description:
      "Deletes one AI CFO conversation and all of its messages, in the signed-in account's active workspace. The client asks for confirmation first; there is no undo for a deleted conversation.",
    request: z.object({ token: z.string().max(200).optional(), conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const wsMode = await activeMode(db, user.id);
      const rows = await db
        .select()
        .from(schema.aiConversations)
        .where(
          and(
            eq(schema.aiConversations.id, args.conversationId),
            and(eq(schema.aiConversations.ownerId, user.id), eq(schema.aiConversations.mode, wsMode)),
          ),
        )
        .limit(1);
      if (!rows[0]) throw new Error("Conversation not found.");
      await db.delete(schema.aiMessages).where(eq(schema.aiMessages.conversationId, args.conversationId));
      await db
        .delete(schema.aiConversations)
        .where(
          and(
            eq(schema.aiConversations.id, args.conversationId),
            and(eq(schema.aiConversations.ownerId, user.id), eq(schema.aiConversations.mode, wsMode)),
          ),
        );
      await log(db, "AI CFO conversation deleted", rows[0].title, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  restoreDeletedItem: defineAction({
    description:
      "Undoes a delete: re-inserts the exact record(s) snapshotted into trash_items when something was deleted (same ids, same workspace, linked rows included — invoice items, EMI instalments, savings transfers, note versions). The snapshot is consumed on restore; records whose id already exists again are skipped, so restoring twice or after a re-create never duplicates or overwrites.",
    request: z.object({ token: z.string().max(200).optional(), trashId: z.string() }),
    response: z.object({ ok: z.boolean(), restored: z.number(), label: z.string(), error: z.string().nullable() }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);
      const rows = await db
        .select()
        .from(schema.trashItems)
        .where(and(eq(schema.trashItems.id, args.trashId), eq(schema.trashItems.ownerId, user.id)))
        .limit(1);
      const trash = rows[0];
      if (!trash) return { ok: false, restored: 0, label: "", error: "That undo is no longer available — the item may already have been restored." };
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(trash.payloadJson) as Record<string, unknown>;
      } catch {
        return { ok: false, restored: 0, label: trash.label, error: "That undo snapshot could not be read." };
      }
      // JSON round-trip turns Date fields into ISO strings; revive the
      // timestamp columns drizzle expects as Dates.
      const revive = (row: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...row };
        for (const k of ["createdAt", "updatedAt"]) {
          if (typeof out[k] === "string") out[k] = new Date(out[k] as string);
        }
        return out;
      };
      const asRows = (v: unknown): Record<string, unknown>[] =>
        Array.isArray(v) ? (v as Record<string, unknown>[]).map(revive) : [];
      const asRow = (v: unknown): Record<string, unknown> | null =>
        v && typeof v === "object" && !Array.isArray(v) ? revive(v as Record<string, unknown>) : null;
      let restored = 0;
      const insertIfAbsent = async (
        table: typeof schema.transactions,
        row: Record<string, unknown> | null,
      ): Promise<boolean> => {
        if (!row || typeof row.id !== "string") return false;
        const existing = await db.select({ id: table.id }).from(table).where(eq(table.id, row.id)).limit(1);
        if (existing[0]) return false;
        try {
          // Rows come from this app's own delete snapshots; the cast is
          // safe because every field was written by drizzle itself.
          await db.insert(table).values(row as never);
          return true;
        } catch {
          return false;
        }
      };
      const kind = trash.kind;
      if (kind === "transaction") {
        if (await insertIfAbsent(schema.transactions, asRow(payload.row))) restored++;
      } else if (kind === "transactions_bulk") {
        for (const r of asRows(payload.rows)) {
          if (await insertIfAbsent(schema.transactions, r)) restored++;
        }
        const batchRow = asRow(payload.batchRow);
        if (batchRow) await insertIfAbsent(schema.importBatches as never, batchRow);
      } else if (kind === "invoice") {
        if (await insertIfAbsent(schema.invoices as never, asRow(payload.row))) {
          restored++;
          for (const it of asRows(payload.items)) await insertIfAbsent(schema.invoiceItems as never, it);
        }
      } else if (kind === "budget") {
        const row = asRow(payload.row);
        if (row) {
          const clash = await db.select().from(schema.budgets).where(and(eq(schema.budgets.ownerId, user.id), eq(schema.budgets.mode, trash.mode), eq(schema.budgets.category, String(row.category ?? "")))).limit(1);
          if (!clash[0] && (await insertIfAbsent(schema.budgets as never, row))) restored++;
        }
      } else if (kind === "note") {
        if (await insertIfAbsent(schema.notes as never, asRow(payload.row))) {
          restored++;
          for (const v of asRows(payload.versions)) await insertIfAbsent(schema.noteVersions as never, v);
        }
      } else if (kind === "recurring") {
        if (await insertIfAbsent(schema.recurringCashflows as never, asRow(payload.row))) restored++;
      } else if (kind === "scenario") {
        if (await insertIfAbsent(schema.scenarios as never, asRow(payload.row))) restored++;
      } else if (kind === "custom_category") {
        if (await insertIfAbsent(schema.customCategories as never, asRow(payload.row))) restored++;
      } else if (kind === "emi_plan") {
        if (await insertIfAbsent(schema.emiPlans as never, asRow(payload.row))) {
          restored++;
          for (const inst of asRows(payload.instalments)) await insertIfAbsent(schema.emiInstalments as never, inst);
        }
      } else if (kind === "savings_goal") {
        if (await insertIfAbsent(schema.savingsGoals as never, asRow(payload.goal))) {
          restored++;
          for (const tr of asRows(payload.transfers)) await insertIfAbsent(schema.savingsTransfers as never, tr);
        }
      } else if (kind === "demo_bulk") {
        for (const inv of asRows(payload.invoices)) {
          if (await insertIfAbsent(schema.invoices as never, inv)) restored++;
        }
        for (const it of asRows(payload.invoiceItems)) await insertIfAbsent(schema.invoiceItems as never, it);
        for (const n of asRows(payload.notes)) {
          if (await insertIfAbsent(schema.notes as never, n)) restored++;
        }
        for (const v of asRows(payload.noteVersions)) await insertIfAbsent(schema.noteVersions as never, v);
        for (const pl of asRows(payload.emiPlans)) {
          if (await insertIfAbsent(schema.emiPlans as never, pl)) restored++;
        }
        for (const inst of asRows(payload.emiInstalments)) await insertIfAbsent(schema.emiInstalments as never, inst);
        for (const g of asRows(payload.savingsGoals)) {
          if (await insertIfAbsent(schema.savingsGoals as never, g)) restored++;
        }
        for (const tr of asRows(payload.savingsTransfers)) await insertIfAbsent(schema.savingsTransfers as never, tr);
        for (const t of asRows(payload.transactions)) {
          if (await insertIfAbsent(schema.transactions, t)) restored++;
        }
        for (const sc of asRows(payload.scenarios)) {
          if (await insertIfAbsent(schema.scenarios as never, sc)) restored++;
        }
        for (const r of asRows(payload.recurring)) {
          if (await insertIfAbsent(schema.recurringCashflows as never, r)) restored++;
        }
      } else {
        return { ok: false, restored: 0, label: trash.label, error: "That kind of delete can't be undone." };
      }
      await db.delete(schema.trashItems).where(eq(schema.trashItems.id, trash.id));
      await log(db, "Delete undone", trash.label, user.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, restored, label: trash.label, error: null };
    },
  }),

  purgeDemoAccount: defineAction({
    description:
      "Finishes the removal of the fictional demo account (demo@cashflow-genius.local): deletes that account, all of its sessions, and every record it owns across all four workspaces, exactly like a permanent account deletion. It can only ever touch that one hard-coded demo identifier, never a real account, and is a safe no-op once the demo account is gone. The same purge also runs automatically the moment any surviving demo session is presented to the server.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      removed: z.boolean(),
      identifier: z.string().nullable(),
    }),
    async handler(ctx) {
      /* db: module singleton (see ./lib/db) */
      const removed = await purgeDemoAccountRows(db);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { removed, identifier: removed ? DEMO_IDENTIFIER : null };
    },
  }),

  authStatus: defineAction({
    description:
      "Reports whether a verified user is signed in on this workspace, plus the Supabase Auth status flags: supabaseConfigured / supabaseGoogleEnabled report the most recent completed real probe of the connected Supabase project's Auth settings (cached 60s) and are refreshed in the background — this call never blocks the sign-in answer on a live probe (a slow Supabase once added up to 6s to every app load and sign-in). getSupabaseAuthStatus remains the always-live check.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      authenticated: z.boolean(),
      identifier: z.string().nullable(),
      channel: z.string().nullable(),
      verified: z.boolean(),
      supabaseConfigured: z.boolean(),
      supabaseGoogleEnabled: z.boolean(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const u = await currentUser(db, args.token);
      // The signed-in answer must come back immediately. probeSupabase
      // gets a 1.2s head start; if it hasn't answered by then, report
      // the last completed probe (or "not yet verified" before the
      // first one lands) while the probe finishes in the background
      // and populates the cache for the next call.
      const probe = await Promise.race([
        probeSupabase(),
        new Promise<SupabaseProbe>((resolve) =>
          setTimeout(
            () =>
              resolve(
                supabaseProbeCache ?? {
                  reachable: false,
                  googleEnabled: false,
                  emailEnabled: false,
                  checkedAtMs: 0,
                },
              ),
            1200,
          ),
        ),
      ]);
      return {
        authenticated: !!u && u.verified === 1,
        identifier: u ? u.identifier : null,
        channel: u ? u.channel : null,
        verified: u ? u.verified === 1 : false,
        supabaseConfigured: probe.reachable,
        supabaseGoogleEnabled: probe.googleEnabled,
      };
    },
  }),

  getSupabaseAuthStatus: defineAction({
    description:
      "Public live check of the connected Supabase project (no sign-in needed): asks Supabase Auth for its own settings and reports whether the project answered and whether its Google and Email providers are enabled. It ALSO runs a real database probe (connect + auth_users table present) — the signed-out “What's connected” strip only shows the workspace database as Live when this probe actually answers, because the Auth REST check alone cannot prove the database works (it uses the publishable key, not DATABASE_URL, so it stayed Live while every database query failed). Used by the signed-out screens' “What's connected” strip so Google sign-in and email verification are only ever shown as connected after this real check succeeds.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      configured: z.boolean(),
      reachable: z.boolean(),
      googleEnabled: z.boolean(),
      emailEnabled: z.boolean(),
      checkedAt: z.string(),
      databaseLive: z.boolean(),
      databaseTablesReady: z.boolean(),
      databaseErrorCode: z.string().nullable(),
      aiConfigured: z.boolean(),
    }),
    async handler() {
      // The two live probes used to run one after the other, so a
      // cold cache made the sign-in screen wait for both round-trips
      // in series — live, the action took 3s+ and the DB probe still
      // timed out at 5s (2026-11-17). They are independent, so run
      // them in parallel. The DB probe keeps its 5s bound so a dead
      // database can't hang the sign-in screen: the probe returns
      // only booleans + a Postgres error code (e.g. 28P01 for a
      // wrong database password) — never SQL or credentials. The
      // probe promise is also given a logging tail: if the 5s race
      // below fires first, the probe's eventual outcome is still
      // written to the server log, so a slow-but-real failure
      // (wrong password, unreachable host) never vanishes silently
      // behind a bare TIMEOUT.
      const probePromise = checkDatabase();
      void probePromise.then((r) => {
        if (!r.reachable)
          console.error(
            `[cashflow-genius] getSupabaseAuthStatus database probe failed: code=${r.code ?? "unknown"}`,
          );
      });
      const [probe, dbProbe] = await Promise.all([
        probeSupabase(),
        Promise.race([
          probePromise,
          new Promise<{ reachable: false; tablesReady: false; code: string }>(
            (resolve) =>
              setTimeout(() => {
                console.error(
                  "[cashflow-genius] getSupabaseAuthStatus database probe timed out after 5s (returning TIMEOUT; the probe's own result is still logged when it lands)",
                );
                resolve({
                  reachable: false,
                  tablesReady: false,
                  code: "TIMEOUT",
                });
              }, 5000),
          ),
        ]),
      ]);
      return {
        configured: true,
        reachable: probe.reachable,
        googleEnabled: probe.googleEnabled,
        emailEnabled: probe.emailEnabled,
        checkedAt: new Date(probe.checkedAtMs).toISOString(),
        databaseLive: dbProbe.reachable,
        databaseTablesReady: dbProbe.tablesReady,
        databaseErrorCode: dbProbe.code,
        aiConfigured: !!process.env.GEMINI_API_KEY,
      };
    },
  }),

  googleSignIn: defineAction({
    description:
      "Completes a real Google sign-in. The browser ran Supabase Auth's Google OAuth flow and returns the Supabase access token; this action verifies that token directly with Supabase (/auth/v1/user) and only then finds-or-creates the local account for that verified Google email — a brand-new Google user gets their own account with a completely empty workspace, exactly like a fresh sign-up, and no account is ever shared. Returns this app's own session token.",
    request: z.object({
      supabaseAccessToken: z.string().min(10).max(4096),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      token: z.string().nullable(),
      identifier: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const identity = await supabaseUserForToken(args.supabaseAccessToken);
      if (!identity)
        return {
          ok: false,
          error:
            "Supabase did not verify that Google sign-in token, so no account was opened. Please try “Continue with Google” again.",
          token: null,
          identifier: null,
        };
      const identifier = identity.email;
      const rows = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, identifier))
        .limit(1);
      let userId: string;
      if (rows[0]) {
        userId = rows[0].id;
        // Google has just proved ownership of this email address, so
        // an unverified local account with the same email is verified
        // by it; a verified account simply signs in.
        if (rows[0].verified !== 1) {
          await db
            .update(schema.authUsers)
            .set({ verified: 1, updatedAt: new Date() })
            .where(eq(schema.authUsers.id, userId));
        }
      } else {
        userId = uid();
        // The password is a random value that is never shown anywhere:
        // this account signs in with Google, not with a password. (If
        // the person later wants password sign-in too, the account is
        // the same one — same email, same workspace.)
        const { salt, hash } = await hashPassword(randomHex(32));
        await db.insert(schema.authUsers).values({
          id: userId,
          identifier,
          channel: "email",
          passwordHash: hash,
          passwordSalt: salt,
          verified: 1,
        });
      }
      const token = await startSession(db, userId);
      await log(db, "Signed in with Google", identifier, userId);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, error: null, token, identifier };
    },
  }),

  confirmEmailLink: defineAction({
    description:
      "Completes an EMAIL sign-up confirmation that arrived as a link, not a code. Supabase's signup email contains a confirmation link; opening it redirects back here with an auth code, which the client exchanges for a Supabase access token. This action verifies that token directly with Supabase (/auth/v1/user) and only then marks the matching local email account verified and signs it in — it never creates an account (the local account is created by the app's own email sign-up first) and it never calls the sign-in Google, so the activity log honestly records an email sign-in. This is the fix for the 2026-11-14 live test, where the confirmation-link return was routed through the Google callback handler and Settings → Recent activity wrongly showed “Signed in with Google” for a sign-in that was email + password.",
    request: z.object({
      supabaseAccessToken: z.string().min(10).max(4096),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      token: z.string().nullable(),
      identifier: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const identity = await supabaseUserForToken(args.supabaseAccessToken);
      if (!identity)
        return {
          ok: false,
          error:
            "Supabase did not verify that email confirmation, so no account was opened. Please tap the confirmation link in your email again, or log in with your email + password.",
          token: null,
          identifier: null,
        };
      const identifier = identity.email;
      const rows = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, identifier))
        .limit(1);
      if (!rows[0])
        return {
          ok: false,
          error:
            "No Cashflow Genius account is waiting for verification under that email address. Please sign up in the app first, then tap the confirmation link.",
          token: null,
          identifier: null,
        };
      const userId = rows[0].id;
      // The email link proves ownership of this address, so an
      // unverified local account with the same email is verified by
      // it; a verified account simply signs in.
      if (rows[0].verified !== 1) {
        await db
          .update(schema.authUsers)
          .set({ verified: 1, updatedAt: new Date() })
          .where(eq(schema.authUsers.id, userId));
      }
      const token = await startSession(db, userId);
      await log(db, "Signed in with email", identifier, userId);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, error: null, token, identifier };
    },
  }),

  getIntegrationStatus: defineAction({
    description:
      "Reports the live connection status of each integration, verified server-side at call time: the workspace database is probed with a real read of the signed-in account's business row, and Supabase / Google sign-in are probed against the connected Supabase project's real Auth settings — Google sign-in shows Live only when Supabase itself reports the Google provider enabled. The AI engine (ChatGPT / OpenAI, one shared server key for every account) shows Live only when a real OpenAI call has actually succeeded for that account — recorded on the account row by the call itself. Bank/UPI sync has no connection wired, so it is honestly reported as not connected.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: z.object({
      checkedAt: z.string(),
      services: z.array(
        z.object({
          id: z.enum(["database", "ai", "supabase", "gemini", "openrouter", "openai", "bank_upi_sync", "google_signin"]),
          name: z.string(),
          status: z.enum(["live", "not_connected"]),
          detail: z.string(),
          needed: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const user = await requireUser(db, args.token);

      // Real probe 1: the workspace database must answer a read scoped to
      // this account before we call it live.
      let dbLive = false;
      let dbDetail = "The workspace database did not answer a test read.";
      try {
        const rows = await db
          .select({ id: schema.businesses.id })
          .from(schema.businesses)
          .where(eq(schema.businesses.ownerId, user.id))
          .limit(1);
        dbLive = true;
        dbDetail = rows[0]
          ? "Your records are stored in Supabase Postgres, scoped to your account only — and it just answered a live read."
          : "Supabase Postgres answered a live read; your workspace row is created when you finish setup.";
      } catch {
        dbLive = false;
      }

      // Real probe 2: the AI engine is Live only when a real AI call
      // with the SELECTED provider has succeeded — aiComplete records
      // that on the account row (ai_verified_at / ai_verified_provider).
      // A saved key alone is never Live: the user's Gemini key, for
      // example, is saved but every call fails with HTTP 403 "free
      // tier is not available for this project", so Gemini stays Not
      // connected. One state-row read gives provider, keys, model and
      // the verified flag together.
      const aiRow = await workspaceStateRow(db, user.id);
      // One engine for everyone: ChatGPT (OpenAI) with the server
      // key. The stored ai_provider is ignored — there is no
      // per-account provider choice any more.
      const aiProvider = "openai" as const;
      const aiEngineName = "OpenAI (ChatGPT)";
      const aiVerifiedAt = aiRow?.aiVerifiedAt ?? null;
      const aiVerified =
        aiRow?.aiVerifiedProvider === aiProvider && aiVerifiedAt != null;
      const aiVerifiedWhen = aiVerifiedAt
        ? aiVerifiedAt.toLocaleString("en-IN", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const openAiModel = aiRow?.openAiModel || DEFAULT_OPENAI_MODEL;
      const geminiVerified =
        aiRow?.aiVerifiedProvider === "gemini" && aiVerifiedAt != null;
      const orVerified =
        aiRow?.aiVerifiedProvider === "openrouter" && aiVerifiedAt != null;
      const openaiVerified =
        aiRow?.aiVerifiedProvider === "openai" && aiVerifiedAt != null;

      // Real probe 3: Supabase Auth settings for the connected
      // project — Google sign-in is Live only when Supabase itself
      // reports the Google provider enabled (checked just now).
      const sbProbe = await probeSupabase();

      return {
        checkedAt: new Date().toISOString(),
        services: [
          {
            id: "database" as const,
            name: "Workspace database",
            status: dbLive ? ("live" as const) : ("not_connected" as const),
            detail: dbDetail,
            needed: "",
          },
          {
            id: "ai" as const,
            name: "AI CFO engine",
            status: aiVerified ? ("live" as const) : ("not_connected" as const),
            detail: aiVerified
              ? `Live — verified by a real ${aiEngineName} call on ${aiVerifiedWhen}: the AI CFO and daily briefing are generated by ${aiEngineName} (${openAiModel}), fed only with figures calculated from your own records.`
              : "Not connected yet — no OpenAI call has been verified for this account yet, so the AI CFO answers with the built-in rule-based fallback for now. ChatGPT answers for everyone — no key needed. Ask the AI CFO a question once; it turns Live after a real call succeeds.",
            needed: "",
          },
          {
            id: "supabase" as const,
            name: "Supabase",
            status: sbProbe.reachable ? ("live" as const) : ("not_connected" as const),
            detail: sbProbe.reachable
              ? "Connected — the Cashflow Genius Supabase project answered a live Auth settings check just now. Supabase powers Google sign-in and email verification (sign-up confirmation links are emailed by Supabase's free built-in sender, which allows only a few auth emails per hour); your records live in Supabase Postgres, scoped to your account."
              : "The connected Supabase project did not answer a live Auth check just now, so it is honestly not shown as connected. Your records and existing sessions are unaffected.",
            needed: sbProbe.reachable
              ? ""
              : "Nothing to configure — the project is connected; this check will show Live again the moment Supabase answers. Use Re-check above to try again.",
          },
          {
            id: "bank_upi_sync" as const,
            name: "Bank / UPI auto-sync",
            status: "not_connected" as const,
            detail:
              "Not connected — and shown as such, never silently failing. There is no UPI API for apps like this, and Cashflow Genius does not read your SMS. Your working path is fast manual entry (Quick Add, with UPI as a payment method) plus CSV import in Money Flow: imports report exactly what was imported, skipped as duplicates, or invalid — and exact duplicates are always skipped, so re-importing a statement, refunds included, never double-counts. Your last CSV import (if any) is listed under Recent activity in Settings, and every import can be undone there or in Money Flow.",
            needed:
              "Nothing to connect today. If a bank feed is ever added, it will appear here with its real status and last-successful-sync time before it touches your ledger.",
          },
          {
            id: "google_signin" as const,
            name: "Google sign-in",
            status: sbProbe.googleEnabled ? ("live" as const) : ("not_connected" as const),
            detail: sbProbe.googleEnabled
              ? "Connected — verified just now: Supabase Auth reports the Google provider enabled for this project, and the “Continue with Google” button on the home, login and sign-up screens starts the real Google flow. Each person signs in with their own Google account and lands in their own workspace (brand-new Google users start empty) — never a shared account."
              : "Not shown as connected right now: the live Supabase check just now did not confirm the Google provider as enabled (or Supabase did not answer), so this stays honestly Not connected until a check succeeds. Email + password sign-in is unaffected.",
            needed: sbProbe.googleEnabled
              ? ""
              : "If Google was just enabled in Supabase (Authentication → Providers → Google), press Re-check above. If it stays off, the provider needs enabling in the Supabase dashboard with the Google OAuth client's ID and secret.",
          },
          {
            id: "gemini" as const,
            name: "Google Gemini",
            status: geminiVerified ? ("live" as const) : ("not_connected" as const),
            detail: geminiVerified
              ? `Live — a real Gemini call succeeded on ${aiVerifiedWhen}, so the AI CFO answers with Gemini.`
              : "Not in use — the AI CFO runs on ChatGPT (OpenAI) for everyone, so Gemini is not connected and no Gemini key is needed.",
            needed: "",
          },
          {
            id: "openrouter" as const,
            name: "OpenRouter",
            status: orVerified ? ("live" as const) : ("not_connected" as const),
            detail: orVerified
              ? `Live — a real OpenRouter call succeeded on ${aiVerifiedWhen}, so the AI CFO answers with OpenRouter.`
              : "Not in use — the AI CFO runs on ChatGPT (OpenAI) for everyone, so OpenRouter is not connected and no OpenRouter key is needed.",
            needed: "",
          },
          {
            id: "openai" as const,
            name: "OpenAI (ChatGPT)",
            status: openaiVerified ? ("live" as const) : ("not_connected" as const),
            detail: openaiVerified
              ? `Live — a real OpenAI call with model ${openAiModel} succeeded on ${aiVerifiedWhen}, so the AI CFO answers with ChatGPT.`
              : "Not connected yet — no OpenAI call has been verified for this account yet. Ask the AI CFO a question once; it turns Live after a real call succeeds. ChatGPT answers for everyone — no key needed.",
            needed: "",
          },
        ],
      };
    },
  }),

  register: defineAction({
    description:
      "Creates a new EMAIL + password account and starts real email verification: Supabase Auth's email provider is asked to sign the address up, and Supabase emails a confirmation LINK to the user's own inbox through its built-in free sender — opening the link signs the account in (confirmEmailLink). A 6-digit code is only a fallback for emails that also carry one (verifyAccount). The code/link is never generated or shown by this app. The local account row stays unverified until the link is opened or the code is confirmed with Supabase. Phone/mobile sign-up no longer exists (no free SMS OTP exists), and Supabase's free sender allows only a few auth emails per hour, so a rate-limited sign-up says so honestly instead of pretending an email went out.",
    request: z.object({
      email: z.string().min(3).max(160),
      password: z.string().min(8).max(200),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const identifier = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier))
        return { ok: false, error: "Please enter a valid email address." };
      if (identifier === DEMO_IDENTIFIER)
        return {
          ok: false,
          error:
            "That address belonged to the removed demo account and can't be registered. Please use your own email address, or Continue with Google.",
        };
      const existing = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, identifier))
        .limit(1);
      if (existing[0] && existing[0].verified === 1)
        return {
          ok: false,
          error:
            "An account with this email address already exists. Please log in instead — or use “Continue with Google” if that's how you signed up.",
        };
      // Real step: Supabase Auth sign-up. Supabase creates the
      // unconfirmed Auth user and emails the confirmation link itself.
      const sb = await supabaseEmailSignup(identifier, args.password);
      if (!sb.ok) return { ok: false, error: sb.error };
      if (sb.alreadyRegistered && !existing[0]) {
        // Supabase already holds this email but this workspace has no
        // account for it (e.g. the address once started a sign-up
        // that was never finished here). Don't silently take it over:
        // the owner can finish via Google (same email) or log in once
        // verified — a fresh local row is only created by THIS app's
        // own sign-up below, never for an address Supabase says is
        // already registered and we know nothing about.
        return {
          ok: false,
          error:
            "This email address is already registered with Supabase sign-in but has no Cashflow Genius account here. If it's yours, use “Continue with Google” with the same address — that opens your own workspace here.",
        };
      }
      const { salt, hash } = await hashPassword(args.password);
      if (existing[0]) {
        // Unverified local account re-registering (it may predate
        // email verification or never finished it): refresh its
        // password. Supabase was asked first (above), so the link that
        // arrives in the inbox belongs to THIS sign-up attempt.
        await db
          .update(schema.authUsers)
          .set({ passwordHash: hash, passwordSalt: salt, updatedAt: new Date() })
          .where(eq(schema.authUsers.id, existing[0].id));
        if (sb.alreadyRegistered) {
          // Supabase held the address as an unconfirmed sign-up, so
          // /signup sent no fresh email — ask for a resend so a new
          // code actually goes out.
          const rs = await supabaseResendSignupEmail(identifier);
          if (!rs.ok) return { ok: false, error: rs.error };
        }
      } else {
        await db.insert(schema.authUsers).values({
          id: uid(),
          identifier,
          channel: "email",
          passwordHash: hash,
          passwordSalt: salt,
          verified: 0,
        });
        if (sb.alreadyRegistered) {
          const rs = await supabaseResendSignupEmail(identifier);
          if (!rs.ok) return { ok: false, error: rs.error };
        }
      }
      return { ok: true, error: null };
    },
  }),

  verifyAccount: defineAction({
    description:
      "Verifies a new email account with the 6-digit code from the user's own inbox (fallback path — the email Supabase actually sends carries a confirmation link, handled by confirmEmailLink): the code is checked by Supabase Auth (POST /auth/v1/otp), and only when Supabase confirms it is the local account marked verified and signed in. Every account starts with its own empty workspace; pre-authentication records stay quarantined under their unowned marker and are never served to any account.",
    request: z.object({
      email: z.string().min(3).max(160),
      code: z.string().min(4).max(10),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      token: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const identifier = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier))
        return {
          ok: false,
          error: "Enter the email address you signed up with.",
          token: null,
        };
      const code = args.code.replace(/\D/g, "");
      if (!/^\d{6}$/.test(code))
        return {
          ok: false,
          error: "Enter the 6-digit code from your email.",
          token: null,
        };
      const rows = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, identifier))
        .limit(1);
      const u = rows[0];
      if (!u)
        return {
          ok: false,
          error:
            "No Cashflow Genius account is waiting for verification under that email address. Please sign up first.",
          token: null,
        };
      if (u.verified === 1)
        return {
          ok: false,
          error: "This account is already verified — please log in.",
          token: null,
        };
      // The real check: Supabase issued the code and Supabase judges it.
      const sb = await supabaseVerifySignupOtp(identifier, code);
      if (!sb.ok) return { ok: false, error: sb.error, token: null };
      await db
        .update(schema.authUsers)
        .set({ verified: 1, updatedAt: new Date() })
        .where(eq(schema.authUsers.id, u.id));
      const token = await startSession(db, u.id);
      await log(db, "Signed in with email", identifier, u.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true, error: null, token };
    },
  }),

  resendEmailOtp: defineAction({
    description:
      "Asks Supabase Auth to email a fresh sign-up confirmation link to the given address (used by the verification screen's “Send a new link”). Only meaningful for an unverified account created through this app's email sign-up; Supabase's free sender allows only a few auth emails per hour, so a rate-limited resend says so honestly.",
    request: z.object({
      email: z.string().min(3).max(160),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    async handler(_ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const identifier = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier))
        return { ok: false, error: "Enter the email address you signed up with." };
      const rows = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, identifier))
        .limit(1);
      const u = rows[0];
      if (!u)
        return {
          ok: false,
          error:
            "No Cashflow Genius account is waiting for verification under that email address. Please sign up first.",
        };
      if (u.verified === 1)
        return {
          ok: false,
          error: "This account is already verified — please log in.",
        };
      const rs = await supabaseResendSignupEmail(identifier);
      if (!rs.ok) return { ok: false, error: rs.error };
      return { ok: true, error: null };
    },
  }),

  login: defineAction({
    description:
      "Signs in with a registered email address and password. An unverified email account is sent to the verification screen and Supabase is asked to email a fresh confirmation link (never shown in the app). Mobile-number sign-in was removed for new accounts; an already-verified account created earlier with a mobile number can still sign in with that number + password, while an unverified one honestly explains it can no longer be verified (no SMS OTP exists) and to sign up with an email address instead. Wrong credentials get a clear error and no session.",
    request: z.object({
      identifier: z.string().min(3).max(160),
      password: z.string().min(1).max(200),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      needsVerification: z.boolean(),
      token: z.string().nullable(),
    }),
    async handler(ctx, args) {
      /* db: module singleton (see ./lib/db) */
      const found = identifierOf(args.identifier);
      if (!found)
        return {
          ok: false,
          error:
            "Enter your registered email address (mobile-number sign-up is no longer offered — see the note on the sign-up screen).",
          needsVerification: false,
          token: null,
        };
      if (found.identifier === DEMO_IDENTIFIER) {
        // The fictional demo account was removed entirely; make sure no
        // device stays (or gets) signed into it, and finish the removal.
        await purgeDemoAccountRows(db);
        return {
          ok: false,
          error:
            "The demo account has been removed from Cashflow Genius. Please sign in with Google, or with your own email account.",
          needsVerification: false,
          token: null,
        };
      }
      const rows = await db
        .select()
        .from(schema.authUsers)
        .where(eq(schema.authUsers.identifier, found.identifier))
        .limit(1);
      const u = rows[0];
      if (!u || !(await checkPassword(args.password, u.passwordSalt, u.passwordHash)))
        return {
          ok: false,
          error:
            "Incorrect details — no account matched that sign-in and password. Check them and try again.",
          needsVerification: false,
          token: null,
        };
      if (u.verified !== 1) {
        if (found.channel === "phone") {
          // No SMS OTP exists (it is never free) and codes are no
          // longer shown on screen, so this account can no longer be
          // verified. It never reached a workspace, so nothing is
          // lost — say so plainly and point at the working paths.
          return {
            ok: false,
            error:
              "This mobile-number account was never verified, and mobile verification is no longer available — there is no free SMS OTP, and codes are no longer shown in the app. Nothing was ever saved under this number (verification comes before the workspace), so please sign up fresh with your email address, or Continue with Google.",
            needsVerification: false,
            token: null,
          };
        }
        // Ask Supabase to email a fresh confirmation link for the
        // pending sign-up, then send the user to the verification
        // screen. The link exists only in their inbox — it is never
        // returned here.
        const rs = await supabaseResendSignupEmail(found.identifier);
        if (!rs.ok) {
          return {
            ok: false,
            error: `This account hasn't been verified yet, and a fresh code couldn't be emailed just now: ${rs.error}`,
            needsVerification: true,
            token: null,
          };
        }
        return {
          ok: false,
          error:
            "This account hasn't been verified yet. A fresh confirmation link has been emailed to you — tap it to finish setting up your account.",
          needsVerification: true,
          token: null,
        };
      }
      const token = await startSession(db, u.id);
      await log(db, "Signed in with email", found.identifier, u.id);
      /* no query invalidation on Vercel — the client refetches after mutations */
      return {
        ok: true,
        error: null,
        needsVerification: false,
        token,
      };
    },
  }),

  logout: defineAction({
    description: "Signs the current user out by ending their session.",
    request: z.object({ token: z.string().max(200).optional() }),
    response: okShape,
    async handler(ctx, args): Promise<z.infer<typeof okShape>> {
      /* db: module singleton (see ./lib/db) */
      if (args.token) {
        await db
          .delete(schema.authSessions)
          .where(eq(schema.authSessions.token, args.token));
      }
      /* no query invalidation on Vercel — the client refetches after mutations */
      return { ok: true as const };
    },
  }),

  requestPasswordReset: defineAction({
    description:
      "Reports whether password reset can be delivered for an account. Reset codes/links are never returned to an unauthenticated requester (that would let anyone who knows an email address take over the account). Sign-up verification email is live via Supabase, but an in-app password-reset completion flow for workspace password accounts is not wired yet, so this honestly reports delivery as unavailable instead of pretending a reset was sent; Google accounts need no password reset here (Google verifies the owner).",
    request: z.object({ identifier: z.string().min(3).max(160) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      deliveryConfigured: z.boolean(),
    }),
    async handler(_ctx, args) {
      const found = identifierOf(args.identifier);
      if (!found)
        return {
          ok: false,
          error: "Enter your registered email address.",
          deliveryConfigured: false,
        };
      return { ok: true, error: null, deliveryConfigured: false };
    },
  }),

} satisfies ActionsModule;
