// PWA runtime: makes Cashflow Genius an installable phone app.
//
// Static PWA files (manifest, icons) live in client/pwa/ and are
// copied into the built output by client/build.mjs — both at the app
// root (./) and under ./assets/. Which of those the host actually
// serves is not knowable from the source, so at startup we PROBE the
// candidates (and validate the content, because an SPA fallback could
// answer HTML with a 200): the manifest <link> and the apple-touch-icon
// are only injected for a location that really answers. If neither
// location answers, the app simply runs as a normal web app — no
// broken links, no console noise, nothing faked.
//
// Service worker: the worker script (public/sw.js) is served by Vercel
// at the site root, and the registration below activates it automatically.
// Installation therefore works through the manifest + icons + service
// worker (full standalone on iOS via the apple meta/icon tags), and the
// install button falls back to manual Add-to-Home-Screen steps wherever
// the browser does not offer its own prompt.
//
// Install prompt: Chrome/Android fires `beforeinstallprompt`; we keep
// the event and expose it through a tiny store so the Settings
// "Install app" section, the phone More sheet and the public home can
// offer a real one-tap install. Where the browser never offers it
// (iOS Safari, in-app webviews), those same places show the manual
// “Add to Home Screen” steps instead — the honest fallback.

import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Candidate locations for each PWA file, canonical first. The service
// worker is only ever probed at the root: a worker under assets/
// could not control the app's scope anyway, and probing a path that
// is not served would log a 404 in the console for nothing.
const MANIFEST_CANDIDATES = ["./manifest.webmanifest", "./assets/manifest.webmanifest"];
const SW_CANDIDATES = ["./sw.js"];
const APPLE_ICON_CANDIDATES = ["./apple-touch-icon.png", "./assets/apple-touch-icon.png"];

async function probeText(candidates: string[], marker: string): Promise<string | null> {
  for (const url of candidates) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes(marker)) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function probeExists(candidates: string[]): Promise<string | null> {
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("image")) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

let pwaStarted = false;

/** One-time PWA bootstrap: manifest link, touch icon, service worker. */
export function initPwa(): void {
  if (pwaStarted || typeof window === "undefined") return;
  pwaStarted = true;

  void (async () => {
    const manifestUrl = await probeText(MANIFEST_CANDIDATES, "Cashflow Genius");
    if (manifestUrl && !document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = manifestUrl;
      document.head.appendChild(link);
    }
    const iconUrl = await probeExists(APPLE_ICON_CANDIDATES);
    if (iconUrl && !document.querySelector('link[rel="apple-touch-icon"]')) {
      const link = document.createElement("link");
      link.rel = "apple-touch-icon";
      link.href = iconUrl;
      document.head.appendChild(link);
    }
  })();

  if ("serviceWorker" in navigator) {
    void (async () => {
      const swUrl = await probeText(SW_CANDIDATES, "cashflow-genius-sw");
      if (!swUrl) return;
      try {
        // Scope is the app root either way: for ./sw.js that is its
        // natural scope; for ./assets/sw.js the registration throws
        // (scope outside the worker's path) and we accept that — a
        // worker that cannot control the app is not registered at all
        // rather than registered pointlessly.
        await navigator.serviceWorker.register(swUrl, { scope: "./" });
      } catch {
        /* service worker unavailable here — the app still works fully */
      }
    })();
  }
}

// ---------------- install prompt store ----------------

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) installed = true;
  } catch {
    /* matchMedia unavailable */
  }
}

export type InstallState = "ready" | "installed" | "manual";

function installSnapshot(): InstallState {
  if (installed) return "installed";
  return deferredPrompt ? "ready" : "manual";
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    installSnapshot,
    () => "manual" as InstallState,
  );
}

/** Fires the browser's real install prompt. Returns the outcome. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  const ev = deferredPrompt;
  deferredPrompt = null;
  emit();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice.outcome;
  } catch {
    return "unavailable";
  }
}

/**
 * The one Install control used everywhere (public home, More sheet,
 * Settings): a real one-tap install while the browser offers it, an
 * honest “already installed” state, or manual Add-to-Home-Screen steps
 * where no prompt exists.
 */
export function InstallButton({
  className = "btn-primary px-5 py-2.5 text-sm",
  onNotify,
}: {
  className?: string;
  onNotify?: (msg: string) => void;
}) {
  const state = useInstallState();
  if (state === "installed") {
    return (
      <p className="text-sm font-semibold text-[var(--accent)]" role="status">
        ✓ Cashflow Genius is installed on this device — it opens full-screen from your home screen.
      </p>
    );
  }
  if (state === "ready") {
    return (
      <button
        type="button"
        className={className}
        aria-label="Install Cashflow Genius as an app on this device"
        onClick={() => {
          void promptInstall().then((outcome) => {
            if (outcome === "accepted") onNotify?.("Installing Cashflow Genius — look for it on your home screen.");
            else if (outcome === "dismissed") onNotify?.("Install dismissed — you can install any time from Settings → Install app.");
          });
        }}
      >
        📲 Install app
      </button>
    );
  }
  return (
    <p className="text-sm leading-relaxed text-[var(--dim)]">
      To install on this phone: open your browser menu (⋮ or Share) and tap{" "}
      <strong className="text-[var(--text)]">“Add to Home Screen”</strong> /{" "}
      <strong className="text-[var(--text)]">“Install app”</strong>. Cashflow Genius then
      opens full-screen like a real app. (Some browsers offer the one-tap install button
      here instead — if you don&rsquo;t see it, the menu route always works.)
    </p>
  );
}
