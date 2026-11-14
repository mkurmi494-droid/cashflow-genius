# Testing log — Cashflow Genius Vercel port

## Automated suite (local, 2026-11-14)

Ran against a local PostgreSQL 16 (installed in the sandbox for this
test only) with the generated migration applied and a seeded test user
(`test@cashflow-genius.local`, session token). Script: `/tmp/cg-test.mjs`
(53 checks, all through the real HTTP API routes of the production
build — `next start`).

**Result: 53 passed, 0 failed.**

Covered:
- Auth: `authStatus`, `getState` (empty workspace), `logout` (+ signed-out after)
- Business setup: `updateBusiness`
- Transactions: income/expense/duplicate, `getState` counts
- Budgets + `runScan` (duplicate Figma + budget overrun found)
- Invoices: `saveInvoice`, `markInvoicePaid` (exactly 1 linked income
  txn; second call `alreadyPaid`, no duplicate)
- Savings: goal create, deposit ₹5,000, withdraw ₹1,000 → saved ₹4,000
- EMI: plan with 3 instalments, collect #1 (exactly 1 linked income
  txn; second collect `alreadyCollected`)
- Recurring, scenarios, notes (+ edit → version history)
- Scam Shield: OTP/threat/short-link message → `high_risk`, OTP reason present
- AI CFO `askCfo` + `getBriefing` with no Gemini key: honest rule-based
  fallback, says Gemini is not connected, deterministic `sources` present
- `getCombinedSummary` (4 workspaces + combined)
- CSV import: exact duplicate skipped (1 imported / 1 duplicate); `undoLastImport`
- `exportBackup` + `restoreBackup` (careful merge: existing records skipped)
- Delete transaction + `restoreDeletedItem` (Undo restores it)
- All 4 money modes: personal starts empty, personal txn invisible from
  business, student + creator empty
- `setCursorStyle`, `dismissTour`, custom category remembered
- `getIntegrationStatus`: database live, Gemini + AI honestly not_connected
  without a key; `getSupabaseAuthStatus`: reachable, Google + email enabled
  (verified live against the real Supabase project)

Two fixes found by testing and fixed in the port:
1. `server/lib/db.ts` forced `ssl: "require"` — broke plain local
   Postgres. SSL is now required only for Supabase pooler URLs
   (`?sslmode=require`) or non-localhost hosts.
2. Next.js cannot bundle `.mp4`/`.webm` imports — intro videos moved
   to `public/assets/` and referenced as URL strings in `pageAuth.tsx`.

## Static checks (local production build)
- `npm run build`: passes. `npx tsc --noEmit`: 0 errors.
- HTTP 200: `/`, `/manifest.webmanifest`, `/sw.js`,
  `/assets/cashflow-intro.mp4`, `/assets/cashflow-intro-portrait.mp4`,
  icons, all JS chunks.
- Supabase Auth probe from the server: `GET /auth/v1/settings` →
  `google: true, email: true` (one transient probe failure was cached
  for 60s on a cold start, then recovered — same behaviour as the
  original app).

## NOT tested (needs the live deployment + a human)
- Google sign-in round-trip with a real Google account
- OTP email actually landing in a real inbox
- PWA install on a real phone
- React app mounting in a real browser (homepage HTML is the SSR shell;
  all JS chunks serve 200, but no browser drove the UI here)
- Gemini AI answers with a real key (no key exists yet)

## 2026-11-14 — live-check negative-timeout fix (postgres 3.4.5 -> 3.4.9)
- Symptom on live: after DATABASE_URL was re-entered + redeployed,
  "Workspace database: Not connected"; Vercel Runtime Logs showed only
  `TimeoutNegativeWarning — "Timeout duration was set to
  -26824.814303408733"` on POST /api/getSupabaseAuthStatus, no Postgres
  error, all calls HTTP 200.
- Root cause (proven in the driver source): postgres-js 3.4.5
  `connection.js` reconnect() did
  `setTimeout(connect, closedDate + delay - performance.now())` with no
  clamp. A connection that died while idle (idle_timeout 20s / pooler
  kill) and was only reused ~27s later scheduled a NEGATIVE timeout.
  postgres-js 3.4.9 clamps it: `Math.max(0, closedTime + delay -
  performance.now())`. No setTimeout in our own code ever takes a
  computed/negative value (all literals) — the warning came from the
  driver, not the app. Upgraded `postgres` 3.4.5 -> 3.4.9 (package.json
  + lockfile); db.ts carries a "do not downgrade below 3.4.9" comment.
- Hardening in the same fix: checkDatabase() now console.errors the
  real failure server-side (code + sanitised message, never SQL /
  connection string / password) instead of swallowing it;
  getSupabaseAuthStatus logs a 5s race timeout AND the probe's eventual
  outcome, so a slow failure never vanishes behind a bare TIMEOUT.
  The UI strip now shows a specific note for 42P01 / NO_DATABASE_URL /
  TIMEOUT as well as 28P01. Direct host
  db.<ref>.supabase.co:5432 works with the same config (SSL on for any
  non-localhost host, prepare:false, max:1) — confirmed in db.ts.
- Verification (production build, local PostgreSQL 16, migration
  applied, 16/16 harness checks passed): correct DATABASE_URL ->
  databaseLive:true, tablesReady:true; idle 25s then reuse (stale
  reconnect path) -> still Live with NO negative-timeout warning in
  server stderr; wrong DB password -> databaseLive:false,
  databaseErrorCode 28P01, server log carries
  "checkDatabase failed: code=28P01" and never leaks the password;
  empty DB -> tablesReady:false; DATABASE_URL unset ->
  code NO_DATABASE_URL. `npx tsc --noEmit` 0 errors, `npm run build`
  passes. NOT pushed, NOT deployed.
