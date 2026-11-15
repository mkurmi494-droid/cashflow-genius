import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./safeArea";
import { api, setAuthToken, withTimeout } from "./api";
import { completeGoogleCallback, hasGoogleCallback } from "./supabase";
import {
CinematicIntro,
ForgotScreen,
LoginScreen,
PublicHome,
SignupScreen,
VerifyScreen,
} from "./pageAuth";
import type { Route } from "./types";
import { APP_MODES, CUSTOM_CATEGORY, MODE_ICONS, MODE_LABELS, PAYMENT_METHODS, categoriesFor, categoryOptionsFor, fmtMoney, isPersonalLike, modeOf, todayStr, type AppMode, type State } from "./lib";
import { CategorySelect, GlassOrb, Modal, ModePicker, ParticleField } from "./components";
import { DashboardPage } from "./pageDashboard";
import { AiCfoPage } from "./pageCfo";
import { MoneyFlowPage } from "./pageMoney";
import { FutureLensPage, WhatIfPage } from "./pageFuture";
import { InvoicesPage } from "./pageInvoices";
import { PaymentCalendarPage } from "./pageCalendar";
import { SavingsPage } from "./pageSavings";
import { CalculatorPanel } from "./calculator";
import { ConfirmDialog, UndoToast, useSafety } from "./safety";
import { applyCursorStyle, DEFAULT_CURSOR_STYLE } from "./cursor";
import { ScamShieldPage } from "./pageShield";
import { ReportsPage, ScannerPage, TaxPage } from "./pageInsights";
import { SettingsPage, VaultPage } from "./pageVault";
import { parseBankMessage, parseSpokenEntry, type EntryDraft } from "./parseEntry";
import { patchStateAfterMutation, type MutationDetail } from "./optimistic";
import { MODE_SWITCH_TIMEOUT_MS, shouldShowModeSwitchLoading } from "./modeSwitch";
import { AppTour } from "./appTour";
import { InstallButton } from "./pwa";

// `group: "business"` modules are the business money-management tools. In
// the everyday modes (Personal Money, Student / First Salary) they stay
// fully reachable but are visually de-emphasised and grouped under a
// "Business tools" heading; in the business-like modes (Business Money,
// Creator & Freelancer) every module is presented equally. Each mode is a
// completely separate workspace — the nav is shared, the records are not.
// Plain-language labels: what each place IS, in the words a first-time
// user would use — Home, Money in & out, What's due, Savings. The module
// names (Future Lens, Memory Vault…) live on inside their pages.
const NAV: { route: Route; label: string; short: string; icon: string; path: string; group: "core" | "business" }[] = [
  { route: "dashboard", label: "Home", short: "Home", icon: "◉", path: "app/dashboard", group: "core" },
  { route: "money-flow", label: "Money in & out", short: "Money", icon: "≋", path: "app/money-flow", group: "core" },
  { route: "payment-calendar", label: "What's due — calendar", short: "Due", icon: "🗓", path: "app/payment-calendar", group: "core" },
  { route: "savings", label: "Savings goals", short: "Save", icon: "🪙", path: "app/savings", group: "core" },
  { route: "ai-cfo", label: "AI CFO — ask anything", short: "AI CFO", icon: "✦", path: "app/ai-cfo", group: "core" },
  { route: "future-lens", label: "Future forecast", short: "Future", icon: "◎", path: "app/future-lens", group: "core" },
  { route: "what-if-lab", label: "What-if planner", short: "What-if", icon: "⚗", path: "app/what-if-lab", group: "core" },
  { route: "scam-shield", label: "Scam Shield — check a message", short: "Shield", icon: "🛡", path: "app/scam-shield", group: "core" },
  { route: "memory-vault", label: "Notes", short: "Notes", icon: "✎", path: "app/memory-vault", group: "core" },
  { route: "invoices", label: "Invoices", short: "Invoices", icon: "▤", path: "app/invoices", group: "business" },
  { route: "profit-scanner", label: "Find leaks & budgets", short: "Leaks", icon: "⌖", path: "app/profit-scanner", group: "business" },
  { route: "tax", label: "GST & tax", short: "Tax", icon: "§", path: "app/tax", group: "business" },
  { route: "reports", label: "Reports", short: "Reports", icon: "▦", path: "app/reports", group: "business" },
];

function routeFromHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const found = NAV.find((n) => n.path === h);
  if (found) return found.route;
  if (h === "app/settings") return "settings";
  return "dashboard";
}

// ---------------- Welcome / onboarding ----------------

