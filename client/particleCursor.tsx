// Custom desktop cursor (fine-pointer only) with five user-selectable
// styles, chosen in Settings → Cursor style and saved per account:
//
//   blue     — sky blue / royal blue glowing particle + floating trail
//   gradient — violet → fuchsia → coral particle trail (theme gradient)
//   minimal  — a clean dot + ring, no trail; the ring expands slightly
//              over clickable elements
//   mint     — the original mint-green / emerald particle trail
//   off      — no custom cursor at all: the normal system arrow
//
// Everything is drawn on one fixed, pointer-events:none canvas, so it
// never blocks text or controls and costs one requestAnimationFrame
// loop with a hard particle cap. Switching styles applies immediately
// (the Settings picker dispatches a window event — see cursor.ts) with
// no reload.
//
// Touch devices get nothing here: the component renders no effect
// unless the device reports a fine pointer with hover, and the CSS
// that hides the native cursor is gated on the same media query plus
// the `has-particle-cursor` class this component sets — so mobile
// keeps its native touch interaction untouched. With style "off" the
// class is never added and the system arrow stays.

import { useEffect, useRef, useState } from "react";
import {
CURSOR_CHANGE_EVENT,
getStoredCursorStyle,
isCursorStyle,
type CursorStyle,
} from "./cursor";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // ms remaining
  ttl: number; // ms total
  size: number;
  hue: number; // index into the active palette's particle colours
  burst: boolean;
};

type Ring = {
  x: number;
  y: number;
  life: number;
  ttl: number;
};

type Palette = {
  /** Particle colours as [r, g, b] triples, by hue index. */
  particles: [number, number, number][];
  /** Hue index whose particles render softer (pale/translucent). */
  softIndex: number;
  /** Picks a hue index for a new particle, with this palette's mix. */
  pick: () => number;
  /** Main-dot radial gradient stops: highlight, mid, deep. */
  core: [string, string, string];
  /** Glow gradient: centre colour fn of alpha, mid stop, ring stroke. */
  glowRgb: [number, number, number];
  deepRgb: [number, number, number];
  hoverRing: string;
  burstRingRgb: [number, number, number];
};

