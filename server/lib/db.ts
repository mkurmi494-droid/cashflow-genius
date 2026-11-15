// Supabase Postgres connection (Drizzle, postgres-js driver).
// DATABASE_URL must be the Supabase Postgres connection string —
// either the Session Pooler URL (Project Settings → Database →
// Connection string, Session pooler port 5432, with
// ?sslmode=require) or the Direct connection URL
// (db.<project-ref>.supabase.co:5432, no sslmode param): both work
// here, because SSL is required for any non-localhost host (see
// needsSsl below), prepared statements are disabled, and the pool is
// capped at a few connections per serverless instance (see max below). (The Transaction pooler is port 6543; it
// works too. The earlier docs wrongly called 6543 the session
// pooler port; 5432 is the session pooler.)
// Never put the Supabase service-role key here; this connection uses
// the postgres password only, and every query is still scoped by
// owner_id in the actions.
import { appendFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";

const url = process.env.DATABASE_URL;
if (!url) {
  // Throwing at import time would break `next build` (which collects the
  // API routes); instead the client is created lazily and the error
  // surfaces on the first real query with a clear message.
  console.warn(
    "[cashflow-genius] DATABASE_URL is not set — API calls will fail until the Supabase Postgres connection string is configured in Vercel env vars.",
  );
}

// SSL is required for Supabase (hosted) but must be off for plain local
// Postgres. The Supabase pooler URL carries ?sslmode=require; honour
// that, and require SSL for any non-localhost host.
const needsSsl = url
  ? url.includes("sslmode=require") ||
    (!url.includes("localhost") && !url.includes("127.0.0.1"))
  : false;
const client = url
  ? postgres(url, {
      // Supabase's pooler (aws-1-ap-southeast-2.pooler.supabase.com)
      // presents a certificate chain Node does not trust, so strict
      // verification (ssl: true) fails the TLS handshake with
      // SELF_SIGNED_CERT_IN_CHAIN and every query times out — the
      // live site proved this in Vercel Runtime Logs (deployment
      // A62JvjKW1). Pass an SSL object that does not reject the
      // chain for hosted (non-localhost) hosts instead; the
      // connection is still encrypted, and the password is never
      // sent in cleartext. Localhost keeps ssl off entirely.
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
      // max: 1 stays. REVERTED 2026-11-15: max: 5 caused Supabase
      // session-pooler exhaustion live (EMAXCONNSESSION "max clients
      // reached in session mode", Vercel logs 06:15–06:17 UTC 15 Nov
      // 2026) — a Business→Personal switch failed with "Your
      // workspace could not be loaded" for ~6 minutes until the pool
      // drained, while max: 1 never did that. Five per serverless
      // instance times several concurrent Vercel instances exceeds
      // what the free session pooler allows. BUT the revert alone did
      // NOT fix it: 12 more EMAXCONNSESSION errors hit the revert
      // deployment (06:24–06:27 UTC, /api/getState,
      // /api/getCombinedSummary, /api/getBriefing) — max:1 per
      // instance is not enough when the client fires three ledger
      // reads in parallel and Vercel runs each in its own invocation,
      // each holding its own connection, against a 15-client pool.
      // The real fix (2026-11-15, same day) is threefold and lives
      // outside this option: (1) FEWER round-trips — getState is 3
      // statements, getCombinedSummary 2, getBriefing 3 (single-
      // statement JSON batch loads, server/lib/batch.ts); (2) the
      // client serialises the three ledger reads (client/api.ts) and
      // the API route retries read-only actions on pool exhaustion
      // with backoff (app/api/[action]/route.ts); (3) idle connections
      // drain in 5s instead of 20s (idle_timeout below). Do NOT raise
      // max again. The durable fix for the 15-client ceiling is the
      // Supabase TRANSACTION pooler (port 6543) as DATABASE_URL — the
      // code uses no session-level features (prepare:false, no
      // LISTEN/advisory locks/temp tables/SET, no db.transaction),
      // so it is safe; that is a Vercel env change, not a code change.
      max: 1,
      // Supabase's poolers (Supavisor) do not reliably support the
      // extended-protocol prepared statements postgres-js sends by
      // default: the transaction pooler rejects them outright, and a
      // pooled session can also serve a stale prepared statement from
      // an earlier serverless invocation. Disabling them makes every
      // query work identically on the session pooler (5432), the
      // transaction pooler (6543), a direct db.<ref>.supabase.co
      // connection (5432) and a plain local Postgres; postgres-js
      // still escapes every parameter.
      // postgres-js must stay >= 3.4.9: in 3.4.5 its reconnect used
      // setTimeout(connect, closedDate + delay - performance.now())
      // with no clamp, so a connection that had died while idle
      // (idle_timeout / pooler kill) and was only reused seconds
      // later scheduled a NEGATIVE timeout — Node logged
      // "Timeout duration was set to -26824…" on every live check.
      // 3.4.9 clamps it with Math.max(0, …). Do not downgrade.
      prepare: false,
      connect_timeout: 10,
      // Drain idle connections fast: with max:1 every warm Vercel
      // instance holds one pool slot while idle, and the session
      // pooler only allows 15 clients total — a burst of concurrent
      // invocations (dashboard load, mode switch) filled it even
      // after the max:1 revert (EMAXCONNSESSION, 2026-11-15). 5s of
      // idle releases the slot instead of 20s; the price is an
      // occasional TLS reconnect on the next query after idle, which
      // is one handshake per invocation, not per statement (the batch
      // loads are single statements). max_lifetime 10min recycles
      // long-lived connections before the pooler kills them mid-use.
      idle_timeout: 5,
      max_lifetime: 60 * 10,
      // Local-only query counting: when CG_QUERY_LOG is set (harness
      // runs), every statement the driver sends is appended to that
      // file (one line per statement) so the harness can assert the
      // per-call round-trip count. Off by default and never set in
      // production — it exists because local timing proves nothing
      // about live latency (localhost RTT is free) while the
      // STATEMENT COUNT is what the live 15–30s refetch is made of.
      // Each line is the first 200 chars of the statement with
      // whitespace collapsed; parameters are never written.
      debug: process.env.CG_QUERY_LOG
        ? (_connection: number, query: string) => {
            try {
              appendFileSync(
                process.env.CG_QUERY_LOG as string,
                query.replace(/\s+/g, " ").slice(0, 200) + "\n",
              );
            } catch {
              /* counting must never break a query */
            }
          }
        : false,
    })
  : null;

export const db = client
  ? drizzle(client, { schema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(
            "DATABASE_URL is not set. Add the Supabase Postgres connection string (Session Pooler, port 5432) in Vercel → Settings → Environment Variables as DATABASE_URL, then redeploy.",
          );
        },
      },
    ) as ReturnType<typeof drizzle>);

