# Cashflow Genius: The Living Ledger

**"See money before it moves."**

Cashflow Genius is a forward-looking AI money manager built for India, INR and Indian numbering by default, UPI and GST aware. Instead of only recording the past, it takes everything already scheduled (invoices, rent, EMIs, recurring bills) and projects your real position into the future, then answers questions about it in English or Hinglish, always citing the real figures behind every answer.

Live app: https://cashflow-genius.netlify.app/ (also deployed at https://cashflow-genius.vercel.app/)

## What it does

Three money modes, each a completely separate workspace with its own financial records, never mixed: Personal Money, Business Money, and Creator and Freelancer. Switch anytime; view them together without mixing the data.

Fourteen modules, one money brain:

1. Command Center (dashboard with available cash, month in/out, savings pots, business health score)
2. AI CFO (chat that answers only from your recorded figures and shows its sources)
3. Money Flow Universe (money in and out, visualised)
4. Future Lens (30-day forward cash view)
5. What-if Lab (scenarios)
6. Invoice Intelligence (create invoices with GST, mark paid; exactly one linked income transaction is created, never two)
7. Profit Leak Scanner
8. GST and Tax Intelligence (India, FY 2026-27; figures are estimates only, never official tax advice)
9. Business Reports Vault (CSV and Excel export)
10. Memory Vault (notes)
11. Money Calendar (every due date, overdue first: bills, unpaid invoices, EMI instalments)
12. Scam Shield (paste a suspicious UPI or phishing message, or upload a payment screenshot, for a verdict with plain-language reasons; never asks for OTP or PIN; a screenshot or message is never proof of payment, always verify in your bank or UPI app)
13. Savings Goals (pots with targets, dates, pace tracking, recurring contributions)
14. Lend and Borrow (track who owes whom; settling creates exactly one linked Money Flow transaction)

Plus: Genius Insights (a proactive insights engine with deterministic rules, zero LLM, on the Command Center), a Home AI chat on the dashboard that adds transactions, budgets, goals and deposits at once from plain language, Smart Add (type, speak, or snap a bill; drafts never auto-save), voice entry and SMS/bank-message import (pasted messages become drafts, never auto-save), a 10-currency picker with live rates, an in-app calculator, a 12-card Money Tools hub, a 9-card Settings hub, a 12-step app tour, and in-app updates (banner on open plus a Settings check).

Safety by design: every delete asks first and offers a 12-second Undo. There is no demo account and no fictional data; every new account starts empty.

## How to run it

### Local dev

```bash
git clone https://github.com/mkurmi494-droid/cashflow-genius.git
cd cashflow-genius
npm install
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:3000
```

`npm run build` builds for production. `npx tsc --noEmit` type-checks (0 errors expected).

### Environment variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes | Supabase Postgres connection string, Session pooler (port 5432). Never commit it. |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | `https://zfngqppwmyizlnrzhrjc.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | The Supabase publishable key for the project (public by design). |
| `OPENAI_API_KEY` | For AI features | Server-side OpenAI key. Without it the AI features answer with an honest rule-based fallback. |

Create the database tables first (one time): in the Supabase dashboard, open the SQL Editor and run the migration files in `drizzle/` in order (0000 through 0007). No data is seeded; every new user starts with an empty workspace.

### Deploy (free tiers)

Import the repo into Vercel (Hobby, free) or Netlify (free), set the four environment variables above for Production, and deploy. The app is Next.js 15 (App Router), so the defaults work. In Supabase, under Authentication then URL Configuration, add the deployed URL to the redirect allow-list (for example `https://cashflow-genius.netlify.app/**`) so Google and email sign-in return to the app.

## AI models and APIs used

| Use | Model / API |
|---|---|
| AI CFO, Home AI chat, Smart Add parsing, AI budget planner suggestions, Scam Shield image checks | OpenAI `gpt-4o-mini` (one shared server key, `OPENAI_API_KEY`; no key is ever asked from the user) |
| Auth (email + Continue with Google) and Postgres database | Supabase Auth and Supabase Postgres (Drizzle ORM) |
| Live currency conversion rates | open.er-api.com (free, no key) |
| Proactive insights (Genius Insights) | Deterministic rules only, no LLM call |

Honest limits: Gemini is not in use (its free tier is unavailable for this project, account-level 403). Bank and UPI auto-sync is not connected, because no public UPI or bank API exists; the official route is the RBI Account Aggregator framework (licensed, not free). Import works by pasting a bank or UPI message, or by CSV file. Tax figures are estimates only.

## Tech stack

Next.js 15 App Router, React 19, Tailwind CSS 4, TypeScript, Drizzle ORM, Supabase Postgres, PWA (manifest, icons, service worker). Money is stored as integer paise.

## Costs

All free tiers: Vercel Hobby $0, Netlify free $0, Supabase free tier $0 (Auth + Postgres + built-in email sender), Google OAuth $0, open.er-api.com $0. OpenAI usage is billed per call to `gpt-4o-mini` (a few paise per AI CFO question).
