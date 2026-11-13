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
    body: "“See money before it moves.” This quick tour walks through everything the app can do — about a minute, step by step. Skip it any time with Skip or ✕ above; you can reopen it later from Settings → App tour & help.",
    route: "dashboard",
  },
  {
    icon: "◉",
    title: "Home — your Command Center",
    body: "Home shows your available cash, this month's money in and out, how much is sitting in savings pots, and a money health score — plus a “Personal + Business — together” view of your workspaces side by side. Everything here is calculated live from your own records.",
    route: "dashboard",
  },
  {
    icon: "▤",
    title: "Four money modes, fully separate",
    body: "Personal Money, Business Money, Creator & Freelancer and Student / First Salary are four completely separate workspaces — own records, own budgets, own savings. Switch any time from the bar under the top bar or in Settings; switching never moves or mixes a single record.",
    route: "settings",
  },
  {
    icon: "≋",
    title: "Money in & out",
    body: "Your ledger: every income and expense with category, payee and payment method (UPI, cash, card, bank transfer). Add entries by hand, import a bank CSV (exact duplicates are skipped automatically), and edit or delete anything — deletes come with an Undo button.",
    route: "money-flow",
  },
  {
    icon: "＋",
    title: "Quick Add — type it, say it, or paste it",
    body: "The big + button (bottom centre on phones, top bar on desktop) is the fastest way in. Three ways: type it · tap 🎤 Voice and say “500 rupees kharcha chai” · or 📩 paste a bank/UPI SMS and it fills the form for you. Voice and SMS only ever make a draft — nothing is saved until you review and confirm, and a pasted message is never treated as proof of payment.",
    route: "money-flow",
    action: "quickAdd",
    actionLabel: "Open Quick Add now",
  },
  {
    icon: "🗓",
    title: "What's due — the Money Calendar",
    body: "A month calendar plus an overdue-first list of everything coming: recurring bills, unpaid invoices, pending payments and EMI instalments — what you must pay and what you're due to collect, on the exact date. Collecting an EMI instalment records the income exactly once.",
    route: "payment-calendar",
  },
  {
    icon: "🪙",
    title: "Savings goals",
    body: "Create a pot for anything — emergency fund, a laptop, a trip — with a target and a date. Add or withdraw money any time; the app shows saved so far, what's left, progress % and whether your pace is on track. Money in pots is set aside, not spent, and available cash everywhere already excludes it.",
    route: "savings",
  },
  {
    icon: "⌖",
    title: "Find leaks & budgets",
    body: "The Leak Scanner reads your real transactions and flags duplicate subscriptions, price hikes and unusual spikes — with the exact amounts. Set a monthly budget per category on the same page and watch spending against it, in this workspace only.",
    route: "profit-scanner",
  },
  {
    icon: "✦",
    title: "AI CFO — ask anything",
    body: "Ask about your money in English or Hinglish (“Mera cash kab khatm hoga?”). Every answer is grounded in your real figures and shows “What the AI used” — the exact amounts and dates it calculated from — so nothing is ever invented. Try the suggested questions to start.",
    route: "ai-cfo",
  },
  {
    icon: "▤",
    title: "Invoices with GST",
    body: "Create invoices with line items, discount and GST, send them, and mark them paid — the payment lands in your ledger exactly once, linked to the invoice, never double-counted. Overdue invoices surface on Home and in What's due automatically.",
    route: "invoices",
  },
  {
    icon: "🛡",
    title: "Scam Shield",
    body: "Got a suspicious UPI or payment message? Paste it (or a payment screenshot claim) here and get a plain-language verdict with the exact signs it found. It never asks for an OTP or PIN, and it always reminds you: a message is never proof of payment — verify in your bank/UPI app.",
    route: "scam-shield",
  },
  {
    icon: "▦",
    title: "Reports, forecast & what-if",
    body: "Reports break your money down by category and month; the Future forecast projects what's coming; and the What-if planner lets you test “what if sales drop 20%?” against your real run-rate before it happens. That's the tour — your workspace starts empty, with only your own records. Add your first entry whenever you're ready.",
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
            The tour only navigates and explains — it never edits your data. Reopen it any
            time from Settings → App tour &amp; help.
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
