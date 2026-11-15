import { NextRequest, NextResponse } from "next/server";
import { Actions } from "@/server/actions";
import { isPoolExhaustedError, safeErrorMessage } from "@/server/lib/db";

// One route serves every ported server action: POST /api/<action-name>
// with the action's request JSON. The action's zod request schema is
// validated before the handler runs; handler errors (including the
// "Please log in" errors) come back as { error } with a 400/401 status
// so the client shows the message instead of spinning forever.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_TOKEN_ACTIONS = new Set([
  "getSupabaseAuthStatus",
  "register",
  "verifyAccount",
  "resendEmailOtp",
  "login",
  "googleSignIn",
  "confirmEmailLink",
  "requestPasswordReset",
  "purgeDemoAccount",
]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ action: string }> },
) {
  const { action } = await ctx.params;
  const def = (Actions as Record<string, unknown>)[action] as
    | {
        request: { parse: (v: unknown) => unknown };
        response: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } };
        handler: (
          ctx: { invalidateQueries(): void },
          args: never,
        ) => Promise<unknown>;
      }
    | undefined;
  if (!def) {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 404 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  let args: unknown;
  try {
    args = def.request.parse(body ?? {});
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid request for ${action}: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  // Read-only actions are safe to retry whole: they write nothing
  // (the only writes inside getState/getBriefing are first-visit
  // workspace / state-row creates, both guarded by existence checks
  // and onConflictDoNothing), so a retry can never double-apply
  // anything. Pool exhaustion is transient — an idle connection
  // drains within seconds — so a read retried a moment later usually
  // succeeds, and the client keeps showing its loading skeleton
  // instead of the full-screen "could not be loaded" error.
  // Delays (1s, 3s, 6s) span the idle drain; worst case the read
  // takes ~10s, still far better than failing outright. Mutations
  // are NEVER retried here: a half-applied write must not run twice.
  const READ_RETRY_ACTIONS = new Set([
    "getState",
    "getCombinedSummary",
    "getBriefing",
    "authStatus",
    "getSupabaseAuthStatus",
    "getIntegrationStatus",
    "exportBackup",
    "listNoteVersions",
  ]);
  const POOL_RETRY_DELAYS_MS = [1000, 3000, 6000];
  try {
    let attempt = 0;
    for (;;) {
      try {
        const result = await def.handler({ invalidateQueries: () => {} }, args as never);
        const checked = def.response.safeParse(result);
        if (!checked.success) {
          console.error(`[cashflow-genius] ${action} returned an invalid response:`, checked.error);
          return NextResponse.json(
            { error: `The server returned an unexpected result for ${action}. Please try again.` },
            { status: 500 },
          );
        }
        return NextResponse.json(checked.data);
      } catch (e) {
        if (
          READ_RETRY_ACTIONS.has(action) &&
          isPoolExhaustedError(e) &&
          attempt < POOL_RETRY_DELAYS_MS.length
        ) {
          const delay = POOL_RETRY_DELAYS_MS[attempt] as number;
          attempt++;
          console.error(
            `[cashflow-genius] ${action} hit pool exhaustion, retry ${attempt}/${POOL_RETRY_DELAYS_MS.length} in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Not a retryable pool error (or retries spent): hand the
        // error to the shared handling in the outer catch.
        throw e;
      }
    }
  } catch (e) {
    // The full error stays on the server (Vercel logs) so the real
    // cause can be diagnosed there; the client only ever gets a
    // plain-language message. This matters because Drizzle wraps a
    // failed query as "Failed query: <full SQL> params: <values>" —
    // returning e.message verbatim used to show the user raw SQL in a
    // red box while hiding the actual cause (wrong DB password,
    // missing tables, unreachable host all looked identical).
    console.error(`[cashflow-genius] ${action} failed:`, e);
    const rawMessage = e instanceof Error ? e.message : String(e);
    // 401 only for genuine auth failures ("please log in", "verify your
    // account", expired/invalid session). The word "session" alone must NOT
    // trigger it — the DATABASE_URL guidance mentions "Session Pooler".
    const status =
      /please log in|log in first|verify your account|session expired|invalid session|not signed in/i.test(rawMessage) ? 401 : 400;
    // Actions that never need a session keep their own error shape.
    void NO_TOKEN_ACTIONS;
    return NextResponse.json({ error: safeErrorMessage(e) }, { status });
  }
}
