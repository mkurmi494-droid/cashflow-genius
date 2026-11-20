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
import { APP_MODES, CUSTOM_CATEGORY, MODE_ICONS, MODE_LABELS, PAYMENT_METHODS, categoriesFor, categoryOptionsFor, currencyConfirmOptions, fileToBase64, fmtMoney, isPersonalLike, modeOf, todayStr, workspaceHasMoney, type AppMode, type State } from "./lib";
import { CurrencyPicker, currencyMeta } from "./currencyPicker";
import { CalcIcon, CategorySelect, GlassOrb, LogoMark, Modal, ModePicker, ParticleField } from "./components";
import { LoadingMark } from "./LoadingMark";
import { AiAvatar } from "./AiAvatar";
import { DashboardPage } from "./pageDashboard";
import { AiCfoPage } from "./pageCfo";
import { MoneyFlowPage } from "./pageMoney";
import { FutureLensPage, WhatIfPage } from "./pageFuture";
import { InvoicesPage } from "./pageInvoices";
import { PaymentCalendarPage } from "./pageCalendar";
import { SavingsPage } from "./pageSavings";
import { LendBorrowPage } from "./pageLend";
import { MoneyToolsPage } from "./pageTools";
import { CalculatorPanel } from "./calculator";
import { HomeChatFab } from "./homeChat";
import { AppUpdateBanner } from "./appUpdate";
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
// the everyday mode (Personal Money) they stay
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
  { route: "lend-borrow", label: "Lend & borrow", short: "Lend", icon: "⇄", path: "app/lend-borrow", group: "core" },
  { route: "money-tools", label: "Money Tools", short: "Tools", icon: "🧰", path: "app/money-tools", group: "core" },
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

