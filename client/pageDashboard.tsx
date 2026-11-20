import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Area,
AreaChart,
Bar,
BarChart,
CartesianGrid,
Cell,
Pie,
PieChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import {
APP_MODES,
MODE_ICONS,
MODE_LABELS,
fmtMoney,
healthScore,
isPersonalLike,
modeOf,
monthKey,
monthLabel,
prettyDate,
shiftMonth,
summarise,
todayStr,
totalSavedCents,
SAVINGS_STATUS_LABELS,
type AppMode,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, Delta, EmptyState, GlassOrb, SectionTitle, Sparkline } from "./components";
import { AnimatedMoney, AnimatedProgress, Reveal } from "./anim";

const PIE_COLORS = ["#7C3AED", "#D946EF", "#FB7185", "#FB923C", "#38BDF8", "#A78BFA", "#F472B6"];

// ---------- Both modes together ----------
// Personal and Business (plus Creator when used) stay fully
// separate workspaces — their records are never merged. This panel only
// READS each workspace's own totals (via getCombinedSummary, which never
// changes the active workspace) and shows them side by side, with a
// combined overview underneath. Tapping a workspace opens it in one tap
// through the same setMode action used everywhere else.
function DualModePanel({ state, notify, confirm }: { state: PageProps["state"]; notify: PageProps["notify"]; confirm: PageProps["confirm"] }) {
  const queryClient = useQueryClient();
  const active = modeOf(state);
  const combinedQ = useQuery({
    queryKey: ["cg-combined"],
    queryFn: () => api.getCombinedSummary({}),
    staleTime: 30_000,
    retry: 1,
  });
  const switchMode = useMutation({
    mutationFn: (m: AppMode) => api.setMode({ mode: m }),
    onSuccess: (_res, m) => {
      // Narrow invalidation: the App-level cg:mutated listener
      // already patches + refetches ["cg-state"] and ["cg-combined"]
      // on setMode. Invalidating EVERYTHING here used to also refire
      // ["briefing"] and ["cg-auth"] at the same instant — a third
      // and fourth parallel connection during the switch burst, on
      // top of the two ledger refetches. The briefing refetches
      // itself when the transaction count changes; auth needs no
      // refetch on a mode switch.
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
      notify(
        m === active
          ? `You are already in ${MODE_LABELS[m]}.`
          : `Switched to ${MODE_LABELS[m]} — its own records, exactly as you left them. Your other workspaces stay saved and untouched.`,
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askSwitch = async (m: AppMode) => {
    if (m === active) return;
    const ok = await confirm({
      title: `Open ${MODE_LABELS[m]}?`,
      body: `You will switch to the ${MODE_LABELS[m]} workspace and see its own records.`,
      detail: `${MODE_LABELS[active]} stays saved exactly as it is — switching never moves, merges or deletes anything.`,
      confirmLabel: `Open ${MODE_LABELS[m]}`,
    });
    if (ok) switchMode.mutate(m);
  };

  const data = combinedQ.data;
  const cur = data?.currency ?? state.business.currency;
  const mainTwo = data?.workspaces.filter((w) => w.mode === "personal" || w.mode === "business") ?? [];
  const others = data?.workspaces.filter(
    (w) => w.mode === "creator" && (w.exists || w.txnCount > 0),
  ) ?? [];

  return (
    <section className="card p-5 sm:p-6" aria-label="Personal and Business together">
      <SectionTitle
        title="Personal + Business — together"
        hint="Both workspaces stay saved at the same time. Use either one whenever you need it — nothing is ever mixed."
        action={
          <button
            type="button"
            className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
            onClick={() => void combinedQ.refetch()}
            disabled={combinedQ.isFetching}
          >
            {combinedQ.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      {combinedQ.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading both workspaces">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="skeleton h-36" />
            <div className="skeleton h-36" />
          </div>
          <div className="skeleton h-16" />
        </div>
      ) : combinedQ.isError || !data ? (
        <div className="rounded-xl bg-[var(--err)] p-3 text-sm text-[var(--err-text)]">
          The combined view could not load just now. Each workspace's own figures are unaffected.{" "}
          <button type="button" className="font-bold underline" onClick={() => void combinedQ.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {mainTwo.map((w) => {
              const wm = w.mode as AppMode;
              const isActive = wm === active;
              return (
                <article
                  key={w.mode}
                  className={`rounded-3xl border p-4 ${isActive ? "border-[var(--accent)] bg-[var(--surface-soft)]" : "border-[var(--border)] bg-white"}`}
                  aria-label={`${w.label} summary`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-extrabold">
                        <span aria-hidden>{MODE_ICONS[wm]}</span>
                        {w.label}
                        {isActive ? (
                          <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-white">OPEN NOW</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--dim)]">
                        {w.exists ? w.name : "Not started yet — open it to begin, it starts empty"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Cash</p>
                      <p className="tnum text-lg font-extrabold">{fmtMoney(w.cashCents, cur)}</p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-2xl bg-[var(--surface-soft)] px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-[var(--dim)]">In · this month</dt>
                      <dd className="tnum mt-0.5 text-sm font-extrabold text-[var(--accent)]">{fmtMoney(w.curIncomeCents, cur)}</dd>
                    </div>
                    <div className="rounded-2xl bg-[var(--surface-soft)] px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-[var(--dim)]">Out · this month</dt>
                      <dd className="tnum mt-0.5 text-sm font-extrabold text-[#e11d63]">{fmtMoney(w.curExpenseCents, cur)}</dd>
                    </div>
                    <div className="rounded-2xl bg-[var(--surface-soft)] px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-[var(--dim)]">Net · this month</dt>
                      <dd className="tnum mt-0.5 text-sm font-extrabold">{fmtMoney(w.curNetCents, cur)}</dd>
                    </div>
                  </dl>
                  <p className="mt-2.5 text-xs leading-relaxed text-[var(--dim)]">
                    All time: in {fmtMoney(w.incomeCents, cur)} · out {fmtMoney(w.expenseCents, cur)} ·{" "}
                    {w.txnCount} transaction(s)
                    {w.budgetCount > 0 ? ` · ${w.budgetCount} budget(s)` : ""}
                    {w.recurringCount > 0 ? ` · ${w.recurringCount} recurring` : ""}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    🪙 <strong className="tnum text-[var(--accent)]">Saved in pots:{" "}{fmtMoney(w.savedCents, cur)}</strong>
                    {w.savingsGoalCount > 0
                      ? ` across ${w.savingsGoalCount} goal(s) in ${w.label} only`
                      : ` — no savings goals in ${w.label} yet`}
                    . Cash above already excludes it, so it is never counted twice.
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    {w.upcomingCount > 0
                      ? `Next 30 days: pay ${fmtMoney(w.upcomingPayCents, cur)} · collect ${fmtMoney(w.upcomingCollectCents, cur)} (${w.upcomingCount} due)`
                      : "Nothing due in the next 30 days in this workspace."}
                    {w.overdueCount > 0 ? (
                      <span className="font-bold text-[#e11d63]">
                        {" "}· {w.overdueCount} overdue ({fmtMoney(w.overdueCents, cur)})
                      </span>
                    ) : null}
                  </p>
                  <button
                    type="button"
                    className={isActive ? "btn-ghost mt-3 w-full px-4 py-2.5 text-sm" : "btn-primary mt-3 w-full px-4 py-2.5 text-sm"}
                    disabled={switchMode.isPending}
                    onClick={() => {
                      if (!isActive) void askSwitch(wm);
                    }}
                    aria-label={isActive ? `${w.label} is open now` : `Open ${w.label} workspace`}
                  >
                    {isActive ? "✓ Open now — this is where you are" : `Open ${w.label} →`}
                  </button>
                </article>
              );
            })}
          </div>

          {others.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Other workspaces">
              {others.map((w) => {
                const wm = w.mode as AppMode;
                return (
                  <button
                    key={w.mode}
                    type="button"
                    className="btn-ghost px-3 py-2 text-xs"
                    disabled={switchMode.isPending}
                    onClick={() => void askSwitch(wm)}
                    aria-label={`Open ${w.label} workspace — cash ${fmtMoney(w.cashCents, cur)}, saved in pots ${fmtMoney(w.savedCents, cur)}`}
                  >
                    {MODE_ICONS[wm]} {w.label}: {fmtMoney(w.cashCents, cur)} · 🪙 {fmtMoney(w.savedCents, cur)} saved
                    {wm === active ? " · open now" : " →"}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="mt-4 rounded-3xl bg-[var(--surface-mint)]/60 p-4" aria-label="Combined cashflow summary">
            <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--accent)]">
              Combined cashflow — all your workspaces together
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Combined cash</p>
                <p className="tnum mt-0.5 text-xl font-extrabold">{fmtMoney(data.combined.cashCents, cur)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Combined saved in pots</p>
                <p className="tnum mt-0.5 text-xl font-extrabold text-[var(--accent)]">{fmtMoney(data.combined.savedCents, cur)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">This month in</p>
                <p className="tnum mt-0.5 text-xl font-extrabold text-[var(--accent)]">{fmtMoney(data.combined.curIncomeCents, cur)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">This month out</p>
                <p className="tnum mt-0.5 text-xl font-extrabold text-[#e11d63]">{fmtMoney(data.combined.curExpenseCents, cur)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">This month net</p>
                <p className="tnum mt-0.5 text-xl font-extrabold">{fmtMoney(data.combined.curNetCents, cur)}</p>
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
              All time combined: in {fmtMoney(data.combined.incomeCents, cur)} · out{" "}
              {fmtMoney(data.combined.expenseCents, cur)} · net {fmtMoney(data.combined.netCents, cur)} across{" "}
              {data.combined.txnCount} transaction(s). Next 30 days combined: pay{" "}
              {fmtMoney(data.combined.upcomingPayCents, cur)} · collect{" "}
              {fmtMoney(data.combined.upcomingCollectCents, cur)}
              {data.combined.overdueCount > 0
                ? ` · ${data.combined.overdueCount} overdue item(s) totalling ${fmtMoney(data.combined.overdueCents, cur)} — check the Payment Calendar in each workspace.`
                : "."}{" "}
              This combined view only adds the separate totals up for an overview — every transaction,
              budget, recurring schedule and calendar item still belongs to its own workspace and is
              tracked there. Forecasts and reports also stay per workspace, so nothing is double-counted
              or moved.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Switch workspace in one tap">
              {APP_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={m === active}
                  disabled={switchMode.isPending}
                  onClick={() => {
                    if (m !== active) void askSwitch(m);
                  }}
                  className={`rounded-full px-3 py-2 text-xs font-bold transition ${
                    m === active
                      ? "bg-[var(--accent)] text-white"
                      : "bg-white text-[var(--dim)] shadow-[inset_0_0_0_1px_var(--border)]"
                  }`}
                >
                  {MODE_ICONS[m]} {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- Genius Insights ----------
// Proactive findings computed from THIS workspace's own rows by
// deterministic rules (server/lib/insights.ts) — no AI call, no
// extra cost. The server regenerates them lazily (older than 6
// hours) and after ledger mutations; this panel only reads them and
// lets the user act: Dismiss, Expected, Remind me later, or Review
// in Money Flow. Nothing here is seeded or invented — every figure
// comes from a real transaction, invoice, schedule or EMI.
type GeniusInsight = ApiResponse<typeof api, "getInsights">["insights"][number];

function evidenceLine(ins: GeniusInsight, cur: string): string | null {
  const ev = ins.evidenceJson as Record<string, unknown>;
  const num = (k: string): number | null =>
    typeof ev[k] === "number" ? (ev[k] as number) : null;
  const str = (k: string): string =>
    typeof ev[k] === "string" ? (ev[k] as string) : "";
  switch (ins.insightType) {
    case "spending_spike": {
      const c = num("currentMonthCents");
      const a = num("avgMonthCents");
      const p = num("pctAbove");
      return c != null && a != null
        ? `${str("category")} · ${fmtMoney(c, cur)} vs usual ${fmtMoney(a, cur)}${p != null ? ` · +${p}%` : ""}`
        : null;
    }
    case "income_drop": {
      const c = num("currentMonthCents");
      const a = num("avgMonthCents");
      const p = num("pctBelow");
      return c != null && a != null
        ? `Income ${fmtMoney(c, cur)} vs usual ${fmtMoney(a, cur)}${p != null ? ` · −${p}%` : ""}`
        : null;
    }
    case "unusual_transaction": {
      const a = num("amountCents");
      const m = num("medianCents");
      const x = num("multiple");
      return a != null && m != null
        ? `${str("description")} · ${fmtMoney(a, cur)} vs median ${fmtMoney(m, cur)}${x != null ? ` · ${x}x` : ""}`
        : null;
    }
    case "recurring_payment": {
      const a = num("amountCents");
      const months = num("months");
      return a != null
        ? `${str("payee")} · ${fmtMoney(a, cur)} a month${months != null ? ` · ${months} months in a row` : ""}`
        : null;
    }
    case "invoice_risk": {
      const u = num("unpaidCents");
      const uc = num("unpaidCount");
      const oc = num("overdueCount");
      return u != null && uc != null
        ? `${uc} unpaid · ${fmtMoney(u, cur)}${oc != null && oc > 0 ? ` · ${oc} overdue` : ""}`
        : null;
    }
    case "cash_shortage": {
      const low = num("minBalanceCents");
      const inC = num("expectedInCents");
      const outC = num("expectedOutCents");
      return low != null
        ? `Low ${fmtMoney(low, cur)}${str("minDate") ? ` on ${prettyDate(str("minDate"))}` : ""}${inC != null && outC != null ? ` · in ${fmtMoney(inC, cur)} / out ${fmtMoney(outC, cur)}` : ""}`
        : null;
    }
    case "profit_leak": {
      const c = num("currentMonthCents");
      const p = num("previousMonthCents");
      const pct = num("pctIncrease");
      return c != null && p != null
        ? `${str("category")} · ${fmtMoney(c, cur)} vs ${fmtMoney(p, cur)} last month${pct != null ? ` · +${pct}%` : ""}`
        : null;
    }
    case "savings_opportunity": {
      const c = num("currentMonthCents");
      const p = num("previousMonthCents");
      const s = num("savedCents");
      return c != null && p != null
        ? `${str("category")} · ${fmtMoney(c, cur)} vs ${fmtMoney(p, cur)} last month${s != null ? ` · ${fmtMoney(s, cur)} saved` : ""}`
        : null;
    }
    default:
      return null;
  }
}

const INSIGHT_SEVERITY: Record<string, { label: string; tone: "err" | "warn" | "ai"; border: string }> = {
  critical: { label: "Needs attention now", tone: "err", border: "border-l-[#e11d63]" },
  warning: { label: "Worth a look", tone: "warn", border: "border-l-[#d97706]" },
  info: { label: "Heads up", tone: "ai", border: "border-l-[#7c3aed]" },
};

function GeniusInsightsPanel({ state, go, notify }: { state: PageProps["state"]; go: PageProps["go"]; notify: PageProps["notify"] }) {
  const queryClient = useQueryClient();
  const cur = state.business.currency;
  const insightsQ = useQuery({
    queryKey: ["cg-insights", state.activeMode],
    queryFn: () => api.getInsights({}),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
  const act = useMutation({
    mutationFn: ({ kind, id }: { kind: "dismiss" | "expected" | "snooze"; id: string }) =>
      kind === "dismiss"
        ? api.dismissInsight({ id })
        : kind === "expected"
          ? api.markInsightExpected({ id })
          : api.snoozeInsight({ id }),
    onSuccess: (_res, { kind }) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-insights"] });
      notify(
        kind === "snooze"
          ? "Got it — reminding you about this in 7 days."
          : kind === "expected"
            ? "Marked as expected — it will not be flagged again."
            : "Insight dismissed.",
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const refresh = useMutation({
    // Explicit Re-check: force the run past the 60-second guard so the
    // card reflects the ledger as it is right now.
    mutationFn: () => api.generateInsights({ force: true }),
    onSuccess: (res) => {
      // The regeneration already computed the fresh findings — write
      // them straight into the cache so the panel shows the new card
      // in the same tick as the toast. The invalidated refetch below
      // only reconciles afterwards: on its own it was the whole
      // refresh, and when that refetch stalled behind a slow queued
      // read the panel kept its old card until a full reload.
      queryClient.setQueryData(["cg-insights", state.activeMode], {
        insights: res.insights,
        generatedAt: res.generatedAt,
        generatedFresh: true,
      });
      void queryClient.invalidateQueries({ queryKey: ["cg-insights"] });
      notify("Insights re-checked from your latest records.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const insights = insightsQ.data?.insights ?? [];
  const generatedAt = insightsQ.data?.generatedAt ?? null;
  const checkedLabel = insightsQ.data?.generatedFresh
    ? "Checked just now"
    : generatedAt
      ? `Last checked ${new Date(generatedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : null;

  return (
    <section className="card p-5 sm:p-6" aria-label="Genius Insights">
      <SectionTitle
        title="✦ Genius Insights"
        hint="Things the app noticed in this workspace — checked from your real records, with no AI call. Estimates only, never predictions."
        action={
          <button
            type="button"
            className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? "Checking…" : "Re-check"}
          </button>
        }
      />
      {insightsQ.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading insights">
          <div className="skeleton h-20" />
          <div className="skeleton h-20" />
        </div>
      ) : insightsQ.isError || !insightsQ.data ? (
        <div className="rounded-xl bg-[var(--err)] p-3 text-sm text-[var(--err-text)]">
          Insights could not load just now. Your figures above are unaffected.{" "}
          <button type="button" className="font-bold underline" onClick={() => void insightsQ.refetch()}>
            Try again
          </button>
        </div>
      ) : insights.length === 0 ? (
        <p className="text-sm leading-relaxed text-[var(--dim)]">
          No insights need attention right now — your numbers look steady.
          {checkedLabel ? ` ${checkedLabel}.` : ""}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {insights.map((ins) => {
              const sev = INSIGHT_SEVERITY[ins.severity] ?? INSIGHT_SEVERITY.info!;
              const ev = evidenceLine(ins, cur);
              return (
                <li
                  key={ins.id}
                  className={`rounded-3xl border border-l-4 border-[var(--border)] bg-white p-4 ${sev.border}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm font-extrabold leading-snug">{ins.title}</p>
                    <Badge tone={sev.tone}>{sev.label}</Badge>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">{ins.description}</p>
                  {ev ? (
                    <p className="tnum mt-1.5 text-xs font-bold text-[var(--accent)]">{ev}</p>
                  ) : null}
                  {ins.recommendedAction ? (
                    <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">Suggested:{" "}{ins.recommendedAction}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => go("money-flow")}
                    >
                      Review →
                    </button>
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: "expected", id: ins.id })}
                    >
                      Expected
                    </button>
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: "snooze", id: ins.id })}
                    >
                      Remind me later
                    </button>
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: "dismiss", id: ins.id })}
                    >
                      Dismiss
                    </button>
                    <span className="ml-auto text-[11px] text-[var(--dim)]">
                      Confidence: {ins.confidenceLabel}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {checkedLabel ? (
            <p className="mt-3 text-xs text-[var(--dim)]">{checkedLabel} · re-checked automatically after new transactions, imports and invoice changes.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function DashboardPage({ state, go, notify, confirm, onQuickAdd, onShowTour }: PageProps) {
  const cur = state.business.currency;
  const personal = isPersonalLike(modeOf(state));
  const s = useMemo(() => summarise(state), [state]);
  const score = healthScore(state, s);
  const [now, setNow] = useState(new Date());
  const queryClient = useQueryClient();

  // Recurring savings have no background job — opening the app is what
  // moves scheduled money. Apply due schedules once per mount; the
  // action is idempotent (a second call finds nothing due), so the
  // Savings page firing it too is harmless. Only a real application
  // notifies — a skipped schedule is reported on the Savings page,
  // where the user can act on it.
  const schedulesAppliedRef = useRef(false);
  const applySchedulesMut = useMutation({
    mutationFn: () => api.applyDueSavingsSchedules({}),
    onSuccess: (res) => {
      if (res.applied.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-savings-schedules"] });
        const total = res.applied.reduce((a, x) => a + x.amountCents, 0);
        notify(
          res.applied.length === 1
            ? `Scheduled savings applied: ${fmtMoney(total, cur)} moved into “${res.applied[0]?.goalName}”.`
            : `Scheduled savings applied: ${fmtMoney(total, cur)} moved into ${res.applied.length} pots.`,
        );
      }
    },
  });
  useEffect(() => {
    if (schedulesAppliedRef.current) return;
    schedulesAppliedRef.current = true;
    applySchedulesMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const briefing = useQuery({
    queryKey: ["briefing", state.transactions.length],
    queryFn: () => api.getBriefing({}),
    enabled: state.transactions.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const months = useMemo(() => {
    const curKey = monthKey(todayStr());
    return Array.from({ length: 6 }, (_, i) => {
      const mk = shiftMonth(curKey, i - 5);
      const posted = state.transactions.filter(
        (t) => t.status === "posted" && monthKey(t.date) === mk,
      );
      const rev = posted.filter((t) => t.type === "income").reduce((a, t) => a + t.amountCents, 0);
      const exp = posted.filter((t) => t.type === "expense").reduce((a, t) => a + t.amountCents, 0);
      return {
        month: monthLabel(mk),
        revenue: rev / 100,
        expenses: exp / 100,
        net: (rev - exp) / 100,
      };
    });
  }, [state]);

  const byCategory = (type: "income" | "expense") => {
    const map = new Map<string, number>();
    for (const t of state.transactions) {
      if (t.type === type && t.status === "posted") {
        map.set(t.category, (map.get(t.category) ?? 0) + t.amountCents);
      }
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, value: v / 100 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  };
  const incomeBreak = byCategory("income");
  const expenseBreak = byCategory("expense");

  const trendFor = (type: "income" | "expense") =>
    months.map((m) => (type === "income" ? m.revenue : m.expenses));

  const upcoming = useMemo(() => {
    const items: { label: string; date: string; cents: number; kind: string }[] = [];
    for (const inv of state.invoices) {
      if (inv.status === "sent") {
        items.push({
          label: `Invoice ${inv.number} — ${inv.customerName}`,
          date: inv.dueDate,
          cents: inv.totalCents,
          kind: inv.effectiveStatus === "overdue" ? "Overdue invoice" : "Invoice due",
        });
      }
    }
    for (const r of state.recurring) {
      if (r.active) {
        items.push({
          label: r.description || r.category,
          date: r.nextDate,
          cents: r.type === "expense" ? -r.amountCents : r.amountCents,
          kind: "Recurring",
        });
      }
    }
    for (const t of state.transactions) {
      if (t.status === "pending") {
        items.push({
          label: t.description || t.category,
          date: t.date,
          cents: t.type === "expense" ? -t.amountCents : t.amountCents,
          kind: "Pending",
        });
      }
    }
    return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  }, [state]);

  const recent = state.transactions.slice(0, 7);
  const greeting =
    now.getHours() < 12 ? "Good morning" : now.getHours() < 17 ? "Good afternoon" : "Good evening";

  const kpis = [
    {
      label: personal ? "Total Income" : "Total Revenue",
      value: s.revenueCents,
      cur: s.curRevenueCents,
      prev: s.prevRevenueCents,
      trend: trendFor("income"),
      good: true,
    },
    {
      label: personal ? "Total Spending" : "Total Expenses",
      value: s.expensesCents,
      cur: s.curExpensesCents,
      prev: s.prevExpensesCents,
      trend: trendFor("expense"),
      good: false,
    },
    {
      label: personal ? "Left Over" : "Net Profit",
      value: s.profitCents,
      cur: s.curRevenueCents - s.curExpensesCents,
      prev: s.prevRevenueCents - s.prevExpensesCents,
      trend: months.map((m) => m.net),
      good: true,
    },
    {
      label: personal ? "Money Available" : "Available Cash",
      value: s.cashCents,
      cur: s.curRevenueCents - s.curExpensesCents,
      prev: s.prevRevenueCents - s.prevExpensesCents,
      trend: months.map((m) => m.net),
      good: true,
    },
  ];

  return (
    <div className="page-anim space-y-6">
      {/* Hero — home at a glance: the numbers that matter and the
          actions people use most, first. Available cash, this month
          in/out and total saved sit on the deep-emerald panel; Add,
          Savings, What's due and the AI CFO are one tap away here. */}
      <section className="hero-panel relative overflow-hidden p-5 sm:p-7">
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[#fbf7ea]/75">
              {now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}{" "}
              ·{" "}
              <button
                type="button"
                className="underline decoration-dotted"
                aria-label="Refresh current time"
                onClick={() => setNow(new Date())}
              >
                {now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </button>
            </p>
            <h1 className="display-font mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
              {greeting}
              {state.business.ownerName ? `, ${state.business.ownerName.split(" ")[0]}` : ""}
            </h1>
            {state.business.name ? (
              <p className="mt-0.5 text-base font-bold text-white/85">{state.business.name}</p>
            ) : null}
            <div className="mt-5">
              <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#fbf7ea]/70">
                {personal ? "Money available" : "Available cash"}
              </p>
              <p className="display-font tnum mt-1 text-4xl font-semibold sm:text-5xl">
                <AnimatedMoney cents={s.cashCents} currency={cur} />
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
                <span className="chip-glass rounded-full px-3 py-1.5">
                  This month in · <span className="tnum">{fmtMoney(s.curRevenueCents, cur)}</span>
                </span>
                <span className="chip-glass rounded-full px-3 py-1.5">
                  This month out · <span className="tnum">{fmtMoney(s.curExpensesCents, cur)}</span>
                </span>
                <span className="chip-glass rounded-full px-3 py-1.5">
                  🪙 Saved in pots · <span className="tnum">{fmtMoney(totalSavedCents(state), cur)}</span>
                </span>
              </div>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-[#fbf7ea]/85">
              {state.transactions.length === 0
                ? personal
                  ? "Nothing recorded yet. Add your first income or daily expense with the Add button below — or take the 1-minute app tour (Settings → App tour & help) to see everything first."
                  : "Your ledger is empty. Add your first transaction with the Add button below — or take the 1-minute app tour (Settings → App tour & help) to see everything first."
                : score >= 70
                  ? personal
                    ? "Your money is in a healthy position. Income is covering your spending and the recent trend is on your side."
                    : "Your business is in a healthy position. Cash is covering commitments and the recent trend is on your side."
                  : score >= 45
                    ? personal
                      ? "Your money is stable but worth watching — check the Cashflow Radar and Future forecast for what is coming."
                      : "Your business is stable but worth watching — check the Cashflow Radar and Future forecast for what is coming."
                    : personal
                      ? "Your numbers need attention. Start with this month's biggest spending categories and your budgets."
                      : "Your numbers need attention. Start with overdue invoices and the leak scanner."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="chip-glass rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide">
                {MODE_ICONS[modeOf(state)]} {MODE_LABELS[modeOf(state)]} — the others stay saved alongside
              </span>
              <span className="chip-glass rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide">
                Health: {state.transactions.length === 0 ? "No data yet" : score >= 70 ? "Strong" : score >= 45 ? "Watch" : "At risk"}
              </span>
              {s.runwayMonths != null ? (
                <span className="chip-glass rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide">
                  Runway ≈ {s.runwayMonths.toFixed(1)} months
                </span>
              ) : state.transactions.length > 0 ? (
                <span className="chip-glass rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide">
                  Not burning cash on average
                </span>
              ) : null}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-full bg-[var(--gold)] px-5 py-3 text-sm font-extrabold text-[#431407] shadow-[0_10px_24px_rgba(251,146,60,0.35)] transition hover:brightness-105 active:scale-[0.97]"
                onClick={() => (onQuickAdd ? onQuickAdd() : go("money-flow"))}
              >
                ＋ Add money in or out
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-3 text-sm font-extrabold text-[var(--accent-deep)] shadow-[0_10px_24px_rgba(76,29,149,0.3)] transition hover:brightness-105 active:scale-[0.97]"
                onClick={() => go("savings")}
              >
                🪙 Add to savings
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-3 text-sm font-extrabold text-[var(--accent-deep)] shadow-[0_10px_24px_rgba(76,29,149,0.3)] transition hover:brightness-105 active:scale-[0.97]"
                onClick={() => go("payment-calendar")}
              >
                🗓 What&rsquo;s due
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-4 py-3 text-sm font-extrabold text-[var(--accent-deep)] shadow-[0_10px_24px_rgba(76,29,149,0.3)] transition hover:brightness-105 active:scale-[0.97]"
                onClick={() => go("ai-cfo")}
              >
                ✦ Ask the AI CFO
              </button>
              {onShowTour ? (
                <button
                  type="button"
                  className="rounded-full bg-white px-4 py-3 text-sm font-extrabold text-[var(--accent-deep)] shadow-[0_10px_24px_rgba(76,29,149,0.3)] transition hover:brightness-105 active:scale-[0.97]"
                  onClick={onShowTour}
                  aria-label="Take the guided app tour"
                >
                  🧭 Take the app tour
                </button>
              ) : null}
            </div>
          </div>
          <div className="hidden shrink-0 sm:block">
            <GlassOrb
              size={168}
              label={state.transactions.length ? `${score} / 100` : "—"}
              sub={personal ? "Money health score" : "Business health score"}
            />
          </div>
        </div>
      </section>

      {/* Genius Insights — proactive findings from this workspace's
          own records, right under the hero so they are seen first. */}
      <Reveal><GeniusInsightsPanel state={state} go={go} notify={notify} /></Reveal>

      {/* KPIs */}
      <section aria-label="Key financial figures">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((k, i) => (
            <article key={k.label} className="card card-hover rise p-4" style={{ animationDelay: `${i * 70}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">{k.label}</p>
                  <p className="display-font tnum mt-1 text-[26px] font-semibold tracking-tight">
                    <AnimatedMoney cents={k.value} currency={cur} duration={850 + i * 90} />
                  </p>
                </div>
                <Sparkline values={k.trend} positive={k.good ? k.value >= 0 : k.cur <= k.prev} />
              </div>
              <div className="mt-2">
                <Delta cur={k.cur} prev={k.prev} />
                <span className="ml-2 text-xs text-[var(--dim)]">
                  This month {fmtMoney(k.label === "Total Revenue" || k.label === "Total Expenses" ? k.cur : k.cur, cur)}
                </span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Reveal><DualModePanel state={state} notify={notify} confirm={confirm} /></Reveal>

      {/* Savings — total saved across goals in the ACTIVE workspace.
          Per-workspace saved totals (Personal separately from Business,
          and so on) are in the together panel above; this section is
          the open workspace's own pots, from its own transfers only. */}
      <section className="card p-5 sm:p-6" aria-label="Savings in this workspace">
        <SectionTitle
          title={`🪙 Savings — ${MODE_LABELS[modeOf(state)]}`}
          hint="Total saved across this workspace's goals. Adding or withdrawing is a transfer — never income or spending — so nothing double-counts."
          action={
            <button type="button" className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={() => go("savings")}>
              Open Savings
            </button>
          }
        />
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Total saved in this workspace</p>
            <p className="tnum mt-0.5 text-3xl font-extrabold text-[var(--accent)]"><AnimatedMoney cents={totalSavedCents(state)} currency={cur} /></p>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-[var(--dim)]">
            {state.savingsGoals.length === 0
              ? "No savings goals yet in this workspace. Create a pot with a target amount and date, then add money in small transfers whenever you can."
              : `Across ${state.savingsGoals.length} goal(s). Available cash (${fmtMoney(s.cashCents, cur)}) already excludes this saved money — it is set aside, not spent.`}
          </p>
        </div>
        {state.savingsGoals.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {state.savingsGoals.slice(0, 3).map((g) => (
              <li key={g.id}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-bold">
                    {g.name}{" "}
                    <span className="ml-1 font-semibold text-[var(--dim)]">
                      · {SAVINGS_STATUS_LABELS[g.status] ?? g.status} · by {prettyDate(g.targetDate)}
                    </span>
                  </span>
                  <span className="tnum shrink-0 font-extrabold">
                    {fmtMoney(g.savedCents, cur)} <span className="font-semibold text-[var(--dim)]">of {fmtMoney(g.targetCents, cur)} · {g.progressPct}%</span>
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-soft)]" role="img" aria-label={`${g.progressPct}% saved toward ${g.name}`}>
                  <AnimatedProgress pct={g.progressPct} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {state.savingsGoals.length > 3 ? (
          <p className="mt-3 text-xs text-[var(--dim)]">
            + {state.savingsGoals.length - 3} more goal(s) — see them all in Savings.
          </p>
        ) : null}
      </section>

      {state.transactions.length === 0 ? (
        <EmptyState
          title="Nothing to chart yet"
          body="Charts, the Cashflow Radar and the AI briefing all calculate live from your transactions. Add one manually, say it with Voice entry in Quick Add, paste a bank SMS there, or import a CSV in Money Flow."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className="btn-primary px-5 py-2.5 text-sm" onClick={() => go("money-flow")}>
                Add a transaction
              </button>
              {onShowTour ? (
                <button type="button" className="btn-ghost px-5 py-2.5 text-sm" onClick={onShowTour}>
                  🧭 Take the app tour
                </button>
              ) : null}
            </div>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <section className="card p-5 lg:col-span-3" aria-label="Revenue versus expenses">
              <SectionTitle title={personal ? "Income vs Spending" : "Revenue vs Expenses"} hint="Posted transactions, last 6 months" />
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={months}>
                    <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6D6390" }} />
                    <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
                    <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                    <Area type="monotone" dataKey="revenue" name={personal ? "Income" : "Revenue"} stroke="#7C3AED" fill="#E9D5FF" strokeWidth={2.4} isAnimationActive animationDuration={900} animationEasing="ease-out" />
                    <Area type="monotone" dataKey="expenses" name={personal ? "Spending" : "Expenses"} stroke="#FB7185" fill="#FFE4E6" strokeWidth={2.4} isAnimationActive animationDuration={900} animationEasing="ease-out" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="card p-5 lg:col-span-2" aria-label="AI daily briefing">
              <SectionTitle
                title="AI Daily Briefing"
                hint="Generated from today's calculated figures"
                action={
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => briefing.refetch()}
                  >
                    Refresh
                  </button>
                }
              />
              {briefing.isPending ? (
                <p className="text-sm text-[var(--dim)]">Reading your numbers…</p>
              ) : briefing.isError ? (
                <div className="rounded-xl bg-[var(--err)] p-3 text-sm text-[var(--err-text)]">
                  The briefing could not be generated right now. Your figures above are unaffected.{" "}
                  <button type="button" className="font-bold underline" onClick={() => briefing.refetch()}>
                    Try again
                  </button>
                </div>
              ) : briefing.data ? (
                <div>
                  <p className="font-bold">{briefing.data.headline}</p>
                  <ul className="mt-2 space-y-2">
                    {briefing.data.points.map((p, i) => (
                      <li key={i} className="flex gap-2 text-sm text-[var(--dim)]">
                        <span aria-hidden className="mt-0.5 text-[var(--accent)]">●</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn-ghost mt-4 px-4 py-2 text-xs"
                    onClick={() => go("ai-cfo")}
                  >
                    Ask the AI CFO →
                  </button>
                </div>
              ) : null}
            </section>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <section className="card p-5 lg:col-span-3" aria-label="Monthly cashflow">
              <SectionTitle title="Monthly Cashflow" hint="Net movement per month" />
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={months}>
                    <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6D6390" }} />
                    <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
                    <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                    <Bar dataKey="net" name="Net cashflow" radius={[8, 8, 0, 0]} isAnimationActive animationDuration={850} animationEasing="ease-out">
                      {months.map((m, i) => (
                        <Cell key={i} fill={m.net >= 0 ? "#A855F7" : "#FB7185"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-extrabold">{personal ? "Where money came from" : "Income breakdown"}</h3>
                  {incomeBreak.length ? (
                    <div className="h-44">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={incomeBreak} dataKey="value" nameKey="name" innerRadius={42} outerRadius={68} paddingAngle={2} isAnimationActive animationDuration={900} animationEasing="ease-out">
                            {incomeBreak.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--dim)]">No income recorded yet.</p>
                  )}
                  <ul className="mt-1 space-y-1">
                    {incomeBreak.map((c, i) => (
                      <li key={c.name} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          {c.name}
                        </span>
                        <span className="font-semibold">{fmtMoney(Math.round(c.value * 100), cur)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-extrabold">{personal ? "Where money went" : "Expense distribution"}</h3>
                  {expenseBreak.length ? (
                    <div className="h-44">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={expenseBreak} dataKey="value" nameKey="name" innerRadius={42} outerRadius={68} paddingAngle={2} isAnimationActive animationDuration={900} animationEasing="ease-out">
                            {expenseBreak.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[(i + 2) % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--dim)]">No expenses recorded yet.</p>
                  )}
                  <ul className="mt-1 space-y-1">
                    {expenseBreak.map((c, i) => (
                      <li key={c.name} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[(i + 2) % PIE_COLORS.length] }} />
                          {c.name}
                        </span>
                        <span className="font-semibold">{fmtMoney(Math.round(c.value * 100), cur)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <div className="space-y-6 lg:col-span-2">
              <section className="card p-5" aria-label="Cashflow radar">
                <SectionTitle title="Cashflow Radar" hint="Signals from your ledger" />
                <ul className="space-y-2.5 text-sm">
                  <li className="flex items-start gap-2">
                    <span aria-hidden>{s.cashCents >= 0 ? "🟢" : "🔴"}</span>
                    <span>
                      Cash position is <strong>{fmtMoney(s.cashCents, cur)}</strong>
                      {s.pendingOutCents > 0
                        ? `, with ${fmtMoney(s.pendingOutCents, cur)} of pending expenses recorded.`
                        : "."}
                    </span>
                  </li>
                  {personal ? (
                    <li className="flex items-start gap-2">
                      <span aria-hidden>{expenseBreak.length ? "🟢" : "⚪"}</span>
                      <span>
                        {expenseBreak.length
                          ? <>Biggest spending category so far: <strong>{expenseBreak[0]!.name}</strong> at {fmtMoney(Math.round(expenseBreak[0]!.value * 100), cur)}.</>
                          : "No spending recorded yet — your categories will appear here."}
                      </span>
                    </li>
                  ) : (
                    <li className="flex items-start gap-2">
                      <span aria-hidden>{state.invoices.some((i) => i.effectiveStatus === "overdue") ? "🟠" : "🟢"}</span>
                      <span>
                        {state.invoices.filter((i) => i.effectiveStatus === "overdue").length} overdue
                        invoice(s),{" "}
                        {fmtMoney(
                          state.invoices
                            .filter((i) => i.status === "sent")
                            .reduce((a, i) => a + i.totalCents, 0),
                          cur,
                        )}{" "}
                        still outstanding.
                      </span>
                    </li>
                  )}
                  <li className="flex items-start gap-2">
                    <span aria-hidden>{s.curExpensesCents > s.prevExpensesCents ? "🟠" : "🟢"}</span>
                    <span>
                      {personal ? "Spending" : "Expenses"} this month are{" "}
                      {s.prevExpensesCents === 0
                        ? "starting fresh"
                        : `${Math.abs(((s.curExpensesCents - s.prevExpensesCents) / s.prevExpensesCents) * 100).toFixed(0)}% ${s.curExpensesCents > s.prevExpensesCents ? "higher" : "lower"} than last month`}
                      .
                    </span>
                  </li>
                  <li>
                    <button type="button" className="btn-ghost px-4 py-2 text-xs" onClick={() => go("future-lens")}>
                      Open Future Lens →
                    </button>
                  </li>
                </ul>
              </section>

              <section className="card p-5" aria-label="Upcoming payments">
                <SectionTitle title="Upcoming Payments" hint="Invoices, schedules & pending items" />
                {upcoming.length === 0 ? (
                  <p className="text-sm text-[var(--dim)]">
                    Nothing scheduled. Add recurring cashflows in Future Lens or send an invoice.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--border)]">
                    {upcoming.map((u, i) => (
                      <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{u.label}</p>
                          <p className="text-xs text-[var(--dim)]">
                            {u.kind} · {prettyDate(u.date)}
                          </p>
                        </div>
                        <span className={`text-sm font-extrabold ${u.cents >= 0 ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
                          {u.cents >= 0 ? "+" : "−"}{fmtMoney(Math.abs(u.cents), cur).replace("−", "")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <section className="card p-5" aria-label="Recent transactions">
            <SectionTitle
              title="Recent Transactions"
              action={
                <button type="button" className="btn-ghost px-4 py-2 text-xs" onClick={() => go("money-flow")}>
                  View all in Money Flow
                </button>
              }
            />
            <ul className="divide-y divide-[var(--border)]">
              {recent.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {t.description || t.category}
                      {t.demo ? <span className="ml-2"><Badge tone="warn">Demo</Badge></span> : null}
                    </p>
                    <p className="text-xs text-[var(--dim)]">
                      {t.category} · {prettyDate(t.date)} · {t.status}
                    </p>
                  </div>
                  <span className={`text-sm font-extrabold ${t.type === "income" ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
                    {t.type === "income" ? "+" : "−"}{fmtMoney(t.amountCents, cur).replace("−", "")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[var(--dim)]">
              Tip: use the Quick Note button anywhere to capture an idea — it lands in the Memory Vault.
              <button type="button" className="ml-1 font-bold text-[var(--accent)] underline" onClick={() => notify("Use the floating ✎ Quick Note button at the bottom right.")}>
                How?
              </button>
            </p>
          </section>
        </>
      )}

      {/* How budgeting works here — explained on day one, in plain words:
          record everything in its own workspace, give each category a
          monthly budget, and check the week before it becomes a month. */}
      <Reveal><section className="card p-5" aria-label="How budgeting works here">
        <SectionTitle title="How budgeting works here" hint="The whole method, in three steps — no paywall, every report and forecast included" />
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <li className="rounded-2xl bg-[var(--surface-soft)] p-3.5">
            <p className="text-sm font-extrabold">1 · Record in seconds</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              Tap ＋ Add, enter the amount, pick a category and how you paid (UPI first).
              Personal spends — rent, bills, EMI, loans, shopping — have ready-made
              categories, and “✎ Custom” lets you add your own.
            </p>
          </li>
          <li className="rounded-2xl bg-[var(--surface-soft)] p-3.5">
            <p className="text-sm font-extrabold">2 · Give categories a limit</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              Set a monthly budget per category in the {personal ? "Spending Leak Check" : "Profit Leak Scanner"}.
              Each workspace keeps its own budgets, so personal limits never mix with business ones.
            </p>
          </li>
          <li className="rounded-2xl bg-[var(--surface-soft)] p-3.5">
            <p className="text-sm font-extrabold">3 · Check the week, then the future</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              Use Money Flow's “This week” view for the week, the Payment Calendar for what's
              due, and Future Lens for what's coming — all included, nothing gated.
            </p>
          </li>
        </ol>
      </section></Reveal>
    </div>
  );
}
