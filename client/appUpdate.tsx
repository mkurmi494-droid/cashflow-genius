// In-app updates: when a newer deploy of Cashflow Genius exists, the
// app says so on open and offers a one-tap Update. The web app loads
// its newest version from the server, so "updating" is a reload after
// asking the service worker for its newest copy — nothing is
// downloaded or installed by hand.
//
// How it knows: the running bundle's version is baked in at build
// time from the Vercel commit SHA (next.config env). On open — and
// whenever the user taps "Check for updates" in Settings — the app
// fetches /api/version (no-store) from the live deployment and
// compares. A mismatch means a newer deploy exists.

import { useCallback, useEffect, useRef, useState } from "react";
import { RUNNING_VERSION, isUpdateAvailable } from "./appVersion";

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null && typeof (data as { version?: unknown }).version === "string")
      return (data as { version: string }).version;
    return null;
  } catch {
    return null;
  }
}

export function useAppUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const dismissedRef = useRef(false);

  const check = useCallback(async () => {
    setChecking(true);
    const latest = await fetchLatestVersion();
    setChecking(false);
    setChecked(true);
    setLatestVersion(latest);
    if (!dismissedRef.current && isUpdateAvailable(RUNNING_VERSION, latest)) setUpdateAvailable(true);
    return latest;
  }, []);

  // Check once, as soon as the app opens.
  useEffect(() => {
    void check();
  }, [check]);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    setUpdateAvailable(false);
  }, []);

  // Pull the newest version: ask the service worker for its newest
  // copy, then reload — navigations are network-first, so the reload
  // loads the new deploy.
  const applyUpdate = useCallback(async () => {
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg?.update();
      }
    } catch {
      /* the reload below still fetches the newest version */
    }
    window.location.reload();
  }, []);

  return { updateAvailable, checking, checked, latestVersion, check, dismiss, applyUpdate };
}

/** Banner shown at the top of the app whenever a newer deploy exists. */
export function AppUpdateBanner() {
  const { updateAvailable, dismiss, applyUpdate } = useAppUpdate();
  if (!updateAvailable) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5"
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-soft)] text-lg"
      >
        ⟳
      </span>
      <span className="min-w-0 flex-1 text-sm font-semibold">
        A new version of Cashflow Genius is available.
        <span className="block text-xs font-normal text-[var(--muted)]">
          Update now to get the latest features and fixes.
        </span>
      </span>
      <button type="button" className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={() => void applyUpdate()}>
        Update now
      </button>
      <button
        type="button"
        aria-label="Dismiss update"
        className="shrink-0 rounded-full px-2 py-1 text-lg leading-none text-[var(--muted)] hover:bg-[var(--surface-soft)]"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

/** Settings hub footer: current version + a manual "Check for updates". */
export function AppUpdateFooter() {
  const { updateAvailable, checking, checked, latestVersion, check, applyUpdate } = useAppUpdate();
  return (
    <div className="mt-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">App version &amp; updates</span>
          <span className="block text-sm text-[var(--muted)]">
            {RUNNING_VERSION === "local" ? "Running a local build." : `Running version ${RUNNING_VERSION}.`}
            {checking
              ? " Checking for updates…"
              : checked && updateAvailable
                ? " A new version is available."
                : checked && latestVersion
                  ? " You're on the latest version."
                  : checked
                    ? " Couldn't check just now — try again."
                    : ""}
          </span>
        </span>
        {updateAvailable ? (
          <button type="button" className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={() => void applyUpdate()}>
            Update now
          </button>
        ) : (
          <button
            type="button"
            className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-soft)] px-4 py-2 text-sm font-semibold"
            onClick={() => void check()}
            disabled={checking}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </div>
  );
}
