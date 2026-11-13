import { NextRequest, NextResponse } from "next/server";
import { Actions } from "@/server/actions";

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
    const message = e instanceof Error ? e.message : String(e);
    const status =
      /log in|verify your account|session/i.test(message) ? 401 : 400;
    // Actions that never need a session keep their own error shape.
    void NO_TOKEN_ACTIONS;
    return NextResponse.json({ error: message }, { status });
  }
}
