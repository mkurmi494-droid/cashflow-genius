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

function notifyMutation(name: string): void {
  if (READ_ONLY_ACTIONS.has(name)) return;
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent("cg:mutated", { detail: { action: name } }),
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
  notifyMutation(name);
  return data;
}

// Every action call automatically carries the session token; the server
// verifies it and scopes all data to the signed-in account.
export const api = new Proxy(
  {},
  {
    get(_target, prop) {
      return (args: Record<string, unknown> = {}) =>
        callAction(String(prop), { ...args, token: getAuthToken() });
    },
  },
) as unknown as ApiClient;
