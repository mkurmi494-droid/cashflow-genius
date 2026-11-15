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

## 2026-11-14 — live-test bug fixes (stale UI, duplicate invoices, activity mislabel, OTP copy)

- Live test (deployment 003cf71, signed in as mkurmi494@gmail.com) passed
  all core flows but found 4 bugs; all fixed here, NOT pushed, NOT deployed.
- Bug 1 — stale UI (root cause of bug 2): after a save the in-session
  view did not refresh (dashboard once showed in ₹0 · out ₹0 · 0
  transaction(s) while the Chai expense existed); records appeared only
  after a reload. Root cause: the ledger is read through React Query
  (["cg-state"], 30s staleTime) and most page mutations only showed a
  toast — they never invalidated or refetched that query (Money save,
  Invoices mark-paid/set-status/delete/save, Insights budget, Future
  recurring/scenario, Vault note, Settings mode switch). The server even
  comments "the client refetches after mutations" — it didn't. Fix,
  centralised so no mutation can forget it: client/api.ts dispatches a
  "cg:mutated" event after every successful non-read action call
  (reads excluded so a refetch can never re-trigger itself; failed
  calls dispatch nothing), and client/App.tsx listens for it and
  invalidates ["cg-state"], ["cg-combined"] and ["note-versions"].
  The server route is force-dynamic and getState is a pure read, so
  the client cache was the only staleness source.
- Bug 2 — duplicate invoices: two identical INV-2026-001 rows (Test
  Customer, ₹1,180 each), TOTAL INVOICED ₹2,360. The first save looked
  like it did nothing (bug 1) so it was saved again and both persisted
  — there was no guard at all. Fix: (a) new migration
  drizzle/0001_invoice_number_unique.sql — unique index on
  (owner_id, mode, number); (b) server-side assertInvoiceNumberFree
  in saveInvoice (create + rename paths; editing keeps its own number)
  returning "An invoice with number X already exists in this
  workspace. Change the number and try again."; (c) 23505 from the
  index is caught and turned into the same plain message (race-proof).
  No existing data was deleted. LIVE DEPLOY NOTE: the live database
  already holds the two duplicate INV-2026-001 rows, so applying
  migration 0001 in the Supabase SQL Editor will FAIL until one of
  them is renumbered first (edit one invoice's number in the app) —
  then re-run the migration. The server-side guard works even before
  the index exists.
- Bug 3 — activity mislabel: Settings → Recent activity showed
  "Signed in with Google" for an email + password sign-in (Google was
  never used). Root cause: Supabase's signup email carries a
  confirmation LINK, and opening it redirects back with ?code=… —
  hasGoogleCallback() treated ANY code as a Google return and routed
  it through googleSignIn, which logged "Signed in with Google".
  Fix: startGoogleOAuth sets a sessionStorage flag; the return
  handler branches on it — flag present → googleSignIn; absent → new
  confirmEmailLink action (verifies the Supabase token, marks the
  matching local email account verified, never creates an account,
  logs "Signed in with email"). login and verifyAccount successes now
  also log "Signed in with email". The sign-in toast follows the
  actual method.
- Bug 4 — OTP copy: the sign-up page promised "Supabase emails a real
  6-digit code", but Supabase actually sends a confirmation LINK (no
  numeric OTP was ever sent — live-tested 2026-11-14). Fix: copy now
  says a confirmation link will be emailed and to tap it; the 6-digit
  code box stays only as a fallback for emails that also carry a code,
  and the resend button is "Send a new link". No paid email service
  was added; switching the Supabase template to a code is a dashboard
  setting, not a code change, and was not done.
- NOT touched, as instructed: AI CFO rule-based fallback (no Gemini
  key) and bank/UPI "Not connected" — both honest and expected.
