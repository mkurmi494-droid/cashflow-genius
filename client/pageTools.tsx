import type { PageProps } from "./types";
import type { Route } from "./types";
import { SectionTitle } from "./components";

// Every tool in the app, in one place — list on a phone, grid on a
// laptop. Each card opens the real tool; nothing here is a placeholder
// and there is no "Challenge" card (we have no friends system, so we
// never fake one). Debt lives on the payment calendar, where the EMIs
// and bills actually are — the card says so instead of promising a
// separate Debt page that does not exist.
const TOOLS: { route: Route; icon: string; title: string; desc: string }[] = [
  { route: "profit-scanner", icon: "⌖", title: "Budget", desc: "50/30/20 or your own rule — plan it with AI." },
  { route: "savings", icon: "🪙", title: "Savings", desc: "Goals, pots and recurring savings." },
  { route: "lend-borrow", icon: "⇄", title: "Lend & borrow", desc: "Who owes whom, and by when." },
  { route: "payment-calendar", icon: "🗓", title: "Debt & dues", desc: "EMIs, bills and everything due, overdue first." },
  { route: "scam-shield", icon: "🛡", title: "Scam Shield", desc: "Check a message or payment screenshot." },
  { route: "what-if-lab", icon: "⚗", title: "What-if planner", desc: "Test a big decision before you take it." },
  { route: "future-lens", icon: "◎", title: "Future forecast", desc: "See money before it moves." },
  { route: "invoices", icon: "▤", title: "Invoices", desc: "Send, track and get paid." },
  { route: "tax", icon: "§", title: "GST & tax", desc: "Tax estimates — never tax advice." },
  { route: "reports", icon: "▦", title: "Reports", desc: "Your money, summarised and exportable." },
  { route: "memory-vault", icon: "✎", title: "Notes", desc: "Quick notes kept with your money." },
  { route: "ai-cfo", icon: "✦", title: "AI CFO", desc: "Ask anything about your money." },
];

export function MoneyToolsPage({ go }: PageProps) {
  return (
    <div className="page-anim space-y-5">
      <SectionTitle title="Money Tools" hint="Everything in the app, in one place." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t) => (
          <button
            key={t.route}
            type="button"
            onClick={() => go(t.route)}
            className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent)]"
          >
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--surface-soft)] text-xl text-[var(--accent)]"
            >
              {t.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{t.title}</span>
              <span className="block truncate text-sm text-[var(--muted)]">{t.desc}</span>
            </span>
            <span aria-hidden className="shrink-0 text-[var(--muted)]">
              ›
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
