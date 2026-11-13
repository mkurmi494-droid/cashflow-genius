import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
Area,
AreaChart,
Bar,
BarChart,
CartesianGrid,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api } from "./api";
import {
buildForecast,
CUSTOM_CATEGORY,
categoriesFor,
categoryOptionsFor,
fmtMoney,
isPersonalLike,
modeOf,
prettyDate,
summarise,
todayStr,
type AppMode,
type Recurring,
type State,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, CategorySelect, EmptyState, Field, Modal, SectionTitle } from "./components";
import { AnimatedMoney } from "./anim";

// ---------------- Future Lens ----------------

export function FutureLensPage({ state, notify, notifyDeleted, confirm, saveToVault }: PageProps) {
  const cur = state.business.currency;
  const mode = modeOf(state);
  const personal = isPersonalLike(mode);
  const [horizon, setHorizon] = useState<7 | 30 | 90>(30);
  const [showRecForm, setShowRecForm] = useState(false);
  const [editingRec, setEditingRec] = useState<Recurring | null>(null);
  const s = useMemo(() => summarise(state), [state]);
  const fc = useMemo(() => buildForecast(state, horizon), [state, horizon]);

  const delRec = useMutation({
    mutationFn: (id: string) => api.deleteRecurring({ id }),
    onSuccess: (res, id) => {
      const r = state.recurring.find((x) => x.id === id);
      notifyDeleted(`Schedule removed — ${r ? (r.description || r.category) : "schedule"}.`, res.trashId, r?.description || r?.category);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteRec = async (r: Recurring) => {
    const ok = await confirm({
      title: "Delete this recurring schedule?",
      body: "Forecasts and the payment calendar will stop including it. Past transactions are not touched, and you can undo this right after.",
      detail: `${r.type} · ${r.description || r.category} · ${fmtMoney(r.amountCents, cur)} · ${r.frequency} · next ${prettyDate(r.nextDate)}`,
      confirmLabel: "Delete schedule",
      danger: true,
    });
    if (ok) delRec.mutate(r.id);
  };

  const chartData = fc.days
    .filter((_, i) => horizon <= 30 || i % 3 === 0 || i === fc.days.length - 1)
    .map((d) => ({
      date: d.date.slice(5),
      balance: d.balanceCents / 100,
    }));

  const shortage = fc.minBalance < 0;

  return (
    <div className="page-anim space-y-6">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">Future forecast</h1>
        <p className="text-sm text-[var(--dim)]">
          {personal
            ? "A projection built from your real history, regular bills and scheduled money in and out — an estimate with visible assumptions, never a guarantee."
            : "A projection built from your real history, unpaid invoices and scheduled cashflows — an estimate with visible assumptions, never a guarantee."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Forecast horizon">
        {([7, 30, 90] as const).map((h) => (
          <button
            key={h}
            type="button"
            aria-pressed={horizon === h}
            onClick={() => setHorizon(h)}
            className={`px-5 py-2 text-sm ${horizon === h ? "btn-primary" : "btn-ghost"}`}
          >
            {h} DAYS
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[
          { label: "Current cash", v: fc.startCash },
          { label: "Expected incoming", v: fc.expectedIn },
          { label: "Upcoming outgoings", v: fc.expectedOut },
          { label: `Projected closing (${horizon}d)`, v: fc.closing },
        ].map((k) => (
          <article key={k.label} className="card p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">{k.label}</p>
            <p className="mt-1 text-xl font-extrabold sm:text-2xl"><AnimatedMoney cents={k.v} currency={cur} /></p>
          </article>
        ))}
      </div>

      {shortage ? (
        <div className="rounded-2xl bg-[var(--err)] px-4 py-3 text-sm text-[var(--err-text)]" role="alert">
          <strong>Possible cash shortage:</strong> the projected balance dips to{" "}
          {fmtMoney(fc.minBalance, cur)}
          {fc.minDate ? ` around ${prettyDate(fc.minDate)}` : ""}. Consider chasing
          outstanding invoices or moving a payment date.
        </div>
      ) : (
        <div className="rounded-2xl bg-[var(--surface-soft)] px-4 py-3 text-sm text-[var(--accent)]">
          No shortage is projected in this window. Lowest projected balance:{" "}
          <strong>{fmtMoney(fc.minBalance, cur)}</strong>
          {fc.minDate ? ` on ${prettyDate(fc.minDate)}` : ""}.
          {s.runwayMonths != null
            ? ` At your recent average burn, cash runway is about ${s.runwayMonths.toFixed(1)} months.`
            : " Runway is not shown because your recent average monthly net is not negative."}
        </div>
      )}

      <section className="card p-5" aria-label="Projected balance timeline">
        <SectionTitle title="Projected balance timeline" hint={`Next ${horizon} days`} />
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6D6390" }} minTickGap={24} />
              <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
              <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
              <Area type="monotone" dataKey="balance" name="Projected balance" stroke="#7C3AED" fill="#E9D5FF" strokeWidth={2.4} isAnimationActive animationDuration={950} animationEasing="ease-out" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 max-h-40 space-y-1 overflow-y-auto pr-1">
          {fc.days
            .filter((d) => d.inflowCents > 0 || d.outflowCents > 0)
            .slice(0, 14)
            .map((d) => (
              <div key={d.date} className="flex items-center justify-between text-sm">
                <span className="font-semibold">{prettyDate(d.date)}</span>
                <span className="text-[var(--dim)]">
                  {d.inflowCents > 0 ? <span className="text-[var(--accent)]">+{fmtMoney(d.inflowCents, cur)} </span> : null}
                  {d.outflowCents > 0 ? <span className="text-[#e11d63]">−{fmtMoney(d.outflowCents, cur)}</span> : null}
                </span>
                <span className="font-bold">{fmtMoney(d.balanceCents, cur)}</span>
              </div>
            ))}
        </div>
      </section>

      <section className="card p-5" aria-label="Forecast assumptions">
        <SectionTitle
          title="Assumptions behind this forecast"
          action={
            <button
              type="button"
              className="btn-ghost px-4 py-2 text-xs"
              onClick={() =>
                saveToVault(
                  `Forecast — next ${horizon} days`,
                  `Projected closing balance: ${fmtMoney(fc.closing, cur)}\nExpected incoming: ${fmtMoney(fc.expectedIn, cur)}\nUpcoming outgoings: ${fmtMoney(fc.expectedOut, cur)}\nLowest balance: ${fmtMoney(fc.minBalance, cur)}${fc.minDate ? ` on ${prettyDate(fc.minDate)}` : ""}\n\nAssumptions:\n${fc.assumptions.map((a) => `• ${a}`).join("\n")}`,
                  "Future Lens",
                )
              }
            >
              Save forecast to Memory Vault
            </button>
          }
        />
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-[var(--dim)]">
          {fc.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </section>

      <section className="card p-5" aria-label="Recurring cashflows">
        <SectionTitle
          title="Scheduled recurring cashflows"
          hint={personal ? "These power the forecast — salary, rent, bills, EMIs" : "These power the forecast — salaries, rent, retainers"}
          action={
            <button
              type="button"
              className="btn-primary px-4 py-2 text-xs"
              onClick={() => {
                setEditingRec(null);
                setShowRecForm(true);
              }}
            >
              + Add schedule
            </button>
          }
        />
        {state.recurring.length === 0 ? (
          <p className="text-sm text-[var(--dim)]">
            {personal
              ? "No schedules yet. Add your monthly salary, rent or regular bills and Future Lens will project them forward automatically."
              : "No schedules yet. Add monthly salaries, rent or a client retainer and Future Lens will project them forward automatically."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {state.recurring.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-semibold">
                    {r.description || r.category}
                    {r.demo ? <span className="ml-2"><Badge tone="warn">Demo</Badge></span> : null}
                    {!r.active ? <span className="ml-2"><Badge tone="grey">Paused</Badge></span> : null}
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    {r.type} · {r.category} · {r.frequency} · next {prettyDate(r.nextDate)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-extrabold ${r.type === "income" ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
                    {r.type === "income" ? "+" : "−"}{fmtMoney(r.amountCents, cur).replace("−", "")}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1 text-xs"
                    aria-label={`Edit schedule ${r.description || r.category}`}
                    onClick={() => {
                      setEditingRec(r);
                      setShowRecForm(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1 text-xs"
                    aria-label={`Delete schedule ${r.description || r.category}`}
                    onClick={() => void askDeleteRec(r)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showRecForm ? (
        <RecurringForm
          initial={editingRec}
          mode={mode}
          state={state}
          onClose={() => setShowRecForm(false)}
          notify={notify}
        />
      ) : null}
    </div>
  );
}

function RecurringForm({
  initial,
  mode = "business",
  state,
  onClose,
  notify,
}: {
  initial: Recurring | null;
  mode?: AppMode;
  state?: State;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const [type, setType] = useState<"income" | "expense">(initial?.type === "income" ? "income" : "expense");
  const [category, setCategory] = useState(initial?.category ?? categoriesFor(mode, "expense")[0] ?? "General");
  const [customCategory, setCustomCategory] = useState("");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amountCents / 100) : "");
  const [frequency, setFrequency] = useState<"weekly" | "monthly">(initial?.frequency === "weekly" ? "weekly" : "monthly");
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayStr());
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  const isCustom = category === CUSTOM_CATEGORY;
  const effectiveCategory = isCustom ? customCategory.trim() : category;

  const save = useMutation({
    mutationFn: () =>
      api.saveRecurring({
        id: initial?.id,
        type,
        category: effectiveCategory,
        description,
        amountCents: Math.round(parseFloat(amount) * 100),
        frequency,
        nextDate,
        active,
      }),
    onSuccess: () => {
      notify("Schedule saved.");
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!effectiveCategory) {
      setError("Type your custom category name.");
      return;
    }
    save.mutate();
  };

  return (
    <Modal title={initial ? "Edit schedule" : "Add recurring cashflow"} onClose={onClose}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className="field" value={type} aria-label="Cashflow type" onChange={(e) => { const v = e.target.value === "income" ? "income" : "expense"; setType(v); setCategory(categoriesFor(mode, v)[0] ?? "General"); setCustomCategory(""); }}>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </Field>
          <Field label="Frequency">
            <select className="field" value={frequency} aria-label="Frequency" onChange={(e) => setFrequency(e.target.value === "weekly" ? "weekly" : "monthly")}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
        </div>
        <Field label="Category">
          <CategorySelect options={categoryOptionsFor(state, mode, type, [initial?.category])} value={category} onChange={setCategory} ariaLabel="Schedule category" />
        </Field>
        {isCustom ? (
          <Field label="Your custom category">
            <input
              className="field"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              aria-label="Custom category name"
              placeholder="Type your own category, e.g. Pet care"
              maxLength={60}
              autoFocus
            />
          </Field>
        ) : null}
        <Field label="Description">
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Schedule description" placeholder={isPersonalLike(mode) ? "e.g. House rent" : "e.g. Office rent"} maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <input className="field" type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Schedule amount" required />
          </Field>
          <Field label="Next occurrence">
            <input className="field" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} aria-label="Next occurrence date" required />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} aria-label="Schedule is active" />
          Active (include in forecasts)
        </label>
        {error ? <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm text-[var(--err-text)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost px-5 py-2.5 text-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary px-6 py-2.5 text-sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------- What-if Lab ----------------

export interface SimParams {
  salesPct: number;
  expensePct: number;
  salaryDelta: number;
  marketingDelta: number;
  paymentPct: number;
  delayDays: number;
}

const DEFAULT_SIM: SimParams = {
  salesPct: 10,
  expensePct: 0,
  salaryDelta: 0,
  marketingDelta: 0,
  paymentPct: 100,
  delayDays: 0,
};

export function WhatIfPage({ state, notify, notifyDeleted, confirm, saveToVault }: PageProps) {
  const cur = state.business.currency;
  const personal = isPersonalLike(modeOf(state));
  const s = useMemo(() => summarise(state), [state]);
  const [sim, setSim] = useState<SimParams>(DEFAULT_SIM);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const monthlyRev = s.curRevenueCents || s.prevRevenueCents;
  const monthlyExp = s.curExpensesCents || s.prevExpensesCents;

  const simResult = useMemo(() => {
    const revDelta = Math.round(monthlyRev * (sim.salesPct / 100));
    const expPctDelta = Math.round(monthlyExp * (sim.expensePct / 100));
    const newRevenue = monthlyRev + revDelta;
    const newExpenses =
      monthlyExp + expPctDelta + sim.salaryDelta * 100 + sim.marketingDelta * 100;
    const origProfit = monthlyRev - monthlyExp;
    const newProfit = newRevenue - newExpenses;
    const collectible = Math.round(newRevenue * (sim.paymentPct / 100));
    const origCash3 = s.cashCents + origProfit * 3;
    const simCash3 = s.cashCents + newProfit * 3 + (collectible - newRevenue);
    const runway = (cash: number, profit: number) =>
      profit < 0 && cash > 0 ? cash / Math.abs(profit) : null;
    return {
      newRevenue,
      newExpenses,
      origProfit,
      newProfit,
      origCash3,
      simCash3,
      revDelta,
      expDelta: newExpenses - monthlyExp,
      origRunway: runway(origCash3, origProfit),
      simRunway: runway(simCash3, newProfit),
    };
  }, [monthlyRev, monthlyExp, sim, s.cashCents]);

  const save = useMutation({
    mutationFn: () =>
      api.saveScenario({
        id: editingId ?? undefined,
        name: name.trim() || "Untitled scenario",
        params: JSON.stringify(sim),
      }),
    onSuccess: (res) => {
      setEditingId(res.id);
      notify("Scenario saved. You can revisit it any time below.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteScenario({ id }),
    onSuccess: (res, id) => {
      const sc = state.scenarios.find((x) => x.id === id);
      notifyDeleted(`Scenario deleted — ${sc ? sc.name : "scenario"}.`, res.trashId, sc?.name);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteScenario = async (sc: { id: string; name: string }) => {
    const ok = await confirm({
      title: `Delete scenario “${sc.name}”?`,
      body: "The saved simulation will be removed. Your real records are not touched, and you can undo this right after.",
      confirmLabel: "Delete scenario",
      danger: true,
    });
    if (ok) del.mutate(sc.id);
  };

  const slider = (
    label: string,
    key: keyof SimParams,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    hint: string,
  ) => (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`sim-${key}`} className="text-sm font-bold">{label}</label>
        <span className="rounded-full bg-[var(--surface-soft)] px-2.5 py-0.5 text-sm font-extrabold text-[var(--accent)]">
          {format(sim[key])}
        </span>
      </div>
      <input
        id={`sim-${key}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={sim[key]}
        aria-label={label}
        onChange={(e) => setSim((p) => ({ ...p, [key]: Number(e.target.value) }))}
        className="mt-1 w-full accent-[#7C3AED]"
      />
      <p className="text-xs text-[var(--dim)]">{hint}</p>
    </div>
  );

  const chartData = [
    { name: "Revenue", Original: monthlyRev / 100, Simulated: simResult.newRevenue / 100 },
    { name: "Expenses", Original: monthlyExp / 100, Simulated: simResult.newExpenses / 100 },
    { name: "Profit", Original: simResult.origProfit / 100, Simulated: simResult.newProfit / 100 },
  ];

  const diffRow = (label: string, orig: number, simv: number, money = true) => {
    const d = simv - orig;
    return (
      <tr className="border-b border-[var(--border)] last:border-0">
        <td className="py-2.5 pr-3 font-semibold">{label}</td>
        <td className="py-2.5 pr-3 text-right">{money ? fmtMoney(orig, cur) : orig.toFixed(1)}</td>
        <td className="py-2.5 pr-3 text-right">{money ? fmtMoney(simv, cur) : simv.toFixed(1)}</td>
        <td className={`py-2.5 text-right font-extrabold ${d >= 0 ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
          {d >= 0 ? "+" : "−"}{money ? fmtMoney(Math.abs(d), cur).replace("−", "") : Math.abs(d).toFixed(1)}
        </td>
      </tr>
    );
  };

  return (
    <div className="page-anim space-y-6">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">What-if planner</h1>
        <p className="text-sm text-[var(--dim)]">
          Deterministic simulations from your current monthly run-rate — no AI
          numbers, just arithmetic you can audit.
        </p>
      </div>

      {state.transactions.length === 0 ? (
        <EmptyState
          title="Simulations need a baseline"
          body="The lab projects from your current (or last) month's revenue and expenses. Add transactions first and the sliders will come alive."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <section className="card space-y-5 p-5 lg:col-span-2" aria-label="Simulation controls">
              <SectionTitle title="Decision levers" />
              {personal ? (
                <>
                  {slider("Income change", "salesPct", -50, 100, 1, (v) => `${v > 0 ? "+" : ""}${v}%`, "Applied to your monthly income run-rate, e.g. a raise or a side income.")}
                  {slider("Spending change", "expensePct", -50, 100, 1, (v) => `${v > 0 ? "+" : ""}${v}%`, "Applied across your monthly spending.")}
                  {slider("Monthly cost change (rent, EMIs, help)", "salaryDelta", -100000, 300000, 5000, (v) => fmtMoney(v * 100, cur), "Add or remove a regular monthly cost, e.g. a rent rise or a new EMI.")}
                  {slider("Lifestyle spending change", "marketingDelta", -50000, 200000, 2500, (v) => fmtMoney(v * 100, cur), "Extra (or less) monthly spending on shopping, eating out and fun.")}
                  {slider("Income actually received", "paymentPct", 40, 100, 1, (v) => `${v}%`, "Share of expected income that actually lands in the period.")}
                  {slider("Income delay", "delayDays", 0, 60, 1, (v) => `${v} days`, "Late salary or freelance payments strain cash even when the month looks fine — reflected in assumptions.")}
                </>
              ) : (
                <>
                  {slider("Sales change", "salesPct", -50, 100, 1, (v) => `${v > 0 ? "+" : ""}${v}%`, "Applied to monthly revenue run-rate.")}
                  {slider("Expense change", "expensePct", -50, 100, 1, (v) => `${v > 0 ? "+" : ""}${v}%`, "Applied across monthly expenses.")}
                  {slider("Salary change (per month)", "salaryDelta", -100000, 300000, 5000, (v) => fmtMoney(v * 100, cur), "Add or remove monthly salary cost, e.g. a new hire.")}
                  {slider("Marketing budget change", "marketingDelta", -50000, 200000, 2500, (v) => fmtMoney(v * 100, cur), "Extra (or less) monthly marketing spend.")}
                  {slider("Customer payments collected", "paymentPct", 40, 100, 1, (v) => `${v}%`, "Share of simulated revenue actually collected in the period.")}
                  {slider("Payment delay", "delayDays", 0, 60, 1, (v) => `${v} days`, "Longer delays strain cash even when profit looks fine — reflected in assumptions.")}
                </>
              )}
              <div className="rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-xs text-[var(--dim)]">
                Assumptions: the baseline is this month's posted run-rate (last month if
                this month is empty). Results project three months of the simulated
                profit. A {sim.delayDays}-day average payment delay means roughly{" "}
                {fmtMoney(Math.round(simResult.newRevenue * (sim.delayDays / 30) * ((100 - sim.paymentPct) / 100 + 0.0)), cur)}{" "}
                more cash is tied up in receivables at any time.
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="sr-only" htmlFor="scenario-name">Scenario name</label>
                <input
                  id="scenario-name"
                  className="field flex-1"
                  placeholder="Scenario name, e.g. Hire one designer"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                />
                <button type="button" className="btn-primary px-5 py-2.5 text-sm" disabled={save.isPending} onClick={() => save.mutate()}>
                  {editingId ? "Update scenario" : "Save scenario"}
                </button>
              </div>
              <button
                type="button"
                className="btn-ghost w-full px-4 py-2 text-sm"
                onClick={() =>
                  saveToVault(
                    `What-if: ${name || "Untitled scenario"}`,
                    `Sales ${sim.salesPct}%, expenses ${sim.expensePct}%, salary change ${fmtMoney(sim.salaryDelta * 100, cur)}/mo, marketing change ${fmtMoney(sim.marketingDelta * 100, cur)}/mo, collections ${sim.paymentPct}%, delay ${sim.delayDays} days.\nSimulated monthly profit: ${fmtMoney(simResult.newProfit, cur)} (original ${fmtMoney(simResult.origProfit, cur)}).`,
                    "What-if Lab",
                  )
                }
              >
                Save to Memory Vault
              </button>
              <button
                type="button"
                className="btn-ghost w-full px-4 py-2 text-sm"
                onClick={() => {
                  setSim(DEFAULT_SIM);
                  setEditingId(null);
                  setName("");
                }}
              >
                Reset levers
              </button>
            </section>

            <section className="space-y-6 lg:col-span-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <article className="card p-5">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">{personal ? "Your money today" : "Original business"}</p>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between"><dt>{personal ? "Monthly income" : "Monthly revenue"}</dt><dd className="font-bold">{fmtMoney(monthlyRev, cur)}</dd></div>
                    <div className="flex justify-between"><dt>{personal ? "Monthly spending" : "Monthly expenses"}</dt><dd className="font-bold">{fmtMoney(monthlyExp, cur)}</dd></div>
                    <div className="flex justify-between"><dt>{personal ? "Left over each month" : "Monthly profit"}</dt><dd className="font-bold">{fmtMoney(simResult.origProfit, cur)}</dd></div>
                    <div className="flex justify-between"><dt>Cash in 3 months</dt><dd className="font-bold">{fmtMoney(simResult.origCash3, cur)}</dd></div>
                    <div className="flex justify-between"><dt>Runway</dt><dd className="font-bold">{simResult.origRunway != null ? `${simResult.origRunway.toFixed(1)} mo` : "Not burning"}</dd></div>
                  </dl>
                </article>
                <article className="card border-[var(--accent-bright)] p-5" style={{ background: "linear-gradient(160deg, #ffffff, #F0EAFF)" }}>
                  <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--accent)]">{personal ? "Simulated month" : "Simulated business"}</p>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between"><dt>{personal ? "Monthly income" : "Monthly revenue"}</dt><dd className="font-bold">{fmtMoney(simResult.newRevenue, cur)}</dd></div>
                    <div className="flex justify-between"><dt>{personal ? "Monthly spending" : "Monthly expenses"}</dt><dd className="font-bold">{fmtMoney(simResult.newExpenses, cur)}</dd></div>
                    <div className="flex justify-between"><dt>{personal ? "Left over each month" : "Monthly profit"}</dt><dd className="font-bold">{fmtMoney(simResult.newProfit, cur)}</dd></div>
                    <div className="flex justify-between"><dt>Cash in 3 months</dt><dd className="font-bold">{fmtMoney(simResult.simCash3, cur)}</dd></div>
                    <div className="flex justify-between"><dt>Runway</dt><dd className="font-bold">{simResult.simRunway != null ? `${simResult.simRunway.toFixed(1)} mo` : "Not burning"}</dd></div>
                  </dl>
                </article>
              </div>

              <section className="card p-5" aria-label="Difference summary">
                <SectionTitle title="What changes" />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--dim)]">
                        <th className="py-2 pr-3">Measure</th>
                        <th className="py-2 pr-3 text-right">Original</th>
                        <th className="py-2 pr-3 text-right">Simulated</th>
                        <th className="py-2 text-right">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffRow(personal ? "Monthly income" : "Monthly revenue", monthlyRev, simResult.newRevenue)}
                      {diffRow(personal ? "Monthly spending" : "Monthly expenses", monthlyExp, simResult.newExpenses)}
                      {diffRow(personal ? "Left over each month" : "Monthly profit", simResult.origProfit, simResult.newProfit)}
                      {diffRow("Cash after 3 months", simResult.origCash3, simResult.simCash3)}
                      {simResult.origRunway != null || simResult.simRunway != null
                        ? diffRow("Runway (months)", simResult.origRunway ?? 0, simResult.simRunway ?? 0, false)
                        : null}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#6D6390" }} />
                      <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
                      <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                      <Bar dataKey="Original" fill="#DDD6FE" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={850} animationEasing="ease-out" />
                      <Bar dataKey="Simulated" fill="#7C3AED" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={850} animationEasing="ease-out" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </section>
          </div>

          <section className="card p-5" aria-label="Saved scenarios">
            <SectionTitle title="Saved scenarios" hint="Revisit and compare past decisions" />
            {state.scenarios.length === 0 ? (
              <p className="text-sm text-[var(--dim)]">No scenarios saved yet.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {state.scenarios.map((sc) => {
                  let summary = "";
                  try {
                    const p = JSON.parse(sc.params) as SimParams;
                    summary = `Sales ${p.salesPct}%, expenses ${p.expensePct}%, salary ${fmtMoney(p.salaryDelta * 100, cur)}, marketing ${fmtMoney(p.marketingDelta * 100, cur)}, collections ${p.paymentPct}%`;
                  } catch {
                    summary = "Saved simulation";
                  }
                  return (
                    <li key={sc.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <p className="text-sm font-bold">
                          {sc.name}
                          {sc.demo ? <span className="ml-2"><Badge tone="warn">Demo</Badge></span> : null}
                        </p>
                        <p className="text-xs text-[var(--dim)]">{summary}</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-ghost px-3 py-1.5 text-xs"
                          aria-label={`Load scenario ${sc.name}`}
                          onClick={() => {
                            try {
                              setSim({ ...DEFAULT_SIM, ...(JSON.parse(sc.params) as SimParams) });
                            } catch {
                              notify("That scenario's data could not be read.");
                              return;
                            }
                            setName(sc.name);
                            setEditingId(sc.id);
                            notify(`Loaded scenario "${sc.name}".`);
                          }}
                        >
                          Load
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-3 py-1.5 text-xs"
                          aria-label={`Delete scenario ${sc.name}`}
                          onClick={() => void askDeleteScenario(sc)}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
