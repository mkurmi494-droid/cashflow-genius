import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
addDays,
buildCalendarEvents,
fmtMoney,
isPersonalLike,
modeOf,
monthKey,
prettyDate,
shiftMonth,
todayStr,
type CalEvent,
type EmiPlan,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, EmptyState, Field, Modal, SectionTitle } from "./components";
import { AnimatedProgress } from "./anim";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthTitle(key: string): string {
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/** Monday-first cells for the month containing `key` (yyyy-mm). */
function monthCells(key: string): string[] {
  const [y = 1970, m = 1] = key.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: string[] = [];
  for (let i = 0; i < lead; i++) cells.push("");
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${key}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push("");
  return cells;
}

function EventRow({
  ev,
  currency,
  onCollect,
  collectingId,
  go,
}: {
  ev: CalEvent;
  currency: string;
  onCollect: (instalmentId: string) => void;
  collectingId: string | null;
  go: PageProps["go"];
}) {
  const collect = ev.direction === "collect";
  return (
    <li className="rounded-2xl border border-[var(--border)] bg-white px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-extrabold ${
            collect ? "bg-[var(--surface-soft)] text-[var(--accent)]" : "bg-[#f9e7e7] text-[#e11d63]"
          }`}
        >
          {collect ? "↓" : "↑"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{ev.title}</span>
          <span className="block truncate text-xs text-[var(--dim)]">
            {prettyDate(ev.date)} · {ev.detail}
          </span>
        </span>
        <span className={`tnum shrink-0 text-sm font-extrabold ${collect ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
          {collect ? "+" : "−"}{fmtMoney(ev.amountCents, currency)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
        {ev.overdue ? <Badge tone="err">Overdue</Badge> : null}
        <Badge tone={ev.source === "emi" ? "gold" : ev.source === "invoice" ? "ai" : "grey"}>
          {ev.source === "emi" ? "EMI" : ev.source === "invoice" ? "Invoice" : ev.source === "recurring" ? "Recurring" : "Pending"}
        </Badge>
        <span className="flex-1" />
        {ev.source === "emi" && ev.instalmentId ? (
          <button
            type="button"
            className="btn-primary px-3.5 py-1.5 text-xs"
            disabled={collectingId === ev.instalmentId}
            onClick={() => onCollect(ev.instalmentId!)}
          >
            {collectingId === ev.instalmentId ? "Recording…" : "Mark collected"}
          </button>
        ) : null}
        {ev.source === "invoice" ? (
          <button type="button" className="btn-ghost px-3.5 py-1.5 text-xs" onClick={() => go("invoices")}>
            Open invoice
          </button>
        ) : null}
      </div>
    </li>
  );
}

function EmiPlanCard({
  plan,
  currency,
  onCollect,
  collectingId,
  onDelete,
}: {
  plan: EmiPlan;
  currency: string;
  onCollect: (instalmentId: string) => void;
  collectingId: string | null;
  onDelete: (plan: EmiPlan) => void;
}) {
  const pct = plan.totalCents - plan.downPaymentCents > 0
    ? Math.round((plan.collectedCents / (plan.totalCents - plan.downPaymentCents)) * 100)
    : 100;
  return (
    <div className="card card-hover p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-extrabold">{plan.product}</p>
          <p className="text-sm text-[var(--dim)]">
            {plan.customerName}
            {plan.customerContact ? ` · ${plan.customerContact}` : ""}
            {plan.demo ? " · demo" : ""}
          </p>
        </div>
        <Badge tone={plan.remainingCents <= 0 ? "mint" : "gold"}>
          {plan.paidCount} of {plan.instalmentCount} collected
        </Badge>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-soft)]" role="img" aria-label={`${pct}% of the financed amount collected`}>
        <AnimatedProgress pct={pct} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <p><span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Total</span><span className="tnum font-bold">{fmtMoney(plan.totalCents, currency)}</span></p>
        <p><span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Down payment</span><span className="tnum font-bold">{fmtMoney(plan.downPaymentCents, currency)}</span></p>
        <p><span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Collected</span><span className="tnum font-bold text-[var(--accent)]">{fmtMoney(plan.collectedCents + plan.downPaymentCents, currency)}</span></p>
        <p><span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Still to collect</span><span className="tnum font-bold">{fmtMoney(plan.remainingCents, currency)}</span></p>
      </div>
      <ul className="mt-4 space-y-1.5">
        {plan.instalments.map((inst) => (
          <li
            key={inst.id}
            className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-soft)]/60 px-3 py-2 text-sm"
          >
            <span className="font-bold">#{inst.seq}</span>
            <span className="text-[var(--dim)]">{prettyDate(inst.dueDate)}</span>
            <span className="tnum font-bold">{fmtMoney(inst.amountCents, currency)}</span>
            <span className="flex-1" />
            {inst.status === "paid" ? (
              <Badge tone="mint">Collected{inst.paidDate ? ` · ${prettyDate(inst.paidDate)}` : ""}</Badge>
            ) : inst.effectiveStatus === "overdue" ? (
              <>
                <Badge tone="err">Overdue</Badge>
                <button
                  type="button"
                  className="btn-primary px-3 py-1 text-xs"
                  disabled={collectingId === inst.id}
                  onClick={() => onCollect(inst.id)}
                >
                  {collectingId === inst.id ? "Recording…" : "Mark collected"}
                </button>
              </>
            ) : (
              <>
                <Badge tone="warn">Pending</Badge>
                <button
                  type="button"
                  className="btn-ghost px-3 py-1 text-xs"
                  disabled={collectingId === inst.id}
                  onClick={() => onCollect(inst.id)}
                >
                  {collectingId === inst.id ? "Recording…" : "Mark collected"}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {plan.paidCount === 0 ? (
        <button type="button" className="btn-ghost mt-3 px-3.5 py-1.5 text-xs" onClick={() => onDelete(plan)}>
          Delete plan
        </button>
      ) : null}
    </div>
  );
}

function NewEmiPlanModal({
  currency,
  onClose,
  notify,
}: {
  currency: string;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [product, setProduct] = useState("");
  const [total, setTotal] = useState("");
  const [down, setDown] = useState("0");
  const [count, setCount] = useState("6");
  const [frequency, setFrequency] = useState<"monthly" | "weekly">("monthly");
  const [firstDue, setFirstDue] = useState(addDays(todayStr(), 30));
  const [error, setError] = useState<string | null>(null);

  const totalCents = Math.round((parseFloat(total) || 0) * 100);
  const downCents = Math.round((parseFloat(down) || 0) * 100);
  const n = Math.max(1, parseInt(count, 10) || 0);
  const financed = totalCents - downCents;
  const perInstalment = financed > 0 && n > 0 ? Math.floor(financed / n) : 0;

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.saveEmiPlan({
        customerName: customerName.trim(),
        customerContact: customerContact.trim(),
        product: product.trim(),
        totalCents,
        downPaymentCents: downCents,
        instalmentCount: n,
        frequency,
        firstDueDate: firstDue,
      });
      if (!res.ok) throw new Error(res.error ?? "Could not create the EMI plan.");
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      notify(`EMI plan created — ${n} instalment(s) of about ${fmtMoney(perInstalment, currency)} for ${customerName.trim()}.`);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal title="New EMI plan" onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!customerName.trim()) return setError("Enter the customer's name.");
          if (!product.trim()) return setError("Enter the product sold on EMI.");
          if (totalCents <= 0) return setError("Enter the total product price.");
          if (downCents < 0 || downCents >= totalCents) return setError("The down payment must be less than the total price.");
          if (n < 1 || n > 60) return setError("Instalments can be between 1 and 60.");
          if (!firstDue) return setError("Pick the first instalment due date.");
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer name">
            <input className="field" value={customerName} onChange={(e) => setCustomerName(e.target.value)} aria-label="Customer name" placeholder="e.g. Rohan Mehta" maxLength={120} required />
          </Field>
          <Field label="Customer phone / note (optional)">
            <input className="field" value={customerContact} onChange={(e) => setCustomerContact(e.target.value)} aria-label="Customer contact" placeholder="e.g. 98XXXXXX10" maxLength={120} />
          </Field>
        </div>
        <Field label="Product sold on EMI">
          <input className="field" value={product} onChange={(e) => setProduct(e.target.value)} aria-label="Product sold on EMI" placeholder="e.g. Smartphone — 128 GB" maxLength={200} required />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`Total price (${currency})`}>
            <input className="field tnum" type="number" inputMode="decimal" step="1" min="0" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Total price" placeholder="0.00" required />
          </Field>
          <Field label={`Down payment paid upfront (${currency})`}>
            <input className="field tnum" type="number" inputMode="decimal" step="1" min="0" value={down} onChange={(e) => setDown(e.target.value)} aria-label="Down payment" />
          </Field>
          <Field label="Number of instalments">
            <input className="field tnum" type="number" min="1" max="60" step="1" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Number of instalments" required />
          </Field>
          <Field label="Instalments are">
            <select className="field" value={frequency} onChange={(e) => setFrequency(e.target.value as "monthly" | "weekly")} aria-label="Instalment frequency">
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
        </div>
        <Field label="First instalment due date">
          <input className="field" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} aria-label="First instalment due date" required />
        </Field>
        {financed > 0 ? (
          <p className="rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-sm font-semibold">
            {n} instalment(s) of {fmtMoney(perInstalment, currency)} {frequency}
            {financed - perInstalment * n > 0 ? ` — the last one is ${fmtMoney(financed - perInstalment * (n - 1), currency)} so the total adds up exactly` : ""}.
            First due {prettyDate(firstDue)}.
          </p>
        ) : null}
        {error ? (
          <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{error}</p>
        ) : null}
        <button type="submit" className="btn-primary w-full px-6 py-3 text-sm" disabled={save.isPending}>
          {save.isPending ? "Creating…" : "Create EMI plan"}
        </button>
      </form>
    </Modal>
  );
}

