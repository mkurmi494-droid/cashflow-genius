// App tour — the proper onboarding walkthrough, for every account.
//
// Shown automatically once right after a brand-new user finishes
// setting up their first workspace (the App shell opens it then), and
// re-openable any time from Settings → “App tour & help”. It explains
// every main thing in the app — Home, Money in & out, Quick Add with
// voice + SMS import, What's due, Savings goals, Find leaks & budgets,
// the AI CFO, Invoices, Reports, Scam Shield and the four separate
// money workspaces — one step at a time, moving the app to the page
// each step is about.
//
// Controls, on EVERY step: Next / Back, a visible Skip button and a ✕
// close button, and a “Don't show this tour again” checkbox. Closing
// is always allowed and never blocks the app (the card floats above
// the bottom nav; the app stays usable behind it). When the user
// finishes the tour, or closes it with the checkbox ticked, the App
// shell saves the choice on the account (dismissTour) so it never
// auto-opens again; unticked closes leave the preference alone.

import { useEffect, useRef, useState } from "react";
import type { Route } from "./types";

interface AppTourStep {
  icon: string;
  title: string;
  body: string;
  route: Route;
  /** Optional real action offered instead of plain navigation. */
  action?: "quickAdd";
  actionLabel?: string;
}

const STEPS: AppTourStep[] = [
  {
    icon: "👋",
    title: "Welcome to Cashflow Genius",
    body: "A 1-minute walkthrough of everything the app can do. Skip any time.",
    route: "dashboard",
  },
  {
    icon: "◉",
    title: "Home — your Command Center",
    body: "Available cash, this month's money in and out, savings pots, health score — all live from your records.",
    route: "dashboard",
  },
  {
    icon: "▤",
    title: "Three money modes, fully separate",
    body: "Three completely separate workspaces — own records, budgets, savings. Switch any time; switching never moves or mixes a record.",
    route: "settings",
  },
  {
    icon: "≋",
    title: "Money in & out",
    body: "Every income and expense, with category, payee and payment method. Add by hand or import a CSV; deletes come with Undo.",
    route: "money-flow",
  },
  {
    icon: "＋",
    title: "Quick Add — type it, say it, or paste it",
    body: "The fastest way in: type it, say it (🎤 Voice), or paste a bank/UPI SMS (📩). Drafts only — nothing saves until you confirm, and a message is never proof of payment.",
    route: "money-flow",
    action: "quickAdd",
    actionLabel: "Open Quick Add now",
  },
  {
    icon: "🗓",
    title: "What's due — the Money Calendar",
    body: "A month calendar plus an overdue-first list of everything coming — what to pay and what to collect, on the exact date.",
    route: "payment-calendar",
  },
  {
    icon: "🪙",
    title: "Savings goals",
    body: "Pots with a target and date. Add or withdraw any time; saved so far, what's left and your pace are all shown.",
    route: "savings",
  },
  {
    icon: "⌖",
    title: "Find leaks & budgets",
    body: "Flags duplicate subscriptions, price hikes and unusual spikes, with exact amounts. Set a monthly budget per category here too.",
    route: "profit-scanner",
  },
  {
    icon: "✦",
    title: "AI CFO — ask anything",
    body: "Ask in English or Hindi. Every answer is grounded in your real figures, with “What the AI used” shown — nothing invented.",
    route: "ai-cfo",
  },
  {
    icon: "▤",
    title: "Invoices with GST",
    body: "Create invoices with line items, discount and GST, send them, mark them paid. Overdue invoices surface on Home and in What's due.",
    route: "invoices",
  },
  {
    icon: "🛡",
    title: "Scam Shield",
    body: "Paste a suspicious UPI message or payment screenshot for a plain-language verdict. It never asks for an OTP or PIN; a message is never proof of payment.",
    route: "scam-shield",
  },
  {
    icon: "▦",
    title: "Reports, forecast & what-if",
    body: "Reports by category and month, a Future forecast, and a What-if planner to test decisions against your real run-rate.",
    route: "reports",
  },
];

export function AppTour({
  go,
  notify,
  onQuickAdd,
  onClose,
}: {
  go: (r: Route) => void;
  notify: (m: string) => void;
  onQuickAdd: () => void;
  /** dontShowAgain: persist “never auto-show” on the account. */
  onClose: (dontShowAgain: boolean) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [dontShow, setDontShow] = useState(false);
  const appliedStep = useRef(-1);
  const step = STEPS[idx]!;
  const last = idx === STEPS.length - 1;

  // Move the app to the page each step is about, once per step.
  useEffect(() => {
    if (appliedStep.current === idx) return;
    appliedStep.current = idx;
    go(step.route);
    // go is stable in the App shell; a step is applied once, when it
    // becomes current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  const close = (persist: boolean) => onClose(persist || dontShow);

  return (
    <div
      className="no-print fixed inset-x-0 bottom-0 z-[70] px-3 pb-3 sm:px-6 sm:pb-5"
      role="dialog"
      aria-label="Cashflow Genius app tour"
      aria-live="polite"
    >
      <div className="mx-auto max-w-3xl rounded-3xl border-2 border-[var(--accent-bright)] bg-white p-4 shadow-[0_24px_60px_rgba(76,29,149,0.35)] sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="sticker">🧭 App tour</span>
          <span className="text-xs font-bold text-[var(--dim)]">
            Step {idx + 1} of {STEPS.length}
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => close(false)}
              aria-label="Skip the app tour"
            >
              Skip tour
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => close(false)}
              aria-label="Close the app tour"
            >
              ✕ Close
            </button>
          </span>
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-soft)]"
          role="img"
          aria-label={`Tour progress: step ${idx + 1} of ${STEPS.length}`}
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${((idx + 1) / STEPS.length) * 100}%`, background: "var(--grad)" }}
          />
        </div>
        <h2 className="display-font mt-3 text-xl font-semibold tracking-tight">
          <span aria-hidden className="mr-2">{step.icon}</span>
          {step.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">{step.body}</p>
        <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[#7c3aed]"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            aria-label="Don't show this tour again"
          />
          Don&rsquo;t show this tour again
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost px-4 py-2.5 text-sm"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
          >
            ← Back
          </button>
          {step.action === "quickAdd" ? (
            <button
              type="button"
              className="btn-ghost px-4 py-2.5 text-sm"
              onClick={() => {
                onClose(dontShow);
                onQuickAdd();
                notify("Quick Add is open — try typing, the 🎤 Voice tab, or the 📩 SMS import tab.");
              }}
            >
              {step.actionLabel ?? "Open Quick Add"}
            </button>
          ) : null}
          {last ? (
            <button
              type="button"
              className="btn-primary px-5 py-2.5 text-sm"
              onClick={() => close(true)}
            >
              Finish — start using the app
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary px-5 py-2.5 text-sm"
              onClick={() => setIdx((i) => Math.min(STEPS.length - 1, i + 1))}
            >
              Next →
            </button>
          )}
          <span className="text-xs text-[var(--dim)]">
            The tour only navigates and explains — it never edits your data.
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`h-1.5 rounded-full transition-all ${i === idx ? "w-6 bg-[var(--accent)]" : i < idx ? "w-3 bg-[var(--accent-bright)]/60" : "w-3 bg-[var(--surface-mint)]"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
