import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setAuthToken } from "./api";
import { MODE_ICONS, MODE_LABELS, NOTE_CATEGORIES, currencyConfirmOptions, downloadFile, isPersonalLike, modeOf, workspaceHasMoney, type AppMode, type Note } from "./lib";
import type { PageProps } from "./types";
import { Badge, EmptyState, Field, Modal, ModePicker, SectionTitle } from "./components";
import { CurrencyPicker } from "./currencyPicker";
import {
CURSOR_OPTIONS,
applyCursorStyle,
cursorLabel,
DEFAULT_CURSOR_STYLE,
getStoredCursorStyle,
type CursorStyle,
} from "./cursor";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export function VaultPage({ state, notify, notifyDeleted, confirm, openNoteId }: PageProps) {
  const tz = state.business.timezone || "Asia/Kolkata";
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (openNoteId && state.notes.some((n) => n.id === openNoteId)) {
      setSelectedId(openNoteId);
    }
  }, [openNoteId, state.notes]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [sort, setSort] = useState<"updated" | "created" | "title">("updated");
  const [showVersions, setShowVersions] = useState(false);

  const selected = state.notes.find((n) => n.id === selectedId) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api.saveNote({
        title: "Untitled note",
        content: "",
        category: "General",
        tags: "",
        pinned: false,
      }),
    onSuccess: (res) => setSelectedId(res.id),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const shown = useMemo(() => {
    const list = state.notes.filter((n) => {
      if (catFilter !== "all" && n.category !== catFilter) return false;
      if (
        search &&
        !`${n.title} ${n.content} ${n.tags}`.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
    const sorted = [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return sorted;
  }, [state.notes, catFilter, search, sort]);

  const fmtTs = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="page-anim space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-font text-[27px] font-semibold tracking-tight">Notes — Memory Vault</h1>
          <p className="text-sm text-[var(--dim)]">
            {isPersonalLike(modeOf(state)) ? "Your money notebook." : "Your business notebook."} Notes auto-save as you type, every earlier version
            is kept, and timestamps are stored in UTC and shown in {tz}.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-5 py-2.5 text-sm"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          + New note
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <section className="space-y-4 lg:col-span-2" aria-label="Note list">
          <div className="card space-y-3 p-4">
            <label className="block">
              <span className="sr-only">Search notes</span>
              <input className="field" placeholder="Search title, content, tags…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search notes" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="sr-only">Filter by category</span>
                <select className="field" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label="Filter notes by category">
                  <option value="all">All categories</option>
                  {NOTE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="sr-only">Sort notes</span>
                <select className="field" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort notes">
                  <option value="updated">Recently edited</option>
                  <option value="created">Recently created</option>
                  <option value="title">Title A–Z</option>
                </select>
              </label>
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title="No notes here yet"
              body="Create a note, or use the floating Quick Note button anywhere in the app. AI CFO answers, forecasts, scenarios and scanner findings can all be saved here too."
              action={
                <button type="button" className="btn-primary px-5 py-2.5 text-sm" onClick={() => create.mutate()}>
                  Write your first note
                </button>
              }
            />
          ) : (
            <ul className="space-y-3">
              {shown.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    aria-current={selectedId === n.id}
                    onClick={() => setSelectedId(n.id)}
                    className={`card block w-full p-4 text-left transition hover:shadow-md ${
                      selectedId === n.id ? "border-[var(--accent-bright)]" : ""
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-extrabold">
                        {n.pinned ? "📌 " : ""}{n.title}
                      </span>
                      {n.demo ? <Badge tone="warn">Demo</Badge> : null}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm text-[var(--dim)]">
                      {n.content || "Empty note"}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="mint">{n.category}</Badge>
                      {n.sourceModule ? <Badge tone="ai">From {n.sourceModule}</Badge> : null}
                      <Badge tone="grey">Edited {fmtTs(n.updatedAt)}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="lg:col-span-3" aria-label="Note editor">
          {selected ? (
            <NoteEditor
              key={selected.id}
              note={selected}
              tz={tz}
              notify={notify}
              notifyDeleted={notifyDeleted}
              confirm={confirm}
              onShowVersions={() => setShowVersions(true)}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <div className="card flex h-full min-h-64 items-center justify-center px-6 py-12 text-center">
              <div>
                <p className="font-extrabold">Pick a note to open the editor</p>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Glass note cards expand into the full editor here, with version history
                  one tap away.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      {showVersions && selected ? (
        <VersionsModal
          note={selected}
          tz={tz}
          onClose={() => setShowVersions(false)}
          notify={notify}
          confirm={confirm}
        />
      ) : null}
    </div>
  );
}

function NoteEditor({
  note,
  tz,
  notify,
  notifyDeleted,
  confirm,
  onShowVersions,
  onDeleted,
}: {
  note: Note;
  tz: string;
  notify: (m: string) => void;
  notifyDeleted: PageProps["notifyDeleted"];
  confirm: PageProps["confirm"];
  onShowVersions: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [category, setCategory] = useState(note.category);
  const [tags, setTags] = useState(note.tags);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const lastSaved = useRef({
    title: note.title,
    content: note.content,
    category: note.category,
    tags: note.tags,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useMutation({
    mutationFn: (payload: { title: string; content: string; category: string; tags: string }) =>
      api.saveNote({ id: note.id, pinned: note.pinned, ...payload }),
    onSuccess: (res, payload) => {
      lastSaved.current = payload;
      setStatus("saved");
      setSavedAt(res.updatedAt);
    },
    onError: () => setStatus("failed"),
  });
  const saveRef = useRef(save.mutate);
  saveRef.current = save.mutate;

  useEffect(() => {
    const current = { title, content, category, tags };
    const prev = lastSaved.current;
    if (
      current.title === prev.title &&
      current.content === prev.content &&
      current.category === prev.category &&
      current.tags === prev.tags
    ) {
      return;
    }
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setStatus("saving");
      saveRef.current({ title, content, category, tags });
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [title, content, category, tags]);

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      api.saveNote({
        id: note.id,
        title: lastSaved.current.title,
        content: lastSaved.current.content,
        category: lastSaved.current.category,
        tags: lastSaved.current.tags,
        pinned,
      }),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: () => api.deleteNote({ id: note.id }),
    onSuccess: (res) => {
      notifyDeleted(`Note deleted — “${note.title}”.`, res.trashId, note.title);
      onDeleted();
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteNote = async () => {
    const ok = await confirm({
      title: `Delete note “${note.title}”?`,
      body: "The note and its version history will be removed from the Memory Vault. You can undo it right after from the Undo button — the note and its versions come back exactly as they were.",
      detail: `${note.category}${note.tags ? ` · ${note.tags}` : ""} · last edited ${new Date(note.updatedAt).toLocaleDateString("en-IN")}`,
      confirmLabel: "Delete note",
      danger: true,
    });
    if (ok) del.mutate();
  };

  const fmtTs = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="card rise overflow-hidden">
      <div className="border-b border-[var(--border)] bg-[var(--surface-soft)] px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[var(--dim)]">
            Created {fmtTs(note.createdAt)} · Last edited {fmtTs(savedAt ?? note.updatedAt)}
          </p>
          <p className="text-xs font-bold" role="status" aria-live="polite">
            {status === "saving" ? (
              <span className="text-[var(--dim)]">Saving…</span>
            ) : status === "saved" ? (
              <span className="text-[var(--accent)]">Saved ✓</span>
            ) : status === "failed" ? (
              <span className="text-[var(--err-text)]">
                Save failed —{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setStatus("saving");
                    save.mutate({ title, content, category, tags });
                  }}
                >
                  Retry
                </button>
              </span>
            ) : (
              <span className="text-[var(--dim)]">Auto-save on</span>
            )}
          </p>
        </div>
      </div>
      <div className="space-y-4 p-5">
        <label className="block">
          <span className="sr-only">Note title</span>
          <input
            className="w-full border-none bg-transparent text-xl font-extrabold outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Note title"
            placeholder="Note title"
            maxLength={200}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <select className="field" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Note category">
              {NOTE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Tags (comma separated)">
            <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Note tags" placeholder="gst, planning" />
          </Field>
        </div>
        <label className="block">
          <span className="sr-only">Note content (Markdown supported)</span>
          <textarea
            className="field min-h-64 leading-relaxed"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            aria-label="Note content"
            placeholder="Write in plain text or Markdown — # headings, - lists, **bold** all render as you wrote them."
          />
        </label>
        {note.sourceModule ? (
          <p className="text-xs text-[var(--dim)]">
            Saved from {note.sourceModule}
            {note.sourceId ? ` · source ${note.sourceId}` : ""}. The original creation
            time above never changes when you edit.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm"
            onClick={() => pin.mutate(!note.pinned)}
            disabled={pin.isPending}
          >
            {note.pinned ? "Unpin note" : "Pin note"}
          </button>
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onShowVersions}>
            Version history
          </button>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm text-[var(--err-text)]"
            onClick={() => void askDeleteNote()}
            disabled={del.isPending}
          >
            Delete note
          </button>
        </div>
      </div>
    </div>
  );
}

function VersionsModal({
  note,
  tz,
  onClose,
  notify,
  confirm,
}: {
  note: Note;
  tz: string;
  onClose: () => void;
  notify: (m: string) => void;
  confirm: PageProps["confirm"];
}) {
  const versions = useQuery({
    queryKey: ["note-versions", note.id],
    queryFn: () => api.listNoteVersions({ noteId: note.id }),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api.restoreNoteVersion({ noteId: note.id, versionId }),
    onSuccess: () => {
      notify("Version restored. Your previous content was kept as a new version.");
      onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const fmtTs = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Modal title={`Version history — ${note.title}`} onClose={onClose} wide>
      {versions.isPending ? (
        <p className="text-sm text-[var(--dim)]">Loading versions…</p>
      ) : versions.isError ? (
        <p className="text-sm text-[var(--err-text)]">Versions could not be loaded.</p>
      ) : versions.data && versions.data.versions.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          No earlier versions yet. Each time you edit this note, the previous version is
          stored here automatically.
        </p>
      ) : (
        <ul className="space-y-3">
          {versions.data?.versions.map((v) => (
            <li key={v.id} className="rounded-2xl border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold">{v.title}</p>
                <span className="flex items-center gap-2">
                  <Badge tone="grey">{fmtTs(v.createdAt)}</Badge>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1 text-xs"
                    aria-label={`Restore version from ${fmtTs(v.createdAt)}`}
                    disabled={restore.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Restore this version?",
                        body: "The note's current title and content will be replaced by this older version. Nothing is lost — the current version is kept in the history first, so you can restore back.",
                        detail: `Version from ${fmtTs(v.createdAt)} · “${v.title}”`,
                        confirmLabel: "Restore version",
                      });
                      if (ok) restore.mutate(v.id);
                    }}
                  >
                    Restore this version
                  </button>
                </span>
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-[var(--dim)]">
                {v.content || "(empty)"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---------------- Settings ----------------

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "UTC",
];

export function SettingsPage({ state, go, notify, notifyDeleted, confirm, onShowTour, currencyBusy }: PageProps) {
  const b = state.business;
  const appMode = modeOf(state);
  const personal = isPersonalLike(appMode);
  const [name, setName] = useState(b.name);
  const [industry, setIndustry] = useState(b.industry);
  const [country, setCountry] = useState(b.country);
  const [currency, setCurrency] = useState(b.currency);
  const [opening, setOpening] = useState(String(b.openingBalanceCents / 100));
  const [timezone, setTimezone] = useState(b.timezone);
  const [ownerName, setOwnerName] = useState(b.ownerName);
  const [ownerEmail, setOwnerEmail] = useState(b.ownerEmail);
  const [ownerPhone, setOwnerPhone] = useState(b.ownerPhone);

  const save = useMutation({
    mutationFn: () =>
      api.updateBusiness({
        mode: b.mode,
        name,
        industry,
        country,
        currency,
        openingBalanceCents: Math.round((parseFloat(opening) || 0) * 100),
        timezone,
        ownerName,
        ownerEmail,
        ownerPhone,
        gstRateBp: b.gstRateBp,
        gstInclusive: b.gstInclusive,
        eligibleExpensePct: b.eligibleExpensePct,
        onboarded: true,
      }),
    onSuccess: () => notify(personal ? "Profile saved." : "Business profile saved."),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  // Saving the profile with a different currency converts every amount
  // in this workspace at the live rate, so a workspace with money asks
  // first (same question as the top-bar selector). While any currency
  // conversion is running — this save, or the top-bar one — the
  // currency control below is disabled and shows Converting…, so a
  // second conversion can never be fired behind the first.
  const convertingNow = currency !== b.currency && (save.isPending || currencyBusy === true);
  const submitProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (save.isPending || currencyBusy === true) return;
    if (currency !== b.currency && workspaceHasMoney(state)) {
      const ok = await confirm(
        currencyConfirmOptions(b.currency, currency, MODE_LABELS[appMode]),
      );
      if (!ok) return;
    }
    save.mutate();
  };
  const askSwitchMode = async (m: AppMode) => {
    if (m === appMode) return;
    const ok = await confirm({
      title: `Switch to ${MODE_LABELS[m]}?`,
      body: `You will now see the ${MODE_LABELS[m]} workspace — its own transactions, budgets, savings and notes.`,
      detail: `Your ${MODE_LABELS[appMode]} workspace stays saved exactly as it is. Switching never moves, merges or deletes any record.`,
      confirmLabel: `Switch to ${MODE_LABELS[m]}`,
    });
    if (ok) switchMode.mutate(m);
  };
  const switchMode = useMutation({
    mutationFn: (m: AppMode) => api.setMode({ mode: m }),
    onSuccess: (_res, m) => {
      if (m === appMode) return;
      notify(
        `${MODE_LABELS[m]} is on — you are now in that separate workspace. Every record in your other workspaces is exactly where you left it.`,
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const doLogout = async () => {
    try {
      await api.logout({});
    } catch {
      /* session already gone */
    }
    setAuthToken(null);
    // The saved cursor choice stays on the account (server-side); the
    // local cache resets to the default so it never leaks to the next
    // account on this device.
    applyCursorStyle(DEFAULT_CURSOR_STYLE);
    window.location.hash = "";
    window.location.reload();
  };

  // ---- Cursor style (per account, desktop only) ----
  const cursorQueryClient = useQueryClient();
  const [cursorChoice, setCursorChoice] = useState<CursorStyle>(
    () => state.cursorStyle ?? getStoredCursorStyle(),
  );
  // Keep the picker in step with the account's saved value if state
  // reloads (e.g. after signing in on this device).
  useEffect(() => {
    if (state.cursorStyle) setCursorChoice(state.cursorStyle);
  }, [state.cursorStyle]);
  // Custom cursors need a mouse/trackpad: on touch-only devices the
  // picker explains that instead of offering options that can't show.
  const [finePointer] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false,
  );
  const saveCursor = useMutation({
    mutationFn: (style: CursorStyle) => api.setCursorStyle({ style }),
    onSuccess: (_res, style) => {
      void cursorQueryClient.invalidateQueries({ queryKey: ["cg-state"] });
      notify(
        style === "off"
          ? "Cursor set to Off / Default — your normal system arrow is back, everywhere in the app."
          : `Cursor changed to ${cursorLabel(style)} — it applies everywhere right away and is remembered for your account.`,
      );
    },
    onError: (e, style) => {
      // Roll the live cursor and the picker back to the saved choice.
      const fallback = state.cursorStyle ?? DEFAULT_CURSOR_STYLE;
      if (style !== fallback) {
        setCursorChoice(fallback);
        applyCursorStyle(fallback);
      }
      notify(e instanceof Error ? e.message : String(e));
    },
  });
  const pickCursor = (style: CursorStyle) => {
    if (style === cursorChoice || saveCursor.isPending) return;
    // Apply first, save second: the new cursor shows immediately,
    // across the whole app, with no reload — the server save makes it
    // stick for this account.
    setCursorChoice(style);
    applyCursorStyle(style);
    saveCursor.mutate(style);
  };

  // ---- Backup / restore / undo / account control ----
  const backupFileRef = useRef<HTMLInputElement>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const exportBackup = useMutation({
    mutationFn: () => api.exportBackup({}),
    onSuccess: (data) => {
      downloadFile(
        `cashflow-genius-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        "application/json",
      );
      notify("Full backup downloaded — it covers every workspace, with categories, payees, payment methods, budgets, invoices and notes preserved.");
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const restoreBackup = useMutation({
    mutationFn: (backup: unknown) =>
      api.restoreBackup({ backup: backup as never }),
    onSuccess: (res) =>
      setRestoreMsg(`${res.restored} record(s) restored, ${res.skipped} already present and skipped. Nothing was overwritten or deleted.`),
    onError: (e) => setRestoreMsg(`Restore failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const undoImport = useMutation({
    mutationFn: () => api.undoLastImport({}),
    onSuccess: (res) =>
      res.found
        ? notifyDeleted(`Import undone — ${res.removed} imported transaction(s) removed from this workspace.`, res.trashId, "CSV import")
        : notify("No CSV import to undo in this workspace."),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askUndoImport = async () => {
    const ok = await confirm({
      title: "Undo the last CSV import?",
      body: "Every transaction that the last CSV import added in this workspace will be removed. Entries you added by hand are never touched — and you can undo this undo.",
      confirmLabel: "Undo import",
      danger: true,
    });
    if (ok) undoImport.mutate();
  };
  const lastImport = state.activity.find((a) => a.action === "CSV import");

  // ---- Custom categories (this workspace) ----
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const renameCat = useMutation({
    mutationFn: (v: { type: "income" | "expense"; oldName: string; newName: string }) =>
      api.renameCustomCategory(v),
    onSuccess: (res) => notify(`Category renamed — ${res.updated} record(s) and list(s) updated in this workspace.`),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const deleteCat = useMutation({
    mutationFn: (v: { type: "income" | "expense"; name: string }) => api.deleteCustomCategory(v),
    onSuccess: (res, v) => notifyDeleted(`Custom category “${v.name}” removed from this workspace's list. Records already using it keep it.`, res.trashId, v.name),
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  const askDeleteCat = async (v: { type: "income" | "expense"; name: string }) => {
    const ok = await confirm({
      title: `Remove custom category “${v.name}”?`,
      body: "It will disappear from this workspace's category dropdowns. Records already using this name keep it — nothing in your ledger is deleted — and you can undo this right after.",
      detail: `${v.type === "income" ? "Income" : "Expense"} category · ${MODE_LABELS[appMode]} only`,
      confirmLabel: "Remove category",
      danger: true,
    });
    if (ok) deleteCat.mutate(v);
  };

  // ---- Change login / delete account ----
  const [newIdentifier, setNewIdentifier] = useState("");
  const [idPassword, setIdPassword] = useState("");
  const [delPassword, setDelPassword] = useState("");
  const [delConfirm, setDelConfirm] = useState("");
  const changeId = useMutation({
    mutationFn: () => api.changeIdentifier({ newIdentifier: newIdentifier.trim(), password: idPassword }),
    onSuccess: (res) => {
      setNewIdentifier("");
      setIdPassword("");
      notify(`Login updated — you now sign in with ${res.identifier}. Your records were not touched.`);
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });
  const deleteAcct = useMutation({
    mutationFn: () => api.deleteAccount({ password: delPassword, confirm: delConfirm.trim() }),
    onSuccess: () => {
      setAuthToken(null);
      window.location.hash = "";
      window.location.reload();
    },
    onError: (e) => notify(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="page-anim space-y-6">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-[var(--dim)]">
          {personal
            ? "Your mode, profile, preferences and how this workspace is wired."
            : "Your mode, business profile, preferences and how this workspace is wired."}
        </p>
      </div>

      <section className="card p-5" aria-label="How you use Cashflow Genius">
        <SectionTitle
          title="How you use Cashflow Genius"
          hint={`Currently: ${MODE_LABELS[appMode]}`}
        />
        <ModePicker
          value={appMode}
          onChange={(m) => {
            void askSwitchMode(m);
          }}
        />
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]" role="status">
          {switchMode.isPending
            ? "Switching workspace…"
            : "Each mode is a separate workspace — switching never moves, merges or deletes anything."}
        </p>
        {state.workspaces.length > 1 ? (
          <ul className="mt-3 space-y-1.5" aria-label="Your workspaces">
            {state.workspaces.map((w) => {
              const wm = w.mode as AppMode;
              return (
              <li key={w.mode} className="flex items-center justify-between rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-xs">
                <span className="font-bold">
                  {MODE_ICONS[wm]} {MODE_LABELS[wm]}
                  <span className="ml-2 font-semibold text-[var(--dim)]">{w.name || "Unnamed space"}</span>
                </span>
                {w.mode === appMode ? (
                  <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-white">OPEN NOW</span>
                ) : null}
              </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section className="card p-5" aria-label="Cursor style">
        <SectionTitle
          title="Cursor style"
          hint={`Currently: ${cursorLabel(cursorChoice)} · saved to your account`}
        />
        {finePointer ? (
          <>
            <p className="text-sm leading-relaxed text-[var(--dim)]">
              Pick a cursor — it changes immediately, and your choice is saved to your account.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Choose your cursor style">
              {CURSOR_OPTIONS.map((opt) => {
                const selected = cursorChoice === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={saveCursor.isPending}
                    onClick={() => pickCursor(opt.id)}
                    className={`flex items-start gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left transition ${
                      selected
                        ? "border-[var(--accent-bright)] bg-[var(--surface-soft)] shadow-[0_0_0_3px_rgba(217,70,239,0.15)]"
                        : "border-[var(--border)] bg-white hover:bg-[var(--surface-soft)]"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] shadow-[0_4px_10px_rgba(76,29,149,0.18)]"
                      style={{ background: opt.swatch }}
                    >
                      {opt.id === "minimal" ? (
                        <span className="block h-4 w-4 rounded-full border-[1.5px] border-[#241b3a]/60" />
                      ) : opt.id === "off" ? (
                        <span className="text-[13px] leading-none text-[var(--dim)]">↖</span>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-extrabold text-[var(--text)]">
                        {opt.label}
                        {selected ? (
                          <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-white">
                            ON
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-[var(--dim)]">
                        {opt.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]" role="status">
              {saveCursor.isPending
                ? "Saving your choice to your account…"
                : "Cursors show on desktop with a mouse or trackpad."}
            </p>
          </>
        ) : (
          <div className="rounded-2xl bg-[var(--surface-soft)] px-4 py-3">
            <p className="text-sm leading-relaxed text-[var(--dim)]">
              Custom cursors need a mouse or trackpad, so there is nothing to change on this touch device. Your saved choice is{" "}
              <strong className="text-[var(--text)]">{cursorLabel(cursorChoice)}</strong>.
            </p>
          </div>
        )}
      </section>

      <section className="card p-5" aria-label="Your account">
        <SectionTitle title="Your account" />
        <p className="text-sm text-[var(--dim)]">
          Signed in as{" "}
          <strong className="text-[var(--text)]">{state.authUser.identifier}</strong>{" "}
          ({state.authUser.channel === "phone" ? "mobile number" : "email address"})
          {" · "}
          {state.authUser.verified ? (
            <span className="font-bold text-[var(--accent)]">Verified ✓</span>
          ) : (
            <span className="font-bold text-[var(--warn-text)]">Not verified</span>
          )}
        </p>
        <button type="button" className="btn-ghost mt-3 px-5 py-2.5 text-sm" onClick={() => void doLogout()}>
          ⎋ Log out
        </button>
        <form
            className="mt-4 grid grid-cols-1 gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await confirm({
                title: "Change your login?",
                body: "From now on you will sign in with the new email address. Your records, workspaces and password stay exactly the same.",
                detail: `New login: ${newIdentifier.trim()}`,
                confirmLabel: "Change login",
              });
              if (ok) changeId.mutate();
            }}
          >
            <Field label="New email address">
              <input className="field" type="email" value={newIdentifier} onChange={(e) => setNewIdentifier(e.target.value)} aria-label="New email address" placeholder="you@example.com" autoComplete="off" />
            </Field>
            <Field label="Current password (to confirm it's you)">
              <input className="field" type="password" value={idPassword} onChange={(e) => setIdPassword(e.target.value)} aria-label="Current password for changing login" autoComplete="current-password" />
            </Field>
            <div className="flex items-end">
              <button type="submit" className="btn-ghost w-full px-5 py-2.5 text-sm" disabled={changeId.isPending || !newIdentifier.trim() || !idPassword}>
                {changeId.isPending ? "Updating…" : "Change login"}
              </button>
            </div>
          </form>
      </section>

      <section className="card p-5" aria-label="Backup, restore and undo">
        <SectionTitle
          title="Backup, restore & undo"
          hint="Your data is yours — full structure, not CSV-only, and bulk edits can be undone"
        />
        <p className="text-sm leading-relaxed text-[var(--dim)]">
          One JSON file with every workspace. Restoring merges it in — nothing is overwritten or deleted.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary px-5 py-2.5 text-sm" disabled={exportBackup.isPending} onClick={() => exportBackup.mutate()}>
            {exportBackup.isPending ? "Preparing…" : "Download full backup"}
          </button>
          <button type="button" className="btn-ghost px-5 py-2.5 text-sm" onClick={() => backupFileRef.current?.click()}>
            Restore from backup file…
          </button>
          <input
            ref={backupFileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Choose a Cashflow Genius backup file to restore"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const parsed: unknown = JSON.parse(await f.text());
                if (
                  typeof parsed !== "object" || parsed === null ||
                  !Array.isArray((parsed as { workspaces?: unknown }).workspaces)
                ) {
                  setRestoreMsg("That file doesn't look like a Cashflow Genius backup (no workspaces list found). Nothing was restored.");
                  return;
                }
                const wsCount = (parsed as { workspaces: unknown[] }).workspaces.length;
                const ok = await confirm({
                  title: "Restore this backup?",
                  body: "Records from the backup file will be merged into your account. Records that are already here are skipped — nothing is overwritten or deleted, and each record returns to its own workspace.",
                  detail: `File: ${f.name} · ${wsCount} workspace(s) in the file`,
                  confirmLabel: "Restore backup",
                });
                if (ok) restoreBackup.mutate(parsed);
              } catch {
                setRestoreMsg("That file could not be read as a backup. Nothing was restored.");
              }
            }}
          />
          <button type="button" className="btn-ghost px-5 py-2.5 text-sm" disabled={undoImport.isPending} onClick={() => void askUndoImport()}>
            Undo last CSV import (this workspace)
          </button>
        </div>
        {restoreMsg ? (
          <p className="mt-3 rounded-xl bg-[var(--ai)] px-3 py-2 text-sm text-[var(--ai-text)]" role="status">{restoreMsg}</p>
        ) : null}
        <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
          {lastImport
            ? `Last CSV import in this workspace: ${lastImport.detail} — ${new Date(lastImport.createdAt).toLocaleString("en-IN", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`
            : "No CSV import has been recorded in this workspace yet."}
        </p>
      </section>

      <section className="card p-5" aria-label="Your custom categories in this workspace">
        <SectionTitle
          title="Your custom categories"
          hint={`Remembered in ${MODE_LABELS[appMode]} only — rename or remove them here`}
        />
        {(state.customCategories ?? []).length === 0 ? (
          <p className="text-sm text-[var(--dim)]">
            None yet. Pick “✎ Custom — type your own” in any category dropdown and the name will be remembered here.
          </p>
        ) : (
          <ul className="space-y-2">
            {(state.customCategories ?? []).map((c) => {
              const draft = renameDraft[c.id] ?? c.name;
              const dir = c.type === "income" ? ("income" as const) : ("expense" as const);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--surface-soft)] px-3 py-2">
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[var(--dim)]">
                    {c.type}
                  </span>
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Rename custom category {c.name}</span>
                    <input
                      className="field !py-1.5 text-sm font-bold"
                      value={draft}
                      maxLength={60}
                      onChange={(e) => setRenameDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                      aria-label={`Rename custom category ${c.name}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs"
                    disabled={renameCat.isPending || draft.trim() === c.name || !draft.trim()}
                    onClick={() => renameCat.mutate({ type: dir, oldName: c.name, newName: draft.trim() })}
                  >
                    Rename everywhere
                  </button>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs text-[var(--err-text)]"
                    disabled={deleteCat.isPending}
                    onClick={() => void askDeleteCat({ type: dir, name: c.name })}
                    aria-label={`Remove custom category ${c.name} from the list`}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-[var(--dim)]">
          Renaming updates every record using the name. Removing only takes it off this list.
        </p>
      </section>

      <section className="card border-[#e3b3ae] p-5" aria-label="Delete account permanently">
          <SectionTitle title="Delete account permanently" />
          <p className="text-sm leading-relaxed text-[var(--dim)]">
            This deletes your account and <strong className="text-[var(--text)]">every record in every workspace</strong> —
            transactions, invoices, notes, budgets, everything — and it cannot be undone.
            Download a full backup above first if you might want the data again.
          </p>
          <form
            className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await confirm({
                title: "Delete your account forever?",
                body: "This is permanent and cannot be undone — there is no Undo for account deletion. Your account and every record in every workspace (Personal, Business, Creator, Student) will be deleted.",
                detail: "If you might want this data again, cancel now and download a full backup first (Backup, restore & undo, above).",
                confirmLabel: "Yes, delete forever",
                cancelLabel: "Keep my account",
                danger: true,
              });
              if (ok) deleteAcct.mutate();
            }}
          >
            <Field label="Your password">
              <input className="field" type="password" value={delPassword} onChange={(e) => setDelPassword(e.target.value)} aria-label="Password for account deletion" autoComplete="current-password" />
            </Field>
            <Field label="Type DELETE to confirm">
              <input className="field" value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} aria-label="Type DELETE to confirm account deletion" autoComplete="off" />
            </Field>
            <div className="flex items-end">
              <button
                type="submit"
                className="btn-danger w-full px-5 py-2.5 text-sm disabled:opacity-50"
                disabled={deleteAcct.isPending || !delPassword || delConfirm.trim() !== "DELETE"}
              >
                {deleteAcct.isPending ? "Deleting…" : "Delete my account forever"}
              </button>
            </div>
          </form>
        </section>

      <section className="card p-5" aria-label="Business profile">
        <SectionTitle title={personal ? "Your profile" : "Business profile"} />
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => void submitProfile(e)}
        >
          <Field label={personal ? "Name for this space" : "Business name"}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} aria-label="Business name" placeholder={personal ? "e.g. My Daily Spending" : "e.g. Sarya Design Studio"} />
          </Field>
          {personal ? null : (
            <Field label="Industry">
              <input className="field" value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry" placeholder="e.g. Design services" />
            </Field>
          )}
          <Field label="Your name">
            <input className="field" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} aria-label="Your name" />
          </Field>
          <Field label="Your email">
            <input className="field" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} aria-label="Your email" />
          </Field>
          <Field label="Mobile number (optional — profile only)">
            <input className="field" type="tel" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} aria-label="Mobile number, optional profile detail" placeholder="+91 …" autoComplete="tel" />
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              Just a contact detail on your profile. It is never used to sign in
              and no OTP or SMS is ever sent to it — sign-in is email + password
              or Google only.
            </p>
          </Field>
          <Field label="Country">
            <input className="field" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" />
          </Field>
          <Field label="Currency">
            <CurrencyPicker
              value={currency}
              onChange={setCurrency}
              disabled={save.isPending || currencyBusy === true}
            />
            {convertingNow ? (
              <p className="mt-1 text-xs font-bold text-[var(--accent)]" role="status">
                Converting amounts to {currency}…
              </p>
            ) : null}
          </Field>
          <Field label={personal ? "Money you started with" : "Opening cash balance"}>
            <input className="field" type="number" step="1" value={opening} onChange={(e) => setOpening(e.target.value)} aria-label="Opening cash balance" />
          </Field>
          <Field label="Preferred timezone">
            <select className="field" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="Preferred timezone">
              {TIMEZONES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="btn-primary px-6 py-2.5 text-sm"
              disabled={save.isPending || currencyBusy === true}
            >
              {save.isPending ? "Saving…" : currencyBusy === true ? "Converting…" : "Save profile"}
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--dim)]">
          Amounts display in Indian numbering format (en-IN) by default. Cash balance =
          opening balance + posted income − posted expenses; unpaid invoices never count
          as cash.
        </p>
      </section>

      <section className="card p-5" aria-label="App tour and help">
        <SectionTitle
          title="App tour & help"
          hint="The guided walkthrough of everything Cashflow Genius can do"
        />
        <p className="text-sm leading-relaxed text-[var(--dim)]">
          A guided walkthrough of the app — it only explains, never touches your data.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary px-5 py-2.5 text-sm"
            onClick={onShowTour}
            disabled={!onShowTour}
            aria-label="Start the guided app tour"
          >
            🧭 Start the app tour
          </button>
        </div>
      </section>

      <section className="card p-5" aria-label="Recent activity">
        <SectionTitle title="Recent activity" />
        {state.activity.length === 0 ? (
          <p className="text-sm text-[var(--dim)]">No activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {state.activity.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <strong>{a.action}</strong>
                  {a.detail ? <span className="text-[var(--dim)]"> — {a.detail}</span> : null}
                </span>
                <span className="whitespace-nowrap text-xs text-[var(--dim)]">
                  {new Date(a.createdAt).toLocaleString("en-IN", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
