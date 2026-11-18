import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { buildTurns, displayRawText } from "./cfoHistory";
import { addDays, buildCalendarEvents, fmtMoney, prettyDate, summarise, todayStr, totalSavedCents } from "./lib";
import type { PageProps } from "./types";
import { Badge, GlassOrb, SectionTitle } from "./components";

type CfoAnswer = ApiResponse<typeof api, "askCfo">["answer"];
type CfoLang = "en" | "hinglish";

/* Only three suggestions, by Sarya's call (2026-11-18): a wall of 16 chips
   was too much. Two Hinglish + one English, the most useful CFO questions. */
const SUGGESTED_EN = [
    "Which invoices are overdue?",
  ];

const SUGGESTED_HI = [
    "Mera profit kam kyun ho raha hai?",
    "Mera paisa kahan leak ho raha hai?",
  ];

/** "What the AI used — sources" as a collapsed block: only the heading
 *  and a Read more button show by default, so a long sources list no
 *  longer pushes the answer down the page. Tapping Read more reveals
 *  the explainer and the full list; Show less collapses it again. */
function SourcesBlock({
  num,
  sources,
  language,
}: {
  num: number;
  sources: string[];
  language?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--surface-soft)] px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--accent)]">
          {num} · What the AI used — sources {language === "hinglish" ? "· Hinglish answer" : ""}
        </h3>
        <span className="shrink-0 text-xs font-bold text-[var(--accent)]">
          {open ? "Show less ▴" : `Read more (${sources.length}) ▾`}
        </span>
      </button>
      {open ? (
        <>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Ye exact figures aur dates hain jo is answer ko banane mein use hue — server par
            tumhare active workspace ke records se calculate kiye gaye. AI ne koi number
            invent nahi kiya; number galat lage to pehle yehi sources check karo.
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
            {sources.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The AI answers in the language the question was asked in — there is
 *  no language toggle. Devanagari script, or a distinctive Hinglish
 *  word, means Hinglish; everything else is English. */
function detectQuestionLang(q: string): CfoLang {
  if (/[\u0900-\u097F]/.test(q)) return "hinglish";
  if (
    /\b(kya|kyun|kaise|kitna|kitne|kitni|kahan|kab|mera|meri|mere|mujhe|tumhara|tumhari|tumhare|aapka|aapki|paisa|kharcha|kharche|bachat|mahina|raha|rahi|rahe|batao|bataiye|chahiye|sakta|sakti|sakte|nahi|hai|hain|aur|bhi|ho|tha|thi|kar|karo)\b/i.test(
      q,
    )
  ) {
    return "hinglish";
  }
  return "en";
}

export function AiCfoPage({ state, notify, confirm, saveToVault }: PageProps) {
  const cur = state.business.currency;
  const s = useMemo(() => summarise(state), [state]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [localTurns, setLocalTurns] = useState<
    { q: string; a: CfoAnswer }[]
  >([]);

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
      api.askCfo({ conversationId: activeId, question: q, language: detectQuestionLang(q) }),
    onSuccess: (res, q) => {
      setActiveId(res.conversationId);
      setLocalTurns((t) => [...t, { q, a: res.answer }]);
      setQuestion("");
    },
    onError: (e) =>
      notify(`AI CFO could not answer: ${e instanceof Error ? e.message : String(e)}`),
  });

    // Auto-scroll on a new answer: when a turn is added in this session,
  // bring the end of the chat into view above the pinned composer, so the
  // latest answer is visible without scrolling manually. The sentinel is
  // scrolled into view (not window.scrollTo) because scrollIntoView scrolls
  // whichever ancestor actually scrolls the page — the window on a phone,
  // or an inner container if one applies. Keyed on localTurns only, so
  // switching conversations, or a refetch moving a turn from pendingLocal
  // into storedTurns, never scrolls — only a real new answer does.
  const endRef = useRef<HTMLDivElement | null>(null);
  const answeredCount = useRef(0);
  useEffect(() => {
    if (localTurns.length > answeredCount.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    answeredCount.current = localTurns.length;
  }, [localTurns.length]);

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2 || ask.isPending) return;
    ask.mutate(trimmed);
  };

  // Delete a conversation only after the shared confirm dialog — there
  // is no undo for a deleted conversation, so the dialog is the guard.
  const delConversation = useMutation({
    mutationFn: (id: string) => api.deleteConversation({ conversationId: id }),
    onSuccess: (_res, id) => {
      if (activeId === id) {
        setActiveId(null);
        setLocalTurns([]);
      }
      notify("Conversation deleted.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteConversation = async (c: { id: string; title: string }) => {
    const ok = await confirm({
      title: "Delete this conversation?",
      body: "The whole conversation — every question and answer in it — will be removed. This cannot be undone.",
      detail: c.title,
      confirmLabel: "Delete conversation",
      danger: true,
    });
    if (ok) delConversation.mutate(c.id);
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
          <SourcesBlock num={num()} sources={a.sources} language={a.language} />
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
         <>
    <div className="page-anim space-y-6 pb-8">
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
                  <li key={c.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-current={activeId === c.id}
                      onClick={() => {
                        setActiveId(c.id);
                        setLocalTurns([]);
                      }}
                      className={`min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                        activeId === c.id
                          ? "bg-[var(--surface-soft)] text-[var(--accent)]"
                          : "hover:bg-[var(--surface-soft)]"
                      }`}
                    >
                      {c.title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete conversation ${c.title}`}
                      onClick={() => askDeleteConversation(c)}
                      className="shrink-0 rounded-lg px-2 py-2 text-sm text-[var(--dim)] hover:bg-[var(--surface-soft)] hover:text-[var(--err-text)]"
                    >
                      🗑
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
              {[...SUGGESTED_HI, ...SUGGESTED_EN].map((q) => (
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
            {/* End-of-chat marker for the auto-scroll above. scroll-mb-36
                (144px) keeps the last answer clear of the pinned composer
                (bottom-16 plus its own height) and the bottom nav. */}
            <div ref={endRef} className="scroll-mb-36" aria-hidden />
          </div>

        </div>
      </div>
    </div>
    {/* The composer sits OUTSIDE .page-anim on purpose. .page-anim runs an
        entrance animation, and any transform on an ancestor — even one left
        over after the animation finishes — makes that ancestor the
        containing block for position:fixed, so the composer scrolled away
        with the page instead of staying pinned. Outside the animated
        subtree, fixed bottom-16 pins it to the viewport itself (just above
        the mobile bottom nav) on every load — in the AI CFO tab only. */}
    <form
      className="card fixed inset-x-4 bottom-16 z-30 flex flex-row gap-2 p-3 shadow-[0_-8px_24px_rgba(76,29,149,0.10)] lg:sticky lg:inset-x-0 lg:bottom-0 lg:gap-3 lg:p-4"
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
        placeholder="Ask anything"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={1000}
      />
      <button
        type="submit"
        className="btn-primary shrink-0 px-4 py-2.5 text-sm sm:px-6"
        disabled={ask.isPending || question.trim().length < 2}
      >
        {ask.isPending ? "Thinking…" : "Ask AI CFO"}
      </button>
    </form>
    </>
  );
}
