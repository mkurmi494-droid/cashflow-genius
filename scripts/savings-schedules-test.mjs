// Savings schedule date tests for server/lib/savingsSchedules.ts (pure).
// Proves the recurring-date math behind one-time / monthly / yearly
// savings: (1) monthly advances one month, (2) December rolls to
// January of the next year, (3) the day clamps to short months
// (31 Jan -> 28 Feb) and sticks, (4) yearly advances one year with
// 29 Feb -> 28 Feb in a non-leap year, (5) "once" has no next date,
// (6) an impossible date is rejected, (7) due means due-date <= today.
// Run: node scripts/savings-schedules-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-savings-schedules-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
};

const src = readFileSync(join(repo, "server/lib/savingsSchedules.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "savingsSchedules.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);

check("monthly advances one month", mod.nextDueDateAfter("2026-11-20", "monthly"), "2026-12-20");
check("monthly Dec rolls to Jan next year", mod.nextDueDateAfter("2026-12-20", "monthly"), "2027-01-20");
check("monthly clamps 31 Jan to 28 Feb", mod.nextDueDateAfter("2026-01-31", "monthly"), "2026-02-28");
check("clamped day sticks (28 Feb -> 28 Mar)", mod.nextDueDateAfter("2026-02-28", "monthly"), "2026-03-28");
check("monthly 31 Mar -> 30 Apr", mod.nextDueDateAfter("2026-03-31", "monthly"), "2026-04-30");
check("yearly advances one year", mod.nextDueDateAfter("2026-11-20", "yearly"), "2027-11-20");
check("yearly 29 Feb -> 28 Feb non-leap", mod.nextDueDateAfter("2024-02-29", "yearly"), "2025-02-28");
check("yearly 29 Feb -> 29 Feb leap", mod.nextDueDateAfter("2028-02-29", "yearly"), "2029-02-28");
check("once has no next date", mod.nextDueDateAfter("2026-11-20", "once"), null);
check("impossible date has no next date", mod.nextDueDateAfter("2026-02-30", "monthly"), null);
check("bad string has no next date", mod.nextDueDateAfter("not-a-date", "monthly"), null);
check("due today is due", mod.isDue("2026-11-20", "2026-11-20"), true);
check("overdue is due", mod.isDue("2026-11-18", "2026-11-20"), true);
check("future is not due", mod.isDue("2026-11-21", "2026-11-20"), false);
check("valid date accepted", mod.isValidDateStr("2026-02-28"), true);
check("impossible date rejected", mod.isValidDateStr("2026-02-30"), false);
check("frequency guard accepts monthly", mod.isScheduleFrequency("monthly"), true);
check("frequency guard rejects weekly", mod.isScheduleFrequency("weekly"), false);

rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
if (fail > 0) process.exit(1);
