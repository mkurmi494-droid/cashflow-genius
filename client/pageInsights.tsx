import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
Bar,
BarChart,
CartesianGrid,
Cell,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import {
allKnownCategories,
CUSTOM_CATEGORY,
categoryOptionsFor,
expenseCategoriesFor,
downloadFile,
downloadPdf,
fmtMoney,
isPersonalLike,
modeOf,
monthKey,
monthLabel,
prettyDate,
shiftMonth,
summarise,
todayStr,
} from "./lib";
import type { PageProps } from "./types";
import { Badge, CategorySelect, EmptyState, Field, SectionTitle } from "./components";
import { AnimatedMoney } from "./anim";

type Finding = ApiResponse<typeof api, "runScan">["findings"][number];

// ---------------- Profit Leak Scanner ----------------

export function ScannerPage({ state, notify, notifyDeleted, confirm, saveToVault }: PageProps) {
  const cur = state.business.currency;
  const mode = modeOf(state);
  const personal = isPersonalLike(mode);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [budgetCat, setBudgetCat] = useState(expenseCategoriesFor(mode)[0]!);
  const [budgetCustom, setBudgetCustom] = useState("");
  const [budgetAmt, setBudgetAmt] = useState("");
  const budgetIsCustom = budgetCat === CUSTOM_CATEGORY;
  const effectiveBudgetCat = budgetIsCustom ? budgetCustom.trim() : budgetCat;

  const scan = useMutation({
    mutationFn: () => api.runScan({}),
    onSuccess: (res) => {
      setFindings(res.findings);
      setScanned(res.scannedCount);
    },
    onError: (e) => notify(`Scan failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const saveBudget = useMutation({
    mutationFn: () =>
      api.saveBudget({
        category: effectiveBudgetCat,
        monthlyLimitCents: Math.round(parseFloat(budgetAmt) * 100),
      }),
    onSuccess: () => {
      notify(`Budget set for ${effectiveBudgetCat}. Run the scan again to check it.`);
      setBudgetAmt("");
      setBudgetCustom("");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const delBudget = useMutation({
    mutationFn: (id: string) => api.deleteBudget({ id }),
    onSuccess: (res, id) => {
      const b = state.budgets.find((x) => x.id === id);
      notifyDeleted(`Budget removed — ${b ? `${b.category} (${fmtMoney(b.monthlyLimitCents, cur)}/month)` : "budget"}.`, res.trashId, b?.category);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteBudget = async (b: { id: string; category: string; monthlyLimitCents: number }) => {
    const ok = await confirm({
      title: `Remove the budget for ${b.category}?`,
      body: "The scanner will stop flagging overspends for this category. Your transactions are not touched, and you can undo this right after.",
      detail: `${b.category} · ${fmtMoney(b.monthlyLimitCents, cur)} / month`,
      confirmLabel: "Remove budget",
      danger: true,
    });
    if (ok) delBudget.mutate(b.id);
  };

  const sevTone = (sev: string): "err" | "warn" | "ai" =>
    sev === "high" ? "err" : sev === "medium" ? "warn" : "ai";

  return (
    <div className="page-anim space-y-6">
      <div className="text-center">
        <h1 className="display-font text-[27px] font-semibold tracking-tight">{personal ? "Spending check & budgets" : "Find leaks & budgets"}</h1>
        <p className="mx-auto mt-1 max-w-xl text-sm text-[var(--dim)]">
          {personal
            ? "A deterministic check of your own daily spending: possible duplicates, unusual increases, repeated subscriptions, recurring costs and budget overspends."
            : "A deterministic analysis of your own records: possible duplicates, unusual increases, repeated subscriptions, recurring costs and budget overspends."}
          Findings are flagged as <em>possible</em> anomalies to review — never
          presented as confirmed fraud.
        </p>
        <div className="relative mx-auto mt-5 max-w-sm overflow-hidden rounded-full">
          <button
            type="button"
            className="btn-primary relative w-full overflow-hidden px-8 py-3.5 text-base"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
          >
            {scan.isPending ? (
              <span
                aria-hidden
                className="absolute inset-y-0 w-1/3 bg-white/25"
                style={{ animation: "scan-sweep 1.1s linear infinite" }}
              />
            ) : null}
            {scan.isPending ? (personal ? "Checking your spending…" : "Scanning your business…") : personal ? "CHECK MY SPENDING" : "SCAN MY BUSINESS"}
          </button>
        </div>
        {findings !== null ? (
          <p className="mt-3 text-sm text-[var(--dim)]" role="status">
            Scanned {scanned} transactions · {findings.length} finding(s)
          </p>
        ) : null}
      </div>

      {findings === null ? (
        state.transactions.length === 0 ? (
          <EmptyState
            title="Nothing to scan yet"
            body="The scanner reads your recorded transactions. Add expenses in Money Flow and then run a scan — it flags duplicate charges, price hikes and unusual spikes with the exact amounts."
          />
        ) : (
          <div className="card px-5 py-8 text-center text-sm text-[var(--dim)]">
            Press <strong className="text-[var(--text)]">{personal ? "CHECK MY SPENDING" : "SCAN MY BUSINESS"}</strong> to analyse{" "}
            {state.transactions.length} recorded transactions.
          </div>
        )
      ) : findings.length === 0 ? (
        <div className="card px-5 py-8 text-center">
          <p className="text-lg font-extrabold text-[var(--accent)]">No leaks found 🎉</p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            No duplicates, spikes, repeated subscriptions or budget breaches were
            detected in the records scanned.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {findings.map((f, i) => (
            <article key={f.id} className="card rise p-5" style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-extrabold leading-snug">{f.title}</h2>
                <Badge tone={sevTone(f.severity)}>{f.severity}</Badge>
              </div>
              <p className="mt-2 text-xl font-extrabold">{fmtMoney(f.amountCents, cur)}</p>
              <p className="mt-1 text-xs text-[var(--dim)]">
                {f.dates.map(prettyDate).join(" · ")}
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="font-bold">Evidence</dt>
                  <dd className="text-[var(--dim)]">{f.evidence}</dd>
                </div>
                <div>
                  <dt className="font-bold">Why it matters</dt>
                  <dd className="text-[var(--dim)]">{f.explanation}</dd>
                </div>
                <div>
                  <dt className="font-bold">Suggested next action</dt>
                  <dd className="text-[var(--dim)]">{f.suggestion}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="btn-ghost mt-4 px-4 py-2 text-xs"
                onClick={() =>
                  saveToVault(
                    `Scanner: ${f.title}`,
                    `${f.title}\nAmount: ${fmtMoney(f.amountCents, cur)}\nDates: ${f.dates.join(", ")}\nEvidence: ${f.evidence}\nExplanation: ${f.explanation}\nSuggested action: ${f.suggestion}\n\nNote: flagged as a possible anomaly, not confirmed fraud.`,
                    "Profit Leak Scanner",
                  )
                }
              >
                Save finding to Memory Vault
              </button>
            </article>
          ))}
        </div>
      )}

      <section className="card p-5" aria-label="Category budgets">
        <SectionTitle title="Category budgets" hint="The scanner flags any category that passes its monthly budget" />
        {state.budgets.length > 0 ? (
          <ul className="mb-4 divide-y divide-[var(--border)]">
            {state.budgets.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-sm font-semibold">{b.category}</span>
                <span className="flex items-center gap-2">
                  <span className="text-sm font-bold">{fmtMoney(b.monthlyLimitCents, cur)} / month</span>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1 text-xs"
                    aria-label={`Remove budget for ${b.category}`}
                    onClick={() => void askDeleteBudget(b)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const amt = parseFloat(budgetAmt);
            if (!Number.isFinite(amt) || amt <= 0) {
              notify("Enter a monthly budget amount above zero.");
              return;
            }
            if (!effectiveBudgetCat) {
              notify("Type your custom category name.");
              return;
            }
            saveBudget.mutate();
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="block flex-1">
              <span className="sr-only">Budget category</span>
              <CategorySelect
                options={[...categoryOptionsFor(state, mode, "expense"), ...allKnownCategories(state)].filter((v, i, a) => a.indexOf(v) === i)}
                value={budgetCat}
                onChange={setBudgetCat}
                ariaLabel="Budget category"
              />
            </label>
            <label className="block flex-1">
              <span className="sr-only">Monthly budget amount</span>
              <input className="field" type="number" min="0" step="1" placeholder="Monthly limit, e.g. 40000" value={budgetAmt} onChange={(e) => setBudgetAmt(e.target.value)} aria-label="Monthly budget amount" />
            </label>
            <button type="submit" className="btn-primary px-5 py-2.5 text-sm" disabled={saveBudget.isPending}>
              Set budget
            </button>
          </div>
          {budgetIsCustom ? (
            <label className="block">
              <span className="sr-only">Custom budget category name</span>
              <input
                className="field"
                value={budgetCustom}
                onChange={(e) => setBudgetCustom(e.target.value)}
                aria-label="Custom category name"
                placeholder="Type your own category, e.g. Pet care"
                maxLength={60}
                autoFocus
              />
            </label>
          ) : null}
        </form>
      </section>
    </div>
  );
}

// ---------------- GST & Tax Intelligence ----------------

export function TaxPage({ state, notify }: PageProps) {
  const cur = state.business.currency;
  const s = useMemo(() => summarise(state), [state]);
  const [fyStart, setFyStart] = useState(() => {
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return y;
  });
  const [rate, setRate] = useState(state.business.gstRateBp / 100);
  const [inclusive, setInclusive] = useState(state.business.gstInclusive);
  const [eligiblePct, setEligiblePct] = useState(state.business.eligibleExpensePct);

  const saveSettings = useMutation({
    mutationFn: () =>
      api.updateBusiness({
        ...state.business,
        gstRateBp: Math.round(rate * 100),
        gstInclusive: inclusive,
        eligibleExpensePct: eligiblePct,
      }),
    onSuccess: () => notify("Tax settings saved to your business profile."),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const fyTxns = useMemo(() => {
    const from = `${fyStart}-04-01`;
    const to = `${fyStart + 1}-03-31`;
    return state.transactions.filter(
      (t) => t.status === "posted" && t.date >= from && t.date <= to,
    );
  }, [state, fyStart]);

  const est = useMemo(() => {
    const revenue = fyTxns.filter((t) => t.type === "income").reduce((a, t) => a + t.amountCents, 0);
    const expenses = fyTxns.filter((t) => t.type === "expense").reduce((a, t) => a + t.amountCents, 0);
    const r = rate / 100;
    const outputGst = inclusive
      ? Math.round(revenue - revenue / (1 + r))
      : Math.round(revenue * r);
    const eligibleBase = Math.round(expenses * (eligiblePct / 100));
    const inputCredit = inclusive
      ? Math.round(eligibleBase - eligibleBase / (1 + r))
      : Math.round(eligibleBase * r);
    const taxCat = fyTxns
      .filter((t) => t.type === "expense" && /tax/i.test(t.category))
      .reduce((a, t) => a + t.amountCents, 0);
    return {
      revenue,
      expenses,
      outputGst,
      inputCredit,
      netPayable: Math.max(0, outputGst - inputCredit),
      taxCat,
    };
  }, [fyTxns, rate, inclusive, eligiblePct]);

  return (
    <div className="page-anim space-y-6">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">GST &amp; tax</h1>
        <p className="text-sm text-[var(--dim)]">
          Estimates for {state.business.country} from your recorded transactions.
        </p>
      </div>

      <div className="rounded-2xl bg-[var(--warn)] px-4 py-3 text-sm text-[var(--warn-text)]">
        <strong>Estimate only — not tax advice, and nothing is filed for you.</strong>{" "}
        These figures are a planning aid calculated from the transactions you recorded
        and the assumptions below. Confirm your actual liability with a qualified tax
        professional or your official GST portal before paying.
      </div>

      <section className="card p-5" aria-label="Tax parameters">
        <SectionTitle title="Tax parameters" hint="Fully configurable — saved to your business profile" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Country / jurisdiction">
            <input className="field" value={state.business.country} readOnly aria-label="Country (change in Settings)" />
          </Field>
          <Field label="Financial year (Apr–Mar)">
            <select
              className="field"
              value={fyStart}
              aria-label="Financial year"
              onChange={(e) => setFyStart(Number(e.target.value))}
            >
              {[0, 1, 2].map((off) => {
                const y = new Date().getFullYear() - off;
                return (
                  <option key={y} value={y}>
                    FY {y}–{String(y + 1).slice(2)}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="GST rate %">
            <input className="field" type="number" min="0" max="100" step="0.1" value={rate} aria-label="GST rate percent" onChange={(e) => setRate(Number(e.target.value) || 0)} />
          </Field>
          <Field label="Eligible expense % (input credit)">
            <input className="field" type="number" min="0" max="100" step="1" value={eligiblePct} aria-label="Eligible expense percent" onChange={(e) => setEligiblePct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={inclusive}
            aria-label="Recorded amounts include GST"
            onChange={(e) => setInclusive(e.target.checked)}
          />
          My recorded amounts already include GST (tax-inclusive)
        </label>
        <button
          type="button"
          className="btn-primary mt-4 px-5 py-2.5 text-sm"
          disabled={saveSettings.isPending}
          onClick={() => saveSettings.mutate()}
        >
          Save tax settings
        </button>
      </section>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[
          { label: `Revenue in FY ${fyStart}`, v: est.revenue },
          { label: "Output GST (on sales)", v: est.outputGst },
          { label: "Input tax credit (estimate)", v: est.inputCredit },
          { label: "Estimated net GST payable", v: est.netPayable },
        ].map((k) => (
          <article key={k.label} className="card p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">{k.label}</p>
            <p className="mt-1 text-xl font-extrabold sm:text-2xl"><AnimatedMoney cents={k.v} currency={cur} /></p>
          </article>
        ))}
      </div>

      <section className="card p-5" aria-label="Tax calculation assumptions">
        <SectionTitle title="How this estimate is calculated" />
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-[var(--dim)]">
          <li>
            Output GST is calculated at {rate}% on posted income of {fmtMoney(est.revenue, cur)}{" "}
            in FY {fyStart}–{fyStart + 1}
            {inclusive ? ", extracting the tax portion because your amounts are tax-inclusive." : ", added on top because your amounts are tax-exclusive."}
          </li>
          <li>
            Input tax credit assumes {eligiblePct}% of your posted expenses ({fmtMoney(est.expenses, cur)})
            were GST-eligible business purchases at the same rate. In reality, credit
            depends on supplier invoices and GSTIN matching — this is a planning estimate.
          </li>
          <li>
            You recorded {fmtMoney(est.taxCat, cur)} in the "Taxes & fees" expense category
            this financial year; it is shown for reference and is not double-counted above.
          </li>
          <li>
            All-time totals for context: revenue {fmtMoney(s.revenueCents, cur)}, expenses{" "}
            {fmtMoney(s.expensesCents, cur)}. Only the selected financial year feeds the
            GST estimate.
          </li>
        </ul>
        <div className="mt-4 rounded-xl bg-[var(--ai)] px-4 py-3 text-sm text-[var(--ai-text)]">
          <strong>Learn:</strong> GST is a value-added tax — you collect it on sales
          (output tax) and claim back the GST you paid on eligible business purchases
          (input tax credit). You remit only the difference. Rates and eligibility vary
          by product, state and registration type, which is why every parameter above is
          yours to configure.
        </div>
      </section>

      <section className="card p-5" aria-label="GSTR-1 style invoice export">
        <SectionTitle
          title="GSTR-1 style invoice export"
          hint={`Sales invoices issued in FY ${fyStart}–${fyStart + 1}, ready to check against your GST filing`}
        />
        {(() => {
          const fyInvs = state.invoices.filter(
            (i) => i.issueDate >= `${fyStart}-04-01` && i.issueDate <= `${fyStart + 1}-03-31`,
          );
          const exportCsv = () => {
            const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
            const head = "invoice_number,invoice_date,customer,customer_email,status,taxable_value,gst_amount,total";
            const lines = fyInvs.map((i) =>
              [
                esc(i.number),
                i.issueDate,
                esc(i.customerName),
                esc(i.customerEmail),
                i.effectiveStatus,
                (i.subtotalCents / 100).toFixed(2),
                (i.taxCents / 100).toFixed(2),
                (i.totalCents / 100).toFixed(2),
              ].join(","),
            );
            downloadFile(`gstr1-invoices-fy${fyStart}.csv`, [head, ...lines].join("\n"), "text/csv");
          };
          return fyInvs.length === 0 ? (
            <p className="text-sm text-[var(--dim)]">
              No invoices were issued in this financial year in this workspace, so there is
              nothing to export. This export lists your own invoices for reconciliation —
              it does not file a return or generate an e-invoice for you.
            </p>
          ) : (
            <>
              <p className="text-sm text-[var(--dim)]">
                {fyInvs.length} invoice(s) totalling{" "}
                {fmtMoney(fyInvs.reduce((a, i) => a + i.totalCents, 0), cur)} (taxable{" "}
                {fmtMoney(fyInvs.reduce((a, i) => a + i.subtotalCents, 0), cur)} + GST{" "}
                {fmtMoney(fyInvs.reduce((a, i) => a + i.taxCents, 0), cur)}). Download the CSV
                and reconcile it with the GST portal / your CA before filing. Cashflow Genius
                does not file GSTR-1 or create e-invoices itself.
              </p>
              <button type="button" className="btn-primary mt-3 px-5 py-2.5 text-sm" onClick={exportCsv}>
                Download GSTR-1 style CSV
              </button>
            </>
          );
        })()}
      </section>
    </div>
  );
}

// ---------------- Business Reports Vault ----------------

type ReportKind = "pl" | "cashflow" | "income" | "expense" | "category" | "monthly";

export function ReportsPage({ state, notify }: PageProps) {
  const cur = state.business.currency;
  const personal = isPersonalLike(modeOf(state));
  const [kind, setKind] = useState<ReportKind>("pl");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const txns = useMemo(
    () =>
      state.transactions.filter((t) => {
        if (from && t.date < from) return false;
        if (to && t.date > to) return false;
        return true;
      }),
    [state, from, to],
  );
  const posted = txns.filter((t) => t.status === "posted");
  const income = posted.filter((t) => t.type === "income");
  const expenses = posted.filter((t) => t.type === "expense");
  const revTotal = income.reduce((a, t) => a + t.amountCents, 0);
  const expTotal = expenses.reduce((a, t) => a + t.amountCents, 0);

  const catRows = (list: typeof posted) => {
    const map = new Map<string, number>();
    for (const t of list) map.set(t.category, (map.get(t.category) ?? 0) + t.amountCents);
    return [...map.entries()]
      .map(([name, cents]) => ({ name, cents, value: cents / 100 }))
      .sort((a, b) => b.cents - a.cents);
  };
  const incCats = catRows(income);
  const expCats = catRows(expenses);

  const monthly = useMemo(() => {
    const curKey = monthKey(todayStr());
    return Array.from({ length: 6 }, (_, i) => {
      const mk = shiftMonth(curKey, i - 5);
      const list = posted.filter((t) => monthKey(t.date) === mk);
      const r = list.filter((t) => t.type === "income").reduce((a, t) => a + t.amountCents, 0);
      const e = list.filter((t) => t.type === "expense").reduce((a, t) => a + t.amountCents, 0);
      return { month: monthLabel(mk), revenue: r / 100, expenses: e / 100, net: (r - e) / 100 };
    });
  }, [posted]);

  const reportLines = (): string[] => {
    const head = [
      state.business.name || "Cashflow Genius workspace",
      `Report period: ${from || "beginning"} to ${to || "today"}`,
      "",
    ];
    if (kind === "pl") {
      return [
        ...head,
        personal ? "INCOME VS SPENDING" : "PROFIT AND LOSS",
        `${personal ? "Total income" : "Total revenue"}: ${fmtMoney(revTotal, cur, 2)}`,
        `${personal ? "Total spending" : "Total expenses"}: ${fmtMoney(expTotal, cur, 2)}`,
        `${personal ? "Left over" : "Net profit"}: ${fmtMoney(revTotal - expTotal, cur, 2)}`,
        "",
        "Income by category:",
        ...incCats.map((c) => `  ${c.name}: ${fmtMoney(c.cents, cur, 2)}`),
        "Expenses by category:",
        ...expCats.map((c) => `  ${c.name}: ${fmtMoney(c.cents, cur, 2)}`),
      ];
    }
    if (kind === "cashflow") {
      return [
        ...head,
        "CASHFLOW STATEMENT",
        `Opening balance: ${fmtMoney(state.business.openingBalanceCents, cur, 2)}`,
        `Cash in (posted income): ${fmtMoney(revTotal, cur, 2)}`,
        `Cash out (posted expenses): ${fmtMoney(expTotal, cur, 2)}`,
        `Closing cash (all-time basis): ${fmtMoney(state.business.openingBalanceCents + revTotal - expTotal, cur, 2)}`,
        "Note: unpaid invoices are not counted as cash.",
      ];
    }
    if (kind === "income" || kind === "expense") {
      const list = kind === "income" ? income : expenses;
      return [
        ...head,
        kind === "income" ? "INCOME REPORT" : "EXPENSE REPORT",
        ...list.map(
          (t) => `${t.date}  ${t.category}  ${t.description}  ${fmtMoney(t.amountCents, cur, 2)}`,
        ),
        "",
        `Total: ${fmtMoney(kind === "income" ? revTotal : expTotal, cur, 2)}`,
      ];
    }
    if (kind === "category") {
      return [
        ...head,
        "CATEGORY BREAKDOWN",
        "Income:",
        ...incCats.map((c) => `  ${c.name}: ${fmtMoney(c.cents, cur, 2)}`),
        "Expenses:",
        ...expCats.map((c) => `  ${c.name}: ${fmtMoney(c.cents, cur, 2)}`),
      ];
    }
    return [
      ...head,
      "MONTHLY COMPARISON (last 6 months, ignores date filter)",
      ...monthly.map(
        (m) =>
          `${m.month}: revenue ${fmtMoney(Math.round(m.revenue * 100), cur, 2)}, expenses ${fmtMoney(Math.round(m.expenses * 100), cur, 2)}, net ${fmtMoney(Math.round(m.net * 100), cur, 2)}`,
      ),
    ];
  };

  const titles: Record<ReportKind, string> = {
    pl: personal ? "Income vs Spending" : "Profit and Loss",
    cashflow: "Cashflow Statement",
    income: "Income Report",
    expense: personal ? "Spending Report" : "Expense Report",
    category: "Category Breakdown",
    monthly: "Monthly Comparison",
  };

  const chartData =
    kind === "category" || kind === "pl"
      ? [...incCats.map((c) => ({ name: c.name, value: c.value, kind: "Income" })), ...expCats.map((c) => ({ name: c.name, value: c.value, kind: "Expense" }))]
      : monthly;

  return (
    <div className="page-anim space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-font text-[27px] font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-[var(--dim)]">
            Every report is produced by the same calculation engine as the Command
            Center — one source of truth.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-5 py-2.5 text-sm"
          onClick={() => {
            downloadPdf(`report-${kind}.pdf`, titles[kind], reportLines());
            notify(`${titles[kind]} PDF downloaded.`);
          }}
        >
          Download PDF
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Report type">
        {(Object.keys(titles) as ReportKind[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`px-4 py-2 text-sm ${kind === k ? "btn-primary" : "btn-ghost"}`}
          >
            {titles[k]}
          </button>
        ))}
      </div>

      <section className="card p-5">
        <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
          <Field label="From date">
            <input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Report from date" />
          </Field>
          <Field label="To date">
            <input type="date" className="field" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Report to date" />
          </Field>
        </div>

        <h2 className="text-lg font-extrabold">{titles[kind]}</h2>
        <p className="mb-4 text-sm text-[var(--dim)]">
          {posted.length} posted transaction(s) in scope · {personal ? "Income" : "Revenue"} {fmtMoney(revTotal, cur)} ·
          {personal ? "Spending" : "Expenses"} {fmtMoney(expTotal, cur)} · {personal ? "Left over" : "Net"} {fmtMoney(revTotal - expTotal, cur)}
        </p>

        {kind === "monthly" ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthly}>
                <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6D6390" }} />
                <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
                <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#7C3AED" strokeWidth={2.4} isAnimationActive animationDuration={900} animationEasing="ease-out" />
                <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#f43f5e" strokeWidth={2.4} isAnimationActive animationDuration={900} animationEasing="ease-out" />
                <Line type="monotone" dataKey="net" name="Net" stroke="#38BDF8" strokeWidth={2} strokeDasharray="5 4" isAnimationActive animationDuration={900} animationEasing="ease-out" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData as { name: string; value: number }[]}>
                <CartesianGrid stroke="#E6DEF8" strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6D6390" }} interval={0} angle={-18} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 12, fill: "#6D6390" }} width={52} />
                <Tooltip formatter={(v: number) => fmtMoney(Math.round(v * 100), cur)} />
                <Bar dataKey="value" name="Amount" radius={[8, 8, 0, 0]} isAnimationActive animationDuration={850} animationEasing="ease-out">
                  {(chartData as { name: string; value: number; kind?: string }[]).map((d, i) => (
                    <Cell key={i} fill={d.kind === "Expense" ? "#FB7185" : "#C084FC"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--dim)]">
                <th className="py-2 pr-3">Line</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {reportLines()
                .slice(3)
                .filter((l) => l.trim() !== "")
                .map((l, i) => {
                  const parts = l.split(": ");
                  return (
                    <tr key={i} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pr-3">{parts.length > 1 ? parts.slice(0, -1).join(": ") : l}</td>
                      <td className="py-2 text-right font-semibold">{parts.length > 1 ? parts[parts.length - 1] : ""}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--dim)]">
          The PDF export contains this same report in full. Figures count posted
          transactions only; unpaid invoices never count as cash.
        </p>
      </section>
    </div>
  );
}
