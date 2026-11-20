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

## 2026-11-15 — mode-switch speedup + pool-exhaustion fix (NOT pushed, NOT deployed)

### Why the max:1 revert did NOT fix the pool exhaustion
- Commit bcd6255 raised the pool max 1→5 to parallelise getState's ~19-query batch. Live it backfired: Supabase session pooler (5432, Supavisor) hit EMAXCONNSESSION "max clients reached in session mode" and a Business→Personal switch failed with "Your workspace could not be loaded" for ~6 minutes. The parent reverted max to 1 in b8b0b9e.
- The revert deployment (Ready 06:23:31 PST 15 Nov 2026) got 12 NEW EMAXCONNSESSION errors 06:24–06:27 PST on /api/getState, /api/getCombinedSummary, /api/getBriefing: "max clients reached in session mode - max clients are limited to pool_size: 15", code XX000 FATAL. A Personal→Business switch failed outright ("Your workspace could not be loaded", recovered after retry + 30s wait) and the app flipped to that error spontaneously a minute after a successful switch.
- Root cause: max:1 is per serverless instance, and the client fires getState + getCombinedSummary + getBriefing in parallel — each a separate Vercel invocation holding its own connection — against a 15-client pool, with connections lingering (idle_timeout 20s, max_lifetime 30min). Raising OR lowering the per-instance max cannot fix a per-invocation count problem; the fix has to cut connections AND round-trips.

### What changed (this commit)
1. **Fewer round-trips (server/lib/batch.ts, new)** — one-statement JSON batch loads (json_agg + row_to_json, camelCase aliases, timestamps rendered `at time zone 'UTC'` and revived to Date so the existing mappers work unchanged):
   - getState: 25 statements → 3 (auth join + prelude [state row + all businesses] + batch of 16 collections). getState JSON output verified byte-identical to the old path (diff of full snapshots: identical).
   - getCombinedSummary: 12 → 2 (auth join + batch incl. state row). Output byte-identical.
   - getBriefing: 7 → 3 (auth join + prelude + briefing batch of txns/invoices/transfers; Gemini key now comes from the prelude row instead of a 4th read).
   - The pool stays at max:1. No data deleted; first-visit path (brand-new account, no state row / no workspace) still creates via ensureWorkspace, verified 4/4.
2. **Retry on pool exhaustion (app/api/[action]/route.ts + server/lib/db.ts)** — `isPoolExhaustedError` detects Supavisor XX000 "max clients reached" and Postgres 53300 "too many connections" (incl. Drizzle-wrapped causes); read-only actions (getState, getCombinedSummary, getBriefing, authStatus, getSupabaseAuthStatus, getIntegrationStatus, exportBackup, listNoteVersions) retry whole with backoff 1s/3s/6s (~10s worst case, behind the loading skeleton instead of the full-screen error). Mutations are NEVER retried. `dbErrorMessage` maps pool exhaustion to plain language ("The database is busy just now — too many connections at once. Nothing was lost; please wait a moment and try again.").
3. **Client serialises the ledger reads (client/api.ts)** — getState/getCombinedSummary/getBriefing queue behind each other per tab (promise chain), so peak connections per tab drop 3→1; mutations and auth are NOT queued. Verified: max 1 in flight, 3×300ms stubbed reads take ~900ms serialised; a mutation starts immediately alongside (max in flight 2).
4. **Faster idle drain (server/lib/db.ts)** — idle_timeout 20s→5s, max_lifetime 30min→10min, so a burst's connections release their pool slots within seconds. Price: an occasional TLS reconnect on the next query after idle (one handshake per invocation, not per statement).
5. **Blanket invalidation narrowed (client/pageDashboard.tsx)** — the mode-switch panel's `invalidateQueries()` (everything, incl. briefing + auth) is now just ["cg-state"] + ["cg-combined"]; the App-level cg:mutated listener already covers those, briefing refetches on transaction-count change, auth needs no refetch on a switch.
6. **Query-count instrumentation (server/lib/db.ts)** — env-gated `CG_QUERY_LOG` debug hook (postgres-js `debug`, off by default, never set in production) appends one line per statement so harnesses can assert per-call counts. Local timing proves nothing about live latency; the statement count is what the live 15–30s refetch is made of.

### Transaction pooler (port 6543) — recommended Vercel env change (NOT applied here)
- Verified in code: nothing uses session-level features — no `db.transaction`, no LISTEN/NOTIFY, no advisory locks, no temp tables, no SET statements, no `SET LOCAL`; `prepare: false` is already set (required for 6543); all queries are single statements with no cross-statement session state. The batch loads work identically on either pooler.
- Trade-offs: transaction mode lets Supavisor serve far more concurrent clients (each query gets a backend connection from the pool instead of holding one per session), which removes the 15-client ceiling that caused both outages — it is designed for serverless. Cost: no session state at all (none used); prepared statements unsupported (already disabled); a future feature needing a multi-statement transaction or LISTEN would need rethinking. A wrong password / wrong host fails identically on both ports.
- Exact change for the parent to apply in Vercel → cashflow-genius → Settings → Environment Variables → DATABASE_URL (Production + Preview only; the separate Development entry stays as-is): keep the current URL and change ONLY the port `5432` → `6543`, i.e. `postgresql://postgres.zfngqppwmyizlnrzhrjc:[PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres` (same password, percent-encode `@` as `%40` as before), then redeploy. No code change needed for the switch. The code fixes above (retry, serialisation, batching, idle drain) stay valuable on 6543 too and must ship either way.
- Verify live after the switch: Live connections shows workspace database Live; a mode switch completes without "could not be loaded"; Vercel Runtime Logs show no EMAXCONNSESSION/XX000 for 10 minutes after; measure the switch wall time (target: skeleton visible only briefly — the 3-statement getState + 2-statement combined + 3-statement briefing should land in ~2–5s even at ~600ms RTT, vs 15–30s before).

### Verification (local PostgreSQL 16, DB cg_fix3, production build, this commit)
- Statement counts (CG_QUERY_LOG): getState 25→3 warm (4 on a cold connection incl. the driver's one-time pg_type introspection), getCombinedSummary 12→2, getBriefing 7→3; getState + getCombinedSummary JSON byte-identical to the pre-change snapshots.
- /tmp/cg-verify-v3.mjs: 23/23 (optimistic instant updates, invoice mark-paid exactly one linked income, duplicate-invoice guard 400, Scam Shield scores, mode-switch immediate + reconciled). scripts/voice-parse-test.mjs: 19/19. /tmp/cg-modeswitch-harness.mjs: 22/22 (view NEVER empty during a slow 3s refetch; gate intact).
- /tmp/cg-pool-harness.mjs (new): 15/15 — statement-count assertions, client queue serialisation, isPoolExhaustedError unit cases (raw XX000, Drizzle-wrapped XX000, 53300 → true; 28P01, 42P01, generic → false), plain-language pool message with no SQL.
- End-to-end retry (CONNECTION LIMIT simulation): 3 server processes (one per Vercel invocation) against a non-superuser role capped at 2 connections — one getState hit 53300, retried 1s/3s/6s and returned 200 in ~10.2s once the other servers' idle connections drained at 5s; the other two returned in ~140ms. Server log shows all three "hit pool exhaustion, retry" lines. (Note: a DB-level CONNECTION LIMIT does not constrain the superuser `postgres` role, so the simulation used a throwaway role `cgtest`, removed afterwards.)
- First-visit path (throwaway user, no state row / no workspace): getState 200 with empty business workspace, setMode personal creates the second workspace, 4/4.
- `npx tsc --noEmit`: 0 errors. `npm run build`: passes. NOT pushed, NOT deployed.

## 2026-11-18 — Proactive Financial Insights Engine ("Genius Insights", NOT pushed, NOT deployed, migration NOT applied live)

Sarya's pick from ChatGPT's roadmap (Priority 1): the AI notices problems
WITHOUT being asked. All detection is deterministic SQL + TypeScript rules
— zero LLM calls, zero extra cost.

### What was built (local only)
- **Migration `drizzle/0004_financial_insights.sql`** (generated with
  `drizzle-kit generate`, then renamed): `financial_insights` (id text PK,
  owner_id/mode text, insight_type, severity info|warning|critical, title,
  description, evidence_json jsonb, recommended_action, confidence int
  0–100, status active|dismissed|expected|snoozed|resolved,
  insight_key, generated_at, expires_at) + `financial_insight_runs`
  (owner_id, mode PK, generated_at, insight_count — the last-run record
  so lazy regeneration works even when no rule fires). Partial unique
  index on (owner_id, mode, insight_key) WHERE status = 'active'.
  drizzle-kit quirk found and fixed: it parameterizes an `eq()` predicate
  in a partial index and emits a broken `WHERE ... = $1` — the schema
  uses a raw `sql` literal instead (see the NOTE comment in schema.ts),
  and a re-run of `drizzle-kit generate` now reports "No schema changes".
- **Engine `server/lib/insights.ts`** (pure, zero imports — transpiled by
  the harness like the voice parser): 8 rules, all month-to-date (this
  month so far vs the same days of earlier months, so the 3rd of the
  month cannot false-fire "income dropped" before the salary lands).
  spending_spike (>30% above 3-mo MTD avg, >₹1,000, ≥2 prior months),
  income_drop (>20% below, >₹1,000), unusual_transaction (>3x the
  category MEDIAN, >₹2,000, ≥5 peers), recurring_payment (same payee ±5%
  amount, 3+ consecutive months ending this month or last), invoice_risk
  (sent invoices only; overdue → critical), cash_shortage (30-day
  projection mirroring Future Lens assumptions; EMI instalments count as
  collections, not payments; floor ₹5,000), profit_leak (>20% vs last
  month, >₹1,000), savings_opportunity (>₹500 less than last month).
  Every insight carries the exact figures in evidence_json; descriptions
  say "estimate" where they project. An empty workspace yields zero
  insights (a ₹0 balance with no history must not raise a false alarm).
- **Actions (server/actions.ts)**: `getInsights` (lists active findings;
  regenerates when the last run is older than 6h; returns [] honestly if
  migration 0004 is not applied yet — 42P01 caught, logged server-side),
  `generateInsights` (unconditional run; 60s debounce guard), `dismissInsight`,
  `markInsightExpected`, `snoozeInsight` (7 days). All scoped by the
  session user + active workspace — the id alone is never trusted.
  Generation state machine: new → active; still firing → figures
  refreshed, status kept (expected stays expected, snoozed stays snoozed
  until its deadline passes); dismissed → never resurrected; condition
  cleared → resolved (and a resolved row reactivates if the condition
  genuinely returns).
- **Wiring**: `getInsights` joins the serialised ledger-read queue
  (client/api.ts) and the route's pool-retry set (its writes are
  idempotent upserts); `generateInsights` is excluded from cg:mutated
  (it never touches ledger data). App.tsx's cg:mutated listener now also
  invalidates ["cg-insights"] and, after transaction/invoice/recurring/
  EMI mutations, fires generateInsights in the background and refreshes
  the panel when it lands.
