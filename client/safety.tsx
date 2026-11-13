// ---------- Confirmation + Undo safety system ----------
// One shared confirmation dialog and one undo snackbar for the whole
// app. Every delete and every big/irreversible step goes through
// `confirm(...)` first — nothing deletes or moves money on a single
// tap any more. After a delete succeeds, the caller passes the
// server-issued trashId to notifyDeleted(...), which shows the undo
// snackbar; tapping Undo calls restoreDeletedItem, which re-inserts
// the exact snapshotted record (and its linked rows) server-side.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Extra line naming exactly what will be affected (optional). */
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button — for deletes and destructive steps. */
  danger?: boolean;
}

export interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmDialog({
  state,
  onDone,
}: {
  state: ConfirmState | null;
  onDone: (ok: boolean) => void;
}) {
  if (!state) return null;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-[rgba(26,16,54,0.45)] p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="alertdialog"
      aria-modal="true"
      aria-label={state.title}
      onClick={() => onDone(false)}
    >
      <div
        className="glass rise w-full max-w-md rounded-t-[28px] p-6 sm:rounded-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-xl ${
              state.danger
                ? "bg-[var(--err)] text-[var(--err-text)]"
                : "bg-[var(--surface-soft)] text-[var(--accent)]"
            }`}
          >
            {state.danger ? "🗑" : "✦"}
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold leading-snug">{state.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{state.body}</p>
            {state.detail ? (
              <p className="mt-2 rounded-2xl bg-[var(--surface-soft)] px-3 py-2 text-sm font-semibold leading-relaxed">
                {state.detail}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn-ghost min-h-[48px] px-4 py-3 text-sm"
            onClick={() => onDone(false)}
            autoFocus
          >
            {state.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`min-h-[48px] rounded-full px-4 py-3 text-sm font-extrabold text-white transition active:scale-[0.97] ${
              state.danger
                ? "bg-[#e0443a] shadow-[0_10px_24px_rgba(224,68,58,0.35)] hover:brightness-105"
                : "btn-primary"
            }`}
            onClick={() => onDone(true)}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ToastState {
  id: number;
  msg: string;
  /** When set, the toast shows an Undo button wired to this snapshot. */
  trashId?: string | null;
  label?: string;
}

/** Hook owning the app shell's confirm dialog + toast/undo state. */
export function useSafety(refresh: () => void) {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((t: ToastState, ms = 5000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  /** Plain notification (no undo). */
  const notify = useCallback(
    (msg: string) => showToast({ id: Date.now(), msg }, 4600),
    [showToast],
  );

  /** Notification after a successful delete, with a real Undo button.
   *  Stays up for 12 seconds — long enough to actually tap it. */
  const notifyDeleted = useCallback(
    (msg: string, trashId: string | null | undefined, label?: string) =>
      showToast({ id: Date.now(), msg, trashId: trashId ?? null, label }, 12000),
    [showToast],
  );

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...opts, resolve });
    });
  }, []);

  const resolveConfirm = useCallback(
    (ok: boolean) => {
      setConfirmState((cur) => {
        cur?.resolve(ok);
        return null;
      });
    },
    [],
  );

  const undo = useCallback(async () => {
    const t = toast;
    if (!t?.trashId) return;
    const trashId = t.trashId;
    setToast(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    try {
      const res = await api.restoreDeletedItem({ trashId });
      if (res.ok) {
        showToast(
          { id: Date.now(), msg: `Restored — “${res.label || t.label || "item"}” is back, exactly as it was.` },
          4600,
        );
      } else {
        showToast({ id: Date.now(), msg: res.error ?? "Undo could not restore that item." }, 6000);
      }
    } catch (e) {
      showToast(
        { id: Date.now(), msg: `Undo failed: ${e instanceof Error ? e.message : String(e)}` },
        6000,
      );
    } finally {
      refresh();
    }
  }, [toast, showToast, refresh]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  return { confirmState, resolveConfirm, toast, setToast, notify, notifyDeleted, confirm, undo };
}

export function UndoToast({
  toast,
  onUndo,
  onClose,
}: {
  toast: ToastState;
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="toast-in no-print fixed inset-x-4 bottom-24 z-[70] mx-auto flex max-w-md items-center gap-3 rounded-[22px] bg-[#1d1440] px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_rgba(29,20,64,0.4)] lg:bottom-8"
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0 flex-1 leading-snug">{toast.msg}</span>
      {toast.trashId ? (
        <button
          type="button"
          className="shrink-0 rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-orange-400 px-4 py-2 text-sm font-extrabold text-white transition active:scale-95"
          onClick={onUndo}
          aria-label={`Undo delete of ${toast.label ?? "the deleted item"}`}
        >
          ↩ Undo
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded-full px-2 py-1 text-white/70 transition hover:text-white"
        onClick={onClose}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
