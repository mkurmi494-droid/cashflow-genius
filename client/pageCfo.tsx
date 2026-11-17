import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { buildTurns, displayRawText } from "./cfoHistory";
import { addDays, buildCalendarEvents, fmtMoney, prettyDate, summarise, todayStr, totalSavedCents } from "./lib";
import type { PageProps } from "./types";
import { Badge, GlassOrb, SectionTitle } from "./components";

type CfoAnswer = ApiResponse<typeof api, "askCfo">["answer"];
type CfoLang = "en" | "hinglish";

const SUGGESTED_EN = [
  "Why is my profit decreasing?",
  "Which expenses increased?",
  "Can I afford another employee?",
  "What are my cashflow risks?",
  "Which invoices are overdue?",
  "How much cash could remain in 30 days?",
  "What are my biggest money leaks?",
  "Am I saving fast enough for my goals?",
];

const SUGGESTED_HI = [
  "Mera profit kam kyun ho raha hai?",
  "Kaun se kharche sabse zyada badhe hain?",
  "Kya main ek aur employee rakh sakta hoon?",
  "Mere paise ka sabse bada risk kya hai?",
  "Kaun si invoices overdue hain aur kitne ki?",
  "30 din baad mere paas kitna cash bachega?",
  "Mera paisa kahan leak ho raha hai?",
  "Kya meri savings sahi speed par hai?",
];

