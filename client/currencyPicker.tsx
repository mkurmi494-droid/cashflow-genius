// Currency picker — one shared list, one shared sheet, used everywhere a
// currency is chosen: first-login setup, the top-bar selector, the More
// sheet and the Settings profile form. Limited to 10 major currencies for
// now. The sheet looks like the reference: flag, code, full name, symbol,
// with search by name, code or symbol. Picking only returns the code —
// converting existing amounts still goes through the caller's own confirm
// flow (requestCurrencyChange / profile save), never through this file.

import { useState } from "react";
import { Modal } from "./components";

export type CurrencyOption = {
  code: string;
  flag: string;
  name: string;
  symbol: string;
};

export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: "INR", flag: "🇮🇳", name: "Indian Rupee", symbol: "₹" },
  { code: "USD", flag: "🇺🇸", name: "United States Dollar", symbol: "$" },
  { code: "EUR", flag: "🇪🇺", name: "Euro", symbol: "€" },
  { code: "GBP", flag: "🇬🇧", name: "British Pound", symbol: "£" },
  { code: "AED", flag: "🇦🇪", name: "UAE Dirham", symbol: "AED" },
  { code: "JPY", flag: "🇯🇵", name: "Japanese Yen", symbol: "¥" },
  { code: "AUD", flag: "🇦🇺", name: "Australian Dollar", symbol: "$" },
  { code: "CAD", flag: "🇨🇦", name: "Canadian Dollar", symbol: "$" },
  { code: "CHF", flag: "🇨🇭", name: "Swiss Franc", symbol: "CHF" },
  { code: "SGD", flag: "🇸🇬", name: "Singapore Dollar", symbol: "$" },
];

export function currencyMeta(code: string): CurrencyOption {
  return (
    CURRENCY_OPTIONS.find((o) => o.code === code) ?? {
      code,
      flag: "🌐",
      name: code,
      symbol: code,
    }
  );
}

export function CurrencyPicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const meta = currencyMeta(value);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? CURRENCY_OPTIONS.filter((o) =>
        `${o.code} ${o.name} ${o.symbol}`.toLowerCase().includes(needle),
      )
    : CURRENCY_OPTIONS;

  const pick = (code: string) => {
    setOpen(false);
    setQ("");
    if (code !== value) onChange(code);
  };

  return (
    <>
      <button
        type="button"
        className={
          compact
            ? "field flex w-[92px] items-center gap-1.5 px-2 py-2 text-sm"
            : "field flex w-full items-center gap-2.5 text-left"
        }
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label="Currency selector"
      >
        <span aria-hidden="true" className={compact ? "text-base" : "text-xl"}>
          {meta.flag}
        </span>
        <span className="font-extrabold">{meta.code}</span>
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--dim)]">
              {meta.name}
            </span>
            <span aria-hidden="true" className="text-[var(--dim)]">
              ⌄
            </span>
          </>
        )}
      </button>
      {open ? (
        <Modal title="Select a currency" onClose={() => setOpen(false)}>
          <p className="-mt-2 text-sm text-[var(--dim)]">
            Search by name, code or symbol.
          </p>
          <label className="mt-3 block">
            <span className="sr-only">Search currencies</span>
            <input
              className="field"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              autoFocus
              aria-label="Search currencies"
            />
          </label>
          <div className="mt-3 space-y-2">
            {filtered.map((o) => {
              const selected = o.code === value;
              return (
                <button
                  key={o.code}
                  type="button"
                  className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left ${
                    selected
                      ? "border-[var(--accent)] bg-[var(--surface-soft)]"
                      : "border-[var(--line)]"
                  }`}
                  onClick={() => pick(o.code)}
                  aria-pressed={selected}
                >
                  <span aria-hidden="true" className="text-2xl">
                    {o.flag}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-extrabold">{o.code}</span>
                    <span className="block truncate text-sm text-[var(--dim)]">
                      {o.name}
                    </span>
                  </span>
                  <span
                    className={`font-bold ${
                      selected
                        ? "text-[var(--accent)]"
                        : "text-[var(--dim)]"
                    }`}
                  >
                    {o.symbol}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--dim)]">
                No currency matches “{q}”.
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
