// The Cashflow Genius loading mark: the Sprout logo gently pulsing,
// with an optional label underneath. Used wherever a load takes time
// — app boot, Google sign-in, session check, workspace switch, AI CFO
// thinking — so the user always sees the app working, not a blank
// grey box. `inline` renders just the mark, for a row like the CFO
// thinking card.
import { LogoMark } from "./components";

export function LoadingMark({
  label,
  className = "h-14 w-14",
  inline = false,
}: {
  label?: string;
  className?: string;
  inline?: boolean;
}) {
  const mark = (
    <span className="cg-loader inline-flex shrink-0 text-[var(--accent-bright)]" aria-hidden>
      <LogoMark className={className} />
    </span>
  );
  if (inline) return mark;
  return (
    <div className="flex flex-col items-center gap-3 py-2" role="status" aria-label={label ?? "Loading"}>
      {mark}
      {label ? <p className="text-center text-sm font-semibold text-[var(--dim)]">{label}</p> : null}
    </div>
  );
}