// ---------- database error diagnosis (never leaks SQL) ----------
// Drizzle wraps a failed query as `Failed query: <full SQL>\nparams:
// <values>` and hides the real Postgres error in `.cause` — so when
// the API route used to return the error's message verbatim, the user
// saw raw SQL in a red box and nobody could tell WHY the query failed
// (wrong password, missing tables, unreachable host all look the
// same). These helpers unwrap the cause to its Postgres error code
// and turn it into a plain-language message. Raw SQL, parameters,
// connection strings and passwords are never returned to the client;
// the full error is only ever written to the server log (see the API
// route's catch block).

/** Postgres / network error code, unwrapped through Drizzle's cause chain. */
export function dbErrorCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** True when this error came from the database driver (Drizzle query
 *  failure or a postgres / network error), as opposed to an app-level
 *  error the actions already worded in plain language. */
export function isDatabaseError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  if (msg.startsWith("Failed query:")) return true;
  return dbErrorCode(e) !== null;
}

/** True when this error is a database connection-pool exhaustion:
 *  Supavisor's session pooler (code XX000, "max clients reached in
 *  session mode — max clients are limited to pool_size: N") or plain
 *  Postgres "too many connections" (53300). Both mean the same thing
 *  for the user — the database is briefly out of free connections —
 *  and both are transient: a retry a moment later usually succeeds
 *  once an idle connection drains. The message is read down the
 *  cause chain, because Drizzle wraps the real Postgres error inside
 *  "Failed query: <SQL>" and the outer message never names the pool.
 *  (2026-11-15: the max:1 revert did NOT stop this — concurrent
 *  Vercel invocations each hold their own connection, so the pool
 *  still filled up. See the route's retry loop.) */
export function isPoolExhaustedError(e: unknown): boolean {
  const code = dbErrorCode(e);
  let messages = "";
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) messages += ` ${cur.message}`;
    else if (typeof cur === "string") messages += ` ${cur}`;
    cur = (cur as { cause?: unknown }).cause;
  }
  if (code === "53300") return true;
  if (code === "XX000" && /max clients/i.test(messages)) return true;
  return /max clients reached in session mode|too many connections/i.test(
    messages,
  );
}

/** Plain-language message for a database failure. Safe to show to the
 *  user: it never contains SQL, parameters, connection strings or
 *  passwords. */
