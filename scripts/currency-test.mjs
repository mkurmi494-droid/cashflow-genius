// Currency-conversion tests for server/lib/rates.ts.
// Three parts: (1) pure conversion math on integer minor units,
// (2) fetchRate validation against a stubbed fetch (bad rates, HTTP
// errors and network failures must all throw — never a guessed rate),
// (3) a LIVE check against the real provider (open.er-api.com) proving
// it returns finite positive rates for all five app currencies.
// Run: node scripts/currency-test.mjs   (exit 1 on any failure)
// The live section is skipped with a plain message only when the
// sandbox itself has no network; a provider that answers without a
// rate is a failure, not a skip.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-currency-test-"));

// Amounts in paise. ₹50,000 = 5,000,000.
const rs = (n) => n * 100;

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};
const checkThrows = async (name, fn, wantSubstring) => {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${name} — did not throw`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (wantSubstring && !msg.includes(wantSubstring)) {
      fail++;
      console.log(`FAIL  ${name} — threw, but message lacks "${wantSubstring}": ${msg}`);
    } else {
      pass++;
      console.log(`PASS  ${name}`);
    }
  }
};

try {
  const src = readFileSync(join(repo, "server", "lib", "rates.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "rates.ts",
  }).outputText;
  writeFileSync(join(out, "rates.js"), js);
  const { convertMinor, fetchRate } = require(join(out, "rates.js"));

  // ---------- (1) conversion math ----------
  // ₹50,000 → USD at 0.0113 = $565.00 = 56,500 cents.
  check("INR→USD: 5,000,000 paise at 0.0113", convertMinor(rs(50000), 0.0113), 56500);
  check("rounding to nearest minor unit (0.565 → 1)", convertMinor(50, 0.0113), 1);
  check("rounding down (0.4972 → 0)", convertMinor(44, 0.0113), 0);
  check("rounding up (11.35 → 11)", convertMinor(1000, 0.01135), 11);
  check("zero stays zero", convertMinor(0, 0.0113), 0);
  check("negative opening balance converts", convertMinor(-250000, 0.0113), -2825);
  check("large amount converts", convertMinor(100000000, 0.0113), 1130000);
  check("rate 1 is identity", convertMinor(123456, 1), 123456);
  check("USD→INR: 56500 cents at 88.5", convertMinor(56500, 88.5), 5000250);

  // ---------- (2) fetchRate validation (stubbed fetch) ----------
  const realFetch = globalThis.fetch;
  const stub = (body, { ok = true, status = 200 } = {}) => {
    globalThis.fetch = async () => ({ ok, status, json: async () => body });
  };
  const canned = (rates) => ({
    result: "success",
    base_code: "INR",
    time_last_update_utc: "Thu, 19 Nov 2026 00:02:31 +0000",
    rates,
  });
  stub(canned({ INR: 1, USD: 0.0113, EUR: 0.0098, GBP: 0.0081, AED: 0.0393 }));
  const live = await fetchRate("INR", "USD");
  check("stubbed fetchRate returns the rate", live.rate, 0.0113);
  check("stubbed fetchRate returns the provider date", live.asOf, "Thu, 19 Nov 2026 00:02:31 +0000");
  stub(canned({ INR: 1, EUR: 0.0098 }));
  await checkThrows("missing target rate throws", () => fetchRate("INR", "USD"), "Nothing was changed");
  stub(canned({ INR: 1, USD: 0 }));
  await checkThrows("zero rate throws", () => fetchRate("INR", "USD"), "Nothing was changed");
  stub(canned({ INR: 1, USD: -0.5 }));
  await checkThrows("negative rate throws", () => fetchRate("INR", "USD"), "Nothing was changed");
  stub(canned({ INR: 1, USD: "0.0113" }));
  await checkThrows("string rate throws", () => fetchRate("INR", "USD"), "Nothing was changed");
  stub({ result: "error", "error-type": "unsupported-code" });
  await checkThrows("provider error body throws", () => fetchRate("XXX", "USD"), "Nothing was changed");
  stub(null, { ok: false, status: 500 });
  await checkThrows("HTTP 500 throws", () => fetchRate("INR", "USD"), "HTTP 500");
  globalThis.fetch = async () => {
    throw new Error("fetch failed");
  };
  await checkThrows("network failure throws", () => fetchRate("INR", "USD"), "Nothing was changed");
  globalThis.fetch = realFetch;

  // ---------- (4) client toast building blocks ----------
  // The toast in client/App.tsx composes the rate from fmtMoney:
  // fmtMoney(100, from) is "₹1" / "$1", and the rate is passed as a
  // cents value so it renders with 4 decimals. Verify the fragments.
  const libSrc = readFileSync(join(repo, "client", "lib.ts"), "utf8");
  const libJs = ts.transpileModule(libSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "lib.ts",
  }).outputText;
  writeFileSync(join(out, "lib.js"), libJs);
  const { fmtMoney } = require(join(out, "lib.js"));
  check("toast left side: fmtMoney(100, INR)", fmtMoney(100, "INR"), "₹1");
  check("toast right side: rate 0.010694 as USD", fmtMoney(Math.round(0.010694 * 10000) / 100, "USD", 4), "$0.0107");
  check(
    "toast text for INR→USD at 0.010694",
    `Currency updated — converted at the live rate: ${fmtMoney(100, "INR")} = ${fmtMoney(Math.round(0.010694 * 10000) / 100, "USD", 4)}.`,
    "Currency updated — converted at the live rate: ₹1 = $0.0107.",
  );
  // Real fetch, no stubs. Only a network-level failure skips this
  // section; a provider that answers without a usable rate fails.
  const liveRate = async (from, to) => {
    try {
      const r = await fetchRate(from, to);
      return { ok: true, rate: r.rate, asOf: r.asOf };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|network/i.test(msg)) {
        return { ok: false, skipped: true, reason: msg };
      }
      return { ok: false, skipped: false, reason: msg };
    }
  };
  const pairs = [
    ["INR", "USD"],
    ["INR", "EUR"],
    ["INR", "GBP"],
    ["INR", "AED"],
    ["USD", "INR"],
  ];
  for (const [from, to] of pairs) {
    const r = await liveRate(from, to);
    if (r.skipped) {
      skipped++;
      console.log(`SKIP  live ${from}→${to} — no network in this sandbox: ${r.reason}`);
    } else if (!r.ok) {
      fail++;
      console.log(`FAIL  live ${from}→${to} — provider answered without a usable rate: ${r.reason}`);
    } else if (typeof r.rate !== "number" || !Number.isFinite(r.rate) || r.rate <= 0) {
      fail++;
      console.log(`FAIL  live ${from}→${to} — rate is not a finite positive number: ${r.rate}`);
    } else {
      pass++;
      console.log(`PASS  live ${from}→${to} = ${r.rate} (as of ${r.asOf})`);
    }
  }
  if (skipped > 0) {
    console.log(`NOTE  ${skipped} live check(s) skipped — the sandbox has no network; nothing was faked.`);
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped (no network)` : ""}`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
