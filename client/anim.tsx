// Premium motion utilities — animation only, no design/layout change.
// Every helper respects prefers-reduced-motion (instant / visible) and
// stays lightweight: one rAF or one IntersectionObserver per element,
// transform + opacity only, no layout thrashing.

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { fmtMoney } from "./lib";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = () => setReduced(mq?.matches ?? false);
    mq.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** Smoothly animates a numeric value toward `target` whenever it changes. */
export function useAnimatedNumber(target: number, duration = 900): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState<number>(() => (reduced ? target : 0));
  const fromRef = useRef<number>(reduced ? target : 0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) {
      setValue(target);
      return;
    }
    // Take the clock from the first frame's own timestamp — never mix
    // performance.now() with rAF timestamps (different webviews have
    // differed), and clamp progress AND easing into [0, 1] so the
    // interpolated value can never overshoot or run away.
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const raw = (now - start) / duration;
      const t = raw >= 1 ? 1 : raw <= 0 || Number.isNaN(raw) ? 0 : raw;
      const eased = Math.min(1, Math.max(0, easeOutExpo(t)));
      const next = from + (target - from) * eased;
      setValue(next);
      if (t >= 1) {
        fromRef.current = target;
        setValue(target);
        return;
      }
      fromRef.current = next;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, reduced]);

  return value;
}

/** Money figure that counts up elegantly on mount and on change. */
export function AnimatedMoney({
  cents,
  currency,
  className,
  duration = 950,
}: {
  cents: number;
  currency: string;
  className?: string;
  duration?: number;
}) {
  const animated = useAnimatedNumber(cents, duration);
  return (
    <span className={className} aria-label={fmtMoney(cents, currency)}>
      <span aria-hidden="true">{fmtMoney(Math.round(animated), currency)}</span>
    </span>
  );
}

/** Generic count-up number (scores, percentages, counts). */
export function AnimatedNumber({
  value,
  className,
  suffix = "",
  duration = 900,
}: {
  value: number;
  className?: string;
  suffix?: string;
  duration?: number;
}) {
  const animated = useAnimatedNumber(value, duration);
  return (
    <span className={className} aria-label={`${value}${suffix}`}>
      <span aria-hidden="true">
        {Math.round(animated).toLocaleString("en-IN")}
        {suffix}
      </span>
    </span>
  );
}

/**
 * Scroll reveal wrapper. Renders exactly the same box as a plain div
 * (className is passed through) — it only adds opacity/transform until
 * the element scrolls into view, then reveals it once. If IO is
 * unavailable or motion is reduced, it is visible immediately.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: _as,
  style,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState<boolean>(reduced);

  useEffect(() => {
    if (reduced) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // Already in view on mount — reveal without waiting for a scroll.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -24px 0px" },
    );
    io.observe(el);
    // Safety net: never leave content hidden if the observer stalls.
    const fallback = setTimeout(() => setVisible(true), 1400);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [reduced]);

  return (
    <div
      ref={ref}
      className={`${className ?? ""} reveal ${visible ? "is-revealed" : ""}`.trim()}
      style={{ ...style, transitionDelay: visible ? `${delay}ms` : `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/**
 * Progress fill that grows from 0 to `pct` on mount and eases to the
 * new value whenever `pct` changes. Drop-in replacement for the inner
 * fill div of a progress track — same colours, same height, same radius.
 */
export function AnimatedProgress({
  pct,
  className,
}: {
  pct: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const clamped = Math.min(100, Math.max(0, pct));
  const [width, setWidth] = useState<number>(reduced ? clamped : 0);
  useEffect(() => {
    if (reduced) {
      setWidth(clamped);
      return;
    }
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setWidth(clamped));
    });
    return () => cancelAnimationFrame(raf);
  }, [clamped, reduced]);
  return (
    <div
      className={className ?? "h-full rounded-full bg-[var(--accent)]"}
      style={{
        width: `${width}%`,
        transition: reduced ? "none" : "width 950ms cubic-bezier(0.22,1,0.36,1)",
      }}
    />
  );
}

/**
 * Magnetic wrapper — desktop fine-pointer only. The wrapper itself
 * does not change layout; on pointer move it translates its child by
 * at most ~4px toward the cursor and eases back on leave. Touch and
 * reduced-motion get no movement at all.
 */
export function Magnetic({
  children,
  className,
  strength = 0.22,
}: {
  children: ReactNode;
  className?: string;
  strength?: number;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const reduced = usePrefersReducedMotion();

  const onMove = (e: React.PointerEvent) => {
    if (reduced) return;
    if (e.pointerType !== "mouse") return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - (rect.left + rect.width / 2);
    const y = e.clientY - (rect.top + rect.height / 2);
    const tx = Math.max(-4, Math.min(4, x * strength * 0.35));
    const ty = Math.max(-3, Math.min(3, y * strength * 0.35));
    el.style.transform = `translate(${tx}px, ${ty}px)`;
  };
  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = "";
  };

  return (
    <span
      ref={ref}
      className={`magnetic-wrap ${className ?? ""}`.trim()}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{ display: "inline-block", transition: "transform 260ms cubic-bezier(0.22,1,0.36,1)", willChange: "transform" }}
    >
      {children}
    </span>
  );
}
