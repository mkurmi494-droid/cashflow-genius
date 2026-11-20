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
import { Badge, CategorySelect, EmptyState, Field, Modal, SectionTitle } from "./components";
import { LoadingMark } from "./LoadingMark";
import { AnimatedMoney } from "./anim";

type Finding = ApiResponse<typeof api, "runScan">["findings"][number];

/** Average posted income a month over the last 3 complete months
 *  (the same grounding the server uses when no figure is typed). */
function avgMonthlyIncomeCents(state: PageProps["state"]): number {
  const curKey = monthKey(todayStr());
  const months = [shiftMonth(curKey, -3), shiftMonth(curKey, -2), shiftMonth(curKey, -1)];
  const byMonth = new Map<string, number>();
  for (const t of state.transactions) {
    if (t.status !== "posted" || t.type !== "income") continue;
    const k = monthKey(t.date);
    if (!months.includes(k)) continue;
    byMonth.set(k, (byMonth.get(k) ?? 0) + t.amountCents);
  }
  const vals = [...byMonth.values()].filter((v) => v > 0);
  return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0;
}

// ---------------- AI budget planner ----------------
// The AI only suggests: the user picks the rule (50/30/20 or their
// own percentages), the planner shows the suggestion as editable
// rows, and budgets are written only when they tap Save — one
// saveBudget per confirmed row. While the AI works, the Sprout
// loader keeps the wait visible ("Customizing your budget…").
function BudgetPlannerModal({
  state,
  currency,
  onClose,
  notify,
}: {
  state: PageProps["state"];
  currency: string;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const avgIncome = useMemo(() => avgMonthlyIncomeCents(state), [state]);
  const [income, setIncome] = useState(avgIncome > 0 ? String(avgIncome / 100) : "");
  const [lifestyle, setLifestyle] = useState("");
  const [rule, setRule] = useState<"50-30-20" | "custom">("50-30-20");
  const [needsPct, setNeedsPct] = useState("50");
  const [wantsPct, setWantsPct] = useState("30");
  const [savingsPct, setSavingsPct] = useState("20");
  const [suggestion, setSuggestion] = useState<ApiResponse<typeof api, "suggestBudget"> | null>(null);
  const [rows, setRows] = useState<{ category: string; bucket: "needs" | "wants"; amount: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const incomeCents = Math.round((parseFloat(income) || 0) * 100);
  const pctSum = (parseInt(needsPct) || 0) + (parseInt(wantsPct) || 0) + (parseInt(savingsPct) || 0);

  const suggest = useMutation({
    mutationFn: async () => {
      if (incomeCents <= 0) throw new Error("Enter your monthly income — the budget is a split of it.");
      if (rule === "custom" && pctSum !== 100) throw new Error("Your three percentages must add up to 100.");
      return await api.suggestBudget({
        monthlyIncomeCents: incomeCents,
        rule,
        ...(rule === "custom"
          ? {
              needsPct: parseInt(needsPct) || 0,
              wantsPct: parseInt(wantsPct) || 0,
              savingsPct: parseInt(savingsPct) || 0,
            }
          : {}),
        lifestyle: lifestyle.trim() || undefined,
      });
    },
    onSuccess: (res) => {
      setSuggestion(res);
      setRows(
        res.allocations.map((a) => ({
          category: a.category,
          bucket: a.bucket,
          amount: String(a.monthlyCents / 100),
        })),
      );
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    const valid = rows.filter((r) => r.category.trim() && (parseFloat(r.amount) || 0) > 0);
    if (valid.length === 0) {
      setError("Nothing to save — check the amounts.");
      return;
    }
    setSaving(true);
    setError(null);
    let saved = 0;
    const failed: string[] = [];
    for (const r of valid) {
      try {
        await api.saveBudget({
          category: r.category.trim().slice(0, 60),
          monthlyLimitCents: Math.round((parseFloat(r.amount) || 0) * 100),
        });
        saved++;
      } catch {
        failed.push(r.category);
      }
    }
    setSaving(false);
    if (saved > 0) {
      notify(
        `${saved} budget${saved > 1 ? "s" : ""} saved${failed.length ? ` — ${failed.length} could not be saved, try them again` : ""}. Run the scan again to check them.`,
      );
    }
    if (failed.length === 0) onClose();
    else setError(`Could not save: ${failed.join(", ")}. The rest are saved — fix these and try again.`);
  };

  const rowsTotal = rows.reduce((s, r) => s + Math.round((parseFloat(r.amount) || 0) * 100), 0);

  return (
    <Modal title="✦ Plan your budget with AI" onClose={onClose}>
      {suggest.isPending ? (
        <div className="py-6 text-center">
          <LoadingMark label="Customizing your budget…" />
          <p className="mt-1 text-sm text-[var(--dim)]">
            Shaping your split from your real income and spending — this usually takes a few seconds.
          </p>
        </div>
      ) : suggestion ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="ai">{suggestion.source === "ai" ? "Suggested by AI" : "Suggested by the 50/30/20 rule"}</Badge>
            <span className="font-bold">
              Needs {suggestion.needsPct}% · Wants {suggestion.wantsPct}% · Savings {suggestion.savingsPct}%
            </span>
            <span className="text-[var(--dim)]">of {fmtMoney(suggestion.monthlyIncomeCents, currency)} / month</span>
          </div>
          {suggestion.note ? (
            <p className="rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-sm leading-relaxed">{suggestion.note}</p>
          ) : null}
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Edit any amount before saving — nothing is set yet. The AI only suggests; you decide.
          </p>
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={`${r.category}-${i}`} className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-white p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{r.category}</p>
                  <p className="text-xs text-[var(--dim)]">{r.bucket === "needs" ? "Needs" : "Wants"}</p>
                </div>
                <label className="block w-32 shrink-0">
                  <span className="sr-only">Monthly budget for {r.category}</span>
                  <input
                    className="field tnum px-2 py-1.5 text-sm font-bold"
                    type="number"
                    inputMode="decimal"
                    step="1"
                    min="0"
                    value={r.amount}
                    onChange={(e) =>
                      setRows((xs) => xs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                    }
                    aria-label={`Monthly budget for ${r.category}`}
                  />
                </label>
                <button
                  type="button"
                  className="shrink-0 rounded-full px-2 py-1 text-xs font-bold text-[var(--dim)]"
                  aria-label={`Remove ${r.category}`}
                  onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold">Budgets total</span>
            <span className="tnum font-extrabold">{fmtMoney(rowsTotal, currency)} / month</span>
          </div>
          <div className="text-sm text-[var(--dim)]">
            <span className="font-bold text-[var(--text)]">Saving {fmtMoney(Math.max(0, suggestion.monthlyIncomeCents - rowsTotal), currency)} / month</span>
            {" "}— the part of your income left after these budgets.
          </div>
          {error ? (
            <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-xs font-semibold text-[var(--err-text)]" role="alert">{error}</p>
          ) : null}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost flex-1 px-4 py-3 text-sm" onClick={() => { setSuggestion(null); setRows([]); }}>
              Start over
            </button>
            <button type="button" className="btn-primary flex-1 px-4 py-3 text-sm" disabled={saving || rows.length === 0} onClick={() => void saveAll()}>
              {saving ? "Saving…" : `Save ${rows.length} budget${rows.length > 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            suggest.mutate();
          }}
        >
          <Field label={`Monthly income (${currency})`}>
            <input
              className="field tnum"
              type="number"
              inputMode="decimal"
              step="1"
              min="0"
              value={income}
              onChange={(e) => setIncome(e.target.value)}
              aria-label="Monthly income for the budget"
              placeholder="e.g. 60000"
              required
            />
          </Field>
          <p className="-mt-2 text-xs text-[var(--dim)]">
            {avgIncome > 0
              ? `Filled in from your records — your average posted income over the last 3 complete months. Change it if this month is different.`
              : `No income in the last 3 months — type your monthly income.`}
          </p>
          <div>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Your rule</span>
            <div className="grid grid-cols-2 gap-1 rounded-full border border-[var(--border)] bg-white p-1" role="group" aria-label="Budget rule">
              {(
                [
                  { key: "50-30-20", label: "50 / 30 / 20" },
                  { key: "custom", label: "My own rule" },
                ] as const
              ).map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRule(r.key)}
                  aria-pressed={rule === r.key}
                  className={`rounded-full px-2 py-2 text-xs font-bold ${rule === r.key ? "bg-[var(--accent)] text-white" : "text-[var(--dim)]"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {rule === "50-30-20" ? (
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
                The classic split: 50% needs, 30% wants, 20% savings — shaped by what you actually spend.
              </p>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(
                  [
                    { key: "needs", label: "Needs %", value: needsPct, set: setNeedsPct },
                    { key: "wants", label: "Wants %", value: wantsPct, set: setWantsPct },
                    { key: "savings", label: "Savings %", value: savingsPct, set: setSavingsPct },
                  ] as const
                ).map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">{f.label}</span>
                    <input
                      className="field tnum px-2 py-1.5 text-sm font-bold"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max="100"
                      value={f.value}
                      onChange={(e) => f.set(e.target.value)}
                      aria-label={f.label}
                    />
                  </label>
                ))}
              </div>
            )}
            {rule === "custom" ? (
              <p className={`mt-1.5 text-xs font-bold ${pctSum === 100 ? "text-[var(--dim)]" : "text-[var(--err-text)]"}`}>
                Your three percentages add up to {pctSum} — they must total 100.
              </p>
            ) : null}
          </div>
          <Field label="About your life (optional)">
            <input
              className="field"
              value={lifestyle}
              onChange={(e) => setLifestyle(e.target.value)}
              aria-label="About your life, for the budget suggestion"
              placeholder="e.g. I eat out a lot, I am saving for a bike"
              maxLength={500}
            />
          </Field>
          {error ? (
            <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-xs font-semibold text-[var(--err-text)]" role="alert">{error}</p>
          ) : null}
          <button type="submit" className="btn-primary w-full px-6 py-3 text-sm" disabled={suggest.isPending}>
            Create my budget →
          </button>
          <p className="text-center text-[11px] leading-relaxed text-[var(--dim)]">
            The AI only suggests — nothing is saved until you check the amounts and tap Save.
          </p>
        </form>
      )}
    </Modal>
  );
}

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
  const [showPlanner, setShowPlanner] = useState(false);
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
        <button
          type="button"
          className="btn-primary mb-4 px-4 py-2.5 text-sm"
          onClick={() => setShowPlanner(true)}
        >
          ✦ Plan with AI — 50/30/20 or your own rule
        </button>
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
      {showPlanner ? (
        <BudgetPlannerModal state={state} currency={cur} onClose={() => setShowPlanner(false)} notify={notify} />
      ) : null}
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