// The navigation shows only these three — Home, Money in & out, Money
// Tools. Every other tool (Budget, Savings, Lend & borrow, Debt & dues,
// Scam Shield, What-if, Future forecast, Invoices, GST & tax, Reports,
// Notes, AI CFO) lives ONLY inside Money Tools. The full NAV list above
// stays as the route registry so deep links, the page switch and Money
// Tools cards keep working. (Changed 2026-11-20 at Sarya's ask.)
const MAIN_NAV = NAV.filter(
  (n) => n.route === "dashboard" || n.route === "money-flow" || n.route === "money-tools",
);

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
  const [currency, setCurrency] = useState("INR");
  const personal = isPersonalLike(appMode);
  const creator = appMode === "creator";
  const defaultSpaceName =
    appMode === "personal" ? "My Money" : "My Creator Studio";

  const finish = useMutation({
    mutationFn: async () => {
      await api.updateBusiness({
        mode: appMode,
        name: personal ? bizName.trim() || defaultSpaceName : bizName,
        industry: personal ? "" : industry,
        country: "India",
        currency,
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
        `Welcome! Your ${MODE_LABELS[appMode]} workspace is ready — it starts empty.`,
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
          <GlassOrb size={130} label={<LogoMark className="h-16 w-16 text-[#7c3aed]" />} sub="The Living Ledger" />
          <h1 className="display-font mt-5 text-[26px] font-semibold tracking-tight">Welcome to Cashflow Genius</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            Command Center, AI CFO, forecasts, invoices, budgets and more — all from one ledger.
          </p>
          <button type="button" className="btn-primary mt-6 w-full px-6 py-3 text-sm" onClick={() => setStep("setup")}>
            Create my workspace
          </button>
          <p className="mt-4 text-xs text-[var(--dim)]">
            This workspace belongs to your account only — it starts empty.
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
            ? "Set up your everyday money"
            : creator
              ? "Set up your creator workspace"
              : "Set up your business"}
        </h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Choose how you'll use Cashflow Genius — you can switch any time in Settings.
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
              {personal ? `Money you have right now (${currencyMeta(currency).symbol})` : `Opening cash balance (${currencyMeta(currency).symbol})`}
            </span>
            <input className="field" type="number" step="1" value={opening} onChange={(e) => setOpening(e.target.value)} aria-label={`Opening cash balance in ${currency}`} />
          </label>
          <div>
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Currency</span>
            <CurrencyPicker value={currency} onChange={setCurrency} />
          </div>
        </div>
        <p className="mt-4 text-xs text-[var(--dim)]">
          Defaults: India, Indian numbering. Change anything later in Settings.
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
  // One save at a time. The note has no id until the first save
  // returns, so a second overlapping save would create a second note
  // instead of updating the first — typing while the server is slow
  // (cold start, 1–3s) used to duplicate the note on every pause.
  // While a save is in flight, remember that newer content arrived
  // and run exactly one more save afterwards, updating the same note.
  const persistingRef = useRef(false);
  const pendingRef = useRef(false);

  const persist = async () => {
    const { title: t, content: c } = latest.current;
    if (!t.trim() && !c.trim()) return;
    if (persistingRef.current) {
      pendingRef.current = true;
      return;
    }
    persistingRef.current = true;
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
    } finally {
      persistingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void persistRef.current();
      }
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
  // The bill scan lives in the Smart Add bar below the form now (see
  // the Smart Add section), not as a fourth tab.
  const [entryTab, setEntryTab] = useState<"type" | "voice" | "sms">("type");
  // Smart Add: one chat-style bar (type / speak / snap a bill) whose
  // AI draft is edited below and saved only on confirmation. Each
  // draft row carries its own type, date and counterparty — a text
  // line may mix income and expense on different dates, and a bill
  // photo brings its own merchant and receipt date.
  type SmartDraftItem = {
    id: string;
    name: string;
    amount: string;
    category: string;
    customCategory: string;
    type: "expense" | "income";
    date: string;
    counterparty: string;
  };
  const [smartText, setSmartText] = useState("");
  const [smartError, setSmartError] = useState<string | null>(null);
  const [smartItems, setSmartItems] = useState<SmartDraftItem[]>([]);
  const [smartSource, setSmartSource] = useState<string>("");
  const [smartSaving, setSmartSaving] = useState(false);
  const [showCameraChoices, setShowCameraChoices] = useState(false);
  const [billImage, setBillImage] = useState<{ base64: string; mime: "image/jpeg" | "image/png"; name: string } | null>(null);
  const [receiptResult, setReceiptResult] = useState<Awaited<ReturnType<typeof api.analyseReceipt>> | null>(null);
  const cameraFileRef = useRef<HTMLInputElement>(null);
  const fileFileRef = useRef<HTMLInputElement>(null);
  const smartExpenseCategories = categoryOptionsFor(state, mode, "expense");
  const smartIncomeCategories = categoryOptionsFor(state, mode, "income");
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
        setVoiceError("Couldn't hear the voice — please try again, or type the phrase below to make a draft.");
      };
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setVoiceError("Voice couldn't start in this browser — type the phrase below to make a draft instead.");
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

  /** Smart Add — text: "dinner 50, shopping 200 yesterday" becomes a
   *  draft list. The AI parses it; the built-in parser answers when
   *  the AI can't. Nothing is saved until the user checks the draft. */
  const parseSmart = useMutation({
    mutationFn: async (text: string) => await api.parseSmartEntry({ text }),
    onSuccess: (res) => {
      setSmartError(null);
      setReceiptResult(null);
      setBillImage(null);
      setSmartSource(res.source === "ai" ? "✦ AI draft" : "Built-in parser draft");
      setSmartItems(
        res.entries.map((it, i) => {
          const cats = it.type === "income" ? smartIncomeCategories : smartExpenseCategories;
          const known = cats.includes(it.category);
          return {
            id: `${i}-${it.description.slice(0, 20)}`,
            name: it.description,
            amount: (it.amountCents / 100).toFixed(2),
            category: known ? it.category : CUSTOM_CATEGORY,
            customCategory: known ? "" : it.category,
            type: it.type,
            date: it.date,
            counterparty: it.counterparty,
          };
        }),
      );
      if (res.entries.length === 0) {
        setSmartError(res.note || "I could not find any amount in that — try 'dinner 50, shopping 200'.");
      }
    },
    onError: (e) => setSmartError(e instanceof Error ? e.message : String(e)),
  });

  /** Smart Add — voice: the same speech recognition as the Voice
   *  tab, but the transcript goes into the Smart bar and the AI
   *  parses it into several entries at once. */
  const startSmartListening = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    setSmartError(null);
    try {
      const rec = new Ctor();
      recognitionRef.current = rec;
      rec.lang = "hi-IN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const transcript = e.results[0]?.[0]?.transcript ?? "";
        setListening(false);
        if (transcript.trim()) {
          setSmartText(transcript);
          parseSmart.mutate(transcript);
        }
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => {
        setListening(false);
        setSmartError("Couldn't hear the voice — please try again, or type the line below.");
      };
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setSmartError("Voice couldn't start in this browser — type the line below instead.");
    }
  };

  /** Smart Add — bill photo: pick it (camera or files), the AI reads
   *  it, and the items land in the same draft list. The photo is read
   *  as soon as it is picked — no extra button. */
  const onPickBillImage = async (file: File | undefined) => {
    setSmartError(null);
    setReceiptResult(null);
    setSmartItems([]);
    setShowCameraChoices(false);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setSmartError("Please choose a JPG or PNG photo of the bill.");
      return;
    }
    if (file.size > 6_000_000) {
      setSmartError("That photo is larger than 6 MB — please use a smaller one.");
      return;
    }
    try {
      const data = await fileToBase64(file);
      const image = { base64: data.dataBase64, mime: data.mimeType as "image/jpeg" | "image/png", name: file.name };
      setBillImage(image);
      analyseReceipt.mutate(image);
    } catch {
      setSmartError("That photo could not be read. Try another one.");
    }
  };

  const analyseReceipt = useMutation({
    mutationFn: async (image: { base64: string; mime: "image/jpeg" | "image/png" }) =>
      await api.analyseReceipt({ imageBase64: image.base64, imageMimeType: image.mime }),
    onSuccess: (res) => {
      setReceiptResult(res);
      setSmartError(null);
      setSmartSource("✦ Bill draft");
      setSmartItems(
        res.items.map((it, i) => {
          const known = smartExpenseCategories.includes(it.category);
          return {
            id: `${i}-${it.name.slice(0, 20)}`,
            name: it.name,
            amount: (it.amountCents / 100).toFixed(2),
            category: known ? it.category : CUSTOM_CATEGORY,
            customCategory: known ? "" : it.category,
            type: "expense" as const,
            date: res.receiptDate ?? todayStr(),
            counterparty: res.merchantName ?? "",
          };
        }),
      );
      if (res.items.length === 0) {
        setSmartError(res.note || "This photo could not be read as a bill — try a clearer photo, straight on, with the items and total visible.");
      }
    },
    onError: (e) => setSmartError(e instanceof Error ? e.message : String(e)),
  });

  /** Saves every checked Smart draft row as its own transaction, one
   *  at a time, and reports how many landed. A failed row stays in
   *  the draft so it can be fixed and retried — nothing is silently
   *  dropped. */
  const saveSmart = async () => {
    const valid = smartItems.filter((it) => it.name.trim() && (parseFloat(it.amount) || 0) > 0);
    if (valid.length === 0) {
      setSmartError("Nothing to save — check the items and amounts.");
      return;
    }
    setSmartSaving(true);
    setSmartError(null);
    let saved = 0;
    let savedTotalCents = 0;
    const failed: string[] = [];
    for (const it of valid) {
      const amountCents = Math.round((parseFloat(it.amount) || 0) * 100);
      const cats = it.type === "income" ? smartIncomeCategories : smartExpenseCategories;
      const cat = it.category === CUSTOM_CATEGORY ? it.customCategory.trim() : it.category;
      if (!cat || amountCents <= 0 || !cats.includes(cat) && it.category !== CUSTOM_CATEGORY) {
        failed.push(it.name.trim() || "Unnamed item");
        continue;
      }
      try {
        await api.saveTransaction({
          type: it.type,
          status: "posted",
          category: cat,
          description: it.name.trim().slice(0, 200),
          counterparty: it.counterparty.trim().slice(0, 120),
          amountCents,
          date: it.date,
          paymentMethod: "",
        });
        saved++;
        savedTotalCents += amountCents;
      } catch {
        failed.push(it.name.trim() || "Unnamed item");
      }
    }
    setSmartSaving(false);
    if (saved > 0) {
      notify(
        `${saved} transaction${saved > 1 ? "s" : ""} recorded (${fmtMoney(savedTotalCents, currency)})${failed.length ? ` — ${failed.length} could not be saved, fix and retry them` : ""}.`,
      );
      onSaved();
    }
    if (failed.length === 0) {
      onClose();
    } else {
      setSmartItems((items) => items.filter((it) => failed.includes(it.name.trim() || "Unnamed item")));
      setSmartError(`Could not save: ${failed.join(", ")}. The rest are saved — fix these and try again.`);
    }
  };

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
          <p className="text-sm font-bold">Say it — a draft will be made 🎤</p>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Say <em>“paid 500 for chai”</em> — amount, in/out, category and date are pulled into a draft. Nothing is saved until you check it.
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
              {listening ? "🔴 Listening… speak now" : "🎤 Tap & speak"}
            </button>
          ) : (
            <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]" role="status">
              Voice recognition isn't available in this browser (it works in Chrome/Android).
              No problem — just type the same phrase below and the draft will be made the same way. This is the typing fallback for voice entry.
            </p>
          )}
          {voiceError ? (
            <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-xs font-semibold text-[var(--err-text)]" role="alert">{voiceError}</p>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
              {speechSupported ? "Or type the phrase here" : "Type the phrase here"}
            </span>
            <input
              className="field"
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              aria-label="Type the phrase you would say"
              placeholder="e.g. paid 500 for chai"
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
        </div>
      ) : null}

      {entryTab === "sms" ? (
        <div className="mb-4 space-y-3 rounded-2xl bg-[var(--surface-soft)] p-4">
          <p className="text-sm font-bold">Paste a bank / UPI message 📩</p>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Paste a bank SMS or UPI message — amount, merchant, in/out, date and UPI reference are pulled into a draft.
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
            ⚠️ A pasted message is never proof of payment. Before saving, verify the transaction
            and UTR in your bank/UPI app yourself — Scam Shield (in the menu) also checks
            suspicious messages.
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
              The fields below are filled from the draft. If anything looks wrong, change it here — nothing is saved until you press Record.
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

      {/* Smart Add — one chat-style bar below the manual form: type it,
       *  speak it, or snap a bill. The AI makes the entries, the user
       *  checks them, and only then are they saved. */}
      <section className="mt-5 border-t border-[var(--border)] pt-4" aria-label="Smart add">
        <div className="mb-3 flex items-start gap-2.5">
          <AiAvatar size={36} label="AI avatar" />
          <div>
            <p className="text-sm font-extrabold">✦ Smart add — write it all at once</p>
            <p className="text-xs leading-relaxed text-[var(--dim)]">
              Type, speak or snap a bill — the AI makes the entries, you check them. Nothing is auto-saved.
            </p>
          </div>
        </div>
        <input
          ref={cameraFileRef}
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          className="hidden"
          aria-label="Take a bill photo with the camera"
          onChange={(e) => void onPickBillImage(e.target.files?.[0])}
        />
        <input
          ref={fileFileRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          aria-label="Choose a bill photo from files"
          onChange={(e) => void onPickBillImage(e.target.files?.[0])}
        />
        <form
          className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-white py-1.5 pr-1.5 pl-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (smartText.trim().length >= 3) parseSmart.mutate(smartText.trim());
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="sr-only">Write everything at once</span>
            <input
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--dim)]"
              value={smartText}
              onChange={(e) => setSmartText(e.target.value)}
              aria-label="Write everything at once"
              placeholder="dinner 50, shopping 200 — yesterday"
              maxLength={1000}
            />
          </label>
          {speechSupported ? (
            <button
              type="button"
              onClick={startSmartListening}
              disabled={listening || parseSmart.isPending}
              aria-label={listening ? "Listening, speak now" : "Speak the line"}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg text-white transition ${
                listening ? "animate-pulse bg-[#e11d63]" : "bg-[#111827]"
              }`}
            >
              {listening ? "🔴" : "🎤"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowCameraChoices((v) => !v)}
            aria-label="Snap a bill photo"
            aria-expanded={showCameraChoices}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#111827] text-lg text-white"
          >
            📷
          </button>
        </form>
        {showCameraChoices ? (
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary flex-1 px-4 py-2.5 text-sm" onClick={() => cameraFileRef.current?.click()}>
              📷 Take photo
            </button>
            <button type="button" className="btn-ghost flex-1 px-4 py-2.5 text-sm" onClick={() => fileFileRef.current?.click()}>
              🖼 Choose from files
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="btn-primary mt-2 w-full px-5 py-2.5 text-sm"
          disabled={smartText.trim().length < 3 || parseSmart.isPending}
          onClick={() => parseSmart.mutate(smartText.trim())}
        >
          {parseSmart.isPending ? "Understanding…" : "✦ Understand it →"}
        </button>
        {parseSmart.isPending || analyseReceipt.isPending ? (
          <div className="mt-3 flex items-center gap-2.5 rounded-2xl bg-[var(--surface-soft)] px-3.5 py-3" role="status">
            <AiAvatar size={28} pulse label="AI is working" />
            <p className="text-sm font-semibold">{analyseReceipt.isPending ? "Reading your bill…" : "Understanding your line…"}</p>
          </div>
        ) : null}
        {billImage ? (
          <div className="mt-3 flex items-center gap-3">
            <img
              src={`data:${billImage.mime};base64,${billImage.base64}`}
              alt="Bill photo"
              className="h-16 w-16 rounded-xl border border-[var(--border)] object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{billImage.name}</p>
              <button type="button" className="text-xs font-bold text-[var(--accent)] underline" onClick={() => setShowCameraChoices(true)}>
                Choose a different photo
              </button>
            </div>
          </div>
        ) : null}
        {smartError ? (
          <p className="mt-3 rounded-xl bg-[var(--err)] px-3 py-2 text-xs font-semibold text-[var(--err-text)]" role="alert">
            {smartError}
          </p>
        ) : null}
        {receiptResult && smartItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-extrabold">{receiptResult.merchantName ?? "Bill"}</span>
            </div>
            {receiptResult.currencyCode !== currency ? (
              <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]" role="status">
                This bill is in {receiptResult.currencyCode} — your workspace is {currency}. Amounts are saved as shown; edit any amount first.
              </p>
            ) : null}
            {receiptResult.totalMismatch ? (
              <p className="rounded-xl bg-[var(--warn)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--warn-text)]" role="status">
                The bill total ({fmtMoney(receiptResult.receiptTotalCents ?? 0, receiptResult.currencyCode)}) doesn&apos;t match the items (
                {fmtMoney(receiptResult.itemsTotalCents, receiptResult.currencyCode)}) — check the amounts before saving.
              </p>
            ) : null}
          </div>
        ) : null}
        {smartItems.length > 0 ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm font-extrabold text-[var(--ai-text)]">{smartSource} — check &amp; edit, then save</p>
            <ul className="space-y-2">
              {smartItems.map((it) => (
                <li key={it.id} className="space-y-2 rounded-2xl border border-[var(--border)] bg-white p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="field min-w-0 flex-1 px-2 py-1.5 text-sm font-bold"
                      value={it.name}
                      onChange={(e) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))}
                      aria-label="Item description"
                      maxLength={200}
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-full px-2 py-1 text-xs font-bold text-[var(--dim)]"
                      aria-label={`Remove ${it.name}`}
                      onClick={() => setSmartItems((items) => items.filter((x) => x.id !== it.id))}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Amount ({currency})</span>
                      <input
                        className="field tnum px-2 py-1.5 text-sm font-bold"
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        value={it.amount}
                        onChange={(e) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, amount: e.target.value } : x)))}
                        aria-label={`Amount for ${it.name}`}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Category</span>
                      <CategorySelect
                        options={it.type === "income" ? smartIncomeCategories : smartExpenseCategories}
                        value={it.category}
                        onChange={(v) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, category: v, customCategory: "" } : x)))}
                        ariaLabel={`Category for ${it.name}`}
                      />
                    </label>
                  </div>
                  {it.category === CUSTOM_CATEGORY ? (
                    <input
                      className="field px-2 py-1.5 text-sm"
                      value={it.customCategory}
                      onChange={(e) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, customCategory: e.target.value } : x)))}
                      aria-label={`Custom category for ${it.name}`}
                      placeholder="Type your own category"
                      maxLength={60}
                    />
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex gap-1" role="group" aria-label={`Money direction for ${it.name}`}>
                      {(["expense", "income"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          aria-pressed={it.type === t}
                          onClick={() =>
                            setSmartItems((items) =>
                              items.map((x) =>
                                x.id === it.id
                                  ? {
                                      ...x,
                                      type: t,
                                      category: (t === "income" ? smartIncomeCategories : smartExpenseCategories)[0] ?? "General",
                                      customCategory: "",
                                    }
                                  : x,
                              ),
                            )
                          }
                          className={`flex-1 rounded-full px-2 py-1.5 text-xs font-bold ${
                            it.type === t
                              ? t === "income"
                                ? "bg-[var(--accent)] text-white"
                                : "bg-[#e11d63] text-white"
                              : "bg-[var(--surface-soft)] text-[var(--dim)]"
                          }`}
                        >
                          {t === "income" ? "↓ In" : "↑ Out"}
                        </button>
                      ))}
                    </div>
                    <label className="block">
                      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">Date</span>
                      <input
                        className="field w-full px-2 py-1 text-xs"
                        type="date"
                        value={it.date}
                        onChange={(e) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, date: e.target.value } : x)))}
                        aria-label={`Date for ${it.name}`}
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">From / to (optional)</span>
                    <input
                      className="field px-2 py-1.5 text-sm"
                      value={it.counterparty}
                      onChange={(e) => setSmartItems((items) => items.map((x) => (x.id === it.id ? { ...x, counterparty: e.target.value } : x)))}
                      aria-label={`Counterparty for ${it.name}`}
                      placeholder="e.g. Swiggy, Client name"
                      maxLength={120}
                    />
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between text-sm">
              <span className="font-bold">Total to save</span>
              <span className="tnum font-extrabold">
                {fmtMoney(
                  smartItems.reduce((a, it) => a + Math.round((parseFloat(it.amount) || 0) * 100), 0),
                  currency,
                )}
              </span>
            </div>
            <button
              type="button"
              className="btn-primary w-full px-5 py-3 text-sm"
              disabled={smartSaving || smartItems.length === 0}
              onClick={() => void saveSmart()}
            >
              {smartSaving ? "Saving…" : `Save ${smartItems.length} transaction${smartItems.length > 1 ? "s" : ""}`}
            </button>
            <p className="text-[11px] leading-relaxed text-[var(--dim)]">
              Each row is saved as its own transaction, with its own date and counterparty. Check every amount first — the AI can misread a line or a bill.
            </p>
          </div>
        ) : null}
      </section>
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
  // Workspace switcher dropdown (header bar): open state + a ref for
  // closing on an outside tap, and Escape. Switching itself still goes
  // through requestModeSwitch, which asks first.
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWsMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wsMenuOpen]);
  useEffect(() => {
    // Mutations whose data the insight rules read (transactions,
    // invoices, recurring schedules, EMI plans): after one lands, the
    // findings may have changed, so regenerate them in the background
    // and refresh the Genius Insights panel when the run lands.
    // generateInsights itself is a read-only action for the event
    // system (it never touches the ledger), so this cannot loop.
    const INSIGHT_DATA_ACTIONS = new Set([
      "saveTransaction",
      "deleteTransaction",
      "importTransactions",
      "undoLastImport",
      "saveInvoice",
      "setInvoiceStatus",
      "markInvoicePaid",
      "deleteInvoice",
      "saveRecurring",
      "deleteRecurring",
      "saveEmiPlan",
      "deleteEmiPlan",
      "collectEmiInstalment",
      "restoreDeletedItem",
      "restoreBackup",
    ]);
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
        void queryClient.invalidateQueries({ queryKey: ["cg-insights"] });
        // A currency/profile change (updateBusiness) rewrites amounts
        // that live outside ["cg-state"] — lend/borrow entries,
        // recurring savings schedules and the AI briefing text. Those
        // queries must refetch too, or the page keeps showing the old
        // numbers under the new currency symbol. (Found 2026-11-20:
        // Lend & Borrow showed only the new symbol after a change.)
        if (detail?.action === "updateBusiness") {
          void queryClient.invalidateQueries({ queryKey: ["cg-lend-borrow"] });
          void queryClient.invalidateQueries({ queryKey: ["cg-savings-schedules"] });
          void queryClient.invalidateQueries({ queryKey: ["briefing"] });
        }
      })();
      if (detail && INSIGHT_DATA_ACTIONS.has(detail.action)) {
        // Fire-and-forget: the server debounces runs to one per
        // minute, and the panel refreshes when this run lands.
        // A failure here must never surface as an error — the panel
        // still shows the last good findings.
        void api
          .generateInsights({})
          .catch(() => null)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["cg-insights"] });
          });
      }
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
    onSuccess: (res) => {
      void stateQ.refetch();
      const c = res.conversion;
      notify(
        c
          ? // 1 old unit = rate new units. fmtMoney(100, cur) renders
            // "₹1" / "$1"; the rate is shown with 4 decimals by passing
            // it as a cents value (rate × 100 minor units per unit).
            `Currency updated — converted at the live rate: ${fmtMoney(100, c.from)} = ${fmtMoney(Math.round(c.rate * 10000) / 100, c.to, 4)}.`
          : "Currency updated.",
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  // Currency change goes through here from every control (top-bar
  // select, More sheet, Settings form): while a conversion is running
  // the controls are disabled, and this handler also ignores a change
  // fired while pending, so a second conversion can never be queued
  // behind the first. A workspace with money asks first — converting
  // re-prices every amount in it at the live rate; an empty workspace
  // converts without asking.
  const requestCurrencyChange = async (next: string) => {
    const current = stateQ.data;
    if (!current || currencyMut.isPending) return;
    const from = current.business.currency;
    if (next === from) return;
    if (workspaceHasMoney(current)) {
      const ok = await confirm(
        currencyConfirmOptions(from, next, MODE_LABELS[modeOf(current)]),
      );
      if (!ok) return;
    }
    currencyMut.mutate(next);
  };

  const modeMut = useMutation({
    mutationFn: (m: AppMode) => api.setMode({ mode: m }),
    onSuccess: (_res, m) => {
      void stateQ.refetch();
      notify(
        `Switched to ${MODE_LABELS[m]}.`,
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
          <LoadingMark className="h-24 w-24" />
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
          <LoadingMark className="h-24 w-24" />
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
          <LoadingMark label="Loading your ledger…" />
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
          <LoadingMark label={`Loading ${MODE_LABELS[switchingTo]}…`} />
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
    currencyBusy: currencyMut.isPending,
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
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-[#fbf7ea] shadow-[0_8px_18px_rgba(124,58,237,0.3)]">
            <LogoMark className="h-6 w-6 text-white" />
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
          {MAIN_NAV.map((n, i) => {
            const deemph = personal && n.group === "business";
            const showBizHeading =
              !collapsed && n.group === "business" && MAIN_NAV[i - 1]?.group !== "business";
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
            <span aria-hidden className="flex w-5 justify-center"><CalcIcon className="h-5 w-5" /></span>
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
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] text-[#fbf7ea] lg:hidden">
            <LogoMark className="h-5 w-5 text-white" />
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
          <label className="hidden items-center gap-1.5 sm:flex">
            <span className="sr-only">Currency</span>
            <CurrencyPicker
              compact
              value={state.business.currency}
              onChange={(c) => void requestCurrencyChange(c)}
              disabled={currencyMut.isPending}
            />
            {currencyMut.isPending ? (
              <span className="whitespace-nowrap text-xs font-bold text-[var(--accent)]" role="status">
                Converting…
              </span>
            ) : null}
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
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg transition ${
              calcOpen ? "bg-[var(--accent)] text-white" : "btn-ghost"
            }`}
            aria-label={calcOpen ? "Close calculator" : "Open calculator"}
            aria-expanded={calcOpen}
            title="Calculator"
            onClick={() => setCalcOpen((o) => !o)}
          >
            <CalcIcon className="h-5 w-5" />
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

      {/* One-tap workspace switcher: Personal and Business (and Creator)
          can be used together — both stay saved at the same time,
          each with its own records. Switching only opens the other
          workspace; it never moves, merges or deletes anything. The
          Command Center shows both totals side by side plus a combined
          overview. */}
      <div className={`${collapsed ? "lg:ml-[76px]" : "lg:ml-[264px]"} no-print border-b border-[var(--border)] bg-white/70`}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <span className="w-full text-[11px] font-extrabold uppercase tracking-wide text-[var(--dim)] sm:w-auto">
            Workspace:
          </span>
          <div className="relative" ref={wsMenuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={wsMenuOpen}
              disabled={modeMut.isPending}
              onClick={() => setWsMenuOpen((o) => !o)}
              className="rounded-full bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white shadow-[0_6px_16px_rgba(124,58,237,0.24)] transition"
            >
              {MODE_ICONS[appMode]} {MODE_LABELS[appMode]} {wsMenuOpen ? "▴" : "▾"}
            </button>
            {wsMenuOpen ? (
              <div
                role="menu"
                aria-label="Switch workspace"
                className="absolute left-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-[0_16px_40px_rgba(76,29,149,0.18)]"
              >
                {APP_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitem"
                    aria-current={m === appMode}
                    onClick={() => {
                      setWsMenuOpen(false);
                      if (m !== appMode) void requestModeSwitch(m);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-sm font-bold transition ${
                      m === appMode
                        ? "bg-[var(--surface-soft)] text-[var(--accent)]"
                        : "text-[var(--text)] hover:bg-[var(--surface-soft)]"
                    }`}
                  >
                    <span>
                      {MODE_ICONS[m]} {MODE_LABELS[m]}
                    </span>
                    {m === appMode ? <span className="text-xs">· open</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
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
          <AppUpdateBanner />
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
          {[NAV.find((n) => n.route === "money-tools")!].map((n) => (
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
                aria-expanded={calcOpen}
                onClick={() => {
                  setMoreOpen(false);
                  setCalcOpen(true);
                }}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2 inline-flex align-middle"><CalcIcon className="h-5 w-5" /></span>
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
              <div className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Currency</span>
                <CurrencyPicker
                  value={state.business.currency}
                  onChange={(c) => {
                    setMoreOpen(false);
                    void requestCurrencyChange(c);
                  }}
                  disabled={currencyMut.isPending}
                />
                {currencyMut.isPending ? (
                  <span className="mt-1 block text-xs font-bold text-[var(--accent)]" role="status">
                    Converting…
                  </span>
                ) : (
                  <span className="mt-1 block text-[11px] font-semibold text-[var(--dim)]">
                    Changes all amounts in {MODE_LABELS[appMode]}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => go("settings")}
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
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
                className="rounded-2xl bg-[var(--surface-soft)] px-3 py-3 text-left text-sm font-bold"
              >
                <span aria-hidden className="mr-2">⎋</span>
                Log out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Quick Note FAB (mobile / always available) — hidden on the AI CFO
          page, where the pinned question box owns the bottom of the screen
          and the FAB would float over it. */}
      {route !== "ai-cfo" ? (
        <button
          type="button"
          className="no-print btn-primary fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-[0_14px_30px_rgba(124,58,237,0.32)] lg:bottom-6"
          aria-label="Open Quick Note"
          onClick={() => setQuickOpen(true)}
        >
          ✎
        </button>
      ) : null}

      {quickOpen ? <QuickNote onClose={() => setQuickOpen(false)} notify={notify} /> : null}
      {/* Home AI chat — pinned on the home screen (dashboard) only: a
          floating button that opens the chat sheet. It sits above the
          Quick Note button so the two never overlap. */}
      {route === "dashboard" ? <HomeChatFab mode={appMode} /> : null}
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
    case "lend-borrow":
      return <LendBorrowPage {...pageProps} />;
    case "money-tools":
      return <MoneyToolsPage {...pageProps} />;
    case "settings":
      return <SettingsPage {...pageProps} />;
    default:
      return <DashboardPage {...pageProps} />;
  }
}

