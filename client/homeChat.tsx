// ---------- Home AI chat — pinned assistant on the home screen ----------
// A floating button on the dashboard (home screen only) that opens a
// chat sheet. The owner talks to it like an AI — "add ₹500 for food",
// "set a ₹5,000 food budget" — and it does the work itself through
// the askHomeChat server action. Safe, complete requests execute at
// once and say what was done (a new transaction offers Undo); a
// delete, a currency change or anything doubtful comes back as a
// confirm card that only runs when the owner taps "Yes, do it".
//
// History lives in localStorage, one thread per workspace — the chat
// keeps no server history, so no migration was needed. The server
// action is marked read-only in client/api.ts (a chat reply must not
// refetch the ledger), so this component dispatches "cg:mutated"
// itself, and only when a reply actually wrote something.
import { useEffect, useRef, useState } from "react";
import { api, type ApiResponse } from "./api";
import { AiAvatar } from "./AiAvatar";

type HomeChatReply = ApiResponse<typeof api, "askHomeChat">;

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  confirm?: NonNullable<HomeChatReply["confirm"]>;
  done?: NonNullable<HomeChatReply["done"]>;
  undone?: boolean;
  answered?: boolean;
};

const HISTORY_KEY = (mode: string) => `cg-home-chat:${mode}`;
const MAX_HISTORY = 30;

const QUICK_CHIPS = ["How much money do I have?", "Add ₹500 for food", "Set a ₹5,000 food budget"];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function loadHistory(mode: string): ChatMsg[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY(mode));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMsg[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => m && typeof m.text === "string").slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

export function HomeChatFab({ mode }: { mode: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadHistory(mode));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A workspace switch loads that workspace's own thread.
  useEffect(() => {
    setMessages(loadHistory(mode));
    setInput("");
    setError(null);
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY(mode), JSON.stringify(messages.slice(-MAX_HISTORY)));
    } catch {
      /* history is a convenience, never a blocker */
    }
  }, [messages, mode]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open ]);

  async function callChat(message: string, confirmedPlan?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const history = [...messages, { id: uid(), role: "user" as const, text: message }]
        .slice(-8)
        .map((m) => ({ role: m.role, text: m.text }));
      const res = await api.askHomeChat({ message, history, confirmedPlan });
      const asst: ChatMsg = {
        id: uid(),
        role: "assistant",
        text: res.reply,
        confirm: res.confirm ?? undefined,
        done: res.done ?? undefined,
      };
      setMessages((m) => [...m, asst]);
      if (res.done) {
        window.dispatchEvent(
          new CustomEvent("cg:mutated", { detail: { action: "askHomeChat", args: {}, data: res } }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setMessages((m) => [...m, { id: uid(), role: "user", text: trimmed }]);
    setInput("");
    await callChat(trimmed);
  }

  async function confirmPlan(msgId: string, plan: unknown) {
    setMessages((m) =>
      m.map((x) => (x.id === msgId ? { ...x, confirm: undefined, answered: true } : x)),
    );
    setMessages((m) => [...m, { id: uid(), role: "user", text: "Yes, do it." }]);
    await callChat("Yes, do it.", plan);
  }

  function declinePlan(msgId: string) {
    setMessages((m) =>
      m.map((x) =>
        x.id === msgId
          ? { ...x, confirm: undefined, answered: true, text: `${x.text}\n— No, leave it.` }
          : x,
      ),
    );
  }

  async function undoTransaction(msgId: string, txnId: string) {
    try {
      await api.deleteTransaction({ id: txnId });
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, undone: true } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo that.");
    }
  }

  return (
    <>
      <button
        type="button"
        className="no-print fixed bottom-40 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full shadow-[0_14px_30px_rgba(124,58,237,0.4)] ring-4 ring-white transition hover:scale-105 lg:bottom-24"
        aria-label={open ? "Close AI chat" : "Open AI chat"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <AiAvatar size={56} label="AI chat" />
      </button>

      {open ? (
        <div
          className="fixed inset-x-3 bottom-20 z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_24px_60px_rgba(30,20,60,0.35)] lg:inset-x-auto lg:bottom-24 lg:right-6 lg:h-[600px] lg:max-h-[600px] lg:w-[400px]"
          role="dialog"
          aria-label="AI chat"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <AiAvatar size={36} />
            <div className="flex-1">
              <p className="text-sm font-extrabold">Home Assistant</p>
              <p className="text-[11px] font-semibold text-[var(--dim)]">
                Ask me anything — or tell me to do it.
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none"
              aria-label="Close AI chat"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-sm font-bold">Hi, I&apos;m your home assistant.</p>
                <p className="mx-auto mt-1 max-w-[260px] text-xs font-semibold leading-relaxed text-[var(--dim)]">
                  Ask about your money, or tell me to do something — add an expense, set a budget, start a
                  savings goal. If I&apos;m unsure, I&apos;ll ask before I do anything.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {QUICK_CHIPS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="rounded-full bg-[var(--surface-soft)] px-3 py-1.5 text-xs font-bold text-[var(--accent)]"
                      onClick={() => void send(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                        m.role === "user"
                          ? "bg-[linear-gradient(120deg,#7c3aed,#d946ef,#fb7185)] font-semibold text-white"
                          : "bg-[var(--surface-soft)] font-medium"
                      }`}
                    >
                      {m.text}
                      {m.confirm ? (
                        <div className="mt-2 rounded-xl bg-[var(--surface)] p-2.5 ring-1 ring-[var(--border)]">
                          <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">
                            Shall I do this?
                          </p>
                          <p className="mt-1 text-sm font-bold">{m.confirm.summary}</p>
                          {m.confirm.match ? (
                            <p className="mt-1 text-xs font-semibold text-[var(--dim)]">{m.confirm.match.label}</p>
                          ) : null}
                          <div className="mt-2 flex gap-1.5">
                            <button
                              type="button"
                              className="btn-primary flex-1 px-3 py-2 text-xs"
                              onClick={() => void confirmPlan(m.id, m.confirm!.plan)}
                            >
                              Yes, do it
                            </button>
                            <button
                              type="button"
                              className="btn-ghost flex-1 px-3 py-2 text-xs"
                              onClick={() => declinePlan(m.id)}
                            >
                              No
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {m.done ? (
                        <div className="mt-2">
                          <p className="text-xs font-bold text-[var(--dim)]">{m.done.summary}</p>
                          {m.done.undoId && m.done.undoKind === "transaction" && !m.undone ? (
                            <button
                              type="button"
                              className="mt-1.5 rounded-full bg-[var(--surface)] px-3 py-1 text-xs font-extrabold text-[var(--accent)] ring-1 ring-[var(--border)]"
                              onClick={() => void undoTransaction(m.id, m.done!.undoId!)}
                            >
                              Undo
                            </button>
                          ) : null}
                          {m.undone ? (
                            <p className="mt-1.5 text-xs font-bold text-[var(--dim)]">Undone.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
                {busy ? (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-2xl bg-[var(--surface-soft)] px-3 py-2">
                      <AiAvatar size={24} pulse label="AI is thinking" />
                      <span className="text-sm font-semibold text-[var(--dim)]">Thinking…</span>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {error ? (
              <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] p-3">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send(input);
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Ask or tell me to do something…"
              aria-label="Message the AI assistant"
              className="min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface-soft)] px-4 py-2.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
            <button
              type="button"
              className="btn-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
              aria-label="Send message"
              disabled={busy || !input.trim()}
              onClick={() => void send(input)}
            >
              ↑
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
