// ---------- In-app calculator ----------
// A working calculator that lives in the app shell, next to the side
// panel. It is mounted once for the whole signed-in session and only
// hidden (never unmounted) when closed, so its expression, result and
// history survive page changes, Quick Add opening/closing, and any
// other work in the app. It is calculation only: it holds plain local
// component state and never calls a server action, so by itself it can
// never create, change or delete a transaction, savings goal or any
// other financial record.
//
// Expressions are evaluated by a small hand-written parser below —
// no eval(), no Function(), no external code — supporting + − × ÷,
// brackets, unary minus, and % as a postfix percent (50% = 0.5).

import { useEffect, useRef, useState } from "react";

interface CalcHistoryItem {
  expr: string;
  result: string;
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "percent" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === ",") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < input.length && /[0-9.]/.test(input[j]!)) {
        if (input[j] === ".") dots++;
        j++;
      }
      const text = input.slice(i, j);
      if (dots > 1) throw new Error("bad number");
      const value = parseFloat(text);
      if (Number.isNaN(value)) throw new Error("bad number");
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if (ch === "+" ) { tokens.push({ kind: "op", value: "+" }); i++; continue; }
    if (ch === "-" || ch === "−") { tokens.push({ kind: "op", value: "-" }); i++; continue; }
    if (ch === "*" || ch === "×" || ch === "x") { tokens.push({ kind: "op", value: "*" }); i++; continue; }
    if (ch === "/" || ch === "÷") { tokens.push({ kind: "op", value: "/" }); i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === "%") { tokens.push({ kind: "percent" }); i++; continue; }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

/** Recursive-descent evaluation:
 *  expr    := term (("+" | "-") term)*
 *  term    := factor (("*" | "/") factor)*
 *  factor  := primary "%"*           (postfix percent: each % divides by 100)
 *  primary := number | "(" expr ")" | ("-" | "+") primary            */
export function evaluateExpression(input: string): number {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error("empty");
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parsePrimary(): number {
    const t = next();
    if (!t) throw new Error("unexpected end");
    if (t.kind === "num") return t.value;
    if (t.kind === "lparen") {
      const v = parseExpr();
      const closing = next();
      if (!closing || closing.kind !== "rparen") throw new Error("missing )");
      return v;
    }
    if (t.kind === "op" && (t.value === "-" || t.value === "+")) {
      const v = parsePrimary();
      return t.value === "-" ? -v : v;
    }
    throw new Error("unexpected token");
  }
  function parseFactor(): number {
    let v = parsePrimary();
    while (peek()?.kind === "percent") {
      next();
      v = v / 100;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/")) {
        next();
        const rhs = parseFactor();
        if (t.value === "/") {
          if (rhs === 0) throw new Error("divide by zero");
          v = v / rhs;
        } else {
          v = v * rhs;
        }
      } else return v;
    }
  }
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        next();
        const rhs = parseTerm();
        v = t.value === "+" ? v + rhs : v - rhs;
      } else return v;
    }
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("trailing tokens");
  if (!Number.isFinite(result)) throw new Error("not finite");
  return result;
}

/** Stable display formatting: kill binary float noise (0.1 + 0.2),
 *  keep up to 10 significant decimals, use Indian digit grouping. */
