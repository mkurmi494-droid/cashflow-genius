import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
APP_MODES,
MODE_ICONS,
MODE_LABELS,
SAVINGS_STATUS_LABELS,
addDays,
fmtMoney,
modeOf,
prettyDate,
summarise,
todayStr,
totalSavedCents,
type AppMode,
type SavingsGoal,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, EmptyState, Field, Modal, SectionTitle } from "./components";
import { AnimatedMoney, AnimatedProgress } from "./anim";

// One recurring savings schedule, as getSavingsSchedules returns it.
type Schedule = {
  id: string;
  goalId: string;
  goalName: string;
  frequency: "once" | "monthly" | "yearly";
  amountCents: number;
  nextDueDate: string;
  active: boolean;
};

function statusTone(status: string): "mint" | "gold" | "err" | "grey" | "ai" {
  switch (status) {
    case "completed":
      return "mint";
    case "on_track":
      return "mint";
    case "behind":
      return "gold";
    case "overdue":
      return "err";
    default:
      return "grey";
  }
}

function GoalFormModal({
  currency,
  activeMode,
  editing,
  onClose,
  notify,
}: {
  currency: string;
  activeMode: AppMode;
  editing: SavingsGoal | null;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(editing?.name ?? "");
  const [target, setTarget] = useState(
    editing ? String(editing.targetCents / 100) : "",
  );
  const [targetDate, setTargetDate] = useState(
    editing?.targetDate ?? addDays(todayStr(), 180),
  );
  const [workspace, setWorkspace] = useState<AppMode>(activeMode);
  const [error, setError] = useState<string | null>(null);

  const targetCents = Math.round((parseFloat(target) || 0) * 100);

  const save = useMutation({
    mutationFn: async () => {
      return await api.saveSavingsGoal({
        id: editing?.id,
        name: name.trim(),
        targetCents,
        targetDate,
        mode: editing ? undefined : workspace,
      });
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
      if (editing) {
        notify(`Savings goal “${name.trim()}” updated.`);
      } else if (res.mode !== activeMode) {
        notify(
          `Savings goal “${name.trim()}” created in ${MODE_LABELS[res.mode as AppMode]} — open that workspace to see it and add money. Nothing was added here, so nothing is mixed.`,
        );
      } else {
        notify(`Savings goal “${name.trim()}” created in ${MODE_LABELS[activeMode]}. Add money to it whenever you're ready.`);
      }
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal title={editing ? "Edit savings goal" : "New savings goal"} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!name.trim()) return setError("Give your goal a name.");
          if (targetCents <= 0) return setError("Enter a target amount greater than zero.");
          if (editing && targetCents < editing.savedCents)
            return setError(`The target can't be less than the ${fmtMoney(editing.savedCents, currency)} already saved in this pot.`);
          if (!targetDate) return setError("Pick a target date.");
          save.mutate();
        }}
      >
        <Field label="Goal name">
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Savings goal name"
            placeholder="e.g. Emergency fund, New bike, Goa trip"
            maxLength={120}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`Target amount (${currency})`}>
            <input
              className="field tnum"
              type="number"
              inputMode="decimal"
              step="1"
              min="0"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Savings goal target amount"
              placeholder="0.00"
              required
            />
          </Field>
          <Field label="Target date">
            <input
              className="field"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              aria-label="Savings goal target date"
              required
            />
          </Field>
        </div>
        {editing ? (
          <p className="rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-sm font-semibold">
            This goal lives in {MODE_LABELS[activeMode]} and stays there — editing never moves a goal
            (or its money) between workspaces.
            {editing.savedCents > 0
              ? ` It already holds ${fmtMoney(editing.savedCents, currency)}, so the target must stay at or above that.`
              : ""}
          </p>
        ) : (
          <Field label="Workspace — whose money is this goal for?">
            <select
              className="field"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value as AppMode)}
              aria-label="Workspace for this savings goal"
            >
              {APP_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_ICONS[m]} {MODE_LABELS[m]}
                  {m === activeMode ? " — open now" : ""}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs font-semibold normal-case tracking-normal text-[var(--dim)]">
              The goal and every rupee added to it will belong to that workspace only — never mixed with the others.
            </span>
          </Field>
        )}
        {error ? (
          <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn-primary w-full px-6 py-3 text-sm" disabled={save.isPending}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Create savings goal"}
        </button>
      </form>
    </Modal>
  );
}

