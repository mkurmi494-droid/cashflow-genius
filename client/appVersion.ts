// App version helpers (pure) — the in-app update check.
// RUNNING_VERSION is baked into the bundle at build time from the
// Vercel commit SHA (next.config env); outside Vercel it is "local".
export const RUNNING_VERSION: string =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_VERSION) || "local";

/** True when the server reports a real, different version than this bundle. */
export function isUpdateAvailable(running: string, latest: string | null): boolean {
  if (!latest || latest === "local") return false;
  if (!running || running === "local") return false;
  return running !== latest;
}