export function formatCalcResult(value: number): string {
  const rounded = Math.round(value * 1e10) / 1e10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  if (Math.abs(normalized) >= 1e15 || (normalized !== 0 && Math.abs(normalized) < 1e-10)) {
    return normalized.toExponential(6);
  }
  const [intPart = "0", fracPart] = String(Math.abs(normalized)).split(".");
  const grouped = Number(intPart).toLocaleString("en-IN");
  const sign = normalized < 0 ? "−" : "";
  return fracPart ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`;
}

const OPERATORS = ["+", "−", "×", "÷"] as const;

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}

// ---------- Resizable calculator panel ----------
// Size is adjustable three ways and remembered (localStorage):
//  - S / M / L preset buttons,
//  - drag-to-resize from the top-left corner handle on desktop
//    (pointer events; width 280–560px, height capped by the viewport),
//  - a Compact / Expanded toggle on phones (compact hides history and
//    shrinks keys so the panel never covers the whole screen).
// The panel stays mounted for the whole session, so resizing, closing
// or switching pages never loses the current calculation.

export type CalcSize = "small" | "medium" | "large";

const CALC_SIZE_KEY = "cg_calc_size";
const CALC_WIDTH_KEY = "cg_calc_width";
const CALC_COMPACT_KEY = "cg_calc_compact";
const CALC_HISTORY_KEY = "cg_calc_history";

// History is also kept in localStorage (last 10, same cap as in-memory),
// so a mode switch — which remounts the app shell — no longer wipes it.
function loadCalcHistory(): CalcHistoryItem[] {
  try {
    const raw = localStorage.getItem(CALC_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is CalcHistoryItem =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as { expr?: unknown }).expr === "string" &&
          typeof (x as { result?: unknown }).result === "string",
      )
      .slice(0, 10);
  } catch {
    return [];
  }
}

const SIZE_WIDTHS: Record<CalcSize, number> = { small: 296, medium: 352, large: 448 };

function loadCalcSize(): CalcSize {
  try {
    const v = localStorage.getItem(CALC_SIZE_KEY);
    if (v === "small" || v === "medium" || v === "large") return v;
  } catch { /* storage unavailable */ }
  return "medium";
}
function loadCalcWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(CALC_WIDTH_KEY));
    if (Number.isFinite(v) && v >= 280 && v <= 560) return v;
  } catch { /* storage unavailable */ }
  return null;
}
function loadCalcCompact(): boolean {
  try {
    return localStorage.getItem(CALC_COMPACT_KEY) === "1";
  } catch {
    return false;
  }
}
function storeCalc(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable — size just won't persist */ }
}

export function CalculatorPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [expr, setExpr] = useState("");
  const [justEvaluated, setJustEvaluated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CalcHistoryItem[]>(loadCalcHistory);

  // Keep the stored copy in step with the visible history.
  useEffect(() => {
    try {
      localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(history));
    } catch { /* storage unavailable — history just won't persist */ }
  }, [history]);
  const [size, setSize] = useState<CalcSize>(loadCalcSize);
  const [customWidth, setCustomWidth] = useState<number | null>(loadCalcWidth);
  const [compact, setCompact] = useState<boolean>(loadCalcCompact);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const [customHeight, setCustomHeight] = useState<number | null>(null);

  const pickSize = (s: CalcSize) => {
    setSize(s);
    setCustomWidth(null);
    setCustomHeight(null);
    storeCalc(CALC_SIZE_KEY, s);
    try { localStorage.removeItem(CALC_WIDTH_KEY); } catch { /* ignore */ }
  };
  const toggleCompact = () => {
    setCompact((c) => {
      storeCalc(CALC_COMPACT_KEY, c ? "0" : "1");
      return !c;
    });
  };

  // Drag-to-resize (desktop): dragging the corner handle left/up grows
  // the panel. Pointer capture keeps it smooth; the final size is
  // remembered, and double-clicking the handle resets to the preset.
  const onDragStart = (e: React.PointerEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const w = Math.min(560, Math.max(280, d.startW + (d.startX - e.clientX)));
    const h = Math.min(window.innerHeight - 120, Math.max(380, d.startH + (d.startY - e.clientY)));
    setCustomWidth(w);
    setCustomHeight(h);
  };
  const onDragEnd = () => {
    if (dragRef.current && customWidth) storeCalc(CALC_WIDTH_KEY, String(Math.round(customWidth)));
    dragRef.current = null;
  };

  // Live result preview (only when the expression parses cleanly).
  let preview: string | null = null;
  if (expr.trim() && !error) {
    try {
      preview = formatCalcResult(evaluateExpression(expr.replace(/,/g, "")));
    } catch {
      preview = null;
    }
  }

  const press = (key: string) => {
    setError(null);
    if (isDigit(key)) {
      if (justEvaluated) {
        setExpr(key);
        setJustEvaluated(false);
      } else {
        setExpr((e) => (e === "0" ? key : e + key));
      }
      return;
    }
    if (key === ".") {
      const segment = expr.split(/[+\-−×÷()%\s]/).pop() ?? "";
      if (segment.includes(".")) return;
      if (justEvaluated) {
        setExpr("0.");
        setJustEvaluated(false);
      } else if (expr === "" || /[+\-−×÷(]\s?$/.test(expr)) {
        setExpr((e) => e + "0.");
      } else {
        setExpr((e) => e + ".");
      }
      return;
    }
    if ((OPERATORS as readonly string[]).includes(key)) {
      if (justEvaluated) setJustEvaluated(false);
      setExpr((e) => {
        if (e === "") return key === "−" ? "−" : e;
        const trimmed = e.replace(/\s+$/, "");
        const last = trimmed.slice(-1);
        if ((OPERATORS as readonly string[]).includes(last)) {
          return trimmed.slice(0, -1) + key;
        }
        if (last === "(") return key === "−" ? trimmed + "−" : trimmed;
        return trimmed + key;
      });
      return;
    }
    if (key === "(") {
      if (justEvaluated) {
        setExpr("(");
        setJustEvaluated(false);
      } else {
        setExpr((e) => {
          const last = e.slice(-1);
          if (e !== "" && (isDigit(last) || last === ")" || last === "%" || last === ".")) {
            return e + "×(";
          }
          return e + "(";
        });
      }
      return;
    }
    if (key === ")") {
      setExpr((e) => {
        const opens = (e.match(/\(/g) ?? []).length;
        const closes = (e.match(/\)/g) ?? []).length;
        if (opens <= closes) return e;
        const last = e.slice(-1);
        if (last === "(" || (OPERATORS as readonly string[]).includes(last)) return e;
        return e + ")";
      });
      setJustEvaluated(false);
      return;
    }
    if (key === "%") {
      const last = expr.slice(-1);
      if (expr === "" || last === "(" || (OPERATORS as readonly string[]).includes(last)) return;
      setExpr((e) => e + "%");
      setJustEvaluated(false);
      return;
    }
  };

  const clearAll = () => {
    setExpr("");
    setError(null);
    setJustEvaluated(false);
  };

  const backspace = () => {
    setError(null);
    setJustEvaluated(false);
    setExpr((e) => e.slice(0, -1));
  };

  const equals = () => {
    const source = expr.trim();
    if (!source) return;
    try {
      const value = evaluateExpression(source.replace(/,/g, ""));
      const result = formatCalcResult(value);
      setHistory((h) => {
        const item = { expr: source, result };
        const deduped = h.filter((x) => !(x.expr === item.expr && x.result === item.result));
        return [item, ...deduped].slice(0, 10);
      });
      setExpr(result.replace(/,/g, ""));
      setJustEvaluated(true);
      setError(null);
    } catch {
      setError("Couldn't calculate that — check the expression and try again.");
    }
  };

  // Physical keyboard support while the panel is open. Keys typed into
  // form fields (Quick Add amounts, transaction forms…) are left alone,
  // so calculating never interferes with entering money.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target?.isContentEditable ?? false);
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (typing) return;
      if (/^[0-9.]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === "+") { press("+"); e.preventDefault(); }
      else if (e.key === "-") { press("−"); e.preventDefault(); }
      else if (e.key === "*" || e.key.toLowerCase() === "x") { press("×"); e.preventDefault(); }
      else if (e.key === "/") { press("÷"); e.preventDefault(); }
      else if (e.key === "%") { press("%"); e.preventDefault(); }
      else if (e.key === "(" || e.key === ")") { press(e.key); e.preventDefault(); }
      else if (e.key === "Enter" || e.key === "=") { equals(); e.preventDefault(); }
      else if (e.key === "Backspace") { backspace(); e.preventDefault(); }
      else if (e.key === "Delete") { clearAll(); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expr, justEvaluated, onClose]);

  const width = customWidth ?? SIZE_WIDTHS[size];
  const keyH = compact ? 44 : size === "large" ? 56 : 48;
  const keyBtn =
    "flex items-center justify-center rounded-2xl font-extrabold transition active:scale-95";
  const numBtn = `${keyBtn} bg-[var(--surface)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border)] hover:bg-[var(--surface-soft)]`;
  const opBtn = `${keyBtn} bg-[var(--surface-soft)] text-[var(--accent)] hover:bg-[var(--surface-mint)]`;
  const utilBtn =
    "flex min-h-[40px] items-center justify-center rounded-2xl bg-[var(--surface-soft)] px-2 text-[13px] font-extrabold text-[var(--dim)] transition active:scale-95 hover:text-[var(--text)]";

  return (
    <section
      aria-label="Calculator"
      aria-hidden={!open}
      className={`no-print fixed inset-x-3 bottom-[76px] z-[65] sm:inset-x-auto sm:right-4 lg:bottom-5 ${
        open ? "" : "pointer-events-none invisible"
      }`}
      style={open ? undefined : { visibility: "hidden" }}
    >
      <div
        ref={panelRef}
        className="glass relative ml-auto max-h-[calc(100vh-110px)] overflow-y-auto rounded-[26px] p-4 shadow-[0_22px_54px_rgba(124,58,237,0.28)]"
        style={{
          width: `min(${width}px, calc(100vw - 24px))`,
          height: customHeight ? `min(${customHeight}px, calc(100vh - 110px))` : undefined,
          // Elegant open/close motion only — same size, same position.
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0) scale(1)" : "translateY(10px) scale(0.98)",
          transition: "opacity 260ms cubic-bezier(0.22,1,0.36,1), transform 320ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        {/* Drag handle (desktop): drag to resize, double-click to reset */}
        <button
          type="button"
          aria-label="Drag to resize calculator, double-click to reset size"
          title="Drag to resize · double-click to reset"
          className="absolute left-1.5 top-1.5 hidden h-8 w-8 cursor-nwse-resize touch-none items-center justify-center rounded-full text-[var(--dim)] hover:bg-[var(--surface-soft)] sm:flex"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={() => pickSize(size)}
          tabIndex={open ? 0 : -1}
        >
          <span aria-hidden className="text-sm leading-none">⤡</span>
        </button>

        <div className="mb-2 flex items-center justify-between gap-2 pl-6 sm:pl-7">
          <h2 className="flex items-center gap-2 text-base font-extrabold">
            <span aria-hidden>🧮</span> Calculator
          </h2>
          <button
            type="button"
            className="btn-ghost flex h-10 w-10 items-center justify-center text-lg leading-none"
            aria-label="Close calculator"
            onClick={onClose}
            tabIndex={open ? 0 : -1}
          >
            ×
          </button>
        </div>

        {/* Size controls: S/M/L presets + phone compact toggle */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Calculator size">
          <span className="text-[11px] font-extrabold uppercase tracking-wide text-[var(--dim)]">Size</span>
          {(["small", "medium", "large"] as CalcSize[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={size === s && !customWidth}
              aria-label={`Calculator size ${s}`}
              onClick={() => pickSize(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-extrabold transition active:scale-95 ${
                size === s && !customWidth
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-soft)] text-[var(--dim)]"
              }`}
              tabIndex={open ? 0 : -1}
            >
              {s === "small" ? "S" : s === "medium" ? "M" : "L"}
            </button>
          ))}
          {customWidth ? (
            <span className="rounded-full bg-[var(--surface-soft)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--dim)]">
              Custom {Math.round(customWidth)}px
            </span>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            aria-pressed={compact}
            aria-label={compact ? "Expand calculator" : "Make calculator compact"}
            onClick={toggleCompact}
            className={`rounded-full px-3 py-1.5 text-xs font-extrabold transition active:scale-95 sm:hidden ${
              compact ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-soft)] text-[var(--dim)]"
            }`}
            tabIndex={open ? 0 : -1}
          >
            {compact ? "⤢ Expanded view" : "Compact"}
          </button>
          <span className="hidden text-[11px] font-semibold text-[var(--dim)] sm:inline">
            Drag ⤡ to resize
          </span>
        </div>

        <div className="rounded-2xl bg-[var(--surface-soft)] px-4 py-3" aria-live="polite">
          <p
            className={`tnum min-h-8 break-all text-right font-extrabold tracking-tight ${size === "large" ? "text-3xl" : "text-2xl"}`}
            aria-label="Calculator expression"
          >
            {expr === "" ? <span className="text-[var(--dim)]">0</span> : expr}
          </p>
          <p className="tnum mt-0.5 min-h-5 text-right text-sm font-bold text-[var(--accent)]" aria-label="Calculator result preview">
            {error ? (
              <span className="text-[var(--err-text)]">{error}</span>
            ) : preview && expr.trim() ? (
              <> = {preview}</>
            ) : (
              " "
            )}
          </p>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label="Calculator editing keys">
          <button type="button" className={utilBtn} aria-label="Clear calculator" onClick={clearAll} tabIndex={open ? 0 : -1}>
            C · Clear
          </button>
          <button type="button" className={utilBtn} aria-label="Open bracket" onClick={() => press("(")} tabIndex={open ? 0 : -1}>
            (
          </button>
          <button type="button" className={utilBtn} aria-label="Close bracket" onClick={() => press(")")} tabIndex={open ? 0 : -1}>
            )
          </button>
          <button type="button" className={utilBtn} aria-label="Backspace" onClick={backspace} tabIndex={open ? 0 : -1}>
            ⌫ Delete
          </button>
        </div>

        <div className="mt-1.5 grid grid-cols-4 gap-1.5" role="group" aria-label="Calculator number and operator keys">
          {["7", "8", "9"].map((d) => (
            <button key={d} type="button" className={numBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label={`Digit ${d}`} onClick={() => press(d)} tabIndex={open ? 0 : -1}>{d}</button>
          ))}
          <button type="button" className={opBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Divide" onClick={() => press("÷")} tabIndex={open ? 0 : -1}>÷</button>
          {["4", "5", "6"].map((d) => (
            <button key={d} type="button" className={numBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label={`Digit ${d}`} onClick={() => press(d)} tabIndex={open ? 0 : -1}>{d}</button>
          ))}
          <button type="button" className={opBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Multiply" onClick={() => press("×")} tabIndex={open ? 0 : -1}>×</button>
          {["1", "2", "3"].map((d) => (
            <button key={d} type="button" className={numBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label={`Digit ${d}`} onClick={() => press(d)} tabIndex={open ? 0 : -1}>{d}</button>
          ))}
          <button type="button" className={opBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Subtract" onClick={() => press("−")} tabIndex={open ? 0 : -1}>−</button>
          <button type="button" className={numBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Digit 0" onClick={() => press("0")} tabIndex={open ? 0 : -1}>0</button>
          <button type="button" className={numBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Decimal point" onClick={() => press(".")} tabIndex={open ? 0 : -1}>.</button>
          <button type="button" className={opBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Percent" onClick={() => press("%")} tabIndex={open ? 0 : -1}>%</button>
          <button type="button" className={opBtn} style={{ minHeight: keyH, fontSize: size === "large" ? 20 : 18 }} aria-label="Add" onClick={() => press("+")} tabIndex={open ? 0 : -1}>+</button>
        </div>

        <button
          type="button"
          className="btn-primary mt-1.5 w-full px-4 text-lg"
          style={{ minHeight: keyH }}
          aria-label="Equals — calculate the result"
          onClick={equals}
          tabIndex={open ? 0 : -1}
        >
          =
        </button>

        {!compact && history.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-xs font-extrabold uppercase tracking-wide text-[var(--dim)]">Recent calculations</h3>
              <button
                type="button"
                className="text-xs font-bold text-[var(--accent)] underline"
                aria-label="Clear calculator history"
                onClick={() => setHistory([])}
                tabIndex={open ? 0 : -1}
              >
                Clear history
              </button>
            </div>
            <ul className="space-y-1">
              {history.map((h, i) => (
                <li key={`${h.expr}-${h.result}-${i}`}>
                  <button
                    type="button"
                    className="tnum flex w-full items-center justify-between gap-3 rounded-xl bg-[var(--surface)]/70 px-3 py-2 text-left text-sm shadow-[inset_0_0_0_1px_var(--border)] transition hover:bg-[var(--surface-soft)]"
                    aria-label={`Reuse result ${h.result} from ${h.expr} equals ${h.result}`}
                    onClick={() => {
                      setExpr(h.result.replace(/,/g, ""));
                      setJustEvaluated(true);
                      setError(null);
                    }}
                    tabIndex={open ? 0 : -1}
                  >
                    <span className="min-w-0 truncate text-[var(--dim)]">{h.expr}</span>
                    <span className="shrink-0 font-extrabold">= {h.result}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : !compact ? (
          <p className="mt-3 text-center text-xs text-[var(--dim)]">
            Your recent calculations will appear here. The calculator only calculates — it never adds or changes any record.
          </p>
        ) : (
          <p className="mt-2 text-center text-[11px] text-[var(--dim)]">
            Compact mode — history hidden. Tap “Expanded view” to see it again.
          </p>
        )}
      </div>
    </section>
  );
}
