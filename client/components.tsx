import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Procedural particle field + glass sphere. Pure CSS/canvas-free DOM so it
// stays light, works everywhere, and is the fallback "video" background the
// brief allows when no real video asset exists (no external links are used).

export function ParticleField({ count = 26, dense = false }: { count?: number; dense?: boolean }) {
  const particles = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const seed = (i * 37.7) % 100;
        const seed2 = (i * 53.3) % 100;
        return {
          left: `${seed}%`,
          top: `${55 + (seed2 % 45)}%`,
          size: 3 + ((i * 7) % 6),
          dx: `${((i % 7) - 3) * 26}px`,
          dy: `${-60 - ((i * 13) % 90)}px`,
          delay: `${(i % 12) * 0.9}s`,
          dur: `${7 + (i % 6)}s`,
        };
      }),
    [count],
  );
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            left: p.left,
            top: p.top,
            width: p.size,
            height: p.size,
            background: i % 4 === 0 ? "rgba(251,146,60,0.5)" : "rgba(217,70,239,0.55)",
            boxShadow: "0 0 10px rgba(217,70,239,0.5)",
            ["--dx" as string]: p.dx,
            ["--dy" as string]: p.dy,
            animation: `drift ${p.dur} ease-in-out ${p.delay} infinite`,
            opacity: dense ? undefined : 0.8,
          }}
        />
      ))}
    </div>
  );
}

/** Brand mark: the Cashflow Genius sprout (ChatGPT-designed logo, 2026-11-18).
    Currency-neutral by design — no rupee/dollar sign, so it works globally.
    Uses currentColor so call sites pick the colour (white on gradient tiles,
    violet inside the light glass orbs). */
export function LogoMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden="true">
      <path d="M50 6 L70 28 C72 30 70 34 67 34 L58 34 L58 50 C58 55 54 58 50 58 C46 58 42 55 42 50 L42 34 L33 34 C30 34 28 30 30 28 Z" />
      <path d="M48 64 L52 64 L51 94 L49 94 Z" />
      <path d="M47 64 C31 64 19 74 15 90 C29 92 43 84 47 66 Z" />
      <path d="M53 64 C69 64 81 74 85 90 C71 92 57 84 53 66 Z" />
    </svg>
  );
}

// A calculator that looks like one — body, display and key grid —
// drawn with strokes so it follows the surrounding text colour.
// Replaces the 🧮 abacus emoji, which reads as beads, not a calculator.
export function CalcIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
      <rect x="7.5" y="5" width="9" height="3.5" rx="1" />
      <path d="M7.5 12.5h2M11 12.5h2M14.5 12.5h2M7.5 16h2M11 16h2M14.5 16h2M7.5 19.5h2M11 19.5h2M14.5 19.5h2" />
    </svg>
  );
}

export function GlassOrb({
  size = 190,
  label,
  sub,
  tone = "mint",
}: {
  size?: number;
  label?: ReactNode;
  sub?: string;
  tone?: "mint" | "ai";
}) {
  const ring =
    tone === "ai"
      ? "border-[rgba(120,170,210,0.45)]"
      : "border-[rgba(217,70,239,0.5)]";
  const bg =
    tone === "ai"
      ? "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95) 0%, rgba(232,242,250,0.75) 34%, rgba(190,220,240,0.45) 62%, rgba(160,205,230,0.28) 100%)"
      : "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.97) 0%, rgba(245,243,255,0.85) 34%, rgba(221,214,254,0.55) 62%, rgba(196,181,253,0.32) 100%)";
  return (
    <div
      className="relative mx-auto flex items-center justify-center"
      style={{ width: size, height: size, animation: "floaty 7s ease-in-out infinite" }}
      role="img"
      aria-label={typeof label === "string" ? label : "Cashflow Genius logo"}
    >
      <span
        aria-hidden
        className={`absolute inset-0 rounded-full border ${ring}`}
        style={{ animation: "pulse-ring 3.6s ease-out infinite" }}
      />
      <span
        aria-hidden
        className="absolute rounded-full border border-white/70"
        style={{
          inset: -14,
          animation: "orb-spin 26s linear infinite",
          borderStyle: "dashed",
          opacity: 0.55,
        }}
      />
      <div
        className="flex h-full w-full flex-col items-center justify-center rounded-full text-center shadow-[0_24px_50px_rgba(124,58,237,0.2),inset_0_-18px_30px_rgba(217,70,239,0.28),inset_0_14px_24px_rgba(255,255,255,0.9)]"
        style={{ background: bg }}
      >
        {label ? (
          <span className="px-4 text-lg font-extrabold leading-tight text-[var(--text)]">
            {label}
          </span>
        ) : null}
        {sub ? (
          <span className="mt-1 px-5 text-xs font-semibold text-[var(--dim)]">{sub}</span>
        ) : null}
      </div>
      <span
        aria-hidden
        className="absolute rounded-full bg-white/70 blur-md"
        style={{ width: size * 0.34, height: size * 0.16, top: size * 0.12, left: size * 0.16 }}
      />
    </div>
  );
}

