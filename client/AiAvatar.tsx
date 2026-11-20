import { useId } from "react";

/** The AI's face: the Sprout logo, given a friendly face, on the GenZ
 *  gradient. This is the avatar the user sees wherever the AI speaks
 *  — the AI CFO header and thinking card, and the Smart Add bar in
 *  Quick Add. Pure SVG, so it stays crisp at any size and is always
 *  exactly the logo — never a generated image that drifts from the
 *  brand.
 *
 *  Geometry: the LogoMark paths live in a 0–100 box (arrowhead x
 *  30–70, y 6–34; shaft x 42–58, y 34–58; stem + leaves y 64–94).
 *  The sprout is scaled to 0.66 and moved to (17, 12), so the
 *  arrowhead lands at roughly x 37–63, y 16–30 — the eyes sit on it
 *  at y 26 and the smile just below them at y 30, still on the white
 *  arrowhead. The face is deep violet (#4c1d95) so it reads on the
 *  white sprout. */
export function AiAvatar({
  size = 40,
  pulse = false,
  label = "AI avatar",
}: {
  size?: number;
  /** Gentle pulse while the AI is working (same animation as the loader). */
  pulse?: boolean;
  label?: string;
}) {
  const gradId = useId();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} className={pulse ? "cg-loader" : undefined} aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="55%" stopColor="#d946ef" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="48" fill={`url(#${gradId})`} />
        <g transform="translate(17 12) scale(0.66)" fill="#ffffff">
          <path d="M50 6 L70 28 C72 30 70 34 67 34 L58 34 L58 50 C58 55 54 58 50 58 C46 58 42 55 42 50 L42 34 L33 34 C30 34 28 30 30 28 Z" />
          <path d="M48 64 L52 64 L51 94 L49 94 Z" />
          <path d="M47 64 C31 64 19 74 15 90 C29 92 43 84 47 66 Z" />
          <path d="M53 64 C69 64 81 74 85 90 C71 92 57 84 53 66 Z" />
        </g>
        <circle cx="44" cy="26" r="2.4" fill="#4c1d95" />
        <circle cx="56" cy="26" r="2.4" fill="#4c1d95" />
        <path d="M45 30 Q50 34.5 55 30" fill="none" stroke="#4c1d95" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}