- **UI**: "✦ Genius Insights" section on the Command Center, directly
  below the hero (before the KPIs; nothing else moved). Each card shows
  severity badge, title, description, evidence line (e.g. "Food
  ₹12,400 vs usual ₹9,400 · +32%"), suggested action, confidence label,
  and Dismiss / Expected / Remind me later / Review (Money Flow).
  Empty state: "No insights need attention right now". Per-workspace:
  the query key carries the active mode.
- **Not built (deliberately)**: no cron/scheduler (Vercel Hobby cron out
  of scope); no AI CFO changes; no other module touched. Two engine
  bugs found by the harnesses and fixed: income_drop divided by this
  month's income (zero when unpaid → never fired) and generation
  reactivated "expected" rows.

### Verification (local PostgreSQL 16, production build, DB cg_insights)
- `scripts/insights-test.mjs` (pure rules, 59 checks): every rule fires
  and does not fire (spike ±32% / within 30% / 1 prior month / <₹1,000
  excess; income drop / zero-income critical; unusual 7.2x median /
  <₹2,000 floor / <5 peers; recurring 3 months / 2 months / stale run /
  gap month; invoice risk overdue days + sent-only totals; cash shortage
  fire / healthy / invoice-lands-first / EMI-as-inflow; leak + saving;
  empty workspace → 0; keys unique; confidence labels; INR formatting).
  **59/59.**
- `scripts/insights-e2e-test.mjs` (real HTTP API, 38 checks): first load
  lazily generates 6 findings with real evidence (spike pctAbove 32,
  invoice_risk critical); 60s debounce skips an immediate re-run with no
  duplicate keys; dismiss/snooze/expected remove findings and a second
  dismiss is rejected; a 7h-old run regenerates on load while dismissed/
  snoozed/expected survive; topping income back up resolves income_drop
  in the DB; an expired snooze reactivates; Personal starts empty, gets
  its own cash_shortage, and it never leaks into Business; unknown id
  rejected; the partial unique index rejects a second active row per key
  (23505). **38/38.**
- Migrations 0000–0004 apply cleanly in order on a fresh database
  (26 tables, partial unique index present). `npx tsc --noEmit`: 0
  errors. `npm run build`: passes. NOT pushed, NOT deployed, migration
  NOT applied to the live database — the parent pushes and applies after
  review. Live checklist for the parent: apply 0004 in the Supabase SQL
  Editor, deploy, open the dashboard on a workspace with history and
  confirm findings appear, dismiss one and reload to confirm it stays
  gone.

### Currency conversion on currency change (2026-11-19, NOT pushed, NOT deployed)
- Bug: changing the currency only swapped the display symbol (₹50,000 → $50,000); amounts are stored as integer minor units and were never converted.
- Fix (server-side only, so both the top-bar select and the Settings form are covered): `server/lib/rates.ts` (new) fetches the live rate from https://open.er-api.com/v6/latest/<FROM> (free, no key, 8s timeout, response validated — rates[to] must be a finite positive number or it throws; no hardcoded rates, no cache, no fallback). `updateBusiness` fetches the live rate FIRST, then in ONE `db.transaction` converts every money column of that workspace only (owner_id + mode): businesses.openingBalanceCents, transactions.amountCents, invoice_items.unitPriceCents (via the invoices of that workspace; invoice totals are computed from items, so no totals column exists to convert), recurring_cashflows.amountCents, budgets.monthlyLimitCents, emi_plans.totalCents + downPaymentCents, emi_instalments.amountCents (via the plans of that workspace), savings_goals.targetCents, savings_transfers.amountCents. All five currencies have 100 minor units: newMinor = round(oldMinor × rate). Percentages (discountBp/taxBp/gstRateBp/eligibleExpensePct), scenario params, notes, AI text and activity text are never converted. If the rate fetch or any conversion step fails, the handler throws before any write — the currency label never changes without the amounts. After a conversion the financial_insight_runs row for that workspace is deleted (insights rows kept) so Genius Insights regenerate in the new currency. The response carries an optional `conversion` { from, to, rate, asOf, convertedCounts }; the conversion is logged ("Currency converted", "INR → USD at 0.0113"). No schema migration. Client touch (one place): `currencyMut.onSuccess` in client/App.tsx shows e.g. "Currency updated — converted at the live rate: ₹1 = $0.0107." when a conversion object is present, else the old "Currency updated."
- `scripts/currency-test.mjs` (26 checks): conversion math incl. ₹50,000 → $565 at a stubbed 0.0113 rate, rounding to nearest minor unit, zero stays zero, negative opening balance converts, rate-1 identity; fetchRate validation against a stubbed fetch (missing/zero/negative/string rate, provider error body, HTTP 500, network failure — all throw with "Nothing was changed"); LIVE provider checks for INR→USD/EUR/GBP/AED and USD→INR (0.010694 / 0.009756 / 0.008131 / 0.03927 / 93.513568, as of Thu, 19 Nov 2026 00:02:31 +0000); toast fragments via the real fmtMoney. **26/26.**
- `scripts/currency-e2e-test.mjs` (real HTTP API, production build on port 3100, local PostgreSQL 16 DB cg_insights, fresh user each run; run with CG_E2E_PG_PASSWORD + BASE_URL — both in gitignored .env.e2e.local): seeds Business INR with an opening balance, 2 transactions, 1 invoice item, 1 recurring schedule, 1 budget, 1 EMI plan (4 instalments), 1 savings goal + 1 transfer, plus a Personal workspace; converts INR → USD at the live rate and asserts every amount equals round(old × rate) ±1 and the label is USD (e.g. ₹50,000 income → $534.70); counts match; insight run row deleted, insight row kept; Personal untouched; same-currency save is a no-op with no conversion object; updateBusiness with currency "XXX" is rejected (400, error mentions the exchange rate) and leaves label + amounts untouched; a negative USD opening converts on a second USD → EUR conversion. **50/50.**
- Regression: `scripts/insights-test.mjs` still **77/77**. `npx tsc --noEmit`: 0 errors. `npm run build`: passes. NOT pushed, NOT deployed — the parent pushes after review. Live checklist for the parent: deploy, change the currency on the top-bar select, confirm the toast shows the live rate and the dashboard amounts convert (₹50,000 income must read ≈ $534, not $50,000).

### Currency safeguards — "never again" (2026-11-19, NOT pushed, NOT deployed)
- Incident: 19:07–19:09 IST the Business workspace currency was changed 12 times in ~2 min; two overlapping updateBusiness requests both read the stale currency INR and both converted INR → EUR, shrinking every amount ~100x (₹27,50,000 → ₹26,837). Data was restored exactly from the 17:20 IST CSV export (12 SQL UPDATEs, verified in-app: dashboard ₹27,57,310, re-exported CSV byte-identical). Root causes: (a) updateBusiness read the business row before the conversion transaction, so concurrent requests shared a stale base; (b) no in-flight guard or pending state — a tap looked dead, so the user tapped again; (c) the top-bar currency selector is hidden on phones (`hidden sm:block`), so there was no currency control on mobile at all.
- Fix, server (`server/actions.ts`): inside the conversion transaction the workspace row is re-read FOR UPDATE (Drizzle `.for("update")`) and that locked row's currency is the authority. If it already equals the target, the conversion is skipped entirely (label-only save; the opening balance keeps the STORED value, because the form value is still in the old currency). If it differs from both the target and the currency the rate was fetched for, the handler throws and the transaction aborts — no stale-rate conversion, no relabelling without converting. Single-transaction conversion, rate-fetch-first rule, log format and response shape unchanged.
- Fix, client: `client/lib.ts` gains `workspaceHasMoney(state)` and `currencyConfirmOptions(from, to, modeLabel)`; `client/App.tsx` gains one `requestCurrencyChange(next)` used by every control — returns immediately while a conversion is pending or the currency is unchanged, asks for confirmation (existing confirm dialog, naming the direction and stating all amounts convert at the live rate) when the workspace has money, empty workspaces convert without asking. Top-bar select is disabled while `currencyMut.isPending` with a "Converting…" indicator; the More sheet (mobile only) gains a Currency box with the same handler/state and caption "Changes all amounts in <workspace>". `client/pageVault.tsx` (Settings) routes its submit through the same confirm-if-money rule, disables its currency select while its own save or the top-bar conversion is pending, shows "Converting amounts to …" under the field, and its Save button reads "Converting…" while busy. `client/types.ts` adds optional `currencyBusy?: boolean` on PageProps. The slowness itself (live rate fetch + cold start, a few seconds) is unchanged in duration — it is now visible instead of looking dead.
- `scripts/currency-e2e-test.mjs` gains a concurrent case: two updateBusiness calls fired at once from the same EUR base; asserts exactly one conversion reported, one live rate, label USD, both transactions and the opening balance converted exactly once, and exactly one "Currency converted" log entry. **57/57** (50 original + 7 new).
- Regression: `scripts/currency-test.mjs` still **26/26**, `scripts/insights-test.mjs` still **77/77**. `npx tsc --noEmit`: 0 errors. `npm run build`: passes. NOT pushed, NOT deployed — the parent pushes after review. Live checklist for the parent: deploy, on the EMPTY Student workspace change currency via the top-bar select (confirm dialog appears only if the workspace has money — Student is empty so it converts without asking), confirm the "Converting…" state shows and the selector is disabled meanwhile, then change it back; on a phone-width viewport open the More sheet and confirm the Currency box is there and works.

### Excel export (.xlsx) — formatted, with red/green rows (2026-11-19, NOT pushed, NOT deployed)
- Why: the CSV export opened in Excel showed #### in the date column (column A too narrow — the dates were in the file, nothing missing) and a CSV cannot carry colours at all. Fix: a new "Export Excel" button next to "Export CSV" in Money Flow.
- Build: `client/xlsxExport.ts` (new) — `txnsToXlsx(txns)` returns a Blob. SheetJS (`xlsx` 0.18.5, community) builds the workbook — real date cells, number formats, column widths — but CE cannot write cell styles (fills are a Pro feature; verified empirically: `s: {fill}` silently dropped), so `fflate` (0.8.3) post-processes: unzip, replace `xl/styles.xml` with green/red fills + bold header font, rewrite every cell's style index, zip back. Both libs load via dynamic import inside the export function only (~403 KB lazy chunk; First Load JS unchanged).
- Format: same 8 columns as the CSV; date as a real Excel date cell — serial computed in UTC so it is an exact integer in every timezone (a JS Date via local midnight leaves a ~10s residue in Asia/Calcutta from the 1899 basedate's historical offset, which made the harness fail 4/115 before the fix); column widths date 13, type 10, status 10, category 18, description 32, counterparty 18, amount 14, payment_method 14; bold header; income rows light-green fill C6EFCE, expense rows light-red fill FFC7CE; amount as a real number with 0.00 format.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/xlsx-export-test.mjs` **115/115** (unzip + XML asserts: real date serials, yyyy-mm-dd format, green/red fills per row type, bold headers, date width set; openpyxl cross-check confirms the same; LibreOffice Calc opens a generated file cleanly). The old CSV export is untouched. Note: the subagent's first report said 115/0, but Muse's own re-run initially showed 111/4 (the ~10s date-serial residue in IST); fixed by computing serials in UTC, re-verified 115/0.
- NOT pushed, NOT deployed — the parent pushes after review. Live checklist for the parent: deploy, Money Flow → Export Excel, open the downloaded file in Excel and confirm dates show (no ####), income rows green, expense rows red.

### Scam Shield false positive — non-payment images no longer score high risk (2026-11-19, NOT pushed, NOT deployed)
- Report: Sarya uploaded a photo of a car; Scam Shield said high risk though nothing scammy was in it. Root cause: the handler unconditionally added `screenshot_not_proof` (high, +30) for ANY uploaded image, plus `image_not_payment` (high, +30) when the vision model correctly said it was not a payment screenshot — 60/100 ≥ 45 → high_risk for any readable non-payment image. The ChatGPT vision (gpt-4o-mini via aiComplete) was already wired and judging correctly; only the scoring was wrong.
- Fix: new pure module `server/lib/scamShield.ts` (`scoreReasons`, `imageReasons`, `SCAM_WEIGHTS`; weights/thresholds unchanged: critical 45, high 30, medium 15, info 5; ≥45 high_risk, ≥15 suspicious). Readable non-payment image → exactly one reason, `image_not_payment` info (+5) → score 5, no_strong_signs, with the AI's one-phrase description of what the image shows (vision prompt extended; `imageDescription` added to the findings shape, `z.string().default("")` so a missing description degrades to an empty string, never a failed parse). Name/amount checks are skipped entirely for non-payment images. Unreadable image or failed vision call → only `image_unreadable` medium (+15) → 15, suspicious, never high_risk alone. Payment-looking screenshots keep the strict treatment: `screenshot_not_proof` (high) plus editing-signs / name / UPI / amount mismatch checks as before. Safety rules kept: the check never confirms a payment; the bank/UPI-app disclaimer is unchanged. `client/pageShield.tsx` also renders a "What the image shows" row and its Hinglish UI strings are now English.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/scam-shield-test.mjs` **31/31** (fixture vision results, no live AI calls: car photo incl. with claimed sender/amount, clean/edited/name-mismatch/unknown-name/amount-mismatch/unknown-UPI screenshots, unreadable, null findings). Currency 26/26, insights 77/77, xlsx-export 115/115 all still pass. Live AI behaviour (gpt-4o-mini emitting `imageDescription`) is NOT verified locally — the parent live-verifies by uploading a real non-payment photo after deploy.
- NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, Scam Shield → upload a non-payment photo (e.g. a car) → expect "This image is not a payment screenshot" with score 5, no_strong_signs; upload a real payment screenshot → expect the strict treatment unchanged.

### App text in English (2026-11-19, NOT pushed, NOT deployed)
- Sarya chose "App text in English": no Hindi/Hinglish in user-facing app text. Converted 31 strings across 6 files (strings only, no logic/layout): `client/App.tsx` (13: Quick Add voice + SMS import hints, errors, placeholders), `client/appTour.tsx` (2), `client/pageCalendar.tsx` (1), `client/pageCfo.tsx` (4: the two Hinglish CFO suggestions are now English — "Why is my profit falling?", "Where is my money leaking?" — still exactly 3 suggestions total; sources explainer in English), `client/parseEntry.ts` (9: draft notes shown to the user), `client/pitch.tsx` (3: in-app "Why Cashflow Genius?" section). `client/pageShield.tsx` strings were converted in the Scam Shield fix above.
- Deliberately kept: `detectQuestionLang` + the "hinglish" language type (detection logic, not displayed text — the CFO still answers in the language the user asks in); parseEntry keyword arrays/regexes (input matching so voice/SMS parsing keeps understanding Hinglish phrases); the word "Kal" quoted inside one draft note because the note explains how that exact word was read; the "· Hinglish answer" sources label (an English label naming the answer's language).
- Verification (re-run personally by Muse): zero Devanagari characters anywhere in `client/` (Python scan); `npx tsc --noEmit` 0 errors; `npm run build` passes. NOT pushed, NOT deployed — pushed with the Scam Shield fix.

### Scam Shield live 500 — the vision call never matched the schema (2026-11-19, NOT pushed, NOT deployed)
- Live failure 23:41 IST 2026-11-19 (deploy 3d1a640 Ready 23:39:20 IST): uploading a car image to Scam Shield errored twice with "The server returned an unexpected result for analyseScamText" — no verdict at all. English text and the 3 CFO chips verified live in the same check.
- Root cause (Vercel Runtime Logs, 23:41:12 and 23:41:53 IST, HTTP 500 on POST /api/analyseScamText): gpt-4o-mini returned `{ "description": "a cartoon image of a red car on a road", "extraction": { "payment_amount": null, "transaction_id": null, "date": null, "sender": null, "receiver": null }, "signs_of_editing": "none" }` — its own invented shape, not the schema's flat keys. The prompt never named the JSON keys, so the model guessed. The parse ladder (tryJsonAnswer + normalizeAnswerShape) has no image-shape aliases, so it threw `parse`, aiComplete fell back to ruleBasedFallback — whose hardcoded image object had NO `imageDescription` — and the action's response validation failed with `ZodError: imageFindings.imageDescription: Invalid input` → 500. An older deploy's log (23:19 IST) shows a third invented shape `{ transaction_id, amount, date, time, merchant, status, signs_of_editing }`. Conclusion: the vision path likely NEVER worked live — it always fell back (old response shape tolerated the fallback, so Sarya's car photo still got a verdict: high_risk from screenshot_not_proof + image_unreadable).
- Fix (three layers): (1) `server/lib/ai.ts` ruleBasedFallback image branch now includes `imageDescription: ""`, so a fallback can never break response validation again. (2) `server/lib/scamShield.ts` gains `normalizeImageFindings` (handler calls it on every vision result; missing/non-string imageDescription defaults to "") and `normalizeImageShape` (maps the two logged invented shapes onto the schema keys: description → imageDescription, extraction.payment_amount/date/sender/receiver → amountText/dateText/senderOrReceiverName, signs_of_editing → editingSigns, amount/merchant/status → amountText/senderOrReceiverName/statusWording; readable defaults true for a structured extraction, appearsToBePaymentScreenshot true only when an amount/transaction-id/payment-success status is present; unrecognised objects pass through untouched). `tryJsonAnswer` in ai.ts tries `normalizeImageShape` when the schema has a "readable" key. (3) The vision prompt in `server/actions.ts` now lists the exact JSON keys to return (primary fix — the model should return the schema shape directly).
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/scam-shield-test.mjs` **54/54** (was 31; +6 normalizeImageFindings cases, +17 normalizeImageShape cases using the exact logged model outputs as fixtures, including the payment-like invented shape staying strict at 30/suspicious). OpenAI harness 22/22 (parse ladder unchanged for CFO answers), currency 26/26, insights 77/77, xlsx-export 115/115. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, Scam Shield → upload the same car image → expect "No strong signs", score 5, "What the image shows: a cartoon image of a red car on a road" (or the new prompt's description).

### Scam Shield v2 live result — 500 fixed, verdict still Suspicious (2026-11-19, NOT pushed, NOT deployed)
- Live re-check 23:56 IST 2026-11-19 (deploy f27eef1 Ready 23:54:47 IST): the car image now returns a verdict instead of erroring — but "Suspicious", score 15/100, single reason "The screenshot could not be read clearly" (image_unreadable, medium). The "What the image shows" row was correct ("a cartoon image of a red car on a road", "Looks like a payment screenshot: No"). Expected: "No strong signs", score 5, image_not_payment reason.
- Cause (from the live result, not the logs): the model returned the exact-keys shape this time, but with readable:false — a clear cartoon with no text in it, so the model judged it "not readable" even while describing it perfectly. The scoring took readable:false at face value and went down the unreadable branch.
- Fix: (1) `normalizeImageFindings` in `server/lib/scamShield.ts` — a description IS the reading: readable becomes true when imageDescription is non-empty, unless the description itself says the image cannot be made out (blurry / too dark / cannot tell / unreadable / not clear). (2) The vision prompt in `server/actions.ts` now defines readable as "true if you can see clearly what the image shows, even if it has no text at all".
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/scam-shield-test.mjs` **59/59** (+5 description-wins cases: described-but-flagged → readable true → 5/no_strong_signs; blurry description → readable false → 15/suspicious; no description → readable false). PUSHED 2026-11-20 00:02 IST (HEAD b6b36b9, 4 files, all md5-verified). **LIVE-VERIFIED 2026-11-20 00:04 IST (deploy b6b36b9 Ready 00:02:19 IST): car photo gives "No strong scam signs found", score 5/100, one info reason "This image is not a payment screenshot", "What the image shows: a cartoon illustration of a red car".** Scam Shield image checks work.

### Settings cleanup — essays removed (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (10:46 IST 2026-11-20): "settings me ye sab remove kro, user ko ye sb nhi dikhana hota h" — the Settings page was full of long internal explanations. Removed from `client/pageVault.tsx`: "Pricing, ads & offers — the plain facts", "Why Cashflow Genius?" pitch, "AI engine", "Install app", and "Architecture & integrations — the honest version" (incl. its Gemini/OpenRouter key talk). Trimmed to one short line each: mode switcher note, cursor text, backup text, custom-categories text, app-tour text, Live connections footer; removed the "every record belongs to this account" paragraph. Kept: mode picker, cursor picker, account + change login + log out, backup/restore/undo buttons, custom categories list, delete account, Live connections statuses, business profile form, app-tour button, recent activity.
- `server/actions.ts`: Live connections `detail`/`needed` strings shortened to one line each (AI CFO, Supabase, Bank/UPI, Google sign-in, OpenAI-not-live). Statuses unchanged — still Live only after a real check.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, Settings → only the kept sections show, each short; Live connections still lists all 8 services with correct statuses.

### Settings cleanup, round 2 — Live connections panel removed (2026-11-20, NOT pushed, NOT deployed)
- The artifact builder (phone app) removed the whole Live connections panel as part of the same cleanup, so the Vercel app now matches: the "Live connections" section is gone from `client/pageVault.tsx` (section + its `integrations` query removed), and the two `pitch.tsx` "Honest limits" lines that pointed at it now say the app never shows a bank feed it doesn't have, and the CFO runs on ChatGPT. Two stale code comments fixed (`client/lib.ts`, `client/pageAuth.tsx`). The server `getIntegrationStatus` action stays (unused by the client, harmless). The app never displays a connection it hasn't verified — by not listing unverified services at all.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, Settings → 9 sections, no "Live connections"; homepage pitch "Honest limits" reads correctly with no reference to a removed panel.

### Currency picker with flags (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (11:00 IST 2026-11-20): on first login, a currency selector like her screenshot — bottom sheet, search, country flag + code + name + symbol; limited currencies only. New shared `client/currencyPicker.tsx`: `CURRENCY_OPTIONS` (10: INR, USD, EUR, GBP, AED, JPY, AUD, CAD, CHF, SGD) + `currencyMeta()` + `CurrencyPicker` (button trigger + `Modal` bottom sheet with search; picking only returns the code). Wired in 4 places: first-login setup form in `client/App.tsx` (currency was hardcoded INR before — now a picker field, opening-balance label follows the chosen symbol, footnote updated), top-bar selector (compact flag+code), More-sheet currency box, and the Settings profile form in `client/pageVault.tsx` (local 5-item `CURRENCIES` removed). Conversion behaviour untouched: every change still goes through `requestCurrencyChange` / profile save with the confirm dialog on a workspace with money.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; no hardcoded 5-currency arrays remain in client/. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, sign out → sign up a fresh test account → setup shows the picker with INR selected; pick USD → opening label shows ($); finish → workspace is USD. Existing account: top-bar and More-sheet pickers open the same sheet; changing currency on a workspace with money still asks first.

### Receipt / bill scan — Quick Add "📷 Scan bill" tab (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (11:01 IST 2026-11-20): like her screenshot — put a bill photo in and the AI records the items as categorized expenses, no manual entry per item. New pure module `server/lib/receipts.ts`: `RECEIPT_CATEGORIES` (21 names), `normalizeReceipt` (drops empty/non-positive/NaN items, caps 50 items, amount ceiling 100_000_000_00 paise, validates dates incl. impossible ones like 2026-02-30, currency must be 3 letters else INR, unknown categories kept as custom trimmed to 60 chars, `totalMismatch` when |itemsTotal − receiptTotal| > 1 paise — flagged, never silently fixed), `emptyReceipt` (honest zero-item result — never invents). Harness `scripts/receipts-test.mjs`: 21/21 passed (re-run personally by Muse). New `analyseReceipt` action in `server/actions.ts` after `analyseScamText`: `receiptOutShape` (amounts as plain numbers in the printed currency; currencyCode default INR); prompt lists the EXACT JSON keys, says discount/tax/tip lines are not items; handler calls `aiComplete` with the image + schema + `getAiSettings`, catch → `emptyReceipt()`; writes nothing to the DB. `analyseReceipt` added to `READ_ONLY_ACTIONS` in `client/api.ts` (pure read — otherwise its success would dispatch `cg:mutated` and refetch the ledger, the 2026-11-19 self-loop lesson). `fileToBase64` shared in `client/lib.ts` (`client/pageShield.tsx` now imports it, local copy removed).
- Client wiring in `client/App.tsx`: Quick Add gains a 4th tab "📷 Scan bill" (grid-cols-4); the main Type form is hidden on the scan tab. Scan panel: photo picker (jpeg/png ≤ 6 MB, `capture="environment"`), thumbnail preview, "Read this bill →" (AI via `analyseReceipt`), editable draft rows (item name, amount, `CategorySelect` per row + custom-name input when the AI category is not a known one), merchant + editable receipt date header, currency warning when the receipt currency ≠ workspace currency ("amounts are saved as shown; edit any amount first" — v1 does NOT auto-convert), total-mismatch warning, running total, "Save N expenses" — saves one `saveTransaction` per item (type expense, status posted, description = item name, counterparty = merchant, date = receipt date), collecting failures and reporting "Saved N of M" with failed rows kept for fixing. Nothing is saved before the user's Save tap (same draft-confirm pattern as voice/SMS import).
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/receipts-test.mjs` 21/21. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, open Quick Add → Scan bill → upload a real receipt photo → draft items appear with categories → edit one amount → Save → each item appears as its own expense in Money Flow with the merchant as counterparty; foreign-currency receipt shows the warning; unreadable photo shows the zero-item message.

### Live verification — currency picker + receipt scan + Settings cleanup round 2 (2026-11-20 11:26 IST, deploy b67527c Ready)
- Browser live check (deploy b67527c, Ready 11:21:26 IST): Settings has exactly 9 sections, NO "Live connections" panel — round 2 confirmed. Currency picker opens with search + 10 flag rows from the top-bar selector and the Settings profile field; currency stayed INR. Quick Add has 4 tabs (Type, Voice, SMS import, Scan bill). Receipt scan end-to-end on the empty Student workspace: test receipt (TEST MART — Rice 1kg ₹120, Milk 1L ₹56, Bread 400g ₹40, total ₹216) → AI draft matched exactly (merchant TEST MART, all three items Food & groceries, total ₹216) → "Save 3 expenses" toast "3 expenses recorded from the bill (₹216)" → Money Flow showed all three as separate posted expenses (counterparty TEST MART, 12 Nov 2026) → all three deleted via the app's own delete, Student empty again (₹0, "Nothing recorded yet"). Personal/Business/Creator untouched, no currency or account setting changed.
- Two issues found in that same live check, fixed right after (this push): (1) Modal sheets: on a tall list the header (with the × close button) scrolled out of reach and Escape did nothing — `client/components.tsx` Modal now has a sticky header (solid surface background) and an Escape-to-close listener. (2) Genius Insights Re-check could show a stale card: `runInsightGeneration` has a 60-second guard, and the explicit Re-check went through the same guarded path — after the three test expenses were deleted one by one, Re-check returned the skipped run and the card kept showing "Cash stays at ₹176" even after a reload. Fix: `runInsightGeneration` takes `{ force }`; the `generateInsights` action accepts `force`; the dashboard Re-check passes `force: true` (the automatic mutation-triggered calls in App.tsx still go through the guard). Live checklist for the fix: on an empty workspace press Re-check → the stale insight resolves and the card shows the nothing-needs-attention state.

### Loading animation — Sprout loader (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (11:02 IST 2026-11-20): wherever something takes time to load, show a Cashflow Genius icon animation so the user sees something is loading. New shared `client/LoadingMark.tsx`: the Sprout `LogoMark` gently pulsing (scale 1 → 1.12, opacity 1 → 0.75, 1.4s ease-in-out infinite) with an optional label underneath; `inline` renders just the mark for a row. Keyframes `cg-loader-pulse` + `.cg-loader` in `app/globals.css` — infinite animation, no fill-mode, so no transform ever persists (the CFO composer pin lesson: a persisted transform on a parent breaks fixed descendants). Wired into 5 slow spots: app boot ledger skeleton ("Loading your ledger…"), workspace/mode-switch skeleton ("Loading <mode>…"), session-check screen (replaces the grey circle skeleton), Google sign-in busy screen (same), AI CFO thinking card (replaces the spinning ring; text unchanged). The AI budget planner's "Customizing your budget…" waiting screen will reuse this same mark.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes. NOT pushed, NOT deployed — the parent pushes after review. Live checklist: deploy, cold-load the app → pulsing Sprout above "Loading your ledger…"; switch workspace → pulsing Sprout above "Loading <mode>…"; ask the AI CFO a question → pulsing Sprout in the thinking card.

### Savings recurring contributions — one-time / monthly / yearly (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (11:04 IST 2026-11-20): when adding money to a savings pot, choose whether it is a one-time add or a recurring monthly/yearly one. New table `savings_schedules` (migration `drizzle/0005_savings_schedules.sql`, journal idx 5): id, goalId, ownerId, mode, frequency (once/monthly/yearly), amountCents, nextDueDate (yyyy-mm-dd IST), active. Pure module `server/lib/savingsSchedules.ts`: `nextDueDateAfter` (monthly/yearly clamp the day to the target month — 31 Jan → 28 Feb, 29 Feb → 28 Feb non-leap — and the clamped day sticks), `isDue` (due-date <= today), `isScheduleFrequency`. Harness `scripts/savings-schedules-test.mjs`: 18/18 passed (re-run personally by Muse).
- Server (`server/actions.ts`): `getSavingsSchedules` (pure read, in `READ_ONLY_ACTIONS`; returns [] if migration 0005 is not applied yet), `createSavingsSchedule` (validates the goal; when the start date is today or past it applies the first contribution immediately, only if available cash covers it), `cancelSavingsSchedule` (stops future moves; money already in the pot stays), `applyDueSavingsSchedules` (the engine — see below). Engine: no cron/background job exists, so schedules are applied on load — the dashboard and the Savings page both call `applyDueSavingsSchedules` on mount (idempotent; a second call finds nothing due). Each application is one real deposit transfer (never income/expense), the row is locked FOR UPDATE inside one transaction per application (same pattern as the currency guard), and an application is SKIPPED — never forced — when the workspace's available cash (opening + posted income − posted expenses − net saved in pots) cannot cover it; skipped schedules stay due and are reported. One application per schedule per run (a schedule months behind catches up one period at a time). Deleting a goal also deletes its schedules; both are included in the trash snapshot and Undo restores goal + transfers + schedules.
- Client: `client/pageSavings.tsx` — the Add-money modal gains a "How often?" control (Just once / Monthly / Yearly) for deposits; the Date field becomes the start date when scheduling; the goal card lists its active schedules ("🔁 ₹5,000 monthly · Next: 20 Dec 2026 · Cancel", two-tap cancel); a warning box reports schedules that could not move for lack of cash. `client/pageDashboard.tsx` — dashboard mount applies due schedules once (notifies only when something actually moved).
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/savings-schedules-test.mjs` 18/18; `scripts/receipts-test.mjs` 21/21. NOT pushed, NOT deployed — the parent pushes after review. Live checklist (after migration 0005 is applied in Supabase): deploy; Student workspace → add a ₹10,000 test income (so cash covers it) → create a test goal → Add money ₹1,000 Monthly starting today → first ₹1,000 moves into the pot immediately and the card shows next date 20 Dec 2026 → reload the app → no double-apply → Cancel the schedule → delete the goal and the test income → Student empty again. Also verify a schedule with an amount above available cash is skipped with the warning, not applied.

### AI budget planner (2026-11-20, NOT pushed, NOT deployed)
- Sarya's ask (11:06–11:08 IST 2026-11-20): AI in budget creation — 50/30/20 by default, or the user's own rule, AI only suggests; a "Customizing your budget…" waiting screen while the AI works. Pure module `server/lib/budgetPlanner.ts`: `classifyBudgetCategory` (needs = food/rent/bills/transport/health/education/EMI/loans/tax etc., everything else wants), `deterministicBudget` (splits income by the rule, each bucket shared pro-rata by the last-3-months average spend per category; no-history categories share equally; whole rupees, largest row absorbs rounding so bucket totals are exact), `normalizeBudgetSuggestion` (repairs the AI answer: percentages clamped and rebalanced to 100, bad rows dropped, each bucket rescaled to its percentage of income). Harness `scripts/budget-planner-test.mjs`: 19/19 passed (re-run personally by Muse).
- Server: `suggestBudget` action (after `saveBudget`) — grounded in the average posted income of the last 3 complete months (or the user's typed figure) and the last-3-months spending per category; custom rule validated to sum 100; ChatGPT via `aiComplete` with `budgetOutShape` (EXACT keys listed in the prompt); on failure the deterministic rule answers; response says `source: "ai" | "rule"`. Pure read — added to `READ_ONLY_ACTIONS`, so it never dispatches `cg:mutated`. Nothing is written by this action.
- Client: `client/pageInsights.tsx` — "✦ Plan with AI — 50/30/20 or your own rule" button in the Category budgets section opens `BudgetPlannerModal`: income prefilled from the same 3-month average (editable), lifestyle free-text, rule 50/30/20 or custom percentages (must total 100), waiting screen with the Sprout `LoadingMark` ("Customizing your budget…"), then editable rows (category, bucket tag, amount) with bucket totals and the saving left over; "Save N budgets" writes one `saveBudget` per confirmed row. AI only suggests — nothing is saved until the user taps Save.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/budget-planner-test.mjs` 19/19. NOT pushed, NOT deployed — the parent pushes after the savings live-check finishes, so the check isn't disturbed. Live checklist (after deploy): Leak Scanner → Category budgets → Plan with AI → income prefilled → "Create my budget" → waiting screen shows → suggestion rows appear (needs/wants/savings split, amounts editable) → Save → budgets appear in the list and the scanner flags overspends against them.

### Smart Add bar + AI avatar (2026-11-20, NOT pushed, NOT deployed)
- Sarya's asks (11:52–11:53 IST 2026-11-20): (a) in Quick Add, below the manual form, a chat-style section like her screenshot — one line where she writes everything at once (items, amounts, date, expense/income, where the money came from/went), the AI records it all; the bill-scan AI moves here from its tab and the camera offers "Take photo" or "Choose from files"; (b) an AI avatar built on the app logo, visible in the app as the AI.
- AI avatar: new `client/AiAvatar.tsx` — pure SVG, always exactly the logo: the white Sprout on the GenZ gradient circle, with a friendly face (two deep-violet eyes + smile on the arrowhead; geometry computed from the LogoMark paths so the face sits on the white shape). `size` prop; `pulse` prop reuses the `cg-loader` pulse while the AI works. Wired into the AI CFO page header (replaces the GlassOrb hero; "The brain of your ledger" stays as the caption) and the CFO thinking card (pulsing avatar replaces the inline LoadingMark), and the Smart Add bar header. The boot/mode-switch loader still uses LoadingMark.
- Smart Add server: new pure module `server/lib/smartEntry.ts` — `normalizeSmartEntry` (repairs the AI answer: drops empty/non-positive rows, caps 20 entries and amounts, impossible dates fall back to today, unknown categories kept for the custom field) and the deterministic fallback `parseSmartEntryText` (splits on commas/semicolons/newlines and "and"/"aur"; per chunk: amount via the same ₹/k rules as `client/parseEntry.ts` — the "k" of "kharcha" is not a thousands multiplier — date words today/aaj, yesterday/kal, tomorrow/parson, written "12 Nov"; direction words flip income; keyword→category matched against the workspace's own lists). Harness `scripts/smart-entry-test.mjs`: 19/19 passed (re-run personally by Muse).
- Server: `parseSmartEntry` action — ChatGPT via `aiComplete` with `smartEntryOutShape` (EXACT keys listed; today in IST passed so "yesterday" resolves), fallback to the deterministic parser; response `{ source: "ai" | "rule", entries, note }`. Pure read — in `READ_ONLY_ACTIONS`.
- Client: `client/App.tsx` — the "📷 Scan bill" tab is REMOVED (tabs back to Type / Voice / SMS); the bill scan now lives in the Smart Add section below the manual form. The section (with the AI avatar at its head) has a chat-style pill bar: text input (placeholder "dinner 50, shopping 200 — yesterday"), a round dark mic button (same speech recognition as the Voice tab; the transcript goes into the bar and the AI parses it) and a round dark camera button that opens two choices — "📷 Take photo" (camera) and "🖼 Choose from files". Picking a photo reads it immediately (no extra button). Text and bill drafts share one editable list: name, amount, category (+ custom), per-row expense/income toggle, per-row date, per-row from/to; currency-mismatch and total-mismatch warnings shown for bills. "Save N transactions" writes one `saveTransaction` per row (posted, own type/date/counterparty); failures stay in the draft. Nothing is auto-saved.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; `scripts/smart-entry-test.mjs` 19/19; `scripts/budget-planner-test.mjs` 19/19; `scripts/savings-schedules-test.mjs` 18/18; `scripts/receipts-test.mjs` 21/21. NOT pushed, NOT deployed — same reason as the budget planner. Live checklist (after deploy): Quick Add → below the form, Smart Add bar with avatar, mic + camera; type "dinner 50, shopping 200 yesterday" → draft shows 2 rows dated yesterday → edit one amount → Save → both appear in Money Flow, then delete them; camera → Take photo / Choose from files both offered; take a bill photo → items draft appears (same as the old Scan tab); AI CFO header shows the avatar with a face; CFO thinking shows the pulsing avatar.

### Savings recurring — LIVE-VERIFIED 2026-11-20 12:00 IST (deploy dce221a Ready)
- Migration 0005 applied in the Supabase SQL Editor ("Success. No rows returned", "Run without RLS" chosen so the SQL ran exactly as supplied); `SELECT count(*) FROM savings_schedules;` returned 0. Table did not exist before; it was created by this run.
- Live checks (Student workspace, all test records deleted after): cold load shows the pulsing Sprout above "Loading your ledger…"; test income ₹10,000 added; goal "Test Pot" ₹50,000 target; Add money ₹1,000 Monthly from 20 Nov 2026 → toast "₹1,000 moved into "Test Pot" now, and will move again every month", card shows "🔁 ₹1,000 monthly · Next: 20 Dec 2026", Saved ₹1,000, available ₹9,000. Full reload → still exactly ₹1,000, one transfer only — no double-apply. Second schedule ₹50,000/month (more than the ₹9,000 available) did NOT move money — pot stayed ₹1,000. Cancel works (two taps, "Tap again to cancel"). Cleanup done: goal + test income deleted, Student empty again (₹0, "Nothing recorded yet").
- Two gaps found and fixed in the next push (NOT yet live): (1) the skipped ₹50,000 schedule showed no standalone "not enough available cash" warning in that session — only the toast said it. The warning box only fired on the apply-on-mount, which had already run before the schedule was created. Fix: `MoveMoneyModal` now takes `onScheduleSkipped`, called when `firstApplied` is false, so the Savings page shows the stuck-schedule warning immediately; cancelling the schedule clears it. (2) Insights Re-check verified in the same run: the stale "Cash stays at ₹176" line was already gone, Re-check shows "No insights need attention right now — your numbers look steady. Checked just now."
- Modal × fix did NOT hold live: the currency picker sheet's header/× still scrolled out of view while the list scrolled (Escape did close the sheet). Root cause: the sheet kept a persisted transform from the `cg-modal-in` keyframe (`to { transform: translateY(0) scale(1) }`, fill `both`) — the same mechanism that broke the AI CFO composer pin — plus the sticky header's negative margins. Fix (in the next push): `cg-modal-in`'s `to` keyframe is opacity-only, and the Modal header no longer uses `-mx-5 -mt-5` (the sheet lost its `p-5`; the content is wrapped in `px-5 pb-5 pt-4` instead). Re-verify live after the push: open the picker, scroll the list, the × must stay visible.
- Note: the browser's CFO test question "How much money do I have?" remains as a conversation in the AI CFO history (its delete control was not used). The user can remove it from the CFO page with the 🗑 button on that conversation.

### Modal × fix v3 (2026-11-20, pushed after the da52a01 live check)
- The da52a01 live check (12:23 IST) PASSED the budget planner (waiting screen → AI suggestion → Save → General ₹24,000/month in the list; with no spending history the AI made a single General/Needs row of ₹25,000 and showed wants+savings as the unallocated remainder), the skipped-schedule warning (yellow box appeared IMMEDIATELY: "One scheduled saving could not move — the workspace's available cash doesn't cover it", pot stayed ₹0, cash stayed ₹10,000; cancel cleared it), Smart Add text ("dinner 50, shopping 200 yesterday" → 2 rows dated 19 Nov 2026 → edited dinner to ₹60 → saved ₹260 → both in Money Flow → deleted), Smart Add camera+bill (both "Take photo" and "Choose from files" offered; TEST MART receipt read exactly — Rice ₹120, Milk ₹56, Bread ₹40, total ₹216, dated 12 Nov 2026 — saved and deleted), and the AI avatar (header shows the Sprout WITH a face — two dark eyes and a smile, verified on an enlarged crop; thinking card shows the avatar; the browser's own test conversation was deleted via 🗑, the three pre-existing conversations untouched). Student was left empty again (₹0 everywhere).
- BUT the currency picker × FAILED again: the header still scrolled away with the list even after fix v2 (opacity-only keyframe + no negative margins). Escape closed the sheet (verified 3×). Root cause unknown — sticky simply does not hold in this sheet in the live browser. Fix v3 rebuilds the Modal layout instead of debugging sticky further: the sheet is now a flex column with `overflow-hidden`; the header is a plain `shrink-0` flex child ABOVE the body, and only the body (`min-h-0 flex-1 overflow-y-auto`) scrolls. No sticky positioning anywhere, so nothing can defeat it. This changes every modal (Quick Add, picker, dialogs) — the header now always stays visible. Live re-verify (focused check): open the currency picker, scroll the list hard, the × must stay visible the whole time.
- Minor live observations (not fixed): the Home "Other workspaces" tile lagged, showing a stale "Student / First Salary: ₹9,784" while the workspace's own pages all read ₹0 after cleanup; the goal form's segmented date field resisted direct typing and briefly scrambled to year 202027 (recovered with ArrowUp; the goal was created with the correct date).

### Login page cleanup (2026-11-20, NOT pushed)
- Sarya's ask (12:32–12:35 IST 2026-11-20): remove a list of texts from the login page, pasted verbatim. All removed from `client/pageAuth.tsx`: the "What's connected" strip (the whole `ConnectionStrip` component deleted — including its stale lines "AI CFO engine Not connected / No Gemini key — the AI CFO answers with the built-in rule-based fallback" and "Google Gemini / No Gemini connection wired yet", wrong since the CFO runs on ChatGPT), the "Account setup note" (the whole `SetupNotice` component deleted, including its uses in the Signup, Forgot-password and Verify screens), the "One calm home for your money…" paragraph, the four mode cards, the "Four completely separate workspaces…" line, the "New here? Sign up with your email…" paragraph, and the small line under "Continue with Google" ("Your own Google account, your own private workspace…"). The public home now shows only: logo + "Cashflow Genius" + "See money before it moves.", Continue with Google, Login / Sign Up, Install app, and the collapsed "Why Cashflow Genius? — the pitch" details (left in place — she did not ask to remove it; note its inner line still points at "Settings → Why Cashflow Genius?", a section removed in the Settings cleanup — fix with the clean UI pass).
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; zero matches in pageAuth.tsx for "What's connected", "Account setup note", "One calm home", "Four completely separate", "New here? Sign up", "Your own Google account". NOT pushed. Live checklist (after deploy): sign out → public home shows no removed text; Login and Sign Up screens open and work; the signup flow still offers the mode choice (now 3 modes, see below).

### Student / First Salary removed completely (2026-11-20, NOT pushed)
- Sarya's ask (12:38 IST 2026-11-20): "student/first salary wala feature remove hi kardo completely kyuki ye personal wale me hi aa jata hai".
- DB inventory first (read-only SQL check 12:45 IST): the Student workspace is EMPTY. Main account has one `businesses` row (mode "student", name "My Student Budget", opening 0, INR) with 0 transactions, 0 savings goals and 0 invoices; the second account has no student record of any kind. Nothing to migrate, nothing lost.
- Code removal: `client/lib.ts` (AppMode type, APP_MODES, MODE_LABELS, MODE_ICONS, isPersonalLike now Personal-only, STUDENT_* category constants and their switch branches deleted, allKnownCategories no longer spreads them); `client/components.tsx` (ModePicker student card deleted); `client/App.tsx` (default workspace name, setup title, draft-workspace notice); `client/optimistic.ts` (setMode allow-list); `client/pageDashboard.tsx` (together-panel "others" filter is Creator-only now); `client/pitch.tsx` ("three money modes"); `client/appTour.tsx` ("Three money modes, fully separate"); `client/pageVault.tsx` (delete-account warning lists 3 workspaces); `server/actions.ts` (APP_MODES, MODE_LABELS, MODE_DEFAULT_NAMES, all 10 z.enum mode validations, CFO briefing/framing student branches); `server/schema.ts` (Drizzle mode enum is 3 values now).
- Legacy handling (deliberate, not an oversight): (1) a stored "student" active mode from an older session folds to Personal in client `modeOf` (so a session left on Student lands on Personal, never breaks); (2) the Postgres enum TYPE still contains 'student' and the one empty legacy `businesses` row still carries it — Postgres cannot drop an enum value, so do NOT generate a migration for this difference; the row is inert (never offered, accepted or returned as an active mode) and backups exclude it (export iterates APP_MODES). Deleting that empty row via SQL is possible later if wanted.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; harnesses smart-entry 19/19, budget-planner 19/19, savings-schedules 18/18, receipts 21/21; remaining "student" strings in code are only the lib.ts legacy-fold comments/coercion and the schema.ts enum note. NOT pushed. Live checklist (after deploy): public home + signup + mode switcher + Settings mode list show exactly 3 modes (Personal, Business, Creator); no "Student" text anywhere in the app; a session left on Student opens on Personal.

### Currency incident — verified numbers (DB check 2026-11-20 12:45 IST)
- During the Modal v3 live check (12:30–12:34 IST) the tester accidentally switched the currency to AUD and back to INR. Currency is back to INR and Business is byte-exact unchanged (income ₹29,35,972, expense ₹1,78,662, available ₹27,57,310). Personal Money shrank by the round trip at live rates (~0.11%): income ₹1,48,42,690 → ₹1,48,26,386 (down ₹16,304), expense ₹4,44,569 → ₹4,44,082 (down ₹487), pots ₹35,00,000 → ~₹34,96,156 (down ~₹3,844), available ₹1,08,98,121 → ₹1,08,86,148 (down ₹11,973). Verified from the live DB (transactions summed in paise; available derived as income − expense − pots). The two conversion entries sit in Settings → Recent activity. An exact per-transaction restore would need the precise rates from the activity log — investigate `activity_logs` for the conversion entries before promising a restore.

### Modal v3 — FAILED live again (2026-11-20 12:37 IST)
- The focused re-check (deploy 4b5ce2f Ready) FAILED on the picker: on opening, the header ("Select a currency" + ×), the search box and the INR/USD/EUR rows are ALREADY off-screen above the viewport (GBP cut off at the top edge, SGD at the bottom, sheet bottom about halfway down the screen). Wheel-scrolling over the list does nothing to the list — the page behind scrolls instead. Only workaround: typing in the (autofocused) search box filters to one row. Escape closes the sheet. Quick Add, Calculator and Quick Note modals all PASS with the v3 layout (headers visible, fit the viewport, header stays while scrolling) — so the failure is specific to the picker sheet: it renders taller than the viewport with its top above it, despite max-h-[92vh]. Next step before any further fix: live DOM diagnosis — getBoundingClientRect of the backdrop, sheet, header and body, plus computed max-height/overflow of the sheet — to find why the cap does not hold for this sheet.

### getState crash after Student removal — FIXED (2026-11-20)
- The 12-file Student-removal push (HEAD 68c00bc) BROKE sign-in for the main account: after Google sign-in the app showed only "Your workspace could not be loaded — The server returned an unexpected result for getState. Please try again." (live-verified 13:29 IST; Try again x3 + reload, same error every time). The second account (no student row) was unaffected.
- Root cause: getState's response includes a `workspaces` array built from ALL `businesses` rows, and its zod schema validates each workspace mode against the 3-mode enum — the one empty legacy Student row (mode "student") failed validation and threw the whole action. The removal had taken "student" out of every enum but left the legacy row flowing into that array.
- Fix (server/lib/batch.ts + server/actions.ts): (1) a `withoutLegacyStudent` filter in both batch loaders (`loadWorkspacePrelude`, `loadCombinedBatch`) — the legacy row is now invisible to the app everywhere (getState, getBriefing, getCombinedSummary, export, availableCashCents); (2) `asMode` now maps "student" → "personal", so a stored "student" active mode (e.g. set by the phone artifact, which still offers Student) folds to Personal instead of Business. Verified: tsc 0, build passes, harnesses smart-entry 19/19, budget-planner 19/19, savings-schedules 18/18, receipts 21/21. Live re-check pending: sign-in must land on Personal with the dashboard loading.
- Note the Sign Up screen never had mode cards (the mode choice lives in the setup step after account creation, via ModePicker — now 3 cards); the earlier live-check "deviation" on that point was a wrong expectation, not a bug.

### Modal × — root cause found, portal fix (2026-11-20)
- Code inspection (no live check needed for the cause): the top-bar header carries `backdrop-blur-md`, and `backdrop-filter` makes the header the containing block for `position:fixed` descendants. The picker's Modal backdrop (`fixed inset-0`) therefore collapsed to the header's ~60px box, and the sheet centred on that tiny box — header above the viewport, × unreachable, wheel scrolling the page behind. That matches all three live failures exactly (v1 sticky, v2 opacity-only keyframe, v3 flex column all failed the same way because none of them moved the backdrop out of the header). Quick Add / Calculator / Quick Note pass because their Modals are not rendered inside the blurred header.
- Fix (client/components.tsx): the Modal now renders through `createPortal(..., document.body)` (SSR-guarded — the Modal only opens from a client click), so `fixed` always anchors to the viewport wherever the trigger lives. Header/body layout unchanged (v3 flex column). Verified: tsc 0, build passes. Live re-check pending: open the picker from the top bar — the header + × must be visible on open and stay visible while scrolling the list.

### Lend/Borrow — built (2026-11-20, NOT pushed)
- Sarya's ask (11:12 IST 2026-11-20): add a Lend/Borrow feature so money lent to or borrowed from someone stays clear. Screenshot showed Debt/Lend/Borrow/Challenge tabs, "Hide completed" toggle, filters All / I owe / Owed to me, an empty state and a "+ Add lend/borrow" button. (No Challenge tab — we have no friends system; never fake one.)
- Pure module `server/lib/lendBorrow.ts` — `normalizeLendBorrow` (person ≤120, direction lent/borrowed, positive integer amount ≤ ₹1,00,00,000, valid dates incl. impossible-date rejection, note ≤500, settledDate only when settled), `isOverdue` (open + dueDate < today; due today is NOT overdue), `lendBorrowTotals` (open-only owedToMe/iOwe/net + counts), `filterLendBorrow` (direction + hideCompleted), `sortLendBorrow` (overdue first, then dueDate asc nulls last, then date desc; now generic so the id survives the sort). Harness `scripts/lend-borrow-test.mjs` 21/21 PASS.
- Server: migration `drizzle/0006_lend_borrow.sql` (table `lend_borrow` + owner/mode/status/due index) + journal idx 6; schema table in `server/schema.ts`; 4 actions in `server/actions.ts` following the savings pattern (workspace-scoped, active-workspace edits only): `getLendBorrow` (sorted server-side; honest empty list if migration 0006 not yet applied), `saveLendBorrow` (create/edit, validated by normalizeLendBorrow), `settleLendBorrow` (settled ↔ open; **settling only closes the entry — it never creates a Money Flow transaction**; whether it should is still Sarya's open decision), `deleteLendBorrow` (trash snapshot kind "lend_borrow" + undo branch, so deletes are undoable). Lend/borrow amounts are included in currency conversion (`updateBusiness` counts.lendBorrow). `getLendBorrow` added to READ_ONLY_ACTIONS in `client/api.ts`.
- UI `client/pageLend.tsx` — route "lend-borrow" (`app/lend-borrow`, core nav "Lend & borrow" ⇄, after Savings): summary cards Owed to me / I owe / Net, overdue count, one line stating settling never adds a Money Flow entry, filters All / Owed to me / I owe + Hide completed toggle, entry cards with direction badge, due date, Overdue badge, note, Mark settled / Reopen / Edit / Delete (confirm first, Undo after). Add/edit form in the shared Modal.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes; harnesses lend-borrow 21/21, budget-planner 19/19, savings-schedules 18/18, receipts 21/21, smart-entry 19/19. NOT pushed. Live checklist (after deploy): apply migration 0006 in Supabase SQL Editor first; open Lend & borrow from the nav — empty state shows; add one lent + one borrowed entry (totals + filters + overdue badge), settle one (no Money Flow entry appears), delete one with Undo; switch currency and back — amounts convert.

### Money Tools hub — built (2026-11-20, NOT pushed)
- Sarya's ask (11:12 IST 2026-11-20): a proper Money Tools section with all our options, for phone and laptop. Her screenshot showed Budget, Savings, Debt, Lend/Borrow and Challenge cards with round icons + one-line descriptions + chevrons, and a bottom nav with Money Tools as a tab.
- Built `client/pageTools.tsx` — route "money-tools" (`app/money-tools`, core nav "Money Tools" 🧰 after Lend & borrow; reachable from the sidebar and the phone More sheet — the bottom nav stays Home / Money / + Add / Due / More, so the hub is one tap inside More). 12 cards, list on phone (1 column), grid on laptop (2 cols sm, 3 cols lg): Budget → profit-scanner, Savings → savings, Lend & borrow → lend-borrow, Debt & dues → payment-calendar, Scam Shield, What-if planner, Future forecast, Invoices, GST & tax, Reports, Notes, AI CFO. Every card opens a real tool. No Challenge card (no friends system — never faked). Debt has no separate page: the card links to the payment calendar where the EMIs and bills actually live, and says so.
- Verification (re-run personally by Muse): `npx tsc --noEmit` 0 errors; `npm run build` passes. NOT pushed. Live checklist (after deploy): open Money Tools from the More sheet — all 12 cards show; tap Budget, Lend & borrow and Debt & dues — each opens the right page; on a phone-width viewport the cards stack as a list.

### Clean UI pass — trims applied (2026-11-20, NOT pushed)
- Applied the full re-derived trim audit: **94 items, 0 skipped** — 23 DELETEs, 71 rewrites across 16 files (App.tsx 10, pageDashboard.tsx 10, pageInsights.tsx 11, pageFuture.tsx 2, pageVault.tsx 12, pageAuth.tsx 2, appTour.tsx 13, pageMoney.tsx 2, pageCalendar.tsx 5, pageSavings.tsx 11, pageCfo.tsx 1, pageInvoices.tsx 2, pageShield.tsx 3, components.tsx ModePicker bulk, pitch.tsx 8, pwa.tsx 1). Every quoted string was verified to exist exactly once before replacement. Diff vs origin/main: 16 files, 96 insertions, 275 deletions (net −179 lines).
- Also fixed the stale ModePicker code comment ("Four selectable cards" → "Three").
- **Correction applied (audit finding):** pageCalendar's "No upcoming payments" empty state said "Add a recurring bill in Money Flow" — the recurring-bill form actually lives in Future forecast; now says so.
- **Structural repair during application:** deleting the pre-scan card in pageInsights.tsx left an empty ternary branch (`) : ( )`); fixed to `) : null`. tsc caught it; re-ran clean.
- **Two audit notes:** (1) pageSavings "It happens in {mode} only." appears once in source (it trails one ternary covering all three MoveMoneyModal variants) — one deletion covers all three. (2) The GoalCard "only just begun" status variant ("You've only just begun this goal, so there's no pace to compare yet…") was NOT in the audit and was left untouched.
- Verified: `npx tsc --noEmit` 0 errors; `npm run build` passes. Protected text confirmed intact: Lend/Borrow settling line, Money Tools Debt card, Settings separation line, invoice mark-paid confirm ("exactly one linked income transaction"), EMI collect toast ("one income transaction was added"), Scam Shield warning boxes. Trimmed strings confirmed gone (incl. "How budgeting works here", "The classic split", "Four selectable cards", "Settings → Install app", "Settings → Why Cashflow Genius").
- NOT pushed. Live checklist (after deploy): spot-check Home (no "How budgeting works here" section), ModePicker (title + one line per card, no bullets), tour steps (one line each), Savings page (short status lines), Money Flow header + Calendar header.
