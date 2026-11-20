// Receipt normalisation tests for server/lib/receipts.ts (pure functions).
// Proves the draft a scanned bill becomes — no live AI call:
//   (1) a clean grocery receipt normalises to paise items with no
//       total mismatch; (2) a total that disagrees with the items is
//       flagged, never silently fixed; (3) bad items (empty name, zero /
//       negative / NaN amounts) are dropped; (4) garbage or missing model
//       output becomes zero items, never invented ones; (5) an impossible
//       date becomes null; (6) an unknown category is kept as a custom
//       category, trimmed to the 60-char transaction limit.
// Run: node scripts/receipts-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-receipts-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};

try {
  const src = readFileSync(join(repo, "server", "lib", "receipts.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "receipts.ts",
  }).outputText;
  const modPath = join(out, "receipts.js");
  writeFileSync(modPath, js);
  const { normalizeReceipt, emptyReceipt } = require(modPath);

  // ---- 1: clean grocery receipt (the screenshot case) ----
  const grocery = normalizeReceipt({
    readable: true,
    merchantName: "CORNER GROCER",
    receiptDate: "2026-11-20",
    currencyCode: "USD",
    totalAmount: 18.6,
    items: [
      { name: "Tissues 3ply", amount: 13.6, category: "Shopping" },
      { name: "Milk 2L", amount: 5.0, category: "Food & groceries" },
    ],
    notes: "",
  });
  check("grocery: readable", grocery.readable, true);
  check("grocery: merchant", grocery.merchantName, "CORNER GROCER");
  check("grocery: date", grocery.receiptDate, "2026-11-20");
  check("grocery: currency", grocery.currencyCode, "USD");
  check("grocery: items in paise", grocery.items, [
    { name: "Tissues 3ply", amountCents: 1360, category: "Shopping" },
    { name: "Milk 2L", amountCents: 500, category: "Food & groceries" },
  ]);
  check("grocery: items total", grocery.itemsTotalCents, 1860);
  check("grocery: receipt total", grocery.receiptTotalCents, 1860);
  check("grocery: no mismatch", grocery.totalMismatch, false);

  // ---- 2: total disagrees with the items — flag, never fix ----
  const mismatch = normalizeReceipt({
    readable: true,
    merchantName: "Cafe",
    receiptDate: "2026-11-19",
    currencyCode: "INR",
    totalAmount: 500,
    items: [{ name: "Coffee", amount: 120, category: "Food & groceries" }],
    notes: "",
  });
  check("mismatch: flagged", mismatch.totalMismatch, true);
  check("mismatch: item kept as read", mismatch.items, [
    { name: "Coffee", amountCents: 12000, category: "Food & groceries" },
  ]);
  check("mismatch: receipt total kept", mismatch.receiptTotalCents, 50000);

  // ---- 3: bad items dropped ----
  const bad = normalizeReceipt({
    readable: true,
    merchantName: null,
    receiptDate: null,
    currencyCode: "INR",
    totalAmount: null,
    items: [
      { name: "  ", amount: 10, category: "Shopping" },
      { name: "Zero", amount: 0, category: "Shopping" },
      { name: "Negative", amount: -5, category: "Shopping" },
      { name: "NaN", amount: Number.NaN, category: "Shopping" },
      { name: "Good", amount: 25.5, category: "" },
    ],
    notes: "",
  });
  check("bad items: only the good one survives", bad.items, [
    { name: "Good", amountCents: 2550, category: "General" },
  ]);

  // ---- 4: garbage / missing output invents nothing ----
  check("null input: zero items", normalizeReceipt(null).items, []);
  check("null input: unreadable", normalizeReceipt(null).readable, false);
  check("empty object: zero items", normalizeReceipt({}).items, []);
  check("emptyReceipt: zero items", emptyReceipt().items, []);
  check("emptyReceipt: readable false", emptyReceipt().readable, false);

  // ---- 5: impossible date -> null; bad currency -> INR ----
  const dates = normalizeReceipt({
    readable: true,
    merchantName: null,
    receiptDate: "2026-02-30",
    currencyCode: "xx",
    totalAmount: null,
    items: [{ name: "X", amount: 1, category: "General" }],
    notes: "",
  });
  check("impossible date: null", dates.receiptDate, null);
  check("bad currency: INR", dates.currencyCode, "INR");

  // ---- 6: unknown category kept as custom, trimmed to 60 chars ----
  const custom = normalizeReceipt({
    readable: true,
    merchantName: null,
    receiptDate: null,
    currencyCode: "INR",
    totalAmount: null,
    items: [
      {
        name: "Petrol",
        amount: 100,
        category: "Fuel for the scooter that I use to go to college every single day",
      },
    ],
    notes: "",
  });
  check("custom category: kept, trimmed to 60", custom.items[0].category, "Fuel for the scooter that I use to go to college every single day".slice(0, 60));
  check("custom category: length 60", custom.items[0].category.length, 60);
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
process.exit(fail ? 1 : 0);
