// Supabase Auth (Google sign-in) — client side.
//
// The Supabase project below is the one the app owner created and
// connected for Cashflow Genius. The publishable (anon) key is a
// PUBLIC client key — it is designed to ship in browser code and only
// ever identifies the project; it grants no data access by itself.
// No secret / service-role key and no Google Client Secret exists in
// this file or anywhere in the client bundle — those live only in the
// Supabase dashboard, where the owner pasted them.
//
// Flow (the real Supabase Auth Google OAuth flow, PKCE):
//  1. `startGoogleOAuth` generates a PKCE verifier/challenge, keeps
//     the verifier in sessionStorage, and navigates the browser to
//     {project}/auth/v1/authorize?provider=google — Supabase sends
//     the user to Google, Google sends them back to Supabase's own
//     callback, and Supabase redirects back here with ?code=…
//  2. `completeGoogleCallback` exchanges that code for a Supabase
//     session (POST /auth/v1/token?grant_type=pkce) — or, if the
//     redirect came back in implicit form, reads the access token
//     from the URL hash instead.
//  3. The Supabase access token is handed to the server action
//     `googleSignIn`, which verifies it against Supabase
//     (/auth/v1/user), finds-or-creates THAT person's own local
//     account (keyed by their verified Google email, starting with
//     an empty workspace) and returns the app's own session token.
//     The Supabase token itself is never stored by the app.

import { api, withTimeout, AUTH_TIMEOUT_MS, AUTH_TIMEOUT_MESSAGE } from "./api";

// Public client values: override with NEXT_PUBLIC_* env vars in Vercel;
// the defaults below are the Cashflow Genius project's public values.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://zfngqppwmyizlnrzhrjc.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_6D9rlSGsbPzqkMVyWdrZ3w_60JseEvy";

const VERIFIER_KEY = "cg_pkce_verifier";
// Set only when "Continue with Google" was tapped in THIS tab: it is
// how the return is told apart from an email confirmation link.
// Supabase's signup email contains a confirmation LINK, and opening
// it also redirects back here with ?code=… — without this flag the
// link return was routed through the Google handler, which verified
// the account through googleSignIn and logged “Signed in with
// Google” for a sign-in that was email + password (live test,
// 2026-11-14). The flag lives in sessionStorage, so it is present
// for the same-tab Google return and absent for the (new-tab) email
// link return.
const GOOGLE_STARTED_KEY = "cg_google_oauth_started";

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const arr = new Uint8Array(48);
  globalThis.crypto.getRandomValues(arr);
  return base64Url(arr);
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64Url(new Uint8Array(digest));
}

/** The address Supabase should send the browser back to: this app,
 *  exactly as it is currently served (path kept, stale auth params
 *  and route hash dropped). This must also be allow-listed in the
 *  Supabase dashboard under Authentication → URL Configuration →
 *  Redirect URLs, or Supabase falls back to its Site URL. */
function appReturnUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Starts the real Google sign-in: navigates away to Supabase Auth,
 * which redirects to Google's own sign-in page. Resolves only if the
 * navigation could not be started (the browser normally leaves the
 * page before this returns).
 */
export async function startGoogleOAuth(): Promise<void> {
  try {
    sessionStorage.setItem(GOOGLE_STARTED_KEY, "1");
  } catch {
    /* storage unavailable — the return is then treated as an email link */
  }
  const redirectTo = appReturnUrl();
  let challenge: string | null = null;
  try {
    const verifier = randomVerifier();
    challenge = await sha256Base64Url(verifier);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    // No WebCrypto (very old browser): fall back to the implicit
    // flow — Supabase then returns the session in the URL hash,
    // which completeGoogleCallback also handles.
    challenge = null;
  }
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: redirectTo,
  });
  if (challenge) {
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "s256");
  }
  window.location.assign(
    `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`,
  );
}

/** True when the current URL carries a Supabase return — either a
 *  Google OAuth return (an auth code, an implicit access token, or
 *  an OAuth error) or an email confirmation LINK return, which
 *  Supabase also delivers as ?code=…. completeGoogleCallback tells
 *  the two apart with the cg_google_oauth_started flag. */