export function PaymentCalendarPage({ state, go, notify, notifyDeleted, confirm }: PageProps) {
  const queryClient = useQueryClient();
  const currency = state.business.currency;
  const personal = isPersonalLike(modeOf(state));
  const today = todayStr();
  const [month, setMonth] = useState(monthKey(today));
  const [selectedDay, setSelectedDay] = useState<string>(today);
  const [showEmiForm, setShowEmiForm] = useState(false);
  const [deleting, setDeleting] = useState<EmiPlan | null>(null);

  const monthEvents = useMemo(
    () => buildCalendarEvents(state, `${month}-01`, `${month}-31`),
    [state, month],
  );
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of monthEvents) {
      const arr = map.get(ev.date) ?? [];
      arr.push(ev);
      map.set(ev.date, arr);
    }
    return map;
  }, [monthEvents]);

  const upcoming = useMemo(
    () => buildCalendarEvents(state, addDays(today, -370), addDays(today, 62)),
    [state, today],
  );
  const overdueList = upcoming.filter((e) => e.overdue);
  const comingList = upcoming.filter((e) => !e.overdue).slice(0, 20);
  const dayEvents = byDay.get(selectedDay) ?? [];

  const monthTotals = useMemo(() => {
    let pay = 0;
    let collect = 0;
    for (const ev of monthEvents) {
      if (ev.direction === "pay") pay += ev.amountCents;
      else collect += ev.amountCents;
    }
    return { pay, collect };
  }, [monthEvents]);

  const collectMut = useMutation({
    mutationFn: async (instalmentId: string) => {
      const res = await api.collectEmiInstalment({ instalmentId });
      if (!res.ok) throw new Error(res.error ?? "Could not record the collection.");
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      notify("EMI instalment collected — one income transaction was added to Money Flow.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askCollect = async (instalmentId: string) => {
    let label = "this instalment";
    let detail = "One linked income transaction will be created in Money Flow.";
    for (const plan of state.emiPlans) {
      const inst = plan.instalments.find((i) => i.id === instalmentId);
      if (inst) {
        label = `EMI ${inst.seq} of ${plan.instalmentCount} — ${plan.product}`;
        detail = `${plan.customerName} · ${fmtMoney(inst.amountCents, currency)} · due ${prettyDate(inst.dueDate)} — one linked income transaction will be created in Money Flow.`;
        break;
      }
    }
    const ok = await confirm({
      title: `Mark ${label} as collected?`,
      body: "Only mark this collected when the money has actually reached you — this adds real income to your ledger.",
      detail,
      confirmLabel: "Yes, mark collected",
    });
    if (ok) collectMut.mutate(instalmentId);
  };

  const deleteMut = useMutation({
    mutationFn: async (plan: EmiPlan) => {
      const res = await api.deleteEmiPlan({ id: plan.id });
      if (!res.ok) throw new Error(res.error ?? "Could not delete the plan.");
      return res;
    },
    onSuccess: (res, plan) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      notifyDeleted(`EMI plan deleted — ${plan.product} for ${plan.customerName}.`, res.trashId, plan.product);
      setDeleting(null);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const cells = monthCells(month);

  return (
    <div className="page-anim space-y-7">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">🗓️ What&rsquo;s due — payment calendar</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--dim)]">
          Kis date pe kya pay karna hai, aur kis date pe kya collect karna hai — all in one place.
          Built only from your own records: recurring bills and income, unpaid invoices, pending
          transactions{personal ? "" : " and EMI instalments you need to collect"}.
        </p>
      </div>

      {/* Month grid */}
      <section aria-label="Month calendar">
        <div className="card p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5 text-sm" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
              <h2 className="min-w-40 text-center text-lg font-extrabold">{monthTitle(month)}</h2>
              <button type="button" className="btn-ghost px-3 py-1.5 text-sm" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setMonth(monthKey(today)); setSelectedDay(today); }}>
                Today
              </button>
              <Badge tone="err">To pay {fmtMoney(monthTotals.pay, currency)}</Badge>
              <Badge tone="mint">To collect {fmtMoney(monthTotals.collect, currency)}</Badge>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-extrabold uppercase tracking-wide text-[var(--dim)]" aria-hidden>
            {WEEKDAYS.map((d) => <span key={d} className="py-1">{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((date, i) => {
              if (!date) return <span key={`blank-${i}`} aria-hidden />;
              const evs = byDay.get(date) ?? [];
              const hasPay = evs.some((e) => e.direction === "pay");
              const hasCollect = evs.some((e) => e.direction === "collect");
              const hasOverdue = evs.some((e) => e.overdue);
              const isToday = date === today;
              const isSelected = date === selectedDay;
              return (
                <button
                  key={date}
                  type="button"
                  aria-label={`${prettyDate(date)}${evs.length ? ` — ${evs.length} payment item(s)` : ""}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedDay(date)}
                  className={`flex min-h-[52px] flex-col items-center justify-start rounded-xl px-1 py-1.5 text-sm transition sm:min-h-[64px] ${
                    isSelected
                      ? "bg-[var(--surface-soft)] shadow-[inset_0_0_0_2px_var(--accent)]"
                      : "hover:bg-[var(--surface-soft)]"
                  }`}
                >
                  <span className={`tnum font-bold ${isToday ? "flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-white" : ""}`}>
                    {Number(date.slice(8))}
                  </span>
                  {evs.length > 0 ? (
                    <span className="mt-1 flex items-center gap-1" aria-hidden>
                      {hasCollect ? <span className="h-2 w-2 rounded-full bg-[var(--accent)]" /> : null}
                      {hasPay ? <span className="h-2 w-2 rounded-full bg-[#f43f5e]" /> : null}
                      <span className="hidden text-[10px] font-bold text-[var(--dim)] sm:inline">{evs.length}</span>
                      {hasOverdue ? <span className="text-[10px] font-extrabold text-[#e11d63]">!</span> : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-[var(--dim)]">
            <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--accent)]" /> money to collect
            <span aria-hidden className="mx-1 ml-3 inline-block h-2 w-2 rounded-full bg-[#f43f5e]" /> money to pay
            <span className="ml-3 font-bold text-[#e11d63]">!</span> includes something overdue
          </p>
        </div>

        <div className="mt-4">
          <SectionTitle title={prettyDate(selectedDay)} hint={dayEvents.length ? `${dayEvents.length} item(s) on this date` : undefined} />
          {dayEvents.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-5 text-center text-sm text-[var(--dim)]">
              Nothing to pay or collect on this date.
            </p>
          ) : (
            <ul className="space-y-2">
              {dayEvents.map((ev) => (
                <EventRow key={ev.id} ev={ev} currency={currency} onCollect={(id) => void askCollect(id)} collectingId={collectMut.isPending ? (collectMut.variables ?? null) : null} go={go} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Overdue + upcoming */}
      <section aria-label="Overdue and upcoming payments">
        <SectionTitle title="Coming up" hint="Overdue items first, then the next two months — from your records, nothing invented." />
        {overdueList.length === 0 && comingList.length === 0 ? (
          <EmptyState
            title="No upcoming payments on record"
            body="Add a recurring bill in Money Flow, send an invoice, or create an EMI plan, and its dates will appear here automatically."
          />
        ) : (
          <ul className="space-y-2">
            {[...overdueList, ...comingList].map((ev) => (
              <EventRow key={ev.id} ev={ev} currency={currency} onCollect={(id) => void askCollect(id)} collectingId={collectMut.isPending ? (collectMut.variables ?? null) : null} go={go} />
            ))}
          </ul>
        )}
      </section>

      {/* EMI plans */}
      <section aria-label="EMI plans">
        <SectionTitle
          title={personal ? "EMI plans" : "EMI plans — products sold on EMI"}
          hint="Sold a product on EMI? Add the plan once — the calendar will remind you on every due date, and marking an instalment collected adds exactly one income entry."
          action={
            <button type="button" className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={() => setShowEmiForm(true)}>
              ＋ New EMI plan
            </button>
          }
        />
        {state.emiPlans.length === 0 ? (
          <EmptyState
            title="No EMI plans yet"
            body={personal
              ? "EMI plans are for selling products on instalments. If you ever sell something on EMI, add the plan here and every due date lands on this calendar."
              : "Add your first EMI plan — customer, product, total amount and instalments — and Cashflow Genius will track every due date, pending and overdue instalment for you."}
            action={
              <button type="button" className="btn-primary px-5 py-2.5 text-sm" onClick={() => setShowEmiForm(true)}>
                Create an EMI plan
              </button>
            }
          />
        ) : (
          <div className="space-y-4">
            {state.emiPlans.map((plan) => (
              <EmiPlanCard
                key={plan.id}
                plan={plan}
                currency={currency}
                onCollect={(id) => void askCollect(id)}
                collectingId={collectMut.isPending ? (collectMut.variables ?? null) : null}
                onDelete={(p) => setDeleting(p)}
              />
            ))}
          </div>
        )}
      </section>

      {showEmiForm ? (
        <NewEmiPlanModal currency={currency} onClose={() => setShowEmiForm(false)} notify={notify} />
      ) : null}
      {deleting ? (
        <Modal title="Delete this EMI plan?" onClose={() => setDeleting(null)}>
          <p className="text-sm leading-relaxed text-[var(--dim)]">
            “{deleting.product}” for {deleting.customerName} and its {deleting.instalmentCount} unpaid
            instalment(s) will be removed from the calendar. You can undo it right after from the Undo button.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => setDeleting(null)}>Keep it</button>
            <button
              type="button"
              className="btn-danger px-4 py-2 text-sm"
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate(deleting)}
            >
              {deleteMut.isPending ? "Deleting…" : "Delete plan"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
