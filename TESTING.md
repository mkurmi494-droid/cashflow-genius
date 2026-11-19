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
