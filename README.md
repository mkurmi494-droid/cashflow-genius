# Cashflow Genius — Vercel port

**Cashflow Genius — The Living Ledger. “See money before it moves.”**

This is the Vercel-ready port of the Cashflow Genius app (originally a
Muse fullstack artifact). Same GenZ gradient UI, same exact 5-second
intro (landscape + portrait cuts), same 13 modules, same 4 money modes,
same PWA + 12-step tour — rebuilt on free tiers only:

| Piece | Muse original | This port |
|---|---|---|
| Frontend | Hatch runtime SPA | Next.js 15 App Router (SPA page, React 19, Tailwind 4) |
| API | `@hatch/space-sdk` actions → `./actions` | Same 55 actions, same names/shapes → `/api/<action>` |
| Database | Local SQLite (`app.db`) | Supabase Postgres (Drizzle `pg-core`) |
| Auth | Local PBKDF2 + Supabase Auth for OTP/Google | Same model, data in Supabase Postgres; Supabase Auth verifies email OTP + Google |
| AI CFO | `ctx.inference` | Gemini free tier (account key or `GEMINI_API_KEY`); honest rule-based fallback when no key |
| PWA | Manifest + icons (no service worker — one-bundle limit) | Manifest + icons **+ real `sw.js`** served at the root, so Android one-tap install works |

**Project name (Vercel): `cashflow-genius` → live URL `https://cashflow-genius.vercel.app`**
**Repo: https://github.com/mkurmi494-droid/cashflow-genius** (public, empty — push this folder into it)

## What was tested here (local, before pushing)

- `npm run build` — production build passes; `npx tsc --noEmit` — 0 errors.
- Full end-to-end action suite against a local Postgres seeded with a
  test user: **53/53 checks passed** (see `TESTING.md`): auth, business
  setup, transactions, budgets + leak scan, invoices + mark-paid
  duplicate guard (exactly 1 linked income txn), savings goals,
  EMI plans + collect (exactly 1 linked income txn, second collect
  rejected), recurring, scenarios, notes + versions, Scam Shield
  (high-risk OTP message), AI CFO + briefing (honest rule-based
  fallback — no Gemini key here), CSV import duplicate-skip + undo,
  backup export + careful merge-restore, delete + Undo restore,
  all 4 money modes isolated, cursor/tour prefs, integration status,
  Supabase Auth probe (Google + email live), logout.
- Homepage, manifest, service worker, both intro videos, icons and all
  JS chunks return HTTP 200 locally.

**Not yet tested live (needs the real deployment + a human):** the
Google sign-in round-trip with a real Google account, an OTP email
actually landing in an inbox, and PWA install on a real phone. The
React app mounts client-side, so the signed-in dashboard could not be
driven in this sandbox either — re-check it on the live URL after
deploy (see “After deploy” below).

## Deploy (free, $0)

### 1. Create the database tables in Supabase (one time, ~2 minutes)
1. Supabase dashboard → your project `zfngqppwmyizlnrzhrjc` →
   **SQL Editor** → **New query**.
2. Paste the whole file `drizzle/0000_far_mephistopheles.sql` and run it.
   It creates all 24 tables (auth, transactions, invoices, EMI,
   savings, notes, budgets, scam checks, trash/undo, …). No data is
   seeded — every new user starts with an empty workspace.
   (Alternative: `DATABASE_URL=… npm run db:push` with drizzle-kit.)

### 2. Get the Postgres connection string
Supabase dashboard → **Project Settings → Database → Connection
string** → choose **Session pooler** (port 6543). It looks like:
`postgresql://postgres.<ref>:<DB_PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require`
Use your database password (the one set when the project was created).
This is the only secret the deploy needs — put it in Vercel env vars,
never in the repo.

### 3. Push this folder to GitHub
```bash
cd cashflow-genius-vercel
git init
git add .
git commit -m "Cashflow Genius — Vercel port (Next.js + Supabase Postgres)"
git branch -M main
git remote add origin https://github.com/mkurmi494-droid/cashflow-genius.git
git push -u origin main
```

### 4. Import into Vercel (Hobby, free)
1. https://vercel.com/new → **Import** `mkurmi494-droid/cashflow-genius`.
2. **Project Name must be exactly `cashflow-genius`** (so the URL is
   `https://cashflow-genius.vercel.app`).
3. Framework: Next.js (auto-detected). Build command / output: defaults.
4. **Environment Variables** (all three scopes: Production, Preview,
   Development):
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Session-pooler connection string from step 2 (**required**) |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://zfngqppwmyizlnrzhrjc.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_6D9rlSGsbPzqkMVyWdrZ3w_60JseEvy` |
   | `GEMINI_API_KEY` | *(optional)* free Gemini key from Google AI Studio — enables the AI CFO; without it the AI CFO answers with the honest rule-based fallback |
5. **Deploy.**

### 5. Supabase redirect URLs (so Google + email sign-in return to Vercel)
Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `https://cashflow-genius.vercel.app`
- **Redirect URLs → Add URL:** `https://cashflow-genius.vercel.app/**`
- Keep the existing Supabase callback (`https://zfngqppwmyizlnrzhrjc.supabase.co/auth/v1/callback`)
  in the Google OAuth client — it does not change.

No other Google Cloud change is needed: the OAuth client already
redirects to Supabase, and Supabase redirects back to the app.

## After deploy — check these on the live URL
1. Open `https://cashflow-genius.vercel.app` — 5-second intro plays,
   then Login / Sign Up.
2. **Continue with Google** — sign in with a real Google account;
   you must land in an empty Command Center.
3. **Email sign-up** — sign up with a real email; the 6-digit OTP must
   arrive in the inbox (Supabase free sender: only a few auth emails
   per hour — if it says “limit reached”, wait an hour).
4. Add one transaction, one invoice (mark paid → exactly one income
   transaction appears), one savings deposit — reload the page; all
   three must still be there.
5. Settings → Live connections — Database, Supabase and Google sign-in
   must show **Live**; Gemini shows Live only if a key is configured,
   otherwise honestly **Not connected**; Bank/UPI sync is honestly
   **Not connected** (there is no UPI API).
6. Phone → browser menu → **Install app / Add to Home Screen** —
   the app must install and open full-screen (service worker now ships).

## Local dev
```bash
cp .env.example .env.local   # fill DATABASE_URL
npm install
npm run dev                  # http://localhost:3000
```

## Costs (all free tier)
Vercel Hobby $0 · Supabase free tier $0 (Auth + Postgres) · Google
OAuth $0 · Supabase built-in email sender $0 (rate-limited, a few
auth emails/hour) · Gemini free tier $0 (optional). No SMS OTP
anywhere — phone sign-in was removed because SMS is never free.

## Notes / honest limits
- Existing accounts/data from the Muse workspace database are **not**
  migrated by this deploy — Vercel starts with an empty Supabase
  database. Users sign up fresh (Google or email OTP). If the old
  records must move over, that is a separate migration step.
- The demo account stays removed: login/sign-up refuse
  `demo@cashflow-genius.local`, and any surviving demo session purges
  the demo account.
- `DATABASE_URL` is the one value that cannot be derived here — it
  needs the Supabase database password, which only the project owner
  has. Without it the app serves the homepage/intro but every API call
  fails with a clear “DATABASE_URL is not set” message.