function Welcome({
  notify,
  onDone,
}: {
  notify: (m: string) => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"welcome" | "setup">("welcome");
  const [appMode, setAppMode] = useState<AppMode>("business");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [bizName, setBizName] = useState("");
  const [industry, setIndustry] = useState("");
  const [opening, setOpening] = useState("0");
  const personal = isPersonalLike(appMode);
  const creator = appMode === "creator";
  const defaultSpaceName =
    appMode === "personal" ? "My Money" : appMode === "student" ? "My Student Budget" : "My Creator Studio";

  const finish = useMutation({
    mutationFn: async () => {
      await api.updateBusiness({
        mode: appMode,
        name: personal ? bizName.trim() || defaultSpaceName : bizName,
        industry: personal ? "" : industry,
        country: "India",
        currency: "INR",
        openingBalanceCents: Math.round((parseFloat(opening) || 0) * 100),
        timezone: "Asia/Kolkata",
        ownerName,
        ownerEmail,
        gstRateBp: 1800,
        gstInclusive: true,
        eligibleExpensePct: 60,
        onboarded: true,
      });
    },
    onSuccess: () => {
      notify(
        `Welcome! Your ${MODE_LABELS[appMode]} workspace is ready — it starts empty, with only your own records, and stays completely separate from your other workspaces.`,
      );
      onDone();
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  if (step === "welcome") {
    return (
      <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
        <ParticleField count={20} />
        <div className="glass rise relative w-full max-w-lg rounded-3xl p-7 text-center sm:p-9">
          <GlassOrb size={130} label="₹" sub="The Living Ledger" />
          <h1 className="display-font mt-5 text-[26px] font-semibold tracking-tight">Welcome to Cashflow Genius</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            A financial intelligence universe for your money: a command center, an
            AI CFO grounded in your real numbers, forecasts, what-if simulations,
            invoices, a profit-leak scanner, GST estimates, reports and a memory vault
            — all calculated from one ledger.
          </p>
          <button type="button" className="btn-primary mt-6 w-full px-6 py-3 text-sm" onClick={() => setStep("setup")}>
            Create my workspace
          </button>
          <p className="mt-4 text-xs text-[var(--dim)]">
            This workspace belongs to your account only — it starts empty, and
            nothing in it is ever shared with another account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <ParticleField count={16} />
      <form
        className="glass rise relative w-full max-w-2xl rounded-3xl p-7 sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          finish.mutate();
        }}
      >
        <h1 className="text-xl font-extrabold">
          {personal
            ? appMode === "student"
              ? "Set up your student money"
              : "Set up your everyday money"
            : creator
              ? "Set up your creator workspace"
              : "Set up your business"}
        </h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          First, choose how you'll use Cashflow Genius. Each mode is a completely
          separate workspace with its own records. You can switch any time in
          Settings — switching never moves or deletes a single record.
        </p>
        <div className="mt-5">
          <ModePicker value={appMode} onChange={setAppMode} />
        </div>
        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Your name</span>
            <input className="field" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} aria-label="Your name" placeholder="e.g. Sarya" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Email</span>
            <input className="field" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} aria-label="Your email" placeholder="you@example.com" />
          </label>
          {personal ? (
            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                Name for this space <span className="font-semibold normal-case">(optional)</span>
              </span>
              <input className="field" value={bizName} onChange={(e) => setBizName(e.target.value)} aria-label="Name for this space" placeholder={defaultSpaceName} />
            </label>
          ) : creator ? (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Creator / freelance name</span>
                <input className="field" value={bizName} onChange={(e) => setBizName(e.target.value)} aria-label="Creator or freelance name" placeholder="e.g. Sarya Creates" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">What do you create?</span>
                <input className="field" value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="What you create" placeholder="e.g. YouTube videos & brand content" />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Business name</span>
                <input className="field" value={bizName} onChange={(e) => setBizName(e.target.value)} aria-label="Business name" placeholder="e.g. Sarya Design Studio" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Industry</span>
                <input className="field" value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry" placeholder="e.g. Design services" />
              </label>
            </>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
              {personal ? "Money you have right now (₹)" : "Opening cash balance (₹)"}
            </span>
            <input className="field" type="number" step="1" value={opening} onChange={(e) => setOpening(e.target.value)} aria-label="Opening cash balance in rupees" />
          </label>
        </div>
        <p className="mt-4 text-xs text-[var(--dim)]">
          Defaults: India, INR, Indian numbering. Everything — including this mode —
          can be changed later in Settings.
        </p>
        <button type="submit" className="btn-primary mt-4 w-full px-6 py-3 text-sm" disabled={finish.isPending}>
          {finish.isPending ? "Creating…" : "Start using Cashflow Genius"}
        </button>
        <button type="button" className="btn-ghost mt-3 w-full px-6 py-2.5 text-sm" onClick={() => setStep("welcome")}>
          Back
        </button>
      </form>
    </div>
  );
}

// ---------------- Quick Note ----------------

function QuickNote({
  onClose,
  notify,
}: {
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const noteId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title: "", content: "" });
  latest.current = { title, content };

  const persist = async () => {
    const { title: t, content: c } = latest.current;
    if (!t.trim() && !c.trim()) return;
    setStatus("saving");
    try {
      const res = await api.saveNote({
        id: noteId.current ?? undefined,
        title: t.trim() || "Quick note",
        content: c,
        category: "General",
        tags: "quick-note",
        pinned: false,
        sourceModule: "Quick Note",
      });
      noteId.current = res.id;
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (!title && !content) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persistRef.current(), 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [title, content]);

  return (
    <Modal title="Quick Note" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs font-semibold text-[var(--dim)]" role="status" aria-live="polite">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓ to Memory Vault" : status === "failed" ? "Save failed — your text is still here; press Done to retry." : "Auto-saves to the Memory Vault as you type."}
        </p>
        <label className="block">
          <span className="sr-only">Quick note title</span>
          <input className="field font-bold" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Quick note title" maxLength={200} />
        </label>
        <label className="block">
          <span className="sr-only">Quick note content</span>
          <textarea className="field min-h-32" placeholder="Capture the thought before it moves…" value={content} onChange={(e) => setContent(e.target.value)} aria-label="Quick note content" />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-primary px-5 py-2.5 text-sm"
            onClick={async () => {
              await persist();
              notify("Quick note saved to the Memory Vault.");
              onClose();
            }}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Voice entry (Web Speech API) ----------------
// Voice entry uses the browser's own SpeechRecognition when it exists.
// Support is uneven (Chrome/Android yes; many webviews and Firefox no),
// so the voice tab always offers the same thing typed: type the phrase
// exactly as you'd say it and the same parser builds the draft. Either
// way the result is only a DRAFT — the user reviews/edits it in the
// form and confirms before anything is saved.

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  return ctor ?? null;
}

// ---------------- Quick Add transaction ----------------
// The two-tap path to the ledger: type, amount, category — everything else
// has a sensible default and can be refined later in Money Flow.
// Three entry modes, one draft: Type it, 🎤 say it (voice entry), or
// 📩 paste a bank/UPI message (SMS import). Voice and SMS both parse
// into this same form as an editable draft — never a silent save.

function QuickAdd({
  currency,
  mode,
  state,
  onClose,
  notify,
  onSaved,
}: {
  currency: string;
  mode: AppMode;
  state: State;
  onClose: () => void;
  notify: (m: string) => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<string>(categoriesFor(mode, "expense")[0] ?? "General");
  const [customCategory, setCustomCategory] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayStr());
  const [method, setMethod] = useState<string>("UPI");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Entry mode: type it, say it (voice), or paste a bank/UPI message.
  const [entryTab, setEntryTab] = useState<"type" | "voice" | "sms">("type");
  const [draftNotes, setDraftNotes] = useState<string[] | null>(null);
  const [draftSource, setDraftSource] = useState<string>("");
  const [voiceText, setVoiceText] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [smsText, setSmsText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [speechSupported] = useState<boolean>(() => speechRecognitionCtor() !== null);

  /** Applies a parsed voice/SMS draft to the form and switches back to
   *  the Type tab, where the user reviews and edits it before saving. */
  const applyDraft = (draft: EntryDraft, source: string) => {
    setType(draft.type);
    setAmount(draft.amount);
    setCategory(draft.category);
    setCustomCategory("");
    setDescription(draft.description);
    if (draft.counterparty) {
      // Counterparty has no field in Quick Add; keep it in the
      // description so nothing the parser found is silently dropped.
      setDescription(
        draft.description.toLowerCase().includes(draft.counterparty.toLowerCase())
          ? draft.description
          : `${draft.description}${draft.description ? " — " : ""}${draft.counterparty}`.slice(0, 200),
      );
    }
    setDate(draft.date);
    setMethod(draft.paymentMethod);
    setDraftNotes(draft.notes);
    setDraftSource(source);
    setEntryTab("type");
    setError(null);
  };

  const startListening = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    setVoiceError(null);
    try {
      const rec = new Ctor();
      recognitionRef.current = rec;
      rec.lang = "hi-IN"; // Hinglish/Hindi + English phrases both land well here
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const transcript = e.results[0]?.[0]?.transcript ?? "";
        setListening(false);
        if (transcript.trim()) {
          setVoiceText(transcript);
          applyDraft(parseSpokenEntry(transcript, mode), "🎤 Voice draft");
        }
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => {
        setListening(false);
        setVoiceError("Voice sun nahi paya — dobara try karo, ya neeche phrase type karke draft banao.");
      };
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setVoiceError("Is browser mein voice start nahi hua — neeche phrase type karke draft banao.");
    }
  };

  const isCustom = category === CUSTOM_CATEGORY;
  const effectiveCategory = isCustom ? customCategory.trim() : category;
  // Built-ins for this mode + the custom categories remembered in this
  // workspace (state is scoped to the active workspace by the server).
  const categories = categoryOptionsFor(state, mode, type);

  const pickType = (t: "expense" | "income") => {
    setType(t);
    setCategory(categoriesFor(mode, t)[0] ?? "General");
    setCustomCategory("");
  };

  const save = useMutation({
    mutationFn: async () => {
      const amountCents = Math.round((parseFloat(amount) || 0) * 100);
      if (amountCents <= 0) throw new Error("Enter an amount greater than zero.");
      if (!effectiveCategory) throw new Error("Type your custom category name.");
      return await api.saveTransaction({
        type,
        status: pending ? "pending" : "posted",
        category: effectiveCategory,
        description: description.trim(),
        counterparty: "",
        amountCents,
        date,
        paymentMethod: method,
      });
    },
    onSuccess: (_res, _vars) => {
      const amountCents = Math.round((parseFloat(amount) || 0) * 100);
      notify(
        `${type === "income" ? "Income" : "Expense"} of ${fmtMoney(amountCents, currency)} recorded${pending ? " as pending" : ""}.`,
      );
      onSaved();
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal title="Quick add transaction" onClose={onClose}>
      <div className="mb-4 grid grid-cols-3 gap-1 rounded-full border border-[var(--border)] bg-white p-1" role="group" aria-label="How do you want to add this transaction">
        {(
          [
            { key: "type", label: "⌨️ Type" },
            { key: "voice", label: "🎤 Voice" },
            { key: "sms", label: "📩 SMS import" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={entryTab === t.key}
            onClick={() => setEntryTab(t.key)}
            className={`rounded-full px-2 py-2 text-[13px] font-bold transition ${
              entryTab === t.key ? "bg-[var(--surface-soft)] text-[var(--accent)]" : "text-[var(--dim)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {entryTab === "voice" ? (
        <div className="mb-4 space-y-3 rounded-2xl bg-[var(--surface-soft)] p-4">
          <p className="text-sm font-bold">Bolo, draft ban jayega 🎤</p>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Jaise: <em>“500 rupees kharcha chai”</em> ya <em>“received 5000 from client”</em> ya{" "}
            <em>“kal 18000 rent diya”</em>. Amount, in/out, category aur date hum nikaal lenge —
            phir draft ko check/edit karke hi save hoga. Kuch auto-save nahi hota.
          </p>
          {speechSupported ? (
            <button
              type="button"
              className={`w-full rounded-full px-5 py-3.5 text-sm font-extrabold text-white transition ${
                listening ? "animate-pulse bg-[#e11d63]" : "btn-primary"
              }`}
              onClick={startListening}
              disabled={listening}
              aria-label={listening ? "Listening, speak now" : "Start voice entry"}
            >
              {listening ? "🔴 Sun raha hoon… bolo" : "🎤 Tap & speak"}
            </button>
          ) : (
            <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]" role="status">
              Is browser mein voice recognition available nahi hai (Chrome/Android mein aata hai).
              Koi baat nahi — neeche wahi phrase type kar do, draft waise hi ban jayega. Yehi voice entry ka typing fallback hai.
            </p>
          )}
          {voiceError ? (
            <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-xs font-semibold text-[var(--err-text)]" role="alert">{voiceError}</p>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
              {speechSupported ? "Ya phrase yahan type karo" : "Phrase yahan type karo"}
            </span>
            <input
              className="field"
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              aria-label="Type the phrase you would say"
              placeholder="e.g. 500 rupees kharcha chai"
              maxLength={300}
            />
          </label>
          <button
            type="button"
            className="btn-primary w-full px-5 py-2.5 text-sm"
            disabled={voiceText.trim().length < 3}
            onClick={() => applyDraft(parseSpokenEntry(voiceText, mode), "🎤 Voice draft")}
          >
            Make draft from this phrase →
          </button>
          <p className="text-[11px] leading-relaxed text-[var(--dim)]">
            Draft sirf is workspace ({mode === "personal" ? "Personal Money" : mode === "creator" ? "Creator & Freelancer" : mode === "student" ? "Student / First Salary" : "Business Money"}) mein banta hai — doosre workspace mein kuch nahi jata.
          </p>
        </div>
      ) : null}

      {entryTab === "sms" ? (
        <div className="mb-4 space-y-3 rounded-2xl bg-[var(--surface-soft)] p-4">
          <p className="text-sm font-bold">Bank / UPI message paste karo 📩</p>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Bank SMS ya UPI message yahan paste karo — amount, merchant, in/out, date aur UPI
            reference nikaal ke draft ban jayega. <strong className="text-[var(--text)]">Kuch bhi auto-save nahi hoga</strong> —
            pehle draft check/edit karo, phir save.
          </p>
          <label className="block">
            <span className="sr-only">Paste the bank or UPI message</span>
            <textarea
              className="field min-h-24"
              value={smsText}
              onChange={(e) => setSmsText(e.target.value)}
              aria-label="Paste the bank or UPI message"
              placeholder="e.g. Rs 1,250.00 debited from A/c **1234 on 13-Nov-26 at SWIGGY. UPI Ref No 612345678901. …"
              maxLength={3000}
            />
          </label>
          <button
            type="button"
            className="btn-primary w-full px-5 py-2.5 text-sm"
            disabled={smsText.trim().length < 8}
            onClick={() => applyDraft(parseBankMessage(smsText, mode), "📩 SMS draft")}
          >
            Make draft from this message →
          </button>
          <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]">
            ⚠️ Pasted message kabhi payment ka proof nahi hota. Save karne se pehle apne bank/UPI
            app mein transaction aur UTR khud verify karo — Scam Shield (menu mein) suspicious
            messages ko check bhi karta hai.
          </p>
        </div>
      ) : null}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        {draftNotes ? (
          <div className="rounded-2xl border border-[var(--accent)]/30 bg-[var(--ai)] px-3.5 py-3" role="status">
            <p className="text-sm font-extrabold text-[var(--ai-text)]">{draftSource} — check &amp; edit, then record</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--ai-text)]">
              Neeche ke fields draft se bhare hain. Galat lage to yahin badal do — save tabhi hoga jab tum Record dabaaoge.
            </p>
            {draftNotes.length > 0 ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-[var(--ai-text)]">
                {draftNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Transaction type">
          {(["expense", "income"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              onClick={() => pickType(t)}
              className={`rounded-2xl px-4 py-3 text-sm font-extrabold capitalize transition ${
                type === t
                  ? t === "income"
                    ? "bg-[var(--accent)] text-white shadow-[0_8px_20px_rgba(124,58,237,0.28)]"
                    : "bg-[#e11d63] text-white shadow-[0_8px_20px_rgba(176,82,76,0.25)]"
                  : "bg-[var(--surface-soft)] text-[var(--dim)]"
              }`}
            >
              {t === "income" ? "↓ Money in" : "↑ Money out"}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
            Amount ({currency})
          </span>
          <input
            className="field tnum text-lg font-bold"
            type="number"
            inputMode="decimal"
            step="1"
            min="0"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount"
            autoFocus
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Category</span>
            <CategorySelect options={categories} value={category} onChange={setCategory} ariaLabel="Category" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Date</span>
            <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" required />
          </label>
        </div>
        {isCustom ? (
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Your custom category</span>
            <input
              className="field"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              aria-label="Custom category name"
              placeholder="Type your own category, e.g. Pet care"
              maxLength={60}
              autoFocus
            />
            <span className="mt-1 block text-xs font-semibold normal-case tracking-normal text-[var(--dim)]">
              It will be saved with this transaction and remembered in this workspace's list.
            </span>
          </label>
        ) : null}
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
            Description <span className="font-semibold normal-case">(optional)</span>
          </span>
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Description"
            placeholder={
              isPersonalLike(mode)
                ? type === "income"
                  ? "e.g. Salary credited"
                  : "e.g. Groceries"
                : type === "income"
                  ? "e.g. Client payment"
                  : "e.g. Office supplies"
            }
            maxLength={200}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Paid via</span>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {effectiveCategory === "Refunds" ? (
            <span className="mt-1 block text-xs font-semibold normal-case tracking-normal text-[var(--dim)]">
              A refund is recorded once, as Refunds money-in: it offsets the original expense in your net figures and is never double-counted. Leave the original expense as it is.
            </span>
          ) : null}
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[#7c3aed]"
            checked={pending}
            onChange={(e) => setPending(e.target.checked)}
            aria-label="Mark as pending, not yet settled"
          />
          Pending — money hasn’t moved yet
        </label>
        {error ? (
          <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn-primary w-full px-6 py-3.5 text-sm" disabled={save.isPending}>
          {save.isPending ? "Recording…" : `Record ${type === "income" ? "income" : "expense"}`}
        </button>
        <p className="text-center text-xs text-[var(--dim)]">
          Need counterparty, recurring schedules or CSV import? Money Flow has the full form.
        </p>
      </form>
    </Modal>
  );
}

// ---------------- App ----------------

type Gate = "home" | "login" | "signup" | "verify" | "forgot";

export function App() {
  const queryClient = useQueryClient();
  // staleTime keeps module-hopping instant: within 30s the cached state is
  // reused instead of refetching the whole ledger on every navigation or
  // window refocus. Freshness after the user's own edits does NOT rely
  // on this expiring: every successful mutation dispatches a
  // "cg:mutated" event from the API client (see client/api.ts), and
  // the listener below handles it in three steps, in order:
  //   1. Patch the cached ["cg-state"] optimistically from the
  //      mutation's own arguments + response (client/optimistic.ts),
  //      so the list on screen changes in the same tick as the toast.
  //      (Invalidation alone was not enough: the refetch re-runs the
  //      whole getState ledger, ~15–20s on a live cold start, so every
  //      save looked stale until a reload.)
  //   2. Cancel any getState fetch already in flight — it was started
  //      before the mutation, so its snapshot predates the save and
  //      would overwrite the patch when it lands; cancelling also
  //      means the fresh fetch starts now instead of after the stale
  //      one finishes.
  //   3. Invalidate the state queries so the server reconciliation
  //      refetch runs and corrects anything the patch got wrong.
  //
  //   Mode switches get one more step (client/modeSwitch.ts): the
  //   setMode patch clears the old workspace's lists, so until the
  //   refetch lands the cached state holds EMPTY lists under the new
  //   mode's name — and the pages would render their empty states
  //   ("Your universe is empty") for a workspace that actually has
  //   records. So the switch target is remembered here, and while it
  //   is pending the app renders an honest "Loading …" skeleton
  //   instead of the pages (see the render branch below). The gate
  //   clears as soon as the refetch lands with the new mode's data.
  const [switchingTo, setSwitchingTo] = useState<AppMode | null>(null);
  useEffect(() => {
    const onMutated = (e: Event) => {
      const detail = (e as CustomEvent<MutationDetail>).detail;
      if (detail) {
        if (detail.action === "setMode") {
          const m = detail.args.mode;
          if (typeof m === "string" && (APP_MODES as readonly string[]).includes(m)) {
            setSwitchingTo(m as AppMode);
          }
        }
        queryClient.setQueryData(["cg-state"], (old: State | undefined) =>
          patchStateAfterMutation(old, detail),
        );
      }
      void (async () => {
        await queryClient.cancelQueries({ queryKey: ["cg-state"] });
        await queryClient.cancelQueries({ queryKey: ["cg-combined"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
        void queryClient.invalidateQueries({ queryKey: ["cg-combined"] });
        void queryClient.invalidateQueries({ queryKey: ["note-versions"] });
      })();
    };
    window.addEventListener("cg:mutated", onMutated);
    return () => window.removeEventListener("cg:mutated", onMutated);
  }, [queryClient]);
  // Bounded: if the session check stalls (gateway cold start, the
  // shell credential-refresh handshake, a dropped mobile connection),
  // the query errors and the app lands on the sign-in screens — where
  // the stored token still gets its chance on the next load — instead
  // of sitting on the "Checking your session…" skeleton forever.
  const authQ = useQuery({
    queryKey: ["cg-auth"],
    queryFn: () =>
      withTimeout(
        api.authStatus({}),
        25_000,
        "The session check took too long — please try again.",
      ),
    staleTime: 30_000,
  });
  const authed = authQ.data?.authenticated === true;
  const stateQ = useQuery({
    queryKey: ["cg-state"],
    queryFn: () => api.getState({}),
    enabled: authed,
    retry: false,
    staleTime: 30_000,
  });
  const [gate, setGate] = useState<Gate>("home");
  const [pendingId, setPendingId] = useState("");
  const [route, setRoute] = useState<Route>(() =>
    typeof window !== "undefined" ? routeFromHash() : "dashboard",
  );
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  // Onboarding app tour: opened from Settings / Home / the More sheet
  // any time, and auto-opened once for a brand-new account right after
  // its first workspace setup (see the effect below) unless the
  // account has already dismissed it for good.
  const [tourOpen, setTourOpen] = useState(false);
  const [justOnboarded, setJustOnboarded] = useState(false);
  // Calculator visibility only — the panel itself stays mounted (and
  // keeps its expression, result and history) for the whole session.
  const [calcOpen, setCalcOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  // Confirmation dialog + toast/undo snackbar (safety.tsx). Every
  // delete in the app goes through confirm() first and reports back
  // through notifyDeleted(), whose Undo button restores the exact
  // server-side snapshot of what was deleted.
  const {
    confirmState,
    resolveConfirm,
    toast,
    setToast,
    notify,
    notifyDeleted,
    confirm,
    undo: undoDelete,
  } = useSafety(() => {
    void stateQ.refetch();
  });
  const [introDone, setIntroDone] = useState<boolean>(() => {
    try {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      return reduced || sessionStorage.getItem("cg_intro_done") === "1";
    } catch {
      return true;
    }
  });

  const finishIntro = () => {
    try {
      sessionStorage.setItem("cg_intro_done", "1");
    } catch {
      /* private mode */
    }
    setIntroDone(true);
  };

  const onAuthed = () => {
    // Cancel any auth-status fetch already in flight before refetching:
    // such a fetch started before the new session token was stored, so it
    // carries no token and would answer "not signed in" — and React Query
    // can hand that in-flight result to refetch() instead of starting a
    // fresh request, leaving the app stuck on the homepage/login screen
    // after a successful sign-in. Cancelling first forces the
    // refetch to run with the token that was just stored.
    void (async () => {
      await queryClient.cancelQueries({ queryKey: ["cg-auth"] });
      await authQ.refetch();
      await queryClient.invalidateQueries({ queryKey: ["cg-state"] });
    })();
  };

  // ---- Google sign-in return (Supabase Auth OAuth callback) ----
  // When Supabase redirects the browser back here after Google, the
  // URL carries an auth code (PKCE), an access token (implicit) or an
  // error. That is completed exactly once, before anything else
  // renders: the code/token is exchanged and verified by the server
  // (googleSignIn action), the app's own session token is stored,
  // and the user lands in the Command Center — a brand-new Google
  // user in their own, completely empty workspace.
  const [googleBusy, setGoogleBusy] = useState<boolean>(() => {
    try {
      return hasGoogleCallback();
    } catch {
      return false;
    }
  });
  const googleHandledRef = useRef(false);
  const onAuthedRef = useRef(onAuthed);
  onAuthedRef.current = onAuthed;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    if (googleHandledRef.current) return;
    googleHandledRef.current = true;
    if (!googleBusy) return;
    void (async () => {
      const result = await completeGoogleCallback();
      if (result.status === "ok") {
        setAuthToken(result.token);
        notifyRef.current(
          result.method === "google"
            ? "Signed in with Google — welcome to Cashflow Genius."
            : "Email confirmed — you're signed in. Welcome to Cashflow Genius.",
        );
        onAuthedRef.current();
      } else if (result.status === "error") {
        notifyRef.current(result.message);
      }
      setGoogleBusy(false);
    })();
  }, [googleBusy]);

  const logout = async () => {
    try {
      await api.logout({});
    } catch {
      /* session already gone */
    }
    setAuthToken(null);
    // The cursor choice is per account and stays saved on the server;
    // locally we fall back to the default so the next account (or a
    // signed-out visitor) never inherits this account's cursor.
    applyCursorStyle(DEFAULT_CURSOR_STYLE);
    queryClient.removeQueries({ queryKey: ["cg-state"] });
    setGate("home");
    await authQ.refetch();
    notify("You've been logged out. Your records stay saved to your account.");
  };
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (r: Route) => {
    const item = NAV.find((n) => n.route === r);
    window.location.hash = r === "settings" ? "app/settings" : (item?.path ?? "app/dashboard");
    setRoute(r);
    setMoreOpen(false);
    window.scrollTo({ top: 0 });
  };

  const saveToVault = async (title: string, content: string, sourceModule: string) => {
    try {
      await api.saveNote({
        title,
        content,
        category: "Financial Plans",
        tags: "",
        pinned: false,
        sourceModule,
      });
      await stateQ.refetch();
      notify("Saved to the Memory Vault.");
    } catch (e) {
      notify(`Could not save to the vault: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const currencyMut = useMutation({
    mutationFn: (currency: string) =>
      api.updateBusiness({ ...stateQ.data!.business, currency }),
    onSuccess: () => {
      void stateQ.refetch();
      notify("Currency updated.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const modeMut = useMutation({
    mutationFn: (m: AppMode) => api.setMode({ mode: m }),
    onSuccess: (_res, m) => {
      void stateQ.refetch();
      notify(
        `Switched to ${MODE_LABELS[m]} — a completely separate workspace with its own records. Nothing was moved, mixed or deleted.`,
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  // Switching workspace is a big step — it changes everything on
  // screen — so it always asks first and says plainly what happens.
  const requestModeSwitch = async (m: AppMode) => {
    const current = stateQ.data;
    if (!current || m === modeOf(current)) return;
    const ok = await confirm({
      title: `Switch to ${MODE_LABELS[m]}?`,
      body: `You will now see the ${MODE_LABELS[m]} workspace — its own transactions, budgets, savings and notes.`,
      detail: `Your current workspace (${MODE_LABELS[modeOf(current)]}) stays saved exactly as it is. Switching never moves, merges or deletes any record.`,
      confirmLabel: `Switch to ${MODE_LABELS[m]}`,
    });
    if (ok) modeMut.mutate(m);
  };

  const state = stateQ.data;
  // Mode-switch gate: clear the pending switch as soon as the
  // refetch has landed with the new mode's data (or errored, so the
  // error screen shows instead of the skeleton). A safety timeout
  // clears it anyway if the refetch never settles.
  useEffect(() => {
    if (!switchingTo) return;
    if (stateQ.isError) {
      setSwitchingTo(null);
      return;
    }
    if (state && modeOf(state) === switchingTo && !stateQ.isFetching) {
      setSwitchingTo(null);
    }
  }, [switchingTo, state, stateQ.isFetching, stateQ.isError]);
  useEffect(() => {
    if (!switchingTo) return;
    const t = setTimeout(() => setSwitchingTo(null), MODE_SWITCH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [switchingTo]);
  // Cursor style: the account's saved choice (from getState) is the
  // source of truth. As soon as it loads — and whenever it changes in
  // Settings — it is applied across the whole app immediately, with no
  // reload. Before sign-in the default Blue Particle shows.
  const savedCursorStyle = state?.cursorStyle;
  useEffect(() => {
    if (savedCursorStyle) applyCursorStyle(savedCursorStyle);
  }, [savedCursorStyle]);

  // Auto-open the app tour exactly once, for a brand-new account: the
  // Welcome setup just finished in this session (justOnboarded) and the
  // account has never finished/dismissed the tour. Existing accounts
  // never get it uninvited — they open it from Settings when they want.
  const tourDismissed = state?.tourDismissed === true;
  const onboardedNow = state?.business.onboarded === true;
  useEffect(() => {
    if (justOnboarded && onboardedNow && !tourDismissed) {
      setJustOnboarded(false);
      setTourOpen(true);
    }
  }, [justOnboarded, onboardedNow, tourDismissed]);

  // Closing the tour: finishing it, or closing with “Don't show this
  // tour again” ticked, saves the dismissal on the account so it never
  // auto-opens again. A plain skip leaves the preference untouched.
  const closeTour = (dontShowAgain: boolean) => {
    setTourOpen(false);
    if (dontShowAgain && !tourDismissed) {
      void api
        .dismissTour({})
        .then(() => void stateQ.refetch())
        .catch(() => {
          /* preference save failed — the tour simply stays re-openable */
        });
    }
  };

  // Premium motion — global, animation-only effects for every page:
  // (1) scroll reveals for any .reveal element (anim.tsx Reveal), and
  // (2) a subtle magnetic pull on primary CTAs, desktop fine-pointer
  // only. Both are disabled for reduced-motion and touch, use a
  // single listener/observer, and never change layout or behaviour.
  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch { /* keep animations */ }
    if (reduced) {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-revealed"));
      return;
    }
    // Scroll reveal observer (covers Reveal elements added by any page)
    let revealCleanup: (() => void) | undefined;
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-revealed");
              io?.unobserve(e.target);
            }
          }
        },
        { threshold: 0.08, rootMargin: "0px 0px -24px 0px" },
      );
      const scan = () => document.querySelectorAll(".reveal:not(.is-revealed)").forEach((el) => io?.observe(el));
      scan();
      const mo = new MutationObserver(() => scan());
      mo.observe(document.body, { childList: true, subtree: true });
      revealCleanup = () => { io?.disconnect(); mo.disconnect(); };
    }
    // Magnetic primary buttons — at most 3px toward the cursor
    const fine = (() => { try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch { return false; } })();
    if (!fine) return revealCleanup;
    let raf = 0;
    let current: HTMLElement | null = null;
    const onDown = (e: PointerEvent) => {
      // Press feedback wins over magnetism: clear the inline magnetic
      // transform the moment any primary button is pressed so the
      // stylesheet's :active press-scale is never suppressed.
      const target = (e.target as HTMLElement | null)?.closest?.(".btn-primary, .magnetic") as HTMLElement | null;
      if (target) target.style.transform = "";
      if (current) current.style.transform = "";
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (e.buttons > 0) return; // dragging/pressing — no magnetic pull
      const target = (e.target as HTMLElement | null)?.closest?.(".btn-primary, .magnetic") as HTMLElement | null;
      if (target !== current) {
        if (current) current.style.removeProperty("--mag-x");
        if (current) current.style.transform = "";
        current = target;
      }
      if (!target) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const x = e.clientX - (rect.left + rect.width / 2);
        const y = e.clientY - (rect.top + rect.height / 2);
        const tx = Math.max(-3, Math.min(3, x * 0.045));
        const ty = Math.max(-2.5, Math.min(2.5, y * 0.06));
        // Preserve existing active scale by composing only when not pressed
        if (!target.matches(":active")) target.style.transform = `translate(${tx}px, ${ty}px)`;
      });
    };
    const onLeave = () => { if (current) { current.style.transform = ""; current = null; } };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
      if (revealCleanup) revealCleanup();
    };
  }, [route, authed]);
  const alerts = useMemo(() => {
    if (!state) return [];
    const out: string[] = [];
    const overdue = state.invoices.filter((i) => i.effectiveStatus === "overdue");
    if (overdue.length > 0) {
      out.push(
        `${overdue.length} invoice(s) overdue totalling ${fmtMoney(overdue.reduce((a, i) => a + i.totalCents, 0), state.business.currency)}.`,
      );
    }
    const dueSoon = state.invoices.filter(
      (i) => i.status === "sent" && i.effectiveStatus !== "overdue",
    );
    if (dueSoon.length > 0) out.push(`${dueSoon.length} sent invoice(s) awaiting payment.`);
    const pending = state.transactions.filter((t) => t.status === "pending");
    if (pending.length > 0) out.push(`${pending.length} pending transaction(s) recorded.`);
    const overdueEmi = state.emiPlans.flatMap((p) =>
      p.instalments.filter((i) => i.effectiveStatus === "overdue"),
    );
    if (overdueEmi.length > 0) {
      out.push(
        `${overdueEmi.length} EMI instalment(s) overdue totalling ${fmtMoney(overdueEmi.reduce((a, i) => a + i.amountCents, 0), state.business.currency)} — see the Payment Calendar.`,
      );
    }
    if (out.length === 0) out.push("No alerts — nothing overdue or pending right now.");
    return out;
  }, [state]);

  const searchResults = useMemo(() => {
    if (!state || search.trim().length < 2) return null;
    const q = search.toLowerCase();
    return {
      notes: state.notes.filter((n) => `${n.title} ${n.content}`.toLowerCase().includes(q)).slice(0, 4),
      txns: state.transactions.filter((t) => `${t.description} ${t.counterparty} ${t.category}`.toLowerCase().includes(q)).slice(0, 4),
      invs: state.invoices.filter((i) => `${i.number} ${i.customerName}`.toLowerCase().includes(q)).slice(0, 4),
    };
  }, [state, search]);

  if (googleBusy) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] px-4 py-8" aria-busy="true" aria-label="Completing your Google sign-in">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto max-w-lg space-y-4">
          <div className="skeleton mx-auto h-32 w-32 !rounded-full" />
          <div className="skeleton mx-auto h-6 w-56" />
          <div className="skeleton mx-auto h-4 w-72 max-w-full" />
          <div className="skeleton h-12 w-full !rounded-full" />
          <p className="text-center text-sm font-semibold text-[var(--dim)]">
            Completing your Google sign-in — verifying with Supabase and opening your workspace…
          </p>
        </div>
      </div>
    );
  }

  if (!introDone) {
    return (
      <>
        <SafeAreaTopScrim backgroundColor="#F6F3FF" />
        <CinematicIntro onDone={finishIntro} />
      </>
    );
  }

  if (authQ.isPending) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] px-4 py-8" aria-busy="true" aria-label="Checking your session">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto max-w-lg space-y-4">
          <div className="skeleton mx-auto h-32 w-32 !rounded-full" />
          <div className="skeleton mx-auto h-6 w-56" />
          <div className="skeleton mx-auto h-4 w-72 max-w-full" />
          <div className="skeleton h-12 w-full !rounded-full" />
          <p className="text-center text-sm font-semibold text-[var(--dim)]">Checking your session…</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-dvh bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        {gate === "home" ? (
          <PublicHome
            onLogin={() => setGate("login")}
            onSignup={() => setGate("signup")}
            notify={notify}
          />
        ) : gate === "login" ? (
          <LoginScreen
            notify={notify}
            onAuthed={onAuthed}
            onSignup={() => setGate("signup")}
            onForgot={(id) => {
              setPendingId(id);
              setGate("forgot");
            }}
            onNeedsVerify={(id) => {
              setPendingId(id);
              setGate("verify");
            }}
            onHome={() => setGate("home")}
          />
        ) : gate === "signup" ? (
          <SignupScreen
            notify={notify}
            onVerify={(id) => {
              setPendingId(id);
              setGate("verify");
            }}
            onLogin={() => setGate("login")}
            onHome={() => setGate("home")}
          />
        ) : gate === "verify" ? (
          <VerifyScreen
            identifier={pendingId}
            notify={notify}
            onAuthed={onAuthed}
            onLogin={() => setGate("login")}
          />
        ) : (
          <ForgotScreen
            initialIdentifier={pendingId}
            onLogin={() => setGate("login")}
          />
        )}
        {toast ? <UndoToast toast={toast} onUndo={() => void undoDelete()} onClose={() => setToast(null)} /> : null}
      </div>
    );
  }

  if (stateQ.isPending) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] px-4 py-6" aria-busy="true" aria-label="Loading your ledger">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="skeleton h-40 w-full !rounded-3xl" />
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <div className="skeleton h-24" />
            <div className="skeleton h-24" />
            <div className="skeleton h-24 hidden xl:block" />
            <div className="skeleton h-24 hidden xl:block" />
          </div>
          <div className="skeleton h-64 w-full !rounded-3xl" />
          <p className="text-center text-sm font-semibold text-[var(--dim)]">Loading your ledger…</p>
        </div>
      </div>
    );
  }
  // Mode-switch gate (client/modeSwitch.ts): while the new
  // workspace's refetch is in flight, the cached state holds the
  // deliberately cleared lists — render a loading skeleton, never
  // the pages, so a workspace with records is never shown as empty.
  // The empty states only render once a completed fetch actually
  // returned zero records (the gate is already clear by then).
  const showModeSwitchLoading = shouldShowModeSwitchLoading({
    switchingTo,
    activeMode: state ? modeOf(state) : null,
    isFetching: stateQ.isFetching,
    isError: stateQ.isError,
  });
  if (showModeSwitchLoading && switchingTo) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] px-4 py-6" aria-busy="true" aria-label={`Loading ${MODE_LABELS[switchingTo]}`}>
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="skeleton h-40 w-full !rounded-3xl" />
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <div className="skeleton h-24" />
            <div className="skeleton h-24" />
            <div className="skeleton h-24 hidden xl:block" />
            <div className="skeleton h-24 hidden xl:block" />
          </div>
          <div className="skeleton h-64 w-full !rounded-3xl" />
          <p className="text-center text-sm font-semibold text-[var(--dim)]">Loading {MODE_LABELS[switchingTo]}…</p>
        </div>
      </div>
    );
  }
  if (stateQ.isError || !state) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--bg)] px-4">
        <div className="card max-w-md p-6 text-center">
          <p className="font-extrabold">Your workspace could not be loaded</p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            {stateQ.error instanceof Error ? stateQ.error.message : "A network problem interrupted loading."}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" className="btn-primary px-6 py-2.5 text-sm" onClick={() => stateQ.refetch()}>
              Try again
            </button>
            <button type="button" className="btn-ghost px-6 py-2.5 text-sm" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!state.business.onboarded) {
    return (
      <div className="min-h-dvh bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <Welcome
          notify={notify}
          onDone={() => {
            setJustOnboarded(true);
            void stateQ.refetch();
          }}
        />
        {toast ? <UndoToast toast={toast} onUndo={() => void undoDelete()} onClose={() => setToast(null)} /> : null}
      </div>
    );
  }

  const appMode = modeOf(state);
  const personal = isPersonalLike(appMode);

  const pageProps = {
    state,
    go,
    notify,
    notifyDeleted,
    confirm,
    saveToVault,
    openNoteId,
    onQuickAdd: () => setQuickAddOpen(true),
    onShowTour: () => setTourOpen(true),
  };
  const initials = (state.business.ownerName || state.business.name || "CG")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Sidebar (desktop) */}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-[var(--border)] bg-white/85 backdrop-blur-md transition-all lg:flex ${
          collapsed ? "w-[76px]" : "w-[264px]"
        }`}
        aria-label="Main navigation"
      >
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-lg font-extrabold text-[#fbf7ea] shadow-[0_8px_18px_rgba(124,58,237,0.3)]">
            ₹
          </span>
          {!collapsed ? (
            <span className="min-w-0">
              <span className="display-font block truncate text-[15px] font-semibold tracking-wide">
                Cashflow Genius
              </span>
              <span className="block truncate text-xs text-[var(--dim)]">
                {state.business.name || "The Living Ledger"}
              </span>
            </span>
          ) : null}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
          {NAV.map((n, i) => {
            const deemph = personal && n.group === "business";
            const showBizHeading =
              !collapsed && n.group === "business" && NAV[i - 1]?.group !== "business";
            return (
              <div key={n.route}>
                {showBizHeading ? (
                  <p className="px-3 pb-1 pt-4 text-[10px] font-extrabold uppercase tracking-widest text-[var(--dim)]">
                    Business tools
                  </p>
                ) : null}
                <button
                  type="button"
                  aria-current={route === n.route ? "page" : undefined}
                  title={n.label}
                  onClick={() => go(n.route)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-bold transition ${
                    route === n.route
                      ? "bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-white shadow-[0_8px_18px_rgba(124,58,237,0.25)]"
                      : "text-[var(--dim)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)]"
                  } ${deemph ? "opacity-70" : ""}`}
                >
                  <span aria-hidden className="w-5 text-center text-base">{n.icon}</span>
                  {!collapsed ? (
                    <>
                      <span className="flex-1">{n.label}</span>
                      {deemph ? (
                        <span className="rounded-full bg-[var(--surface-soft)] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-[var(--dim)]">
                          Business
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            aria-current={route === "settings" ? "page" : undefined}
            title="Settings"
            onClick={() => go("settings")}
            className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-bold transition ${
              route === "settings"
                ? "bg-[var(--surface-soft)] text-[var(--accent)]"
                : "text-[var(--dim)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)]"
            }`}
          >
            <span aria-hidden className="w-5 text-center text-base">⚙</span>
            {!collapsed ? <span className="flex-1">Settings</span> : null}
          </button>
          {/* Calculator toggle — in the side panel, available on every
              page. The panel stays mounted when closed, so a result is
              never lost while working elsewhere in the app. */}
          <button
            type="button"
            aria-expanded={calcOpen}
            aria-label={calcOpen ? "Close calculator" : "Open calculator"}
            title="Calculator"
            onClick={() => setCalcOpen((o) => !o)}
            className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-bold transition ${
              calcOpen
                ? "bg-[var(--surface-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--border)]"
                : "text-[var(--dim)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)]"
            }`}
          >
            <span aria-hidden className="w-5 text-center text-base">🧮</span>
            {!collapsed ? <span className="flex-1">Calculator</span> : null}
            {!collapsed ? (
              <span className="text-[10px] font-extrabold text-[var(--dim)]">{calcOpen ? "ON" : ""}</span>
            ) : null}
          </button>
        </nav>
        <div className="px-3 pb-5">
          <button
            type="button"
            className="btn-ghost mb-2 w-full px-3 py-2 text-xs"
            aria-label={`Log out of your account${state.authUser?.identifier ? ` (${state.authUser.identifier})` : ""}`}
            title={state.authUser?.identifier ?? "Log out"}
            onClick={() => void logout()}
          >
            {collapsed ? "⎋" : "⎋ Log out"}
          </button>
          <button
            type="button"
            className="btn-ghost w-full px-3 py-2 text-xs"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "»" : "« Collapse"}
          </button>
          {!collapsed ? (
            <p className="mt-3 px-1 text-center text-[11px] italic text-[var(--dim)]">
              “See money before it moves.”
            </p>
          ) : null}
        </div>
      </aside>

      {/* Top bar */}
      <header
        className={`no-print sticky top-0 z-30 border-b border-[var(--border)] bg-[rgba(246,243,255,0.88)] backdrop-blur-md ${
          collapsed ? "lg:ml-[76px]" : "lg:ml-[264px]"
        }`}
      >
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] font-extrabold text-[#fbf7ea] lg:hidden">
            ₹
          </span>
          <div className="relative min-w-0 flex-1">
            <label className="sr-only" htmlFor="global-search">Global search</label>
            <input
              id="global-search"
              className="field"
              placeholder="Search notes, transactions, invoices…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {searchResults ? (
              <div className="glass pop absolute inset-x-0 top-full z-40 mt-2 rounded-2xl p-2">
                {searchResults.notes.length + searchResults.txns.length + searchResults.invs.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-[var(--dim)]">No matches for “{search}”.</p>
                ) : (
                  <>
                    {searchResults.notes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--surface-soft)]"
                        onClick={() => {
                          setOpenNoteId(n.id);
                          setSearch("");
                          go("memory-vault");
                        }}
                      >
                        ✎ <strong>{n.title}</strong> <span className="text-[var(--dim)]">· Memory Vault</span>
                      </button>
                    ))}
                    {searchResults.txns.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--surface-soft)]"
                        onClick={() => {
                          setSearch("");
                          go("money-flow");
                        }}
                      >
                        ≋ {t.description || t.category} <span className="text-[var(--dim)]">· {fmtMoney(t.amountCents, state.business.currency)} · Money Flow</span>
                      </button>
                    ))}
                    {searchResults.invs.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--surface-soft)]"
                        onClick={() => {
                          setSearch("");
                          go("invoices");
                        }}
                      >
                        ▤ {i.number} — {i.customerName} <span className="text-[var(--dim)]">· Invoices</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="relative">
            <button
              type="button"
              className="btn-ghost relative flex h-10 w-10 items-center justify-center text-lg"
              aria-label={`Notifications: ${alerts.length} item(s)`}
              aria-expanded={bellOpen}
              onClick={() => setBellOpen((o) => !o)}
            >
              🔔
              {state.invoices.some((i) => i.effectiveStatus === "overdue") ? (
                <span aria-hidden className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-[#f43f5e]" />
              ) : null}
            </button>
            {bellOpen ? (
              <div className="glass pop absolute left-1/2 top-full z-40 mt-2 max-h-[70vh] w-72 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 overflow-y-auto rounded-2xl p-3 min-[420px]:left-auto min-[420px]:right-0 min-[420px]:translate-x-0">
                <p className="mb-1 px-1 text-sm font-extrabold">Notifications</p>
                <ul className="space-y-1">
                  {alerts.map((a, i) => (
                    <li key={i} className="rounded-xl px-2 py-1.5 text-sm text-[var(--dim)]">{a}</li>
                  ))}
                </ul>
                <button type="button" className="btn-ghost mt-2 w-full px-3 py-1.5 text-xs" onClick={() => setBellOpen(false)}>
                  Close
                </button>
              </div>
            ) : null}
          </div>
          <label className="hidden sm:block">
            <span className="sr-only">Currency</span>
            <select
              className="field w-[92px]"
              value={state.business.currency}
              aria-label="Currency selector"
              onChange={(e) => currencyMut.mutate(e.target.value)}
            >
              {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-ghost hidden max-w-[150px] shrink-0 truncate px-3 py-2 text-xs sm:block sm:max-w-none"
            aria-label={`Workspace: ${MODE_LABELS[appMode]}. Change workspace in Settings`}
            title="Change workspace in Settings"
            onClick={() => go("settings")}
          >
            {MODE_ICONS[appMode]} {MODE_LABELS[appMode]}
          </button>
          <button
            type="button"
            className="btn-primary flex shrink-0 items-center gap-1 px-3.5 py-2 text-sm sm:px-4"
            aria-label="Quick add a transaction"
            onClick={() => setQuickAddOpen(true)}
          >
            <span aria-hidden className="text-base leading-none">＋</span>
            <span className="hidden md:inline">Add</span>
          </button>
          <button
            type="button"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg transition ${
              calcOpen ? "bg-[var(--accent)] text-white" : "btn-ghost"
            }`}
            aria-label={calcOpen ? "Close calculator" : "Open calculator"}
            aria-expanded={calcOpen}
            title="Calculator"
            onClick={() => setCalcOpen((o) => !o)}
          >
            <span aria-hidden>🧮</span>
          </button>
          <button
            type="button"
            className="btn-primary hidden px-4 py-2 text-sm md:block"
            onClick={() => setQuickOpen(true)}
          >
            ✎ Quick Note
          </button>
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-extrabold text-white"
            aria-label={`Profile and business settings for ${state.business.name || "your business"}`}
            title={state.business.name || "Your business"}
            onClick={() => go("settings")}
          >
            {initials}
          </button>
        </div>
      </header>

      {/* One-tap workspace switcher: Personal and Business (and Creator /
          Student) can be used together — both stay saved at the same time,
          each with its own records. Switching only opens the other
          workspace; it never moves, merges or deletes anything. The
          Command Center shows both totals side by side plus a combined
          overview. */}
      <div className={`${collapsed ? "lg:ml-[76px]" : "lg:ml-[264px]"} no-print border-b border-[var(--border)] bg-white/70`}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <span className="w-full text-[11px] font-extrabold uppercase tracking-wide text-[var(--dim)] sm:w-auto">
            Your workspace — switch anytime, both stay saved:
          </span>
          <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:flex-1 sm:flex-wrap" role="group" aria-label="Switch workspace in one tap">
            {APP_MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={m === appMode}
                disabled={modeMut.isPending}
                onClick={() => {
                  if (m !== appMode) void requestModeSwitch(m);
                }}
                className={`rounded-full px-3 py-2 text-xs font-bold transition ${
                  m === appMode
                    ? "bg-[var(--accent)] text-white shadow-[0_6px_16px_rgba(124,58,237,0.24)]"
                    : "bg-[var(--surface-soft)] text-[var(--dim)] hover:text-[var(--text)]"
                }`}
              >
                {MODE_ICONS[m]} {MODE_LABELS[m]}
                {m === appMode ? " · open" : ""}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="hidden text-[11px] font-bold text-[var(--accent)] underline md:inline"
            onClick={() => go("dashboard")}
          >
            See both together on Home
          </button>
        </div>
      </div>

      {/* Main */}
      <main className={`px-4 pb-28 pt-5 sm:pt-7 lg:pb-12 ${collapsed ? "lg:ml-[76px]" : "lg:ml-[264px]"}`}>
        <div className="mx-auto max-w-6xl">
          <MainContent key={route} route={route} pageProps={pageProps} />
        </div>
      </main>

      {/* Mobile bottom nav — Home, Money, one-tap Add in the centre,
          What's due, and More (everything else, incl. Savings and the
          calculator). Nothing is more than two taps away. */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-white/94 pb-safe backdrop-blur-md lg:hidden" aria-label="Mobile navigation">
        <div className="grid grid-cols-5">
          {[NAV[0]!, NAV[1]!].map((n) => (
            <button
              key={n.route}
              type="button"
              aria-current={route === n.route ? "page" : undefined}
              onClick={() => go(n.route)}
              className={`flex min-h-[58px] flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold ${
                route === n.route ? "text-[var(--accent)]" : "text-[var(--dim)]"
              }`}
            >
              <span
                aria-hidden
                className={`flex h-7 w-12 items-center justify-center rounded-full text-lg leading-none transition ${
                  route === n.route ? "bg-[var(--surface-soft)]" : ""
                }`}
              >
                {n.icon}
              </span>
              {n.short}
            </button>
          ))}
          <button
            type="button"
            aria-label="Add a transaction"
            onClick={() => setQuickAddOpen(true)}
            className="flex min-h-[58px] flex-col items-center justify-center gap-1 py-1.5 text-[11px] font-extrabold text-[var(--accent)]"
          >
            <span
              aria-hidden
              className="flex h-11 w-11 -translate-y-2.5 items-center justify-center rounded-full bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-2xl leading-none text-white shadow-[0_10px_22px_rgba(124,58,237,0.35)] ring-4 ring-white"
            >
              ＋
            </span>
            <span className="-mt-2.5">Add</span>
          </button>
          {[NAV[2]!].map((n) => (
            <button
              key={n.route}
              type="button"
              aria-current={route === n.route ? "page" : undefined}
              onClick={() => go(n.route)}
              className={`flex min-h-[58px] flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold ${
                route === n.route ? "text-[var(--accent)]" : "text-[var(--dim)]"
              }`}
            >
              <span
                aria-hidden
                className={`flex h-7 w-12 items-center justify-center rounded-full text-lg leading-none transition ${
                  route === n.route ? "bg-[var(--surface-soft)]" : ""
                }`}
              >
                {n.icon}
              </span>
              {n.short}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            className="flex min-h-[58px] flex-col items-center justify-center gap-1 py-2 text-[11px] font-bold text-[var(--dim)]"
          >
            <span aria-hidden className="flex h-7 w-12 items-center justify-center rounded-full text-lg leading-none">•••</span>
            More
          </button>
        </div>
      </nav>

      {moreOpen ? (
        <div className="fixed inset-0 z-40 bg-[rgba(30,51,41,0.32)] backdrop-blur-sm lg:hidden" onClick={() => setMoreOpen(false)}>
          <div className="glass pop absolute inset-x-3 bottom-20 rounded-3xl p-3" onClick={(e) => e.stopPropagation()} role="menu" aria-label="All modules">
            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setQuickAddOpen(true);
                }}
                className="rounded-2xl bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] px-3 py-3 text-left text-sm font-bold text-white"
              >
                <span aria-hidden className="mr-2">＋</span>
                Add money in or out
              </button>
              <button
                type="button"
                onClick={() => go("savings")}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2">🪙</span>
                Add to savings
              </button>
              <button
                type="button"
                aria-expanded={calcOpen}
                onClick={() => {
                  setMoreOpen(false);
                  setCalcOpen(true);
                }}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2">🧮</span>
                Calculator
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setQuickOpen(true);
                }}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2">✎</span>
                Quick note
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setTourOpen(true);
                }}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2">🧭</span>
                App tour
              </button>
              <div className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold">
                <InstallButton
                  className="w-full text-left text-sm font-bold text-[var(--accent)]"
                  onNotify={(m) => {
                    setMoreOpen(false);
                    notify(m);
                  }}
                />
              </div>
            </div>
            {personal ? (
              <p className="px-1 pb-1.5 text-[11px] font-bold text-[var(--dim)]">
                Business tools are quieter in everyday modes — they still work exactly the same.
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-1.5">
              {NAV.slice(3).map((n) => (
                <button
                  key={n.route}
                  type="button"
                  onClick={() => go(n.route)}
                  className={`rounded-2xl px-3 py-3 text-left text-sm font-bold ${
                    route === n.route ? "bg-[var(--surface-soft)] text-[var(--accent)]" : "hover:bg-[var(--surface-soft)]"
                  } ${personal && n.group === "business" ? "opacity-70" : ""}`}
                >
                  <span aria-hidden className="mr-2">{n.icon}</span>
                  {n.label}
                  {personal && n.group === "business" ? (
                    <span className="ml-1.5 rounded-full bg-[var(--surface-soft)] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-[var(--dim)]">
                      Business
                    </span>
                  ) : null}
                </button>
              ))}
              <button
                type="button"
                onClick={() => go("settings")}
                className="rounded-2xl px-3 py-3 text-left text-sm font-bold hover:bg-[var(--surface-soft)]"
              >
                <span aria-hidden className="mr-2">⚙</span>
                Settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  void logout();
                }}
                className="rounded-2xl px-3 py-3 text-left text-sm font-bold hover:bg-[var(--surface-soft)]"
              >
                <span aria-hidden className="mr-2">⎋</span>
                Log out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Quick Note FAB (mobile / always available) */}
      <button
        type="button"
        className="no-print btn-primary fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-[0_14px_30px_rgba(124,58,237,0.32)] lg:bottom-6"
        aria-label="Open Quick Note"
        onClick={() => setQuickOpen(true)}
      >
        ✎
      </button>

      {quickOpen ? <QuickNote onClose={() => setQuickOpen(false)} notify={notify} /> : null}
      {quickAddOpen ? (
        <QuickAdd
          currency={state.business.currency}
          mode={appMode}
          state={state}
          onClose={() => setQuickAddOpen(false)}
          notify={notify}
          onSaved={() => void stateQ.refetch()}
        />
      ) : null}
      {/* Calculator: always mounted in the shell (rendered after Quick
          Add and above it, z-65) so it stays usable on every page and
          while Quick Add is open — closing/reopening it, changing
          pages, or entering an amount never loses its result. */}
      <CalculatorPanel open={calcOpen} onClose={() => setCalcOpen(false)} />
      {tourOpen ? (
        <AppTour
          go={go}
          notify={notify}
          onQuickAdd={() => setQuickAddOpen(true)}
          onClose={closeTour}
        />
      ) : null}
      {toast ? <UndoToast key={toast.id} toast={toast} onUndo={() => void undoDelete()} onClose={() => setToast(null)} /> : null}
      <ConfirmDialog state={confirmState} onDone={resolveConfirm} />
    </div>
  );
}

function MainContent({
  route,
  pageProps,
}: {
  route: Route;
  pageProps: Parameters<typeof DashboardPage>[0];
}) {
  // Offset content for the fixed desktop sidebar is handled by the header/main
  // wrappers in App; here we just render the active module.
  switch (route) {
    case "ai-cfo":
      return <AiCfoPage {...pageProps} />;
    case "money-flow":
      return <MoneyFlowPage {...pageProps} />;
    case "payment-calendar":
      return <PaymentCalendarPage {...pageProps} />;
    case "future-lens":
      return <FutureLensPage {...pageProps} />;
    case "what-if-lab":
      return <WhatIfPage {...pageProps} />;
    case "invoices":
      return <InvoicesPage {...pageProps} />;
    case "profit-scanner":
      return <ScannerPage {...pageProps} />;
    case "tax":
      return <TaxPage {...pageProps} />;
    case "reports":
      return <ReportsPage {...pageProps} />;
    case "memory-vault":
      return <VaultPage {...pageProps} />;
    case "scam-shield":
      return <ScamShieldPage {...pageProps} />;
    case "savings":
      return <SavingsPage {...pageProps} />;
    case "settings":
      return <SettingsPage {...pageProps} />;
    default:
      return <DashboardPage {...pageProps} />;
  }
}