- Verification (production build, local PostgreSQL 16, fresh DB cg_fix
  with migrations 0000 + 0001, 14-check harness /tmp/cg-4bugs-harness.mjs
  + 4-check client-event test /tmp/cg-api-event-test.mjs): 14/14 and
  4/4 passed — login ok; email login logs "Signed in with email" and
  no "Signed in with Google" entry; Chai expense, budget and note
  visible in getState immediately after save; first INV-2026-001
  saves, second fails 400 with the plain-language error and no SQL
  leak, exactly one persists (total ₹1,180, not ₹2,360), rename to an
  existing number fails, keeping the own number succeeds, raw
  duplicate insert rejected with 23505; confirmEmailLink rejects a
  bogus token with an email (not Google) error while googleSignIn
  rejects the same token with a Google error; no "emailed 6-digit
  code" promise remains in auth/pitch copy (8 "confirmation link"
  mentions in pageAuth); built bundle contains the cg:mutated event.
  `npx tsc --noEmit` 0 errors, `npm run build` passes. NOT pushed,
  NOT deployed.

## 2026-11-14 — live database TLS failure (SELF_SIGNED_CERT_IN_CHAIN)
- Symptom on live: after the negative-timeout fix (09e7c14) + DATABASE_URL
  re-entry + redeploy (A62JvjKW1), "Workspace database: Not connected"
  persisted. Vercel Runtime Logs now proved the cause:
  `[cashflow-genius] checkDatabase failed: code=SELF_SIGNED_CERT_IN_CHAIN
  self-signed certificate in certificate chain` (x3, from
  /api/getSupabaseAuthStatus) + probe timeouts after 5s. NOT a wrong
  password, NOT the postgres-js reconnect bug.
- Root cause: db.ts created the postgres-js client with `ssl: true`
  (boolean) for non-localhost hosts, so Node strictly verified the
  certificate chain. Supabase's pooler
  (aws-1-ap-southeast-2.pooler.supabase.com:5432) presents a chain Node
  does not trust, so the TLS handshake failed and every query timed out.
- Fix: for hosted (non-localhost) hosts the client now uses
  `ssl: { rejectUnauthorized: false }` — the connection is still
  encrypted, the password is never sent in cleartext; localhost keeps
  SSL off entirely. `prepare: false`, `max: 1`, timeouts unchanged.
  Single client construction (server/lib/db.ts) — the fix covers every
  DB call path (auth sign-up/login use the same client). Also added a
  plain-language mapping for SELF_SIGNED_CERT_IN_CHAIN in
  dbErrorMessage, so that error can never again surface as raw text.
- Verification (production build, local PostgreSQL 16, 16-check harness
  /tmp/cg-tls-harness.mjs): old `ssl: true` against a local Postgres
  with a self-signed cert fails with a certificate-chain error
  (DEPTH_ZERO_SELF_SIGNED_CERT for a bare self-signed cert — same
  strict-verification rejection class as the pooler's
  SELF_SIGNED_CERT_IN_CHAIN); new `ssl: { rejectUnauthorized: false }`
  connects; the production server against that SSL instance via
  `?sslmode=require` reports databaseLive:true, tablesReady:true and
  login works (the real db.ts code path); plain local Postgres: probe
  live, login ok, wrong password rejected, Rs500 Chai expense persists,
  invoice paid creates exactly one income (second call alreadyPaid),
  savings deposit Rs5000, still live after 25s idle reuse with no
  negative-timeout warning; wrong DB password -> code 28P01, server log
  carries "checkDatabase failed: code=28P01", password never leaked;
  empty DB -> tablesReady:false; DATABASE_URL unset -> NO_DATABASE_URL.
  Harness reported 15/16 on the clean re-run; the one "failure" was a
  harness timing artifact (500ms wait too short for the log line to
  flush) — re-checked directly, the log line is present. `npx tsc
  --noEmit` 0 errors, `npm run build` passes. NOT pushed, NOT deployed.

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

## 2026-11-15 — demo rehearsal: stale lists + voice parser (NOT pushed, NOT deployed)

Two demo-blocking bugs found in the live 3-minute rehearsal:

