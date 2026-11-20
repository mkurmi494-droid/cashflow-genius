// AI budget planner — pure suggestion logic (harness-covered in
// scripts/budget-planner-test.mjs). The AI only suggests; budgets are
// written only when the user taps Save. When the AI call fails, the
// deterministic 50/30/20 rule below is the fallback — same shape,
// same grounding, no invention.
//
// Grounding: monthly income (average posted income over the last 3
// complete months, or the user's typed figure) and the last 3 months'
// actual spending per category. Needs/wants split follows the
// category's meaning, not the model's mood: a category is "needs"
// when it matches a needs keyword below, otherwise "wants". Savings
// is the remainder — it is never allocated to a category.
export type BudgetBucket = "needs" | "wants";

export type BudgetAllocation = {
  category: string;
  bucket: BudgetBucket;
  monthlyCents: number; // integer paise
};

export type BudgetSuggestion = {
  needsPct: number;
  wantsPct: number;
  savingsPct: number;
  allocations: BudgetAllocation[];
  note: string;
};

// Substring match (lowercase): "Food & groceries", "Food & canteen",
// "Rent & home", "Bills & recharge", "Fees & education" all match.
const NEEDS_KEYWORDS = [
  "food",
  "grocen",
  "canteen",
  "rent",
  "bill",
  "recharge",
  "emi",
  "loan",
  "transport",
  "health",
  "education",
  "fees",
  "books",
  "courses",
  "utilit",
  "tax",
  "salar",
  "supplier",
];

export function classifyBudgetCategory(category: string): BudgetBucket {
  const name = category.toLowerCase();
  return NEEDS_KEYWORDS.some((k) => name.includes(k)) ? "needs" : "wants";
}

/** Split a bucket's paise across its categories pro-rata by their
 *  3-month average spend. Categories with no history share the bucket
 *  equally (so a new category still gets a suggestion). Whole rupees
 *  only; the largest item absorbs the rounding remainder so the
 *  bucket total is exact. */
function splitBucket(
  bucketTotalCents: number,
  items: { category: string; avgMonthlyCents: number }[],
): BudgetAllocation[] {
  if (items.length === 0 || bucketTotalCents <= 0) return [];
  const totalHistory = items.reduce((s, it) => s + Math.max(0, it.avgMonthlyCents), 0);
  const weights = totalHistory > 0
    ? items.map((it) => Math.max(0, it.avgMonthlyCents) / totalHistory)
    : items.map(() => 1 / items.length);
  const amounts = weights.map((w) => Math.round((bucketTotalCents * w) / 100) * 100);
  const drift = bucketTotalCents - amounts.reduce((s, a) => s + a, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < amounts.length; i++) if (amounts[i] > amounts[biggest]) biggest = i;
    amounts[biggest] += drift;
  }
  return items.map((it, i) => ({
    category: it.category,
    bucket: classifyBudgetCategory(it.category),
    monthlyCents: Math.max(0, amounts[i]),
  }));
}

export function deterministicBudget(input: {
  monthlyIncomeCents: number;
  needsPct: number;
  wantsPct: number;
  savingsPct: number;
  // Average monthly spend per expense category over the last 3 months.
  history: { category: string; avgMonthlyCents: number }[];
  // Every expense category in this workspace (so categories with no
  // history still get a share of their bucket).
  categories: string[];
}): BudgetSuggestion {
  const income = Math.max(0, Math.round(input.monthlyIncomeCents));
  const needsPct = Math.max(0, Math.min(100, Math.round(input.needsPct)));
  const wantsPct = Math.max(0, Math.min(100, Math.round(input.wantsPct)));
  const savingsPct = Math.max(0, 100 - needsPct - wantsPct);
  const byCategory = new Map<string, number>();
  for (const h of input.history) byCategory.set(h.category, Math.max(0, h.avgMonthlyCents));
  for (const c of input.categories) if (!byCategory.has(c)) byCategory.set(c, 0);
  const needsItems = [...byCategory.entries()]
    .filter(([c]) => classifyBudgetCategory(c) === "needs")
    .map(([category, avgMonthlyCents]) => ({ category, avgMonthlyCents }));
  const wantsItems = [...byCategory.entries()]
    .filter(([c]) => classifyBudgetCategory(c) === "wants")
    .map(([category, avgMonthlyCents]) => ({ category, avgMonthlyCents }));
  const needsTotal = Math.round((income * needsPct) / 100);
  const wantsTotal = Math.round((income * wantsPct) / 100);
  const allocations = [
    ...splitBucket(needsTotal, needsItems),
    ...splitBucket(wantsTotal, wantsItems),
  ]
    .filter((a) => a.monthlyCents > 0)
    .sort((a, b) => b.monthlyCents - a.monthlyCents);
  return {
    needsPct,
    wantsPct,
    savingsPct,
    allocations,
    note: `A ${needsPct}/${wantsPct}/${savingsPct} split of ${income === 0 ? "your monthly income" : "₹" + (income / 100).toLocaleString("en-IN") + " a month"}, shared across categories by what you actually spent in the last 3 months. Edit any amount before saving — nothing is set yet.`,
  };
}

