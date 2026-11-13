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