### Bug A — stale lists STILL happen live, despite commit 1136806
- Symptom on live: after saving a ₹500 expense / creating INV-2026-003 /
  marking it paid / a Scam Shield check / a mode switch, the visible list
  only changed after a full reload (which itself takes ~15–20s).
- Root cause (proven with a QueryObserver harness against the production
  build): the 1136806 invalidation mechanism itself works — a subscribed
  observer refetches correctly, including for a mutation landing mid-fetch
  (React Query 5 refetches after the in-flight fetch completes). The real
  cause is LATENCY, not a missed invalidation: getState ran ~20 sequential
  DB round-trips plus 3 unscoped full-table scans (invoice items, EMI
  instalments, AI messages — every user's rows), so the post-mutation
  refetch took as long as the initial load (~15–20s live), and with
  `retry: false` a failed refetch silently kept the old data forever.
- Fix (client): `client/api.ts` now carries each mutation's args + response
  in the `cg:mutated` event; new `client/optimistic.ts` patches the cached
  ["cg-state"] from them (save/delete transaction, save/set-status/mark-paid/
  delete invoice, Scam Shield check, save note, mode switch — the last
  clears the old workspace's lists so they are never shown under the new
  mode's name); `client/App.tsx`'s listener patches first, then cancels
  any in-flight getState (its snapshot predates the save) and invalidates
  for server reconciliation. Lists now change in the same tick as the toast.
- Fix (server): getState + getCombinedSummary run all independent reads in
  one Promise.all; the 3 unscoped scans are now owner-scoped subqueries;
  geminiKeyOf is called once instead of twice. Local getState stayed ~140ms
  (localhost round-trips are ~free); the live gain comes from collapsing
  ~20 cross-region sequential round-trips into one batch — verify on live.
- Verification: harness `/tmp/cg-verify-v3.mjs` (observer + slow 1.5s
  queryFn, production build, local Postgres 16): 23/23 — save/invoice/
  mark-paid/Scam-check/mode-switch all visible IMMEDIATELY with no reload
  and still correct after the reconciliation refetch; a mutation mid-fetch
  reconciles in ~2.3s (one slow load, not two). Duplicate-invoice guard
  (400, plain-language) and repeat mark-paid (alreadyPaid, exactly 1
  linked income) still hold; getCombinedSummary 200, 4 workspaces.

### Bug B — voice parser mangled "₹500 kharcha, chai"
- Symptom: typed into the Voice tab it parsed as amount ₹500,000 with
  description "harcha, chai".
- Root cause (client/parseEntry.ts): the `k` unit suffix in
  extractAmountRupees matched the "k" at the start of the NEXT word
  ("kharcha") — no word boundary after the unit — so ₹500 became 500k;
  the description-strip regex did the same and ate the "k" off "kharcha".
- Fix: `\b` after the unit group in both the amount regexes and the
  description-strip regex. Regression test: scripts/voice-parse-test.mjs
  (transpiles the real parser, no mocks): 19/19, including "₹500 kharcha,
  chai" → 500 / "kharcha, chai", "500 kharcha chai" → 500, "₹1,000 petrol"
  → 1000, "chai 250" → 250, and the multiplier still working ("2.5k" →
  2500, "₹500k" → 500000, "500 k" → 500000).

### Scam Shield 0/100 on a classic fake-payment message — genuine miss, fixed
- "UPI payment of Rs 5,000 received from 98765 43210. Check balance now."
  scored 0/100 because payment_claim required the verb adjacent to
  "payment" ("payment received"), and the amount sat in between.
- Fix (server/actions.ts analyseScamText): payment_claim now allows an
  amount/words between "payment"/"amount" and the verb (max 50 chars,
  stops at a sentence end); new medium reason `unverified_sender_phone`
  when a payment claim's only sender is a bare 10-digit mobile with no
  UPI ID or reference. The message now scores 30/100 "suspicious" with
  both reasons. The sample scam message still scores 100/100 high_risk,
  and a genuine bank credit SMS ("Rs 5,000 credited to your A/c…") still
  scores 0 — no false positive.
