import { useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "./api";
import {
allKnownCategories,
CUSTOM_CATEGORY,
PAYMENT_METHODS,
addDays,
categoriesFor,
categoryOptionsFor,
downloadFile,
fmtMoney,
isPersonalLike,
modeOf,
parseCsv,
prettyDate,
summarise,
todayStr,
txnsToCsv,
type AppMode,
type State,
type Txn,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, CategorySelect, EmptyState, Field, Modal, SectionTitle } from "./components";

interface NodeDef {
  id: string;
  label: string;
  cents: number;
  kind: "in" | "out" | "pending";
  txns: Txn[];
  angle: number;
}

export function MoneyFlowPage({ state, notify, notifyDeleted, confirm }: PageProps) {
  const cur = state.business.currency;
  const mode = modeOf(state);
  const personal = isPersonalLike(mode);
  const s = useMemo(() => summarise(state), [state]);
  const [selected, setSelected] = useState<NodeDef | null>(null);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.deleteTransaction({ id }),
    onSuccess: (res, id) => {
      const t = state.transactions.find((x) => x.id === id);
      const label = t ? (t.description || t.category) : "Transaction";
      notifyDeleted(`Transaction deleted — ${label}.`, res.trashId, label);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteTxn = async (t: Txn) => {
    const ok = await confirm({
      title: "Delete this transaction?",
      body: "This entry will be removed from your ledger and your totals will change. You can undo it right after from the Undo button.",
      detail: `${t.type === "income" ? "Money in" : "Money out"} · ${t.description || t.category} · ${fmtMoney(t.amountCents, cur)} · ${prettyDate(t.date)} · ${t.category}${t.status === "pending" ? " · pending" : ""}`,
      confirmLabel: "Delete transaction",
      danger: true,
    });
    if (ok) del.mutate(t.id);
  };
  const importer = useMutation({
    mutationFn: (
      rows: {
        type: string;
        status: string;
        category: string;
        description: string;
        counterparty: string;
        amountCents: number;
        date: string;
      }[],
    ) => api.importTransactions({ rows }),
    onSuccess: (res) => {
      const parts = [`${res.imported} imported`, `${res.duplicates} duplicates skipped`];
      if (res.errors.length) parts.push(`${res.errors.length} invalid: ${res.errors.slice(0, 3).join(" ")}`);
      setImportMsg(parts.join(" · "));
    },
    onError: (e) => setImportMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const undoImport = useMutation({
    mutationFn: () => api.undoLastImport({}),
    onSuccess: (res) => {
      if (!res.found) notify("No CSV import to undo in this workspace.");
      else notifyDeleted(`Import undone — ${res.removed} imported transaction(s) removed. Entries you added by hand were untouched.`, res.trashId, "CSV import");
      setImportMsg(null);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askUndoImport = async () => {
    const ok = await confirm({
      title: "Undo the last CSV import?",
      body: "Every transaction that the last CSV import added in this workspace will be removed. Entries you added by hand are never touched — and you can undo this undo.",
      confirmLabel: "Undo import",
      danger: true,
    });
    if (ok) undoImport.mutate();
  };

  const nodes = useMemo<NodeDef[]>(() => {
    const posted = state.transactions.filter((t) => t.status === "posted");
    const group = (type: "income" | "expense") => {
      const map = new Map<string, Txn[]>();
      for (const t of posted.filter((x) => x.type === type)) {
        const arr = map.get(t.category) ?? [];
        arr.push(t);
        map.set(t.category, arr);
      }
      return [...map.entries()]
        .map(([label, txns]) => ({
          label,
          txns,
          cents: txns.reduce((a, t) => a + t.amountCents, 0),
        }))
        .sort((a, b) => b.cents - a.cents)
        .slice(0, 5);
    };
    const ins = group("income");
    const outs = group("expense");
    const pending = state.transactions.filter((t) => t.status === "pending");
    const defs: NodeDef[] = [];
    ins.forEach((g, i) =>
      defs.push({ id: `in-${g.label}`, label: g.label, cents: g.cents, kind: "in", txns: g.txns, angle: 150 + i * 38 }),
    );
    outs.forEach((g, i) =>
      defs.push({ id: `out-${g.label}`, label: g.label, cents: g.cents, kind: "out", txns: g.txns, angle: -75 + i * 38 }),
    );
    if (pending.length > 0) {
      defs.push({
        id: "pending",
        label: "Pending",
        cents: pending.reduce((a, t) => a + t.amountCents, 0),
        kind: "pending",
        txns: pending,
        angle: 90,
      });
    }
    return defs;
  }, [state]);

  const filtered = state.transactions.filter((t) => {
    if (typeFilter !== "all" && t.type !== typeFilter) return false;
    if (catFilter !== "all" && t.category !== catFilter) return false;
    if (fromDate && t.date < fromDate) return false;
    if (toDate && t.date > toDate) return false;
    if (
      search &&
      !`${t.description} ${t.counterparty} ${t.category}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  // Mode categories plus every category already used by stored records, so
  // transactions recorded in the other mode stay filterable after a switch.
  const allCategories = allKnownCategories(state);

  const handleCsv = async (file: File) => {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setImportMsg("That file has no data rows. Expected a header row: date,type,category,description,counterparty,amount (status is optional).");
      return;
    }
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const di = idx("date");
    const ti = idx("type");
    const ci = idx("category");
    const descI = idx("description");
    const cpI = idx("counterparty");
    const ai = idx("amount");
    const si = idx("status");
    const mi = idx("payment_method");
    if (di < 0 || ti < 0 || ai < 0) {
      setImportMsg("Could not map columns. The CSV needs at least: date, type, amount. Category, description, counterparty, status and payment_method are optional.");
      return;
    }
    const mapped = rows.slice(1).map((r) => ({
      date: (r[di] ?? "").trim(),
      type: (r[ti] ?? "").trim().toLowerCase(),
      category: ci >= 0 ? (r[ci] ?? "General").trim() || "General" : "General",
      description: descI >= 0 ? (r[descI] ?? "").trim() : "",
      counterparty: cpI >= 0 ? (r[cpI] ?? "").trim() : "",
      status: si >= 0 ? (r[si] ?? "posted").trim().toLowerCase() : "posted",
      paymentMethod: mi >= 0 ? (r[mi] ?? "").trim() : "",
      amountCents: Math.round(parseFloat((r[ai] ?? "").replace(/[^0-9.\-]/g, "")) * 100),
    }));
    importer.mutate(mapped);
  };

  return (
    <div className="page-anim space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-font text-[27px] font-semibold tracking-tight">Money in &amp; out</h1>
          <p className="text-sm text-[var(--dim)]">
            {personal
              ? "Your daily money in and out, mapped. Tap a node to see the entries inside it."
              : "Every rupee, mapped. Tap a node to see the transactions inside it."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm"
            onClick={() => downloadFile("cashflow-transactions.csv", txnsToCsv(state.transactions), "text/csv")}
            disabled={state.transactions.length === 0}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm"
            onClick={() => fileRef.current?.click()}
          >
            Import CSV
          </button>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm"
            disabled={undoImport.isPending}
            onClick={() => void askUndoImport()}
            aria-label="Undo the last CSV import in this workspace"
          >
            Undo last import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="Choose a CSV file of transactions to import"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleCsv(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn-primary px-5 py-2 text-sm"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Add transaction
          </button>
        </div>
      </div>

      {importMsg ? (
        <div className="rounded-2xl bg-[var(--ai)] px-4 py-3 text-sm text-[var(--ai-text)]" role="status">
          <strong>CSV import:</strong> {importMsg}
        </div>
      ) : null}

      {state.transactions.length === 0 ? (
        <EmptyState
          title="Your universe is empty"
          body="Add your first income or expense and it will appear here as a flowing node around your available cash. You can also import a CSV export from your accounting tool — columns: date, type, category, description, counterparty, amount."
          action={
            <button
              type="button"
              className="btn-primary px-5 py-2.5 text-sm"
              onClick={() => {
                setEditing(null);
                setShowForm(true);
              }}
            >
              Add your first transaction
            </button>
          }
        />
      ) : (
        <>
          <section className="card relative overflow-hidden p-4 sm:p-6" aria-label="Money flow universe visualisation">
            {/* Mobile: stacked universe — centre cash card + tappable node grid */}
            <div className="sm:hidden">
              <div
                className="mx-auto flex h-32 w-32 flex-col items-center justify-center rounded-full text-center shadow-[0_18px_40px_rgba(168,85,247,0.18),inset_0_-12px_22px_rgba(192,132,252,0.25)]"
                style={{ background: "radial-gradient(circle at 32% 28%, #ffffff 0%, #F0EAFF 45%, #DDD6FE 100%)" }}
              >
                <span className="px-3 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
                  Available cash
                </span>
                <span className="px-2 text-lg font-extrabold leading-tight">
                  {fmtMoney(s.cashCents, cur)}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                {nodes.map((n) => {
                  const styles =
                    n.kind === "in"
                      ? "bg-[var(--surface-soft)] border-[var(--accent-bright)]"
                      : n.kind === "out"
                        ? "bg-[var(--err)] border-[#e3b3ae]"
                        : "bg-[#faf0d2] border-[#e9c46a]";
                  return (
                    <button
                      key={n.id}
                      type="button"
                      aria-label={`${n.label}: ${fmtMoney(n.cents, cur)} across ${n.txns.length} transactions. View details.`}
                      onClick={() => setSelected(n)}
                      className={`flex flex-col items-center rounded-2xl border px-2 py-2.5 text-center shadow-sm ${styles}`}
                    >
                      <span className="w-full truncate text-xs font-extrabold">{n.label}</span>
                      <span className="text-sm font-bold">{fmtMoney(n.cents, cur)}</span>
                      <span className="text-[11px] text-[var(--dim)]">{n.txns.length} entries</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="relative mx-auto hidden aspect-[4/3] w-full max-w-3xl sm:block sm:aspect-[16/9]">
              <svg viewBox="0 0 800 500" className="absolute inset-0 h-full w-full" aria-hidden>
                {nodes.map((n) => {
                  const rad = (n.angle * Math.PI) / 180;
                  const x = 400 + Math.cos(rad) * 305;
                  const y = 250 + Math.sin(rad) * 185;
                  const color =
                    n.kind === "in" ? "#C084FC" : n.kind === "out" ? "#FB7185" : "#FB923C";
                  return (
                    <path
                      key={n.id}
                      d={`M 400 250 Q ${(400 + x) / 2} ${(250 + y) / 2 - 34} ${x} ${y}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={n.kind === "pending" ? 2 : 3}
                      strokeDasharray="7 7"
                      opacity={0.75}
                      style={{ animation: "stream-dash 1.6s linear infinite" }}
                    />
                  );
                })}
              </svg>
              <div className="absolute left-1/2 top-1/2 flex h-32 w-32 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full text-center shadow-[0_18px_40px_rgba(168,85,247,0.18),inset_0_-12px_22px_rgba(192,132,252,0.25)] sm:h-40 sm:w-40"
                style={{ background: "radial-gradient(circle at 32% 28%, #ffffff 0%, #F0EAFF 45%, #DDD6FE 100%)" }}
              >
                <span className="px-3 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
                  Available cash
                </span>
                <span className="px-2 text-lg font-extrabold leading-tight sm:text-xl">
                  {fmtMoney(s.cashCents, cur)}
                </span>
              </div>
              {nodes.map((n) => {
                const rad = (n.angle * Math.PI) / 180;
                const x = 50 + (Math.cos(rad) * 305) / 8;
                const y = 50 + (Math.sin(rad) * 185) / 5;
                const styles =
                  n.kind === "in"
                    ? "bg-[var(--surface-soft)] border-[var(--accent-bright)]"
                    : n.kind === "out"
                      ? "bg-[var(--err)] border-[#e3b3ae]"
                      : "bg-[#faf0d2] border-[#e9c46a]";
                return (
                  <button
                    key={n.id}
                    type="button"
                    aria-label={`${n.label}: ${fmtMoney(n.cents, cur)} across ${n.txns.length} transactions. View details.`}
                    onClick={() => setSelected(n)}
                    className={`absolute flex w-28 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-2xl border px-2 py-2 text-center shadow-sm transition hover:shadow-md sm:w-32 ${styles}`}
                    style={{ left: `${x}%`, top: `${y}%` }}
                  >
                    <span className="w-full truncate text-xs font-extrabold">{n.label}</span>
                    <span className="text-sm font-bold">{fmtMoney(n.cents, cur)}</span>
                    <span className="text-[11px] text-[var(--dim)]">{n.txns.length} entries</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-2 text-xs">
              <Badge tone="mint">● Incoming</Badge>
              <Badge tone="err">● Outgoing</Badge>
              <Badge tone="gold">● Pending</Badge>
            </div>
          </section>

          {selected ? (
            <section className="card rise p-5" aria-label={`Details for ${selected.label}`}>
              <SectionTitle
                title={`${selected.label} — ${fmtMoney(selected.cents, cur)}`}
                hint={`${selected.txns.length} transaction(s) in this node`}
                action={
                  <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSelected(null)}>
                    Close
                  </button>
                }
              />
              <ul className="divide-y divide-[var(--border)]">
                {selected.txns.slice(0, 12).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{t.description || t.category}</p>
                      <p className="text-xs text-[var(--dim)]">
                        {prettyDate(t.date)} · {t.counterparty || "—"} · {t.status}
                      </p>
                    </div>
                    <span className="text-sm font-extrabold">{fmtMoney(t.amountCents, cur)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <section className="card p-5" aria-label="Transaction table">
        <SectionTitle title="Transactions" hint={`${filtered.length} of ${state.transactions.length} shown`} />
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick date views">
          {[
            { label: "All time", from: "", to: "" },
            { label: "This week", from: addDays(todayStr(), -((new Date().getDay() + 6) % 7)), to: todayStr() },
            { label: "Last 7 days", from: addDays(todayStr(), -6), to: todayStr() },
            { label: "This month", from: `${todayStr().slice(0, 7)}-01`, to: todayStr() },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={fromDate === p.from && toDate === p.to}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                fromDate === p.from && toDate === p.to
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-soft)] text-[var(--dim)]"
              }`}
              onClick={() => {
                setFromDate(p.from);
                setToDate(p.to);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <label className="col-span-2 block lg:col-span-1">
            <span className="sr-only">Search transactions</span>
            <input
              className="field"
              placeholder="Search description, customer, category…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search transactions"
            />
          </label>
          <label className="block">
            <span className="sr-only">Filter by type</span>
            <select className="field" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by transaction type">
              <option value="all">All types</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </label>
          <label className="block">
            <span className="sr-only">Filter by category</span>
            <select className="field" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label="Filter by category">
              <option value="all">All categories</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="sr-only">From date</span>
            <input type="date" className="field" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="Filter from date" />
          </label>
          <label className="block">
            <span className="sr-only">To date</span>
            <input type="date" className="field" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="Filter to date" />
          </label>
        </div>

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--dim)]">
            No transactions match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--dim)]">
                  <th className="py-2 pr-3 font-bold">Date</th>
                  <th className="py-2 pr-3 font-bold">Description</th>
                  <th className="py-2 pr-3 font-bold">Category</th>
                  <th className="py-2 pr-3 font-bold">Status</th>
                  <th className="py-2 pr-3 text-right font-bold">Amount</th>
                  <th className="py-2 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="whitespace-nowrap py-2.5 pr-3">{prettyDate(t.date)}</td>
                    <td className="py-2.5 pr-3">
                      <span className="font-semibold">{t.description || "—"}</span>
                      {t.counterparty ? <span className="block text-xs text-[var(--dim)]">{t.counterparty}</span> : null}
                      {t.demo ? <Badge tone="warn">Demo</Badge> : null}
                      {t.invoiceId ? <Badge tone="ai">Invoice payment</Badge> : null}
                    </td>
                    <td className="py-2.5 pr-3">{t.category}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={t.status === "posted" ? "mint" : "gold"}>{t.status}</Badge>
                      {t.paymentMethod ? <span className="ml-1"><Badge tone="grey">{t.paymentMethod}</Badge></span> : null}
                    </td>
                    <td className={`whitespace-nowrap py-2.5 pr-3 text-right font-extrabold ${t.type === "income" ? "text-[var(--accent)]" : "text-[#e11d63]"}`}>
                      {t.type === "income" ? "+" : "−"}{fmtMoney(t.amountCents, cur).replace("−", "")}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right">
                      <button
                        type="button"
                        className="btn-ghost mr-1 px-3 py-1 text-xs"
                        aria-label={`Edit transaction ${t.description || t.category}`}
                        disabled={!!t.invoiceId}
                        title={t.invoiceId ? "Invoice payments are managed from the invoice" : undefined}
                        onClick={() => {
                          setEditing(t);
                          setShowForm(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-3 py-1 text-xs"
                        aria-label={`Delete transaction ${t.description || t.category}`}
                        disabled={!!t.invoiceId || del.isPending}
                        onClick={() => void askDeleteTxn(t)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showForm ? (
        <TxnForm
          initial={editing}
          currency={cur}
          mode={mode}
          state={state}
          onClose={() => setShowForm(false)}
          notify={notify}
        />
      ) : null}
    </div>
  );
}

export function TxnForm({
  initial,
  mode = "business",
  state,
  onClose,
  notify,
}: {
  initial: Txn | null;
  currency: string;
  mode?: AppMode;
  state?: State;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const [type, setType] = useState<"income" | "expense">(initial?.type === "income" ? "income" : "expense");
  const [status, setStatus] = useState<"posted" | "pending">(initial?.status === "pending" ? "pending" : "posted");
  const [category, setCategory] = useState(initial?.category ?? "General");
  const [customCategory, setCustomCategory] = useState("");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [counterparty, setCounterparty] = useState(initial?.counterparty ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amountCents / 100) : "");
  const [date, setDate] = useState(initial?.date ?? todayStr());
  const [method, setMethod] = useState<string>(initial?.paymentMethod || "UPI");
  const [error, setError] = useState<string | null>(null);

  const isCustom = category === CUSTOM_CATEGORY;
  const effectiveCategory = isCustom ? customCategory.trim() : category;

  const save = useMutation({
    mutationFn: () =>
      api.saveTransaction({
        id: initial?.id,
        type,
        status,
        category: effectiveCategory,
        description,
        counterparty,
        amountCents: Math.round(parseFloat(amount) * 100),
        date,
        paymentMethod: method,
      }),
    onSuccess: () => {
      notify(initial ? "Transaction updated." : "Transaction saved.");
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // The current mode's built-in categories, plus this workspace's
  // remembered custom categories, plus the record's own category when
  // editing — nothing ever disappears from the list.
  const categories = categoryOptionsFor(state, mode, type, [initial?.category]);

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
    if (!date) {
      setError("Choose a date.");
      return;
    }
    save.mutate();
  };

  return (
    <Modal title={initial ? "Edit transaction" : "Add transaction"} onClose={onClose}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select
              className="field"
              value={type}
              aria-label="Transaction type"
              onChange={(e) => {
                const v = e.target.value === "income" ? "income" : "expense";
                setType(v);
                setCategory(categoriesFor(mode, v)[0]!);
                setCustomCategory("");
              }}
            >
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
          </Field>
          <Field label="Status">
            <select className="field" value={status} aria-label="Transaction status" onChange={(e) => setStatus(e.target.value === "pending" ? "pending" : "posted")}>
              <option value="posted">Posted (money moved)</option>
              <option value="pending">Pending (expected)</option>
            </select>
          </Field>
        </div>
        <Field label="Category">
          <CategorySelect options={categories} value={category} onChange={setCategory} ariaLabel="Transaction category" />
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
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={isPersonalLike(mode) ? "e.g. Groceries for the week" : "e.g. Website project — phase 1"} aria-label="Transaction description" maxLength={200} />
        </Field>
        <Field label={isPersonalLike(mode) ? "Paid to / received from" : "Customer / paid to"}>
          <input className="field" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder={isPersonalLike(mode) ? "e.g. Local market" : "e.g. Meera Studios"} aria-label="Counterparty" maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <input className="field" type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" required />
          </Field>
          <Field label="Date">
            <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Transaction date" required />
          </Field>
        </div>
        <Field label="Paid via">
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>
        {effectiveCategory === "Refunds" ? (
          <p className="rounded-xl bg-[var(--ai)] px-3 py-2 text-xs leading-relaxed text-[var(--ai-text)]">
            Recording a refund: it is saved once, as Refunds money-in, so it offsets the original
            expense in your net figures and is never double-counted. Don't edit or delete the
            original expense — the pair together shows what really happened.
          </p>
        ) : null}
        {error ? (
          <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm text-[var(--err-text)]" role="alert">{error}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost px-5 py-2.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary px-6 py-2.5 text-sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save transaction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