export function AiCfoPage({ state, notify, saveToVault }: PageProps) {
  const cur = state.business.currency;
  const s = useMemo(() => summarise(state), [state]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [lang, setLang] = useState<CfoLang>(() => {
    try {
      return localStorage.getItem("cg_cfo_lang") === "hinglish" ? "hinglish" : "en";
    } catch {
      return "en";
    }
  });
  const [localTurns, setLocalTurns] = useState<
    { q: string; a: CfoAnswer }[]
  >([]);

  const pickLang = (l: CfoLang) => {
    setLang(l);
    try {
      localStorage.setItem("cg_cfo_lang", l);
    } catch {
      /* storage unavailable — the toggle still works for this session */
    }
  };

  const active = state.conversations.find((c) => c.id === activeId) ?? null;

  const overdueInvoices = state.invoices.filter((i) => i.effectiveStatus === "overdue");
  const next30 = useMemo(() => {
    const events = buildCalendarEvents(state, todayStr(), addDays(todayStr(), 30));
    return {
      pay: events.filter((e) => e.direction === "pay").reduce((a, e) => a + e.amountCents, 0),
      collect: events.filter((e) => e.direction === "collect").reduce((a, e) => a + e.amountCents, 0),
      count: events.length,
    };
  }, [state]);

  const ask = useMutation({
    mutationFn: (q: string) =>
      api.askCfo({ conversationId: activeId, question: q, language: lang }),
    onSuccess: (res, q) => {
      setActiveId(res.conversationId);
      setLocalTurns((t) => [...t, { q, a: res.answer }]);
      setQuestion("");
    },
    onError: (e) =>
      notify(`AI CFO could not answer: ${e instanceof Error ? e.message : String(e)}`),
  });

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2 || ask.isPending) return;
    ask.mutate(trimmed);
  };

  // Turns from the stored conversation. buildTurns pairs messages by
  // role, not position: the two rows of one turn share a created_at,
  // so ordering can tie and return the assistant row before its
  // question — the answer must still render. Stored free-text answers
  // (raw model JSON inside directAnswer) are unwrapped into structured
  // fields by parseStoredAnswer, exactly like structured answers.
  const storedTurns: { q: string; a: CfoAnswer | null; raw?: string }[] =
    active ? buildTurns(active.messages) : [];
  // Turns asked in this session but not yet reflected in the refetched state.
  const pendingLocal = activeId
    ? localTurns.slice(storedTurns.length)
    : localTurns;

  // Section numbers are assigned at render time, in order, so that hidden
  // (empty) sections never leave gaps like 1, 3, 5 in the visible headings.
  const answerCard = (a: CfoAnswer, q: string, key: number) => {
    let n = 0;
    const num = () => ++n;
    return (
    <article key={key} className="card rise overflow-hidden">
      <div className="border-b border-[var(--border)] bg-[var(--ai)] px-4 py-3">
        <p className="text-sm font-bold text-[var(--ai-text)]">You asked</p>
        <p className="text-sm">{q}</p>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div>
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
            {num()} · Direct answer
          </h3>
          <p className="mt-1 font-semibold">{a.directAnswer}</p>
        </div>
        {a.numbers.length > 0 ? (
          <div>
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
              {num()} · Relevant numbers
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {a.numbers.map((n, i) => (
                <div key={i} className="rounded-xl bg-[var(--surface-soft)] px-3 py-2">
                  <p className="text-xs text-[var(--dim)]">{n.label}</p>
                  <p className="font-extrabold">{n.value}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
            {num()} · Explanation
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{a.explanation}</p>
        </div>
        {a.supportingData.length > 0 ? (
          <div>
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
              {num()} · Supporting data
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
              {a.supportingData.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {a.options.length > 0 ? (
          <div>
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
              {num()} · Suggested options
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
              {a.options.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="rounded-xl bg-[var(--warn)] px-3 py-2">
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--warn-text)]">
            {num()} · Assumptions & limitations
          </h3>
          <p className="mt-1 text-sm text-[var(--warn-text)]">{a.assumptions}</p>
        </div>
        {a.sources && a.sources.length > 0 ? (
          <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--surface-soft)] px-3 py-2.5">
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--accent)]">
              {num()} · What the AI used — sources {a.language === "hinglish" ? "· Hinglish answer" : ""}
            </h3>
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              Ye exact figures aur dates hain jo is answer ko banane mein use hue — server par
              tumhare active workspace ke records se calculate kiye gaye. AI ne koi number
              invent nahi kiya; number galat lage to pehle yehi sources check karo.
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
              {a.sources.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <button
          type="button"
          className="btn-ghost px-4 py-2 text-xs"
          onClick={() =>
            saveToVault(
              `AI CFO: ${q}`,
              `Question: ${q}\n\nDirect answer: ${a.directAnswer}\n\nExplanation: ${a.explanation}\n\nAssumptions: ${a.assumptions}${a.sources && a.sources.length > 0 ? `\n\nSources used:\n${a.sources.map((x) => `- ${x}`).join("\n")}` : ""}`,
              "AI CFO",
            )
          }
        >
          Save to Memory Vault
        </button>
      </div>
    </article>
    );
  };

  return (
    <div className="page-anim space-y-6">
      <section className="card relative overflow-hidden p-5 sm:p-6">
        <div
          aria-hidden
          className="absolute -left-24 -top-28 h-80 w-80 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(232,242,250,0.95), transparent 70%)" }}
        />
        <div
          aria-hidden
          className="absolute -right-20 -bottom-28 h-72 w-72 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(237,233,254,0.9), transparent 70%)" }}
        />
        <div className="relative flex flex-col items-center gap-5 sm:flex-row">
          <GlassOrb size={150} tone="ai" label="AI CFO" sub="The brain of your ledger" />
          <div className="text-center sm:text-left">
            <h1 className="display-font text-[27px] font-semibold tracking-tight">AI CFO</h1>
            <p className="mt-1 max-w-lg text-sm text-[var(--dim)]">
              Ask in plain language — English, Hindi ya Hinglish, teeno chalega. Every answer
              is generated on the server from your calculated figures — cash, runway, overdue
              invoices with amounts and dates, biggest leaks, savings pace, next 30 days ke
              dues — never from invented numbers. Har answer ke neeche{" "}
              <strong className="text-[var(--text)]">“What the AI used”</strong> mein exact
              figures aur dates dikhte hain jo use hue.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="AI CFO answer language">
              <span className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">Answer language:</span>
              {(
                [
                  { key: "en", label: "English" },
                  { key: "hinglish", label: "Hinglish / Hindi" },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={lang === o.key}
                  onClick={() => pickLang(o.key)}
                  className={`rounded-full px-3.5 py-2 text-xs font-extrabold transition ${
                    lang === o.key
                      ? "bg-[var(--accent)] text-white shadow-[0_6px_16px_rgba(124,58,237,0.28)]"
                      : "bg-white text-[var(--dim)] shadow-[inset_0_0_0_1px_var(--border)]"
                  }`}
                >
                  {o.label}
                </button>
              ))}
              <span className="text-xs text-[var(--dim)]">
                {lang === "hinglish" ? "Ab jawab Hinglish mein aayega — sawaal kisi bhi language mein poochho." : "Answers in English — you can still ask in Hindi or Hinglish."}
              </span>
            </div>
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-white/70 px-3 py-2 text-left text-xs text-[var(--dim)]">
              <strong className="text-[var(--text)]">Integration status:</strong>{" "}
              {state.aiProvider === "openrouter" ? (
                state.openRouterKeySaved ? (
                  <>
                    OpenRouter ({state.openRouterModel}) is the selected engine and a key is
                    saved — answers are generated by that model once a real call succeeds; until
                    then the rule-based fallback answers from your real figures below. Free{" "}
                    <code>:free</code> models are capped at 50 requests a day.
                  </>
                ) : (
                  <>
                    OpenRouter is the selected engine but no key is saved — answers come from
                    the rule-based fallback on your real figures below. Save a free OpenRouter
                    key in Settings → OpenRouter API key.
                  </>
                )
              ) : state.aiProvider === "openai" ? (
                state.openAiKeySaved ? (
                  <>
                    OpenAI (ChatGPT, {state.openAiModel}) is the selected engine and a key is
                    saved — answers are generated by ChatGPT once a real call succeeds; until
                    then the rule-based fallback answers from your real figures below. OpenAI
                    usage is billed to your OpenAI account.
                  </>
                ) : (
                  <>
                    OpenAI (ChatGPT) is the selected engine but no key is saved — answers come
                    from the rule-based fallback on your real figures below. Save an OpenAI key
                    in Settings → OpenAI API key.
                  </>
                )
              ) : state.geminiKeySaved ? (
                <>
                  Gemini is the selected engine and a key is saved — answers are generated by
                  Gemini once a real call succeeds; until then the rule-based fallback answers
                  from your real figures below.
                </>
              ) : (
                <>
                  Gemini is the selected engine but no key is saved — answers come from the
                  rule-based fallback on your real figures below. Save a key in Settings →
                  Gemini API key.
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <aside className="space-y-6 lg:col-span-1">
          <section className="card p-4" aria-label="Financial context">
            <SectionTitle title="Context panel" />
            <dl className="space-y-2 text-sm">
              {[
                ["Available cash", fmtMoney(s.cashCents, cur)],
                ["Revenue", fmtMoney(s.revenueCents, cur)],
                ["Expenses", fmtMoney(s.expensesCents, cur)],
                ["Net profit", fmtMoney(s.profitCents, cur)],
                [
                  "Outstanding invoices",
                  fmtMoney(
                    state.invoices
                      .filter((i) => i.status === "sent")
                      .reduce((a, i) => a + i.totalCents, 0),
                    cur,
                  ),
                ],
                [
                  "Overdue invoices",
                  String(state.invoices.filter((i) => i.effectiveStatus === "overdue").length),
                ],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-2">
                  <dt className="text-[var(--dim)]">{k}</dt>
                  <dd className="font-bold">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--dim)]">Cash runway</span>
                <span className="font-bold">
                  {s.runwayMonths != null ? `≈ ${s.runwayMonths.toFixed(1)} months` : "Not burning cash"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--dim)]">Saved in pots</span>
                <span className="font-bold">{fmtMoney(totalSavedCents(state), cur)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--dim)]">Next 30 days · to pay</span>
                <span className="font-bold">{fmtMoney(next30.pay, cur)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--dim)]">Next 30 days · to collect</span>
                <span className="font-bold">{fmtMoney(next30.collect, cur)}</span>
              </div>
            </div>
            {overdueInvoices.length > 0 ? (
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--err-text)]">
                  Overdue — amounts &amp; dates
                </p>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {overdueInvoices.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[var(--dim)]">
                        {i.number} — {i.customerName}
                        <span className="block text-xs">due {prettyDate(i.dueDate)}</span>
                      </span>
                      <span className="shrink-0 font-bold">{fmtMoney(i.totalCents, cur)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {state.savingsGoals.length > 0 ? (
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
                  Savings pace
                </p>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {state.savingsGoals.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[var(--dim)]">{g.name}</span>
                      <span className="shrink-0 font-bold">
                        {g.progressPct}% · {fmtMoney(g.savedCents, cur)} of {fmtMoney(g.targetCents, cur)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="card p-4" aria-label="Conversation history">
            <SectionTitle title="Conversations" />
            <button
              type="button"
              className="btn-primary mb-3 w-full px-4 py-2 text-sm"
              onClick={() => {
                setActiveId(null);
                setLocalTurns([]);
              }}
            >
              + New conversation
            </button>
            {state.conversations.length === 0 ? (
              <p className="text-sm text-[var(--dim)]">No conversations yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {state.conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-current={activeId === c.id}
                      onClick={() => {
                        setActiveId(c.id);
                        setLocalTurns([]);
                      }}
                      className={`w-full truncate rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                        activeId === c.id
                          ? "bg-[var(--surface-soft)] text-[var(--accent)]"
                          : "hover:bg-[var(--surface-soft)]"
                      }`}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <div className="space-y-5 lg:col-span-3">
          <section aria-label="Suggested questions">
            <div className="flex flex-wrap gap-2">
              {(lang === "hinglish" ? SUGGESTED_HI : SUGGESTED_EN).map((q) => (
                <button
                  key={q}
                  type="button"
                  className="btn-ghost px-4 py-2 text-sm"
                  onClick={() => submit(q)}
                  disabled={ask.isPending}
                >
                  {q}
                </button>
              ))}
            </div>
          </section>

          {state.transactions.length === 0 && state.invoices.length === 0 ? (
            <div className="rounded-2xl bg-[var(--warn)] px-4 py-3 text-sm text-[var(--warn-text)]">
              You have no financial records yet, so the AI CFO can only explain what it
              would need. Add transactions first for a grounded
              answer. <Badge tone="warn">No data</Badge>
            </div>
          ) : null}

          <div className="space-y-5" aria-live="polite">
            {storedTurns.map((t, i) =>
              t.a ? (
                answerCard(t.a, t.q, i)
              ) : (
                <article key={i} className="card p-4">
                  <p className="text-sm font-bold">You asked</p>
                  <p className="text-sm">{t.q}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--dim)]">{displayRawText(t.raw ?? "")}</p>
                </article>
              ),
            )}
            {pendingLocal.map((t, i) => answerCard(t.a, t.q, 1000 + i))}
            {ask.isPending ? (
              <div className="card flex items-center gap-3 p-4" role="status">
                <span
                  aria-hidden
                  className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent-bright)] border-t-transparent"
                />
                <p className="text-sm font-semibold">
                  The AI CFO is reading your calculated figures…
                </p>
              </div>
            ) : null}
            {!active && storedTurns.length === 0 && pendingLocal.length === 0 && !ask.isPending ? (
              <div className="card px-5 py-8 text-center">
                <p className="font-bold">Start with a suggested question, or type your own below.</p>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Answers include the numbers used, supporting data, options, and the
                  assumptions behind them.
                </p>
              </div>
            ) : null}
          </div>

          <form
            className="card flex flex-col gap-3 p-4 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
          >
            <label className="sr-only" htmlFor="cfo-question">
              Ask the AI CFO a question
            </label>
            <input
              id="cfo-question"
              className="field flex-1"
              placeholder={
                lang === "hinglish"
                  ? "e.g. Kya main is month ₹50,000 marketing par kharch kar sakta hoon?"
                  : "e.g. Can I afford to spend ₹50,000 on marketing this month?"
              }
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={1000}
            />
            <button
              type="submit"
              className="btn-primary px-6 py-2.5 text-sm"
              disabled={ask.isPending || question.trim().length < 2}
            >
              {ask.isPending ? "Thinking…" : "Ask AI CFO"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