export function hasGoogleCallback(): boolean {
  try {
    const hash = window.location.hash;
    if (
      hash.includes("access_token=") ||
      hash.includes("error_description=") ||
      hash.includes("error=")
    )
      return true;
    const q = new URLSearchParams(window.location.search);
    return q.has("code") || q.has("error") || q.has("error_description");
  } catch {
    return false;
  }
}

/** Removes every OAuth artefact from the visible URL (code, tokens,
 *  errors) without reloading, so tokens never linger in the address
 *  bar or browser history. */
function cleanUrl() {
  try {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* history unavailable — the params are single-use anyway */
  }
}

export type GoogleCallbackResult =
  | { status: "none" }
  | { status: "ok"; token: string; method: "google" | "email" }
  | { status: "error"; message: string };

async function exchangeCodeForAccessToken(code: string): Promise<string> {
  let verifier: string | null = null;
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
  } catch {
    verifier = null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier ?? "" }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    error_description?: string;
    msg?: string;
  } | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(
      data?.error_description ??
        data?.msg ??
        "Supabase could not complete the Google sign-in code exchange.",
    );
  }
  return data.access_token;
}

/**
 * Completes a Supabase return: pulls the code/token out of the URL,
 * cleans the URL, exchanges the code if needed, then trades the
 * Supabase access token for this app's own session. Which server
 * action runs depends on how the return started:
 * - "Continue with Google" was tapped in this tab (the
 *   cg_google_oauth_started flag is set) → googleSignIn, and the
 *   activity log records “Signed in with Google”.
 * - No flag → this is the email confirmation LINK return (Supabase
 *   emails a link, not a code): confirmEmailLink, which verifies the
 *   matching local email account and logs “Signed in with email”.
 *   The old code sent both through googleSignIn, mislabelling every
 *   email-link sign-in as Google.
 * Call once, on app start.
 */
export async function completeGoogleCallback(): Promise<GoogleCallbackResult> {
  if (!hasGoogleCallback()) return { status: "none" };
  const hashParams = new URLSearchParams(
    window.location.hash.replace(/^#\/?/, ""),
  );
  const queryParams = new URLSearchParams(window.location.search);
  const errorText =
    hashParams.get("error_description") ??
    queryParams.get("error_description") ??
    hashParams.get("error") ??
    queryParams.get("error");
  const code = queryParams.get("code");
  const hashToken = hashParams.get("access_token");
  cleanUrl();
  if (errorText) {
    return {
      status: "error",
      message: `Sign-in didn't complete: ${errorText}. You can try again, or use email + password below.`,
    };
  }
  let googleStarted = false;
  try {
    googleStarted = sessionStorage.getItem(GOOGLE_STARTED_KEY) === "1";
    sessionStorage.removeItem(GOOGLE_STARTED_KEY);
  } catch {
    googleStarted = false;
  }
  try {
    const accessToken = hashToken ?? (code ? await exchangeCodeForAccessToken(code) : null);
    if (!accessToken) {
      return {
        status: "error",
        message:
          "The sign-in returned without a session. Please try again — “Continue with Google”, or the confirmation link in your email.",
      };
    }
    // Bounded like every other sign-in call: if this stalls, the
    // "Completing your sign-in…" screen must end with a clear
    // error the user can act on, never spin forever.
    const method = googleStarted ? "google" : "email";
    const res = await withTimeout(
      method === "google"
        ? api.googleSignIn({ supabaseAccessToken: accessToken })
        : api.confirmEmailLink({ supabaseAccessToken: accessToken }),
      AUTH_TIMEOUT_MS,
      AUTH_TIMEOUT_MESSAGE,
    );
    if (!res.ok || !res.token) {
      return {
        status: "error",
        message:
          res.error ??
          "Your email was verified, but this app could not open your workspace. Please try again.",
      };
    }
    return { status: "ok", token: res.token, method };
  } catch (e) {
    return {
      status: "error",
      message: `Sign-in didn't complete: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
}