const rgb = (c: [number, number, number], a: number) =>
  `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

const pick3 = () => (Math.random() < 0.55 ? 0 : Math.random() < 0.6 ? 1 : 2);

const PALETTES: Record<"blue" | "gradient" | "mint", Palette> = {
  blue: {
    particles: [
      [56, 189, 248],
      [37, 99, 235],
      [191, 219, 254],
    ],
    softIndex: 2,
    pick: pick3,
    core: ["#eff6ff", "#38bdf8", "#2563eb"],
    glowRgb: [56, 189, 248],
    deepRgb: [37, 99, 235],
    hoverRing: "rgba(147, 197, 253, 0.55)",
    burstRingRgb: [56, 189, 248],
  },
  mint: {
    particles: [
      [52, 211, 153],
      [5, 150, 105],
      [167, 243, 208],
    ],
    softIndex: 2,
    pick: pick3,
    core: ["#ecfdf5", "#34d399", "#059669"],
    glowRgb: [52, 211, 153],
    deepRgb: [5, 150, 105],
    hoverRing: "rgba(110, 231, 183, 0.55)",
    burstRingRgb: [52, 211, 153],
  },
  gradient: {
    particles: [
      [124, 58, 237],
      [217, 70, 239],
      [251, 113, 133],
      [251, 146, 60],
    ],
    softIndex: -1,
    pick: () => {
      const r = Math.random();
      return r < 0.3 ? 0 : r < 0.6 ? 1 : r < 0.85 ? 2 : 3;
    },
    core: ["#fdf4ff", "#d946ef", "#7c3aed"],
    glowRgb: [217, 70, 239],
    deepRgb: [124, 58, 237],
    hoverRing: "rgba(240, 171, 252, 0.6)",
    burstRingRgb: [217, 70, 239],
  },
};

const MAX_PARTICLES = 110;
const INTERACTIVE =
  "a, button, input, select, textarea, label, [role='button'], [role='link'], [data-cursor-hover]";

export function ParticleCursor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [style, setStyle] = useState<CursorStyle>(() => getStoredCursorStyle());

  // Live switching: the Settings picker (and the app shell syncing the
  // account's saved choice) call applyCursorStyle(), which updates the
  // cache and fires this event. A storage listener covers other tabs.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (isCursorStyle(detail)) setStyle(detail);
    };
    const onStorage = () => setStyle(getStoredCursorStyle());
    window.addEventListener(CURSOR_CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CURSOR_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (style === "off") {
      document.documentElement.classList.remove("has-particle-cursor");
      // The canvas stays in the DOM (and visible on desktop) even for
      // "off" — only the loop is gone. Wipe its last painted frame, or
      // the glow + trail freeze at the last mouse position forever
      // (live, 2026-11-20: turning the cursor off left a frozen
      // gradient blob on screen while the system arrow moved fine).
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    if (!fine.matches) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const minimal = style === "minimal";
    const palette = minimal ? null : PALETTES[style as "blue" | "gradient" | "mint"];
    const particleColor = (hue: number, alpha: number): string => {
      if (!palette) return `rgba(36, 27, 58, ${alpha})`;
      const c = palette.particles[hue] ?? palette.particles[0]!;
      return rgb(c, alpha);
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.documentElement.classList.add("has-particle-cursor");

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Pointer state. `x/y` is the exact pointer position (the main dot is
    // drawn there so clicks always line up); `sx/sy` is a smoothed copy
    // the trail spawns from, which gives the fluid, organic lag.
    let x = -100;
    let y = -100;
    let sx = -100;
    let sy = -100;
    let visible = false;
    let hovering = false;
    let lastSpawnX = -100;
    let lastSpawnY = -100;
    let lastMoveAt = 0;
    // Minimal style: the ring radius eases toward its target so the
    // hover expansion feels smooth, and a click gives a brief pulse.
    let ringR = 10;
    let pressedAt = 0;

    const particles: Particle[] = [];
    const rings: Ring[] = [];

    const spawnTrail = (px: number, py: number, speed: number) => {
      if (!palette) return;
      // Faster movement → a few more particles, wider spread. Counts stay
      // tiny (1–3 per step) so the trail reads elegant, never confetti.
      const count = reduced ? 0 : speed > 14 ? 3 : speed > 5 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        if (particles.length >= MAX_PARTICLES) particles.shift();
        const spread = 3 + Math.min(speed * 0.35, 10);
        const ttl = 550 + Math.random() * 450;
        particles.push({
          x: px + (Math.random() - 0.5) * spread,
          y: py + (Math.random() - 0.5) * spread,
          vx: (Math.random() - 0.5) * 0.35,
          vy: -0.12 - Math.random() * 0.35, // gentle upward float
          life: ttl,
          ttl,
          size: 0.8 + Math.random() * 2.1,
          hue: palette.pick(),
          burst: false,
        });
      }
    };

    const burst = (px: number, py: number) => {
      if (!palette || reduced) return;
      const n = 14;
      for (let i = 0; i < n; i++) {
        if (particles.length >= MAX_PARTICLES) particles.shift();
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.25;
        const sp = 0.9 + Math.random() * 1.1;
        const ttl = 420 + Math.random() * 260;
        particles.push({
          x: px,
          y: py,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: ttl,
          ttl,
          size: 1 + Math.random() * 1.8,
          hue: palette.pick(),
          burst: true,
        });
      }
      rings.push({ x: px, y: py, life: 380, ttl: 380 });
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      x = e.clientX;
      y = e.clientY;
      if (!visible) {
        sx = x;
        sy = y;
        lastSpawnX = x;
        lastSpawnY = y;
        visible = true;
      }
      lastMoveAt = performance.now();
    };
    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      hovering = !!(t && typeof t.closest === "function" && t.closest(INTERACTIVE));
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (minimal) pressedAt = performance.now();
      else burst(e.clientX, e.clientY);
    };
    const onLeave = () => {
      visible = false;
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("mouseover", onOver, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    let raf = 0;
    let prev = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(now - prev, 50);
      prev = now;
      ctx.clearRect(0, 0, w, h);
      if (!visible) return;

      if (minimal) {
        // Clean dot + ring, no trail, no glow, no burst. The ring eases
        // out slightly over clickable elements (and pulses briefly on
        // click), then settles back.
        const sincePress = now - pressedAt;
        const pressPulse = pressedAt > 0 && sincePress < 220 ? Math.sin((sincePress / 220) * Math.PI) * 3 : 0;
        const target = (hovering ? 15 : 10.5) + pressPulse;
        ringR += (target - ringR) * 0.22;
        ctx.strokeStyle = hovering ? "rgba(36, 27, 58, 0.6)" : "rgba(36, 27, 58, 0.38)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#241b3a";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      if (!palette) return;

      // Smooth-follow point trailing the real pointer.
      sx += (x - sx) * 0.32;
      sy += (y - sy) * 0.32;

      // Spawn trail particles based on smoothed travel distance, so a
      // fast flick lays a denser trail than a slow drift.
      const dx = sx - lastSpawnX;
      const dy = sy - lastSpawnY;
      const dist = Math.hypot(dx, dy);
      if (dist > 3 && now - lastMoveAt < 120) {
        spawnTrail(sx, sy, dist);
        lastSpawnX = sx;
        lastSpawnY = sy;
      }

      // Trail particles: drift, spread, fade.
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * (dt / 16.7);
        p.y += p.vy * (dt / 16.7);
        if (p.burst) {
          p.vx *= 0.965;
          p.vy *= 0.965;
        }
        const t = p.life / p.ttl;
        const alpha = (p.hue === palette.softIndex ? 0.4 : 0.75) * t;
        const r = p.size * (0.55 + 0.45 * t);
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
        grad.addColorStop(0, particleColor(p.hue, alpha));
        grad.addColorStop(1, particleColor(p.hue, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = particleColor(p.hue, Math.min(1, alpha + 0.2));
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Click burst rings.
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i]!;
        ring.life -= dt;
        if (ring.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        const t = 1 - ring.life / ring.ttl;
        ctx.strokeStyle = rgb(palette.burstRingRgb, 0.45 * (1 - t));
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, 6 + t * 26, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Main cursor: layered glow + bright core + depth highlight. Grows
      // and brightens slightly over interactive elements.
      const grow = hovering ? 1.45 : 1;
      const glowR = 15 * grow;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      glow.addColorStop(0, rgb(palette.glowRgb, hovering ? 0.5 : 0.34));
      glow.addColorStop(0.55, rgb(palette.deepRgb, 0.16));
      glow.addColorStop(1, rgb(palette.deepRgb, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fill();

      if (hovering) {
        ctx.strokeStyle = palette.hoverRing;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 9.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      const coreR = 4.2 * grow;
      const core = ctx.createRadialGradient(x - coreR * 0.35, y - coreR * 0.4, 0, x, y, coreR);
      core.addColorStop(0, palette.core[0]);
      core.addColorStop(0.45, palette.core[1]);
      core.addColorStop(1, palette.core[2]);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, coreR, 0, Math.PI * 2);
      ctx.fill();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      // Wipe the last painted frame as the loop stops — otherwise the
      // glow + trail stay frozen on the canvas at the last mouse
      // position (the canvas itself stays mounted and visible).
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("mouseover", onOver);
      window.removeEventListener("pointerdown", onDown);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.documentElement.classList.remove("has-particle-cursor");
    };
  }, [style]);

  // Rendered always; the effect no-ops on touch devices and for the
  // "off" style, and the canvas itself is hidden by CSS unless a fine
  // pointer is present.
  return <canvas ref={canvasRef} className="particle-cursor-canvas" aria-hidden="true" />;
}