/** Gradient brand tile: the Sprout on the violet → fuchsia → coral gradient,
    exactly like the sidebar tile — the app icon itself, not the pale glass
    orb. Used on the landing/auth screens so the logo there matches the app
    icon (the old pale orb read as a different, flat violet mark). The `sub`
    sits inside the tile in white, like it did inside the orb. */
export function GradientTile({
  size = 130,
  label,
  sub,
}: {
  size?: number;
  label?: ReactNode;
  sub?: string;
}) {
  return (
    <div
      className="relative mx-auto flex items-center justify-center"
      style={{ width: size, height: size, animation: "floaty 7s ease-in-out infinite" }}
      role="img"
      aria-label="Cashflow Genius logo"
    >
      <div className="flex h-full w-full flex-col items-center justify-center rounded-[26%] bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-white shadow-[0_24px_50px_rgba(124,58,237,0.35)]">
        {label ? <span className="flex items-center justify-center">{label}</span> : null}
        {sub ? (
          <span className="mt-1 px-4 text-center text-[11px] font-semibold leading-tight text-white/90">{sub}</span>
        ) : null}
      </div>
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
        {hint ? <p className="text-sm text-[var(--dim)]">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-10 text-center">
      <div className="float-soft mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-soft)] text-xl">
        🌱
      </div>
      <p className="font-bold">{title}</p>
      <p className="mt-1 max-w-md text-sm text-[var(--dim)]">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "mint",
}: {
  children: ReactNode;
  tone?: "mint" | "ai" | "warn" | "err" | "gold" | "grey";
}) {
  const styles: Record<string, string> = {
    mint: "bg-[var(--surface-soft)] text-[var(--accent)]",
    ai: "bg-[var(--ai)] text-[var(--ai-text)]",
    warn: "bg-[var(--warn)] text-[var(--warn-text)]",
    err: "bg-[var(--err)] text-[var(--err-text)]",
    gold: "bg-[#faf0d2] text-[#7a5b16]",
    grey: "bg-[#eef2ee] text-[var(--dim)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
        {label}
      </span>
      {children}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // Escape closes the sheet. The header sits ABOVE the scrolling
  // body (a plain flex child, not sticky) — on a phone the list can
  // be taller than the screen, and the close button must never
  // scroll out of reach. See the layout comment on the sheet below
  // for why sticky was abandoned (two live failures, 2026-11-20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered through a portal to document.body (2026-11-20): the
  // picker's `fixed inset-0` backdrop used to sit inside the top
  // bar, whose backdrop-blur-md makes the header the containing
  // block for fixed descendants — the backdrop collapsed to the
  // header's ~60px box and the sheet centred on it, so its header
  // sat above the viewport and the × was unreachable (three live
  // failures). In the portal, `fixed` always anchors to the
  // viewport, wherever the trigger lives. The SSR guard matters:
  // the Modal only ever opens from a client click, but the file is
  // rendered on the server too, where document does not exist.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(30,51,41,0.38)] p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      {/* The header is a normal flex child ABOVE the scrolling body —
       *  it never scrolls, so the × can never scroll away. Two earlier
       *  attempts used position:sticky on the header and both failed
       *  live (2026-11-20): first the persisted cg-modal-in transform
       *  defeated the stick, then — even with the transform removed —
       *  the header still scrolled away with the list. This layout
       *  has no sticky positioning at all, so nothing can defeat it.
       *  The body is the only scrolling part (min-h-0 lets it shrink
       *  inside the flex column). */}
      <div
        className={`glass rise flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl ${
          wide ? "sm:max-w-2xl" : "sm:max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 bg-[var(--surface)] px-5 py-4">
          <h3 className="text-lg font-extrabold">{title}</h3>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="btn-ghost flex h-9 w-9 items-center justify-center text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Category select with a Custom option ----------
// A category <select> whose last option is always "✎ Custom — type your
// own" (value CUSTOM_CATEGORY). The owning form keeps two pieces of
// state — the selection and the custom text — and renders its own text
// field when the selection is CUSTOM_CATEGORY; the effective category
// it saves is the trimmed custom text in that case. See lib.ts for how
// typed names are remembered per workspace.

import { CUSTOM_CATEGORY, CUSTOM_CATEGORY_LABEL } from "./lib";

export function CategorySelect({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <select
      className="field"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value={CUSTOM_CATEGORY}>{CUSTOM_CATEGORY_LABEL}</option>
    </select>
  );
}

export function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return <div className="h-8" aria-hidden />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 96},${30 - ((v - min) / range) * 26}`)
    .join(" ");
  return (
    <svg viewBox="0 0 96 32" className="spark-draw h-8 w-24" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke={positive ? "#7C3AED" : "#f43f5e"}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------- Money mode picker (separate workspaces) ----------
// Three selectable cards used at setup and in Settings. Purely
// presentational: the caller owns the value and persists it (setup form,
// or the setMode action in Settings). Each mode is a completely separate
// workspace with its own records — the copy says so plainly.

import type { AppMode } from "./lib";

export function ModePicker({
  value,
  onChange,
}: {
  value: AppMode;
  onChange: (m: AppMode) => void;
}) {
  const options: {
    id: AppMode;
    icon: string;
    title: string;
    body: string;
  }[] = [
    {
      id: "personal",
      icon: "☰",
      title: "Personal Money",
      body: "Your own everyday money — what comes in, what goes out daily.",
    },
    {
      id: "business",
      icon: "▤",
      title: "Business Money",
      body: "Run a business's money — clients, invoices and growth.",
    },
    {
      id: "creator",
      icon: "✦",
      title: "Creator & Freelancer",
      body: "Client work, brand deals and platform payouts — kept apart from personal money.",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How will you use Cashflow Genius?">
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={`rounded-3xl border p-4 text-left transition sm:p-5 ${
              active
                ? "border-[var(--accent)] bg-[var(--surface-soft)] shadow-[0_10px_26px_rgba(124,58,237,0.16)]"
                : "border-[var(--border)] bg-white hover:bg-[var(--surface-soft)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-lg text-[var(--accent)] shadow-sm">
                {o.icon}
              </span>
              <span
                aria-hidden
                className={`flex h-5 w-5 items-center justify-center rounded-full border-2 text-[11px] font-extrabold ${
                  active ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--border)] text-transparent"
                }`}
              >
                ✓
              </span>
            </span>
            <span className="mt-3 block text-base font-extrabold">{o.title}</span>
            <span className="mt-1 block text-sm leading-relaxed text-[var(--dim)]">{o.body}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0) {
    return (
      <span className="text-xs font-semibold text-[var(--dim)]">
        {cur === 0 ? "No change vs last month" : "New this month"}
      </span>
    );
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span
      className={`text-xs font-bold ${up ? "text-[var(--accent)]" : "text-[#e11d63]"}`}
    >
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% vs last month
    </span>
  );
}
