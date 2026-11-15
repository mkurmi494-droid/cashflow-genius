// Typed RPC client for the Vercel port. The original Muse transport
// (createActionClient posting to ./actions) is replaced by plain fetch
// POSTs to /api/<action-name> — same action names, same request/response
// shapes, so every page keeps calling api.getState(), api.saveTransaction()
// etc. unchanged. Types come from the server actions' zod schemas.
import type { Actions } from "../server/actions";
import type { z } from "zod";

// The pages write ApiResponse<typeof api, "getState">, mirroring the
// original SDK client where `api` carried the actions' own types. The
// fetch proxy below cannot carry them, so these helpers read the
// response/request straight from the server `Actions` schemas instead.
export type ApiResponse<T, K extends keyof T> = K extends keyof typeof Actions
  ? z.infer<(typeof Actions)[K]["response"]>
  : never;

export type ApiRequest<T, K extends keyof T> = K extends keyof typeof Actions
  ? z.infer<(typeof Actions)[K]["request"]>
  : never;

type ApiClient = {
  [K in keyof typeof Actions]: (
    args?: ApiRequest<typeof Actions, K>,
  ) => Promise<ApiResponse<typeof Actions, K>>;
};

// ---- session token (issued by the server auth actions) ----
const TOKEN_KEY = "cg_auth_token";

let memoryToken: string | null = null;

export function getAuthToken(): string | undefined {
  if (memoryToken) return memoryToken;
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) {
      memoryToken = t;
      return t;
    }
  } catch {
    /* storage unavailable — fall through to sessionStorage */
  }
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) {
      memoryToken = t;
      return t;
    }
  } catch {
    /* storage unavailable — no persisted token */
  }
  return undefined;
}

export function setAuthToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — the in-memory copy still holds the session */
  }
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — the in-memory copy still holds the session */
  }
}

// ---- bounded waits for sign-in calls ----
export const AUTH_TIMEOUT_MS = 20_000;
export const AUTH_TIMEOUT_MESSAGE =
  "This is taking too long — the connection seems stuck. Nothing was lost and your entries are still here: check your internet connection, then tap the button again.";

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- state refresh after mutations (bug fix, 2026-11-14) ----
// The ledger is read through React Query (["cg-state"], 30s staleTime)
// and most page mutations used to only show a toast — they never
// invalidated or refetched that query, so a save looked like it did
// nothing until the next page reload (and a second save of the same
// invoice then created a real duplicate). The server even comments
// "the client refetches after mutations" — but it didn't.
//
// Fix, centralised here so no individual mutation can forget it:
// every successful call that is NOT a pure read dispatches a
// "cg:mutated" event, and App.tsx listens for it and invalidates
// the state queries. Reads are excluded so a refetch can never
// re-trigger itself (getState → event → refetch → …).
//
// That alone was NOT enough (2026-11-15): the refetch re-runs the
// whole getState ledger, which takes ~15–20s on a live cold start,
// so every save looked stale until a reload — and a refetch that
// fails (retry: false) silently leaves the old data in place. So
// the event also carries the mutation's arguments and response, and
// App patches the cached ["cg-state"] data optimistically from
// them (see client/optimistic.ts): the list the user is looking at
// changes in the same tick as the toast, and the refetch that
// follows only reconciles it with the server.
const READ_ONLY_ACTIONS = new Set([
  "getState",
  "getCombinedSummary",
  "authStatus",
  "getSupabaseAuthStatus",
  "getIntegrationStatus",
  "exportBackup",
  "listNoteVersions",
  "requestPasswordReset",
  "resendEmailOtp",
]);

function notifyMutation(
  name: string,
  args: Record<string, unknown>,
  data: unknown,
): void {
  if (READ_ONLY_ACTIONS.has(name)) return;
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      // The detail carries the mutation's arguments and response (minus
      // the session token) so App can patch the cached ledger
      // optimistically — the list updates in the same tick as the toast
      // instead of waiting on a full getState refetch.
      const { token: _token, ...safeArgs } = args;
      window.dispatchEvent(
        new CustomEvent("cg:mutated", { detail: { action: name, args: safeArgs, data } }),
      );
    }
  } catch {
    /* event dispatch must never break the call itself */
  }
}

async function callAction(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`/api/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  // Only a successful mutation refreshes the views: a failed save
  // must not pretend the (unchanged) data is new.
  notifyMutation(name, args, data);
  return data;
}

// ---- one ledger read at a time (pool-exhaustion fix, 2026-11-15) ----
// A dashboard load fires getState + getCombinedSummary + getBriefing
// together, and a mode switch refetches them together — each is a
// separate Vercel serverless invocation holding its own database
// connection, so one user alone can hold 3 of the session pooler's
// 15 slots, and a burst across instances exhausts it (EMAXCONNSESSION
// "max clients reached in session mode", even after the max:1 revert).
// The three reads queue behind each other here, so peak connections
// per tab drop from 3 to 1. The total wall time is the same work the
// server would have serialised on max:1 anyway; the panels just wait
// their turn instead of failing together. Mutations and auth calls
// are NOT queued — only these three reads. A failed read never blocks
// the queue: the chain is kept alive with a caught copy.
const LEDGER_READ_ACTIONS = new Set([
  "getState",
  "getCombinedSummary",
  "getBriefing",
]);
let ledgerReadQueue: Promise<unknown> = Promise.resolve();

function callActionQueued(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!LEDGER_READ_ACTIONS.has(name)) return callAction(name, args);
  const p = ledgerReadQueue.then(
    () => callAction(name, args),
    () => callAction(name, args),
  );
  ledgerReadQueue = p.catch(() => {});
  return p;
}

// Every action call automatically carries the session token; the server
// verifies it and scopes all data to the signed-in account.
export const api = new Proxy(
  {},
  {
    get(_target, prop) {
      return (args: Record<string, unknown> = {}) =>
        callActionQueued(String(prop), { ...args, token: getAuthToken() });
    },
  },
) as unknown as ApiClient;
