import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { fmtMoney, prettyDate, todayStr } from "./lib";
import type { PageProps } from "./types";
import { Badge, EmptyState, Field, Modal, SectionTitle } from "./components";

// One lend/borrow entry, as getLendBorrow returns it.
type Entry = {
  id: string;
  person: string;
  direction: "lent" | "borrowed";
  amountCents: number;
  date: string;
  dueDate: string | null;
  note: string;
  status: "open" | "settled";
  settledDate: string | null;
};

type Filter = "all" | "lent" | "borrowed";

function LendBorrowForm({
  initial,
  onSave,
  onClose,
  saving,
}: {
  initial: Entry | null;
  onSave: (v: {
    person: string;
    direction: "lent" | "borrowed";
    amountCents: number;
    date: string;
    dueDate: string | null;
    note: string;
  }) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [person, setPerson] = useState(initial?.person ?? "");
  const [direction, setDirection] = useState<"lent" | "borrowed">(initial?.direction ?? "lent");
  const [amount, setAmount] = useState(initial ? String(initial.amountCents / 100) : "");
  const [date, setDate] = useState(initial?.date ?? todayStr());
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const amountCents = Math.round((Number(amount) || 0) * 100);
  const valid = person.trim().length > 0 && amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <div className="space-y-4">
      <Field label="Person">
        <input
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          placeholder="Who is this with?"
          maxLength={120}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
        />
      </Field>
      <div className="flex gap-2">
        {(["lent", "borrowed"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${
              direction === d
                ? "border-[var(--accent)] bg-[var(--surface-soft)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            {d === "lent" ? "I lent — owed to me" : "I borrowed — I owe"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          />
        </Field>
      </div>
      <Field label="Due date (optional)">
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
        />
      </Field>
      <Field label="Note (optional)">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was it for?"
          maxLength={500}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
        />
      </Field>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!valid || saving}
          onClick={() =>
            onSave({
              person: person.trim(),
              direction,
              amountCents,
              date,
              dueDate: dueDate || null,
              note: note.trim(),
            })
          }
          className="flex-1 rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Add entry"}
        </button>
      </div>
    </div>
  );
}

export function LendBorrowPage({ state, notify, notifyDeleted, confirm }: PageProps) {
  const queryClient = useQueryClient();
  const currency = state.business.currency;
  const today = todayStr();
  const [filter, setFilter] = useState<Filter>("all");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);

  const q = useQuery({
    queryKey: ["cg-lend-borrow"],
    queryFn: () => api.getLendBorrow({}),
    staleTime: 30_000,
    retry: 1,
  });
  const entries = useMemo(() => q.data?.entries ?? [], [q.data]);

  const owedToMe = entries.filter((e) => e.direction === "lent" && e.status === "open").reduce((s, e) => s + e.amountCents, 0);
  const iOwe = entries.filter((e) => e.direction === "borrowed" && e.status === "open").reduce((s, e) => s + e.amountCents, 0);
  const overdueCount = entries.filter((e) => e.status === "open" && e.dueDate && e.dueDate < today).length;

  const visible = entries.filter((e) => {
    if (filter === "lent" && e.direction !== "lent") return false;
    if (filter === "borrowed" && e.direction !== "borrowed") return false;
    if (hideCompleted && e.status === "settled") return false;
    return true;
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["cg-lend-borrow"] });
  };

  const saveMut = useMutation({
    mutationFn: (v: {
      id?: string;
      person: string;
      direction: "lent" | "borrowed";
      amountCents: number;
      date: string;
      dueDate: string | null;
      note: string;
    }) => api.saveLendBorrow(v),
    onSuccess: (_res, v) => {
      invalidate();
      setShowForm(false);
      setEditing(null);
      notify(v.id ? "Entry updated." : "Entry added.");
    },
  });

  const settleMut = useMutation({
    mutationFn: (v: { id: string; settled: boolean }) => api.settleLendBorrow(v),
    onSuccess: (_res, v) => {
      invalidate();
      notify(v.settled ? "Marked settled — no Money Flow entry was added." : "Entry reopened.");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteLendBorrow({ id }),
    onSuccess: (res) => {
      invalidate();
      notifyDeleted("Entry deleted.", res.trashId);
    },
  });

  const onDelete = async (entry: Entry) => {
    const ok = await confirm({
      title: "Delete this entry?",
      body: `This removes the ${entry.direction === "lent" ? "lent" : "borrowed"} entry for ${entry.person} (${fmtMoney(entry.amountCents, currency)}). It does not change any transaction.`,
      detail: "You can undo it right after.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(entry.id);
  };

  return (
    <div className="page-anim space-y-5">
      <SectionTitle
        title="Lend & borrow"
        hint="Money you lent and money you borrowed — who owes whom, and by when."
        action={
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
            className="rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white"
          >
            + Add lend/borrow
          </button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-xs text-[var(--muted)]">Owed to me</div>
          <div className="mt-1 text-lg font-bold">{fmtMoney(owedToMe, currency)}</div>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-xs text-[var(--muted)]">I owe</div>
          <div className="mt-1 text-lg font-bold">{fmtMoney(iOwe, currency)}</div>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-xs text-[var(--muted)]">Net</div>
          <div className="mt-1 text-lg font-bold">{fmtMoney(owedToMe - iOwe, currency)}</div>
        </div>
      </div>
      {overdueCount > 0 && (
        <p className="text-sm font-semibold text-[var(--danger)]">
          {overdueCount} {overdueCount === 1 ? "entry is" : "entries are"} past due.
        </p>
      )}
      <p className="text-xs text-[var(--muted)]">
        Settling only marks an entry paid back — it never adds a Money Flow transaction.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "lent", "borrowed"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
              filter === f
                ? "border-[var(--accent)] bg-[var(--surface-soft)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            {f === "all" ? "All" : f === "lent" ? "Owed to me" : "I owe"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setHideCompleted((v) => !v)}
          className={`ml-auto rounded-full border px-3 py-1.5 text-sm font-semibold ${
            hideCompleted
              ? "border-[var(--accent)] bg-[var(--surface-soft)] text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--muted)]"
          }`}
        >
          {hideCompleted ? "✓ Hide completed" : "Hide completed"}
        </button>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-[var(--muted)]">Loading your lend & borrow entries…</p>
      ) : q.isError ? (
        <p className="text-sm text-[var(--danger)]">Could not load lend & borrow entries. Pull to retry.</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title={entries.length === 0 ? "Nothing lent or borrowed yet" : "No entries match this filter"}
          body={
            entries.length === 0
              ? "When you lend money or take some, add it here — the balance stays clear until it is settled."
              : "Try another filter, or show completed entries."
          }
          action={
            entries.length === 0 ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                }}
                className="rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white"
              >
                + Add lend/borrow
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((e) => {
            const overdue = e.status === "open" && !!e.dueDate && e.dueDate < today;
            return (
              <li key={e.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{e.person}</span>
                      <Badge tone={e.direction === "lent" ? "mint" : "gold"}>
                        {e.direction === "lent" ? "Owed to me" : "I owe"}
                      </Badge>
                      {e.status === "settled" ? (
                        <Badge tone="grey">Settled{e.settledDate ? ` · ${prettyDate(e.settledDate)}` : ""}</Badge>
                      ) : overdue ? (
                        <Badge tone="err">Overdue</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm text-[var(--muted)]">
                      {prettyDate(e.date)}
                      {e.dueDate ? ` · due ${prettyDate(e.dueDate)}` : ""}
                      {e.note ? ` · ${e.note}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-lg font-bold">{fmtMoney(e.amountCents, currency)}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {e.status === "open" ? (
                    <button
                      type="button"
                      disabled={settleMut.isPending}
                      onClick={() => settleMut.mutate({ id: e.id, settled: true })}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-semibold"
                    >
                      Mark settled
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={settleMut.isPending}
                      onClick={() => settleMut.mutate({ id: e.id, settled: false })}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-semibold"
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(e);
                      setShowForm(true);
                    }}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-semibold"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={deleteMut.isPending}
                    onClick={() => void onDelete(e)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-semibold text-[var(--danger)]"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {showForm && (
        <Modal title={editing ? "Edit entry" : "Add lend/borrow"} onClose={() => { setShowForm(false); setEditing(null); }}>
          <LendBorrowForm
            initial={editing}
            saving={saveMut.isPending}
            onClose={() => {
              setShowForm(false);
              setEditing(null);
            }}
            onSave={(v) => saveMut.mutate(editing ? { ...v, id: editing.id } : v)}
          />
        </Modal>
      )}
    </div>
  );
}