export function dbErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (!url || /DATABASE_URL is not set/.test(msg))
    return "The database connection isn't set up on the server yet (DATABASE_URL is missing). Please add the Supabase Postgres connection string in Vercel → Settings → Environment Variables as DATABASE_URL, then redeploy.";
  if (isPoolExhaustedError(e))
    return "The database is busy just now — too many connections at once. Nothing was lost; please wait a moment and try again.";
  const code = dbErrorCode(e);
  switch (code) {
    case "28P01":
    case "28000":
    case "28P02":
      // Wrong password (or wrong user) for the Postgres connection.
      // This is the most common cause when the migration ran fine
      // (the SQL Editor uses dashboard auth, not this password) and
      // the Auth REST probe answers (publishable key, no password)
      // while every database query fails.
      return "The app couldn't sign in to the database — the database password in the server settings (DATABASE_URL) doesn't match this Supabase project. Please check the password in Vercel → Settings → Environment Variables and redeploy.";
    case "42P01":
      return "The database tables haven't been created yet — the setup migration needs to be run in the Supabase SQL Editor first.";
    case "3D000":
      return "The database named in the server settings doesn't exist. Please check DATABASE_URL in Vercel → Settings → Environment Variables.";
    case "42501":
      return "The database user doesn't have permission to read the app's tables. Please check the database user in DATABASE_URL.";
    case "SELF_SIGNED_CERT_IN_CHAIN":
      // The database server's TLS certificate chain was rejected
      // during the handshake. The connection is encrypted but the
      // chain is not trusted by the server runtime.
      return "The app couldn't verify the database server's security certificate. Please check the database connection settings and try again in a moment.";
    default:
      break;
  }
  if (
    (code && /^E[A-Z_]+$/.test(code)) ||
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|EPIPE/.test(
      msg,
    )
  )
    return "The app couldn't reach the database server just now. Please check your connection and try again in a moment.";
  if (/timeout/i.test(msg))
    return "The database took too long to answer. Please try again in a moment.";
  return "Something went wrong while talking to the database. Please try again in a moment.";
}

/** Safe error message for ANY handler error: database failures get
 *  the plain-language mapping above; app-level errors (already
 *  worded in plain language by the actions) pass through unchanged.
 *  As a last defence, anything that still looks like SQL or a
 *  connection string is replaced with the generic message. */
export function safeErrorMessage(e: unknown): string {
  if (isDatabaseError(e)) return dbErrorMessage(e);
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (
    /Failed query|params:|postgres(?:ql)?:\/\/|select\s+["\w]+\s+from|insert\s+into|update\s+["\w]+\s+set/i.test(
      msg,
    )
  )
    return "Something went wrong while talking to the database. Please try again in a moment.";
  return msg || "Something went wrong. Please try again.";
}

export type DbDiagnosis = {
  reachable: boolean;
  tablesReady: boolean;
  code: string | null;
};

/** Real database probe: can we connect, and does the auth_users
 *  table exist? Used by getSupabaseAuthStatus so the signed-out
 *  "What's connected" strip stops claiming the workspace database is
 *  Live when it never answered a query. Returns only booleans and a
 *  Postgres error code — no SQL, no credentials.
 *
 *  The failure is ALSO written to the server log (Vercel Runtime
 *  Logs) with its code and a sanitised message — never the
 *  connection string or password. The probe used to swallow the
 *  error silently, so a failing live check left no trace anywhere:
 *  no Postgres error in the logs, HTTP 200, databaseLive:false, and
 *  nobody could tell a wrong password from an unreachable host. */
export async function checkDatabase(): Promise<DbDiagnosis> {
  if (!client)
    return { reachable: false, tablesReady: false, code: "NO_DATABASE_URL" };
  try {
    await client`select 1`;
    const rows = await client<{ exists: boolean }[]>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'auth_users'
      ) as exists`;
    return {
      reachable: true,
      tablesReady: rows[0]?.exists === true,
      code: null,
    };
  } catch (e) {
    const code = dbErrorCode(e);
    // Log the cause server-side only. The message is sanitised:
    // a Drizzle failure message contains the full SQL + params, so
    // only the code and the first line of a non-SQL message are
    // kept, and anything resembling a connection string is dropped.
    const raw = e instanceof Error ? e.message : String(e ?? "");
    const firstLine = raw.split("\n")[0] ?? "";
    const safeDetail = /Failed query|params:|postgres(?:ql)?:\/\/|select\s+["\w]+\s+from|insert\s+into|update\s+["\w]+\s+set/i.test(
      firstLine,
    )
      ? "(SQL omitted)"
      : firstLine.slice(0, 200);
    console.error(
      `[cashflow-genius] checkDatabase failed: code=${code ?? "unknown"} ${safeDetail}`,
    );
    return { reachable: false, tablesReady: false, code };
  }
}