/** Validate + repair an AI suggestion so it can never write nonsense:
 *  percentages clamped to 0–100 and rebalanced to sum 100, rows with
 *  an empty category or non-positive amount dropped, unknown buckets
 *  reclassified by category name, amounts rounded to whole rupees,
 *  and each bucket's total rescaled to its percentage of income
 *  (the largest row absorbs the remainder). Returns null when the
 *  shape is unusable (no income, no valid rows). */
export function normalizeBudgetSuggestion(
  raw: unknown,
  input: { monthlyIncomeCents: number; categories: string[] },
): BudgetSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const income = Math.max(0, Math.round(input.monthlyIncomeCents));
  if (income <= 0) return null;
  let needsPct = Math.max(0, Math.min(100, Math.round(Number(r.needsPct) || 0)));
  let wantsPct = Math.max(0, Math.min(100, Math.round(Number(r.wantsPct) || 0)));
  if (needsPct + wantsPct > 100) {
    const scale = 100 / (needsPct + wantsPct);
    needsPct = Math.round(needsPct * scale);
    wantsPct = 100 - needsPct;
  }
  const savingsPct = 100 - needsPct - wantsPct;
  const rows = Array.isArray(r.allocations) ? r.allocations : [];
  const cleaned: { category: string; bucket: BudgetBucket; monthlyCents: number }[] = [];
  for (const row of rows.slice(0, 50)) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const category = String(o.category ?? "").trim().slice(0, 60);
    const monthlyCents = Math.round(Number(o.monthlyCents) || 0);
    if (!category || monthlyCents <= 0) continue;
    cleaned.push({
      category,
      bucket: o.bucket === "needs" || o.bucket === "wants" ? o.bucket : classifyBudgetCategory(category),
      monthlyCents,
    });
  }
  if (cleaned.length === 0) return null;
  // Rescale each bucket to its percentage of income.
  const rescale = (bucket: BudgetBucket, pct: number): BudgetAllocation[] => {
    const items = cleaned.filter((c) => c.bucket === bucket);
    if (items.length === 0) return [];
    const target = Math.round((income * pct) / 100);
    const total = items.reduce((s, it) => s + it.monthlyCents, 0);
    if (total <= 0) return [];
    const amounts = items.map((it) => Math.round((it.monthlyCents / total) * target / 100) * 100);
    const drift = target - amounts.reduce((s, a) => s + a, 0);
    if (drift !== 0) {
      let biggest = 0;
      for (let i = 1; i < amounts.length; i++) if (amounts[i] > amounts[biggest]) biggest = i;
      amounts[biggest] += drift;
    }
    return items.map((it, i) => ({ category: it.category, bucket, monthlyCents: Math.max(0, amounts[i]) }));
  };
  const allocations = [...rescale("needs", needsPct), ...rescale("wants", wantsPct)]
    .filter((a) => a.monthlyCents > 0)
    .sort((a, b) => b.monthlyCents - a.monthlyCents);
  if (allocations.length === 0) return null;
  return {
    needsPct,
    wantsPct,
    savingsPct,
    allocations,
    note: typeof r.note === "string" ? r.note.slice(0, 300) : "",
  };
}
