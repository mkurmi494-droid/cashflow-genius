// Cursor style preference — shared between Settings (the picker), the
// app shell (which syncs the signed-in account's saved choice from
// getState) and the ParticleCursor canvas (which renders it).
//
// The server is the source of truth: the choice is saved per account
// via the setCursorStyle action and returned by getState as
// state.cursorStyle, so it survives logout/login and reloads and
// follows the account across all four workspaces. localStorage is
// only a local cache so the chosen cursor can appear instantly on the
// next load, before getState returns; the app shell overwrites the
// cache with the account's saved value as soon as state loads, and
// resets it to the default on logout so one account's choice never
// leaks into another account's session on a shared device.

export type CursorStyle = "blue" | "gradient" | "minimal" | "mint" | "off";

export const DEFAULT_CURSOR_STYLE: CursorStyle = "blue";

export const CURSOR_OPTIONS: {
  id: CursorStyle;
  label: string;
  description: string;
  /** CSS background for the little preview dot in the picker. */
  swatch: string;
}[] = [
  {
    id: "blue",
    label: "Blue Particle",
    description: "Sky blue / royal blue glowing particle with a smooth floating trail.",
    swatch: "radial-gradient(circle at 35% 32%, #eff6ff 0%, #38bdf8 45%, #2563eb 100%)",
  },
  {
    id: "gradient",
    label: "Gradient",
    description: "Violet → fuchsia → coral particle trail, matching the app's gradient theme.",
    swatch: "linear-gradient(120deg, #7c3aed 0%, #d946ef 52%, #fb7185 82%, #fb923c 100%)",
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "A clean dot + ring with no trail. The ring expands slightly over buttons and links.",
    swatch: "radial-gradient(circle, #241b3a 0 26%, transparent 30%), conic-gradient(from 0deg, rgba(36,27,58,0.55), rgba(36,27,58,0.55))",
  },
  {
    id: "mint",
    label: "Mint",
    description: "The original mint-green / emerald glowing particle trail.",
    swatch: "radial-gradient(circle at 35% 32%, #ecfdf5 0%, #34d399 48%, #059669 100%)",
  },
  {
    id: "off",
    label: "Off / Default",
    description: "No custom cursor — your normal system arrow, exactly as your device shows it.",
    swatch: "linear-gradient(135deg, #ffffff 0%, #e6def8 100%)",
  },
];

export function cursorLabel(style: CursorStyle): string {
  return CURSOR_OPTIONS.find((o) => o.id === style)?.label ?? "Blue Particle";
}

const STORAGE_KEY = "cg_cursor_style";
export const CURSOR_CHANGE_EVENT = "cg-cursor-change";

export function isCursorStyle(v: unknown): v is CursorStyle {
  return v === "blue" || v === "gradient" || v === "minimal" || v === "mint" || v === "off";
}

export function getStoredCursorStyle(): CursorStyle {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isCursorStyle(v)) return v;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_CURSOR_STYLE;
}

/** Applies a cursor style everywhere, right now, with no reload: it
 *  updates the local cache and notifies the mounted ParticleCursor via
 *  a window event, which swaps its palette / mode immediately. */
export function applyCursorStyle(style: CursorStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* storage unavailable — the in-page event below still applies it */
  }
  try {
    document.documentElement.dataset.cursorStyle = style;
  } catch {
    /* no document (SSR/tests) — nothing to mark */
  }
  window.dispatchEvent(
    new CustomEvent<CursorStyle>(CURSOR_CHANGE_EVENT, { detail: style }),
  );
}