function MoveMoneyModal({
  goal,
  currency,
  direction,
  onClose,
  notify,
}: {
  goal: SavingsGoal;
  currency: string;
  direction: "deposit" | "withdraw";
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Deposit only: just once (the usual transfer), or a recurring
  // schedule that moves the amount every month / every year.
  const [frequency, setFrequency] = useState<"once" | "monthly" | "yearly">("once");
  const amountCents = Math.round((parseFloat(amount) || 0) * 100);
  const deposit = direction === "deposit";

  const move = useMutation({
    mutationFn: async () => {
      const res = deposit
        ? await api.addToSavingsGoal({ goalId: goal.id, amountCents, date, note: note.trim() })
        : await api.withdrawFromSavingsGoal({ goalId: goal.id, amountCents, date, note: note.trim() });
      if (!res.ok) throw new Error(res.error ?? "That transfer could not be recorded.");
      return res;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
      notify(
        deposit
          ? `${fmtMoney(amountCents, currency)} moved into “${goal.name}” as a transfer. It is not an expense — your income and spending totals didn't change. The pot now holds ${fmtMoney(res.savedCents, currency)}.`
          : `${fmtMoney(amountCents, currency)} moved back from “${goal.name}” to your available cash as a transfer. It is not new income, so it isn't counted twice. The pot now holds ${fmtMoney(res.savedCents, currency)}.`,
      );
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // Recurring deposit: creates the schedule; the server applies the
  // first contribution immediately when the start date is today or
  // past (and the workspace's available cash covers it).
  const schedule = useMutation({
    mutationFn: async () => {
      const res = await api.createSavingsSchedule({
        goalId: goal.id,
        frequency: frequency as "monthly" | "yearly",
        amountCents,
        startDate: date,
      });
      if (!res.ok) throw new Error(res.error ?? "That schedule could not be created.");
      return res;
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-savings-schedules"] });
      const every = frequency === "monthly" ? "every month" : "every year";
      notify(
        res.firstApplied
          ? `${fmtMoney(amountCents, currency)} moved into “${goal.name}” now, and will move again ${every}. Cancel it anytime from the goal card.`
          : `${fmtMoney(amountCents, currency)} will move into “${goal.name}” ${every}, starting ${prettyDate(date)}. It only moves when the workspace's available cash covers it — cancel it anytime from the goal card.`,
      );
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal title={deposit ? `Add money to “${goal.name}”` : `Withdraw from “${goal.name}”`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (amountCents <= 0) return setError("Enter an amount greater than zero.");
          if (!deposit && amountCents > goal.savedCents)
            return setError(`This pot holds ${fmtMoney(goal.savedCents, currency)} — you can't withdraw more than that.`);
          if (!date) return setError("Pick the date of this transfer.");
          if (deposit && frequency !== "once") schedule.mutate();
          else move.mutate();
        }}
      >
        <p className="rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-sm leading-relaxed">
          {deposit && frequency !== "once" ? (
            <>
              This sets up a recurring move: <strong>{fmtMoney(amountCents, currency) || "this amount"}</strong>{" "}
              moves from this workspace's <strong>available cash</strong> into the pot{" "}
              <strong>{frequency === "monthly" ? "every month" : "every year"}</strong>
              {date <= todayStr() ? ", starting today" : `, starting ${prettyDate(date)}`} — automatically, and
              only when the available cash covers it. It is still a <strong>transfer</strong>, never an expense.
            </>
          ) : deposit ? (
            <>
              This moves money from this workspace's <strong>available cash</strong> into the pot, recorded
              once as a <strong>transfer</strong> — never as an expense, so your spending totals stay true.
            </>
          ) : (
            <>
              This moves money from the pot back to this workspace's <strong>available cash</strong>, recorded
              once as a <strong>transfer</strong> — never as income, so the same money is never counted twice.
            </>
          )}{" "}
          It happens in {MODE_LABELS[modeOfGoal(goal)]} only.
        </p>
        <p className="text-sm text-[var(--dim)]">
          In the pot now: <strong className="tnum text-[var(--text)]">{fmtMoney(goal.savedCents, currency)}</strong>
          {" · "}Target: <strong className="tnum text-[var(--text)]">{fmtMoney(goal.targetCents, currency)}</strong>
          {!deposit ? (
            <>
              {" · "}You can withdraw up to <strong className="tnum text-[var(--text)]">{fmtMoney(goal.savedCents, currency)}</strong>
            </>
          ) : null}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`Amount (${currency})`}>
            <input
              className="field tnum"
              type="number"
              inputMode="decimal"
              step="1"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={deposit ? "Amount to add to savings" : "Amount to withdraw from savings"}
              placeholder="0.00"
              autoFocus
              required
            />
          </Field>
          <Field label={deposit && frequency !== "once" ? "Start date" : "Date"}>
            <input
              className="field"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Transfer date"
              required
            />
          </Field>
        </div>
        {deposit ? (
          <div>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">How often?</span>
            <div className="grid grid-cols-3 gap-1 rounded-full border border-[var(--border)] bg-white p-1" role="group" aria-label="How often should this amount move into the pot">
              {(
                [
                  { key: "once", label: "Just once" },
                  { key: "monthly", label: "Monthly" },
                  { key: "yearly", label: "Yearly" },
                ] as const
              ).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFrequency(f.key)}
                  aria-pressed={frequency === f.key}
                  className={`rounded-full px-2 py-2 text-xs font-bold ${frequency === f.key ? "bg-[var(--accent)] text-white" : "text-[var(--dim)]"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {frequency !== "once" ? (
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
                {fmtMoney(amountCents, currency)} will move into this pot {frequency === "monthly" ? "every month" : "every year"}
                {date <= todayStr() ? ", starting today" : `, starting ${prettyDate(date)}`} — automatically, only when
                the workspace's available cash covers it. Cancel anytime from the goal card.
              </p>
            ) : null}
          </div>
        ) : null}
        <Field label="Note (optional)">
          <input
            className="field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Transfer note"
            placeholder={deposit ? "e.g. Salary day saving" : "e.g. Needed for a bill"}
            maxLength={200}
          />
        </Field>
        {error ? (
          <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn-primary w-full px-6 py-3 text-sm" disabled={move.isPending || schedule.isPending}>
          {move.isPending
            ? "Recording transfer…"
            : schedule.isPending
              ? "Setting up…"
              : deposit && frequency !== "once"
                ? `Save ${frequency === "monthly" ? "monthly" : "yearly"} — ${amountCents > 0 ? fmtMoney(amountCents, currency) : ""}`
                : deposit
                  ? `Add ${amountCents > 0 ? fmtMoney(amountCents, currency) : ""} to the pot`
                  : `Withdraw ${amountCents > 0 ? fmtMoney(amountCents, currency) : ""} to available cash`}
        </button>
      </form>
    </Modal>
  );
}

// Goals returned in state always belong to the active workspace (the
// server scopes them), so the goal's own mode label is that workspace.
function modeOfGoal(goal: SavingsGoal): AppMode {
  return (APP_MODES as readonly string[]).includes(goal.mode)
    ? (goal.mode as AppMode)
    : "business";
}

function GoalCard({
  goal,
  currency,
  schedules,
  onMove,
  onEdit,
  onDelete,
  onCancelSchedule,
}: {
  goal: SavingsGoal;
  currency: string;
  schedules: Schedule[];
  onMove: (goal: SavingsGoal, direction: "deposit" | "withdraw") => void;
  onEdit: (goal: SavingsGoal) => void;
  onDelete: (goal: SavingsGoal) => void;
  onCancelSchedule: (scheduleId: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  // Two-tap cancel for a schedule: first tap arms it, second confirms.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const pct = Math.min(100, Math.max(0, goal.progressPct));
  const transfers = showHistory ? goal.transfers : goal.transfers.slice(0, 3);
  return (
    <article className="card card-hover p-4 sm:p-5" aria-label={`Savings goal ${goal.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-extrabold">
            {goal.name}
            {goal.demo ? (
              <span className="ml-2">
                <Badge tone="warn">Demo</Badge>
              </span>
            ) : null}
          </p>
          <p className="text-sm text-[var(--dim)]">
            Target {fmtMoney(goal.targetCents, currency)} by {prettyDate(goal.targetDate)}
            {goal.daysRemaining >= 0
              ? ` · ${goal.daysRemaining} day(s) left`
              : ` · ${Math.abs(goal.daysRemaining)} day(s) past the target date`}
          </p>
        </div>
        <Badge tone={statusTone(goal.status)}>{SAVINGS_STATUS_LABELS[goal.status] ?? goal.status}</Badge>
      </div>

      <div
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--surface-soft)]"
        role="img"
        aria-label={`${goal.progressPct}% saved toward ${goal.name}`}
      >
        <AnimatedProgress pct={pct} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <p>
          <span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Saved so far</span>
          <span className="tnum font-extrabold text-[var(--accent)]">{fmtMoney(goal.savedCents, currency)}</span>
        </p>
        <p>
          <span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Remaining</span>
          <span className="tnum font-extrabold">{fmtMoney(goal.remainingCents, currency)}</span>
        </p>
        <p>
          <span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Progress</span>
          <span className="tnum font-extrabold">{goal.progressPct}%</span>
        </p>
        <p>
          <span className="block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">To stay on track</span>
          <span className="tnum font-extrabold">
            {goal.status === "completed"
              ? "Done 🎉"
              : goal.requiredPerMonthCents > 0
                ? `${fmtMoney(goal.requiredPerMonthCents, currency)}/mo`
                : "—"}
          </span>
        </p>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
        {goal.status === "completed"
          ? "You've reached this target. You can keep adding, raise the target by editing, or withdraw the money back to available cash."
          : goal.status === "overdue"
            ? `The target date has passed with ${fmtMoney(goal.remainingCents, currency)} still to go. Edit the goal to set a new date, or keep saving — nothing is lost.`
            : goal.status === "not_started"
              ? "No money in this pot yet. Add your first transfer to get it moving."
              : goal.status === "on_track"
                ? goal.expectedCents > 0
                  ? `You're on track. Saving steadily, a little at a time since this goal began, would have put about ${fmtMoney(goal.expectedCents, currency)} aside by today — and you already have ${fmtMoney(goal.savedCents, currency)}.${goal.requiredPerMonthCents > 0 ? ` Keep saving about ${fmtMoney(goal.requiredPerMonthCents, currency)} a month and you'll reach the target on time.` : ""}`
                  : `You've only just begun this goal, so there's no pace to compare yet.${goal.requiredPerMonthCents > 0 ? ` Saving about ${fmtMoney(goal.requiredPerMonthCents, currency)} a month from here reaches the target on time.` : ""}`
                : `A little behind: saving steadily since this goal began would have put about ${fmtMoney(goal.expectedCents, currency)} aside by today, and you have ${fmtMoney(goal.savedCents, currency)}.${goal.requiredPerMonthCents > 0 ? ` Saving about ${fmtMoney(goal.requiredPerMonthCents, currency)} a month from here still reaches the target on time.` : ""}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary px-4 py-2.5 text-sm" onClick={() => onMove(goal, "deposit")}>
          ＋ Add money
        </button>
        <button
          type="button"
          className="btn-ghost px-4 py-2.5 text-sm"
          disabled={goal.savedCents <= 0}
          onClick={() => onMove(goal, "withdraw")}
        >
          Withdraw
        </button>
        <button type="button" className="btn-ghost px-4 py-2.5 text-sm" onClick={() => onEdit(goal)}>
          Edit goal
        </button>
        <button type="button" className="btn-ghost px-4 py-2.5 text-sm" onClick={() => onDelete(goal)}>
          Delete
        </button>
      </div>

      {schedules.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">Recurring savings</p>
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-sm">
              <span>
                <span className="font-bold">
                  🔁 {fmtMoney(s.amountCents, currency)}{" "}
                  {s.frequency === "once" ? "once" : s.frequency === "monthly" ? "monthly" : "yearly"}
                </span>
                <span className="block text-xs text-[var(--dim)]">Next: {prettyDate(s.nextDueDate)}</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-xs font-bold text-[var(--accent)] underline"
                onClick={() => {
                  if (confirmCancelId === s.id) {
                    setConfirmCancelId(null);
                    onCancelSchedule(s.id);
                  } else {
                    setConfirmCancelId(s.id);
                  }
                }}
              >
                {confirmCancelId === s.id ? "Tap again to cancel" : "Cancel"}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {goal.transfers.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
            Transfers — every move in and out, recorded once
          </p>
          <ul className="mt-1.5 divide-y divide-[var(--border)]">
            {transfers.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold">
                    {t.direction === "deposit" ? "Added to pot" : "Withdrawn to cash"}
                  </span>
                  <span className="block truncate text-xs text-[var(--dim)]">
                    {prettyDate(t.date)}
                    {t.note ? ` · ${t.note}` : ""}
                  </span>
                </span>
                <span className={`tnum shrink-0 font-extrabold ${t.direction === "deposit" ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
                  {t.direction === "deposit" ? "+" : "−"}
                  {fmtMoney(t.amountCents, currency)}
                </span>
              </li>
            ))}
          </ul>
          {goal.transfers.length > 3 ? (
            <button
              type="button"
              className="mt-1 text-xs font-bold text-[var(--accent)] underline"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((s) => !s)}
            >
              {showHistory ? "Show fewer transfers" : `Show all ${goal.transfers.length} transfers`}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-[var(--dim)]">No transfers yet for this goal.</p>
      )}
    </article>
  );
}

export function SavingsPage({ state, notify, notifyDeleted }: PageProps) {
  const queryClient = useQueryClient();
  const currency = state.business.currency;
  const activeMode = modeOf(state);
  const goals = state.savingsGoals ?? [];
  const s = useMemo(() => summarise(state), [state]);
  const totalSaved = totalSavedCents(state);
  const totalTarget = goals.reduce((sum, g) => sum + g.targetCents, 0);
  const overallPct = totalTarget > 0 ? Math.round((totalSaved / totalTarget) * 1000) / 10 : 0;
  const onTrackCount = goals.filter((g) => g.status === "on_track" || g.status === "completed").length;

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [moving, setMoving] = useState<{ goal: SavingsGoal; direction: "deposit" | "withdraw" } | null>(null);
  const [deleting, setDeleting] = useState<SavingsGoal | null>(null);

  // Recurring schedules for this workspace, and the due ones applied
  // on load (there is no background job — opening the app is what
  // moves scheduled money). The apply is idempotent: a second call
  // finds nothing due, so the dashboard firing it too is harmless.
  const schedulesQ = useQuery({
    queryKey: ["cg-savings-schedules"],
    queryFn: () => api.getSavingsSchedules({}),
    staleTime: 30_000,
    retry: 1,
  });
  const schedules = schedulesQ.data?.schedules ?? [];
  const [applyResult, setApplyResult] = useState<{ applied: number; skipped: number } | null>(null);
  const appliedRef = useRef(false);
  const applyMut = useMutation({
    mutationFn: () => api.applyDueSavingsSchedules({}),
    onSuccess: (res) => {
      setApplyResult({ applied: res.applied.length, skipped: res.skipped.length });
      if (res.applied.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-savings-schedules"] });
        const total = res.applied.reduce((s, a) => s + a.amountCents, 0);
        notify(
          res.applied.length === 1
            ? `Scheduled savings applied: ${fmtMoney(total, currency)} moved into “${res.applied[0]?.goalName}”.`
            : `Scheduled savings applied: ${fmtMoney(total, currency)} moved into ${res.applied.length} pots.`,
        );
      }
    },
  });
  useEffect(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    applyMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelScheduleMut = useMutation({
    mutationFn: (id: string) => api.cancelSavingsSchedule({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cg-savings-schedules"] });
      notify("Recurring savings cancelled — money already in the pot stays there.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const deleteMut = useMutation({
    mutationFn: async (goal: SavingsGoal) => {
      const res = await api.deleteSavingsGoal({ id: goal.id });
      if (!res.ok) throw new Error(res.error ?? "Could not delete this goal.");
      return res;
    },
    onSuccess: (res, goal) => {
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
      void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
      notifyDeleted(
        res.returnedCents > 0
          ? `Savings goal “${goal.name}” deleted — its ${fmtMoney(res.returnedCents, currency)} went back to this workspace's available cash. No other goal or record was touched.`
          : `Savings goal “${goal.name}” deleted.`,
        res.trashId,
        goal.name,
      );
      setDeleting(null);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="page-anim space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="display-font text-[27px] font-semibold tracking-tight">🪙 Savings Goals</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--dim)]">
            Savings pots for {MODE_LABELS[activeMode]}. Money you add leaves this workspace's available
            cash and sits in the pot; money you withdraw comes back. Both are recorded once as{" "}
            <strong>transfers</strong> — never as income or spending — so your totals never double-count,
            and savings here never mix with another workspace.
          </p>
        </div>
        <button type="button" className="btn-primary shrink-0 px-5 py-3 text-sm" onClick={() => setShowForm(true)}>
          ＋ New savings goal
        </button>
      </div>

      <section className="card p-5 sm:p-6" aria-label="Total saved in this workspace">
        <SectionTitle
          title={`Total saved — ${MODE_LABELS[activeMode]}`}
          hint="Across every goal in this workspace only. Other workspaces keep their own separate totals — see them side by side on the Command Center."
        />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Total saved</p>
            <p className="tnum mt-0.5 text-2xl font-extrabold text-[var(--accent)]"><AnimatedMoney cents={totalSaved} currency={currency} /></p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Total target</p>
            <p className="tnum mt-0.5 text-2xl font-extrabold"><AnimatedMoney cents={totalTarget} currency={currency} /></p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Overall progress</p>
            <p className="tnum mt-0.5 text-2xl font-extrabold">{goals.length ? `${overallPct}%` : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Available cash</p>
            <p className="tnum mt-0.5 text-2xl font-extrabold"><AnimatedMoney cents={s.cashCents} currency={currency} /></p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
          {goals.length === 0
            ? "No goals yet in this workspace — available cash above is untouched by savings."
            : `${goals.length} goal(s) here, ${onTrackCount} on track or reached. Available cash already excludes the ${fmtMoney(totalSaved, currency)} sitting in pots, so the money is counted exactly once: either spendable, or saved — never both.`}
        </p>
      </section>

      {applyResult && applyResult.skipped > 0 ? (
        <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]" role="status">
          {applyResult.skipped === 1
            ? "One scheduled saving could not move — the workspace's available cash doesn't cover it. The schedule stays due; add money or cancel it from the goal card."
            : `${applyResult.skipped} scheduled savings could not move — the workspace's available cash doesn't cover them. The schedules stay due; add money or cancel them from the goal cards.`}
        </p>
      ) : null}

      {goals.length === 0 ? (
        <EmptyState
          title="No savings goals yet"
          body="Create your first pot — a name, a target amount and a date. Add money in small transfers whenever you can, and watch the progress and on-track pace update from your real transfers."
          action={
            <button type="button" className="btn-primary px-5 py-2.5 text-sm" onClick={() => setShowForm(true)}>
              Create a savings goal
            </button>
          }
        />
      ) : (
        <div className="space-y-4">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              currency={currency}
              schedules={schedules.filter((s) => s.goalId === goal.id && s.active)}
              onMove={(g, direction) => setMoving({ goal: g, direction })}
              onEdit={(g) => setEditing(g)}
              onDelete={(g) => setDeleting(g)}
              onCancelSchedule={(id) => cancelScheduleMut.mutate(id)}
            />
          ))}
        </div>
      )}

      {showForm ? (
        <GoalFormModal
          currency={currency}
          activeMode={activeMode}
          editing={null}
          onClose={() => setShowForm(false)}
          notify={notify}
        />
      ) : null}
      {editing ? (
        <GoalFormModal
          currency={currency}
          activeMode={activeMode}
          editing={editing}
          onClose={() => setEditing(null)}
          notify={notify}
        />
      ) : null}
      {moving ? (
        <MoveMoneyModal
          goal={moving.goal}
          currency={currency}
          direction={moving.direction}
          onClose={() => setMoving(null)}
          notify={notify}
        />
      ) : null}
      {deleting ? (
        <Modal title="Delete this savings goal?" onClose={() => setDeleting(null)}>
          <p className="text-sm leading-relaxed text-[var(--dim)]">
            “{deleting.name}” and its transfer history and recurring schedules will be removed from {MODE_LABELS[activeMode]}.
            {deleting.savedCents > 0
              ? ` The ${fmtMoney(deleting.savedCents, currency)} in the pot goes back to this workspace's available cash — it isn't lost and it isn't counted as income.`
              : ""}{" "}
            No other goal, transaction or workspace is touched. You can undo it right after from the Undo button — the pot, its transfers and its schedules come back exactly as they were.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => setDeleting(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn-danger px-4 py-2 text-sm"
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate(deleting)}
            >
              {deleteMut.isPending ? "Deleting…" : "Delete goal"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
