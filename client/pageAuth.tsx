import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  setAuthToken,
  withTimeout,
  AUTH_TIMEOUT_MS,
  AUTH_TIMEOUT_MESSAGE,
} from "./api";
import { startGoogleOAuth } from "./supabase";
import { GlassOrb, ParticleField } from "./components";
import { WhyCashflowGenius } from "./pitch";
import { InstallButton } from "./pwa";
// Intro videos live in public/assets/ (served at /assets/…) — Next.js
// cannot bundle .mp4/.webm imports, so these are plain URL strings.
const introMp4 = "/assets/cashflow-intro.mp4";
const introWebm = "/assets/cashflow-intro.webm";
const introPortraitMp4 = "/assets/cashflow-intro-portrait.mp4";
const introPortraitWebm = "/assets/cashflow-intro-portrait.webm";

// ------------------------------------------------------------------
// Cinematic intro — EXACTLY 5 seconds.
//
// Playback repair (this component previously had NO video at all: no
// <video> element and no video file existed anywhere in the project, so
// there was nothing for the browser to load or play — the "video" was
// only the CSS/DOM animation below, whose stage timers started on mount
// whether or not anything had rendered, and whose particles use CSS
// animation delays of up to ~10s, far beyond the 5s intro, so the scene
// could look blank, frozen or flickery and no video ever appeared in
// the network log).
//
// Now the intro plays a real local video asset — cashflow-intro.mp4
// (H.264 High, yuv420p, faststart, 1280x720, exactly 5.000s) with a
// VP9 WebM alternative — rendered from this app's own design (GenZ
// gradient: violet → fuchsia → coral over a soft lavender base,
// gradient particles gathering, tinted glass sphere, logo + tagline
// reveal; no external or stock footage). Playback rules:
//  - one single <video> instance, muted + playsInline + autoPlay +
//    preload="auto" so mobile autoplay policies allow it;
//  - the 5s sequence clock starts only when the video can actually
//    play (canplay), never before it has loaded;
//  - the video layer stays transparent until that moment, over the
//    soft gradient, so there is no black frame or flicker;
//  - if the video cannot load/play within 1.2s, or errors at any
//    point, the existing procedural animation below runs the same
//    5-second sequence as the fallback — never a blank screen.
//
// Full-screen on every screen — the intro is orientation-aware.
// The landscape master is 16:9 and its baked-in title spans the middle
// ~56% of the frame, so on a portrait phone neither plain fit works:
// object-cover crops the title to "HFLOW GE", and object-contain (the
// previous fix) letterboxed the video into a band across the middle of
// the screen with empty gradient above and below — the "half screen"
// intro the user reported. Phones therefore get a dedicated portrait
// cut of the same video — cashflow-intro-portrait.* (720x1280, 9:16,
// exactly 5.000s, derived from the landscape master with ffmpeg): the
// full sharp frame sits at the centre of a 9:16 canvas whose top and
// bottom are filled with the master's own gradient, blurred and
// feathered into the scene, so the complete sphere + full title +
// tagline stay sharp and visible while the picture itself fills the
// whole phone screen edge to edge. The component picks the portrait
// sources whenever the viewport is portrait (aspect ratio <= 1:1) and
// re-picks live if the device rotates mid-intro; the video always uses
// object-cover, so no viewport ever shows letterbox bars again.
// Wider/landscape viewports keep the original 16:9 master with
// object-cover (vertical crop only, which never touches the
// horizontally-centred title). The procedural fallback below is a
// full-screen flex scene, so it fills portrait phones too.
// Reduced-motion users skip the intro entirely in App.
// ------------------------------------------------------------------

export function CinematicIntro({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [started, setStarted] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  // Portrait phones (and portrait tablets) play the 9:16 portrait cut;
  // landscape screens play the 16:9 master. Tracked live so rotating
  // the device during the 5 seconds swaps to the matching cut.
  const [isPortrait, setIsPortrait] = useState<boolean>(() => {
    try {
      return window.matchMedia("(max-aspect-ratio: 1/1)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(max-aspect-ratio: 1/1)");
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    setIsPortrait(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startedRef = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // Begin the 5-second sequence exactly once, whichever path (video or
  // procedural fallback) gets there first.
  const beginRef = useRef(() => {});
  beginRef.current = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStarted(true);
  };

  // Stage + finish timers run from the moment playback actually starts,
  // so the visible sequence is a full 5 seconds: fade at 4.4s, done at
  // exactly 5.0s.
  useEffect(() => {
    if (!started) return;
    const timers = [
      setTimeout(() => setStage(1), 900),
      setTimeout(() => setStage(2), 2100),
      setTimeout(() => setStage(3), 3300),
      setTimeout(() => setLeaving(true), 4400),
      setTimeout(() => doneRef.current(), 5000),
    ];
    return () => timers.forEach(clearTimeout);
  }, [started]);

  // Fallback trigger: video not playable within 1.2s -> start the same
  // sequence with the procedural animation instead of waiting on a
  // blank or frozen frame.
  useEffect(() => {
    const fallback = setTimeout(() => beginRef.current(), 1200);
    return () => clearTimeout(fallback);
  }, []);

  // Explicit muted play attempt (some browsers resolve autoplay only via
  // the promise). If playback is blocked but a frame is available, begin
  // anyway so the sequence never stalls.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    v.play().catch(() => {
      if (!cancelled && v.readyState >= 2) beginRef.current();
    });
    return () => {
      cancelled = true;
      v.pause();
    };
  }, []);

  const videoActive = videoReady && !videoFailed;

  return (
    <div
      className="fixed inset-0 z-[80] flex h-[100dvh] flex-col overflow-hidden transition-opacity duration-[600ms]"
      style={{
        background:
          "linear-gradient(170deg, #FDFBFF 0%, #F3EFFF 45%, #FCE7F3 78%, #FFEDD5 100%)",
        opacity: leaving ? 0 : 1,
      }}
      role="img"
      aria-label="Cashflow Genius opening: a glass sphere forms from violet, fuchsia and coral gradient particles, then the Cashflow Genius logo appears with the tagline See money before it moves."
    >
      <video
        // Remount when the orientation cut changes (device rotated
        // mid-intro) so the browser actually loads the other asset.
        key={isPortrait ? "portrait" : "landscape"}
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover transition-opacity duration-500"
        style={{ opacity: videoActive ? 1 : 0 }}
        autoPlay
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden
        tabIndex={-1}
        onCanPlay={() => {
          setVideoReady(true);
          beginRef.current();
        }}
        onPlaying={() => {
          setVideoReady(true);
          beginRef.current();
        }}
        onError={() => setVideoFailed(true)}
      >
        {isPortrait ? (
          <>
            <source src={introPortraitWebm} type="video/webm" />
            <source src={introPortraitMp4} type="video/mp4" />
          </>
        ) : (
          <>
            <source src={introWebm} type="video/webm" />
            <source src={introMp4} type="video/mp4" />
          </>
        )}
      </video>
      <div
        className="absolute inset-0 flex flex-col transition-opacity duration-500"
        style={{ opacity: videoActive ? 0 : 1 }}
        aria-hidden={videoActive}
      >
      <ParticleField count={40} dense />
      {/* flowing digital light */}
      <div
        aria-hidden
        className="absolute left-[-20%] top-[16%] h-40 w-[140%] rounded-full blur-3xl"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(237,233,254,0.9), rgba(245,208,254,0.55), transparent)",
          animation: "light-flow 5s ease-in-out infinite",
        }}
      />
      <div
        aria-hidden
        className="absolute left-[-20%] top-[58%] h-32 w-[140%] rounded-full blur-3xl"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(221,214,254,0.65), transparent)",
          animation: "light-flow 5s ease-in-out 1.2s infinite",
        }}
      />
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-[440px] w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-1000"
        style={{
          background:
            "radial-gradient(circle, rgba(237,233,254,0.9), transparent 68%)",
          opacity: stage >= 1 ? 1 : 0,
        }}
      />
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div
          className="transition-all duration-1000"
          style={{
            opacity: stage >= 1 ? 1 : 0.2,
            transform: stage >= 1 ? "scale(1)" : "scale(0.8)",
          }}
        >
          <GlassOrb
            size={stage >= 2 ? 196 : 148}
            label={stage >= 2 ? "₹" : undefined}
            sub={stage >= 2 ? "your money, visualised" : undefined}
          />
        </div>
        <div
          className="mt-8 transition-all duration-700"
          style={{
            opacity: stage >= 2 ? 1 : 0,
            transform: stage >= 2 ? "translateY(0)" : "translateY(14px)",
          }}
        >
          <p className="max-w-full text-[clamp(1.25rem,6vw,1.875rem)] font-extrabold tracking-[0.18em] text-[var(--text)] sm:text-4xl">
            CASHFLOW <span className="text-[var(--accent)]">GENIUS</span>
          </p>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.3em] text-[var(--dim)]">
            The Living Ledger
          </p>
        </div>
        <p
          className="mt-5 text-xl font-semibold text-[var(--accent)] transition-all delay-100 duration-700 sm:text-2xl"
          style={{
            opacity: stage >= 3 ? 1 : 0,
            transform: stage >= 3 ? "translateY(0)" : "translateY(10px)",
          }}
        >
          “See money before it moves.”
        </p>
      </div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 px-6 pb-8"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
      >
        <p className="mb-2 text-center text-xs font-semibold text-[var(--dim)]" role="status">
          {stage === 0
            ? "Gathering your financial universe…"
            : stage === 1
              ? "Forming the glass sphere…"
              : stage === 2
                ? "Revealing Cashflow Genius…"
                : "Welcome."}
        </p>
        <div className="mx-auto h-1 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-mint)]">
          {started ? (
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ animation: "intro-progress 5s linear forwards" }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------------

function SetupNotice() {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--ai)] px-4 py-3 text-left text-xs leading-relaxed text-[var(--ai-text)]">
      <strong>Account setup note:</strong> Two ways in, both through
      Supabase Auth. “Continue with Google” signs you in with your own
      Google account, into your own private workspace. Or sign up with
      your email + a password: Supabase emails a confirmation link to
      your own inbox (its free built-in sender — only a few emails per
      hour, so it can occasionally ask you to wait), and you tap that
      link to verify; the link is never shown in this app.
      Mobile-number sign-up is not offered — there is no free SMS OTP,
      so a phone number can never be a sign-in method here (it can be
      saved later as an optional profile detail). Password reset for
      email accounts isn&rsquo;t wired in-app yet, so it stays honestly
      unavailable rather than faked — a reset code is never handed to
      someone who merely knows your email. (Google accounts never need
      one: Google itself verifies you.)
    </p>
  );
}

// ------------------------------------------------------------------
// Continue with Google — the primary sign-in option.
//
// Real flow, wired through Supabase Auth: tapping the button starts
// Supabase's Google OAuth flow (PKCE) in supabase.ts — the browser
// goes to Google's own sign-in page, Google returns to Supabase's
// callback, and Supabase redirects back here with an auth code. The
// app shell exchanges the code, and the server verifies the resulting
// Supabase token with Supabase before opening that person's own
// account: every Google user lands in their OWN workspace, and a
// brand-new Google user starts completely empty. Nothing is faked —
// if the flow cannot start, the error is shown under the button.
// ------------------------------------------------------------------

export function GoogleSignIn({ notify }: { notify?: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-center gap-3 rounded-full border-[1.5px] border-[var(--border)] bg-white px-6 py-3.5 text-sm font-extrabold text-[var(--text)] shadow-[0_8px_20px_rgba(76,29,149,0.10)] transition hover:bg-[var(--surface-soft)] active:scale-[0.98] disabled:opacity-60"
        aria-label="Continue with Google"
        disabled={busy}
        onClick={() => {
          setError(null);
          setBusy(true);
          void startGoogleOAuth().catch((e: unknown) => {
            setBusy(false);
            const msg = `Google sign-in couldn't start: ${e instanceof Error ? e.message : String(e)} — email sign-up / login below works fully.`;
            setError(msg);
            notify?.(msg);
          });
        }}
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden focusable="false">
          <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
        </svg>
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      <p className="mt-2 text-center text-xs leading-relaxed text-[var(--dim)]">
        Your own Google account, your own private workspace — new Google
        users start empty. Sign-in runs through Supabase Auth.
      </p>
      {error ? (
        <p
          className="mt-3 rounded-2xl bg-[var(--err)] px-4 py-3 text-left text-xs leading-relaxed font-semibold text-[var(--err-text)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function OrDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--dim)]">{label}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}

// Honest connection summary, visible before sign-in. The Supabase /
// Google / Email rows come from a REAL server-side probe of the
// connected Supabase project (getSupabaseAuthStatus asks Supabase Auth
// for its own settings), and the Workspace database row comes from a
// REAL database probe in the same call (connect + auth_users table
// present): each is only shown Live when its own check actually
// answers, and while the check is still running the rows say
// “Checking…”, never Live. The database row used to be hardcoded
// Live — which is how the strip claimed Live while every database
// query was failing. Gemini is Live only when a Gemini key is
// configured on the server; otherwise it stays Not connected and the
// AI CFO answers with the built-in rule-based fallback. After
// sign-in, Settings → Live connections re-checks every service in
// real time.
function ConnectionStrip() {
  const sb = useQuery({
    queryKey: ["cg-supabase-status"],
    queryFn: () => api.getSupabaseAuthStatus({}),
    staleTime: 60_000,
    retry: 1,
  });
  const checking = sb.isPending;
  const sbLive = sb.data?.reachable === true;
  const googleLive = sb.data?.googleEnabled === true;
  const emailLive = sb.data?.emailEnabled === true;
  const dbLive = sb.data?.databaseLive === true;
  const dbTablesReady = sb.data?.databaseTablesReady === true;
  const aiLive = sb.data?.aiConfigured === true;
  const rows: { name: string; state: "live" | "off" | "checking"; note: string }[] = [
    {
      name: "Workspace database",
      state: checking ? "checking" : dbLive ? "live" : "off",
      note: checking
        ? "Checking the database…"
        : dbLive
          ? dbTablesReady
            ? "Your records live here — database answered just now"
            : "Database answered, but its tables aren't set up yet"
          : sb.data?.databaseErrorCode === "28P01"
            ? "Database didn't answer — its sign-in (DATABASE_URL password) looks wrong"
            : sb.data?.databaseErrorCode === "42P01"
              ? "Database answered, but its tables aren't set up yet — the setup migration needs to run"
              : sb.data?.databaseErrorCode === "NO_DATABASE_URL"
                ? "Database isn't configured on the server yet (DATABASE_URL is missing)"
                : sb.data?.databaseErrorCode === "TIMEOUT"
                  ? "Database took too long to answer the live check — try again in a moment"
                  : "Database didn't answer the live check just now — sign-in can't work until it does",
    },
    {
      name: "AI CFO engine",
      state: checking ? "checking" : aiLive ? "live" : "off",
      note: checking
        ? "Checking…"
        : aiLive
          ? "Gemini connected — AI answers grounded in your figures"
          : "No Gemini key — the AI CFO answers with the built-in rule-based fallback",
    },
    {
      name: "Supabase",
      state: checking ? "checking" : sbLive ? "live" : "off",
      note: checking
        ? "Checking with Supabase…"
        : sbLive
          ? "Project connected — powers Google sign-in + email verification"
          : "Project didn't answer the live check just now",
    },
    {
      name: "Google sign-in",
      state: checking ? "checking" : googleLive ? "live" : "off",
      note: checking
        ? "Checking with Supabase…"
        : googleLive
          ? "Real Google sign-in via Supabase Auth"
          : "Not confirmed by the live check just now",
    },
    {
      name: "Email verification",
      state: checking ? "checking" : emailLive ? "live" : "off",
      note: checking
        ? "Checking with Supabase…"
        : emailLive
          ? "Sign-up confirmation links emailed by Supabase's free sender (a few per hour)"
          : "Not confirmed by the live check just now",
    },
    { name: "Google Gemini", state: "off", note: "No Gemini connection wired yet" },
  ];
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-left">
      <p className="text-[11px] font-extrabold uppercase tracking-widest text-[var(--dim)]">
        What’s connected
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {rows.map((r) => (
          <li key={r.name} className="flex items-start gap-2 text-xs">
            <span
              aria-hidden
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${r.state === "live" ? "bg-[var(--accent)]" : "bg-[#f59e0b]"}`}
            />
            <span>
              <strong className="text-[var(--text)]">{r.name}</strong>{" "}
              <span className={`font-bold ${r.state === "live" ? "text-[var(--accent)]" : "text-[var(--warn-text)]"}`}>
                {r.state === "live" ? "Live" : r.state === "checking" ? "Checking…" : "Not connected"}
              </span>
              <span className="block text-[var(--dim)]">{r.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
        {label}
      </span>
      <span className="relative block">
        <input
          className="field pr-16"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 text-xs font-bold text-[var(--accent)] hover:bg-[var(--surface-soft)]"
          aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={show}
          onClick={() => setShow((v) => !v)}
        >
          {show ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      className="rounded-2xl bg-[var(--err)] px-4 py-3 text-sm font-semibold text-[var(--err-text)]"
      role="alert"
    >
      {error}
    </p>
  );
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <ParticleField count={18} />
      <div className="glass rise relative w-full max-w-md rounded-3xl p-7 sm:p-8">
        <div className="text-center">
          <GlassOrb size={92} label="₹" />
          <h1 className="mt-4 text-xl font-extrabold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-[var(--dim)]">{subtitle}</p>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Public homepage (shown after the intro, before sign-in)
// ------------------------------------------------------------------

export function PublicHome({
  onLogin,
  onSignup,
  notify,
}: {
  onLogin: () => void;
  onSignup: () => void;
  notify?: (m: string) => void;
}) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <ParticleField count={22} />
      <div className="glass rise relative w-full max-w-lg rounded-3xl p-7 text-center sm:p-9">
        <GlassOrb size={130} label="₹" sub="The Living Ledger" />
        <p className="display-font mt-5 text-[32px] font-semibold leading-tight">
          Cashflow <span className="text-[var(--accent)]">Genius</span>
        </p>
        <p className="mt-1 text-xs font-bold uppercase tracking-[0.3em] text-[var(--dim)]">
          The Living Ledger
        </p>
        <p className="mt-3 text-lg font-semibold text-[var(--accent)]">
          “See money before it moves.”
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          One calm home for your money: see what you have, what&rsquo;s coming in
          and going out, what&rsquo;s due, and what you&rsquo;ve saved — plus
          invoices with GST, a future forecast, a scam check for suspicious UPI
          messages, and an AI CFO that answers from your real numbers.
          Everything is calculated from your own records, private to your account.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-left">
          <div className="rounded-2xl bg-[var(--surface-soft)] px-3.5 py-3">
            <p className="text-sm font-extrabold">☰ Personal Money</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
              Daily spending, income and budgets — for everyday money.
            </p>
          </div>
          <div className="rounded-2xl bg-[var(--surface-soft)] px-3.5 py-3">
            <p className="text-sm font-extrabold">▤ Business Money</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
              Invoices, GST, leak scanner and business reports switched on.
            </p>
          </div>
          <div className="rounded-2xl bg-[var(--surface-soft)] px-3.5 py-3">
            <p className="text-sm font-extrabold">✦ Creator &amp; Freelancer</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
              Client payments, brand deals and platform payouts, kept in their own workspace.
            </p>
          </div>
          <div className="rounded-2xl bg-[var(--surface-soft)] px-3.5 py-3">
            <p className="text-sm font-extrabold">🎓 Student / First Salary</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
              Pocket money, part-time work and a first salary — simple and separate.
            </p>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-[var(--dim)]">
          Four completely separate workspaces — you choose at sign-up, switch any time
          in Settings, and data never mixes between them.
        </p>

        {/* Sign in — Google first, then your own account. Every
            account is a real, private account that starts with an
            empty workspace. */}
        <div className="mt-6">
          <GoogleSignIn notify={notify} />
        </div>

        <OrDivider label="or use your own account" />

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            className="btn-primary flex-1 px-6 py-3 text-sm"
            onClick={onLogin}
          >
            Login
          </button>
          <button
            type="button"
            className="btn-ghost flex-1 px-6 py-3 text-sm"
            onClick={onSignup}
          >
            Sign Up
          </button>
        </div>
        <p className="mt-3 text-center text-xs leading-relaxed text-[var(--dim)]">
          New here? Sign up with your email — Supabase emails you a confirmation link to
          verify it — or just continue with Google. Your workspace starts empty,
          with only your own records, and a short app tour shows you everything
          right after setup. It can be skipped any time.
        </p>
        <div className="mt-4 flex justify-center">
          <InstallButton onNotify={notify} />
        </div>
        <div className="mt-5">
          <ConnectionStrip />
        </div>
        <div className="mt-3">
          <SetupNotice />
        </div>
        <details className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3">
          <summary className="cursor-pointer text-sm font-extrabold text-[var(--accent)]">
            Why Cashflow Genius? — the pitch, honest limits included
          </summary>
          <div className="mt-3">
            <WhyCashflowGenius compact />
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">
            The full version, with the comparison table, is inside the app in Settings → Why Cashflow Genius?
          </p>
        </details>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Login
// ------------------------------------------------------------------

export function LoginScreen({
  notify,
  onAuthed,
  onSignup,
  onForgot,
  onNeedsVerify,
  onHome,
}: {
  notify: (m: string) => void;
  onAuthed: () => void;
  onSignup: () => void;
  onForgot: (identifier: string) => void;
  onNeedsVerify: (identifier: string) => void;
  onHome: () => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (identifier.trim().length < 3)
      return setError("Enter your registered email address.");
    if (!password) return setError("Enter your password.");
    setBusy(true);
    try {
      const res = await withTimeout(
        api.login({ identifier: identifier.trim(), password }),
        AUTH_TIMEOUT_MS,
        AUTH_TIMEOUT_MESSAGE,
      );
      if (res.needsVerification) {
        notify(
          res.error ??
            "This account hasn't been verified yet — a fresh code has been emailed to you.",
        );
        onNeedsVerify(identifier.trim().toLowerCase());
        return;
      }
      if (!res.ok || !res.token) {
        setError(res.error ?? "Login failed. Please try again.");
        return;
      }
      setAuthToken(res.token);
      notify("Welcome back — you're signed in.");
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Continue with Google, or log in with your registered email address and password."
    >
      <GoogleSignIn notify={notify} />
      <OrDivider label="or with email" />
      <form className="space-y-4" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
            Email address
          </span>
          <input
            className="field"
            type="email"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            aria-label="Email address"
            placeholder="you@example.com"
            autoComplete="username"
            required
          />
        </label>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <button
          type="submit"
          className="btn-primary w-full px-6 py-3 text-sm"
          disabled={busy}
        >
          {busy ? "Logging in…" : "Login"}
        </button>
      </form>
      <div className="mt-4 flex items-center justify-between text-sm">
        <button
          type="button"
          className="font-bold text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => onForgot(identifier.trim())}
        >
          Forgot password?
        </button>
        <button
          type="button"
          className="font-bold text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={onSignup}
        >
          Create an account
        </button>
      </div>
      <button
        type="button"
        className="btn-ghost mt-4 w-full px-4 py-2 text-xs"
        onClick={onHome}
      >
        ← Back to home
      </button>
    </AuthCard>
  );
}

// ------------------------------------------------------------------
// Sign up (email + password, then a real emailed confirmation link)
// ------------------------------------------------------------------

export function SignupScreen({
  notify,
  onVerify,
  onLogin,
  onHome,
}: {
  notify: (m: string) => void;
  onVerify: (identifier: string) => void;
  onLogin: () => void;
  onHome: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const identifier = email.trim().toLowerCase();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setError("Please enter a valid email address.");
    if (password.length < 8)
      return setError("Your password must be at least 8 characters long.");
    if (password !== confirm)
      return setError("Password and confirm password don't match.");
    setBusy(true);
    try {
      const res = await withTimeout(
        api.register({ email: identifier, password }),
        AUTH_TIMEOUT_MS,
        AUTH_TIMEOUT_MESSAGE,
      );
      if (!res.ok) {
        setError(res.error ?? "Sign up failed. Please try again.");
        return;
      }
      notify(
        "Account created — check your inbox: we emailed you a confirmation link. Tap it to finish setting up your account.",
      );
      onVerify(identifier);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Create your account"
      subtitle="Continue with Google, or sign up with your email. Your own private workspace — it starts empty, with only your records."
    >
      <GoogleSignIn notify={notify} />
      <OrDivider label="or sign up with email" />
      <form className="space-y-4" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
            Email address
          </span>
          <input
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email address"
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </label>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <PasswordField
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <p className="text-xs leading-relaxed text-[var(--dim)]">
          At least 8 characters.{" "}
          <strong className="text-[var(--text)]">
            How verification works:
          </strong>{" "}
          the moment you tap Sign Up, Supabase emails a confirmation link
          to this address (free built-in sender). Open your inbox, tap
          the link, and your account is active — the link is never shown
          inside this app. The free sender allows only a few emails per
          hour, so if it is busy the app will tell you to wait a little
          rather than pretend. (Google accounts skip this entirely —
          Google verifies you itself.)
        </p>
        <p className="text-xs leading-relaxed text-[var(--dim)]">
          <strong className="text-[var(--text)]">No mobile sign-up:</strong>{" "}
          phone OTP needs paid SMS, and this app runs free — so a mobile
          number is never a login method here. You can add one later as
          an optional profile detail after you&rsquo;re signed in.
        </p>
        <button
          type="submit"
          className="btn-primary w-full px-6 py-3 text-sm"
          disabled={busy}
        >
          {busy ? "Creating account…" : "Sign Up"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm">
        Already have an account?{" "}
        <button
          type="button"
          className="font-bold text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={onLogin}
        >
          Login
        </button>
      </p>
      <div className="mt-5 space-y-3">
        <SetupNotice />
        <button
          type="button"
          className="btn-ghost w-full px-4 py-2 text-xs"
          onClick={onHome}
        >
          ← Back to home
        </button>
      </div>
    </AuthCard>
  );
}

// ------------------------------------------------------------------
// Verification — after sign-up. Supabase emails a confirmation LINK
// (not a code): tapping it signs the account in. The code box below
// is a fallback for the rare email that also carries a code —
// Supabase checks what the user types (via the server's
// verifyAccount action). Nothing about the link or code is ever
// shown in this app.
// ------------------------------------------------------------------

export function VerifyScreen({
  identifier,
  notify,
  onAuthed,
  onLogin,
}: {
  identifier: string;
  notify: (m: string) => void;
  onAuthed: () => void;
  onLogin: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!/^\d{6}$/.test(code.trim()))
      return setError("Enter the 6-digit code from your email.");
    setBusy(true);
    try {
      const res = await withTimeout(
        api.verifyAccount({
          email: identifier,
          code: code.trim(),
        }),
        AUTH_TIMEOUT_MS,
        AUTH_TIMEOUT_MESSAGE,
      );
      if (!res.ok || !res.token) {
        setError(res.error ?? "Verification failed. Please try again.");
        return;
      }
      setAuthToken(res.token);
      notify("Account verified — welcome to Cashflow Genius.");
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const res = await withTimeout(
        api.resendEmailOtp({ email: identifier }),
        AUTH_TIMEOUT_MS,
        AUTH_TIMEOUT_MESSAGE,
      );
      if (!res.ok) {
        setError(res.error ?? "A new link couldn't be sent just now.");
        return;
      }
      setNotice(
        "A new confirmation link is on its way to your inbox. Tap the newest one — older links stop working.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthCard
      title="Check your email"
      subtitle={`We emailed a confirmation link to ${identifier || "your email address"}. Tap the link in the email to finish setting up your account — it stays valid for 1 hour. If your email also contains a 6-digit code, you can enter it below instead.`}
    >
      <div className="space-y-4">
        <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] px-4 py-3 text-left text-xs leading-relaxed text-[var(--dim)]">
          The email comes from Supabase (this app&rsquo;s sign-in provider) and
          the link exists only in your inbox — it is never shown here. Check
          your spam / promotions folder if it doesn&rsquo;t arrive in a
          minute or two. Supabase&rsquo;s free sender allows only a few
          emails per hour, so a resend can occasionally ask you to wait.
        </p>
        {notice ? (
          <p
            className="rounded-2xl bg-[var(--ai)] px-4 py-3 text-sm font-semibold text-[var(--ai-text)]"
            role="status"
          >
            {notice}
          </p>
        ) : null}
        <form className="space-y-4" onSubmit={submit}>
          <ErrorBox error={error} />
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
              Verification code from your email
            </span>
            <input
              className="field text-center text-xl font-extrabold tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-label="6-digit verification code from your email"
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
          <button
            type="submit"
            className="btn-primary w-full px-6 py-3 text-sm"
            disabled={busy}
          >
            {busy ? "Verifying…" : "Verify & enter my workspace"}
          </button>
        </form>
        <div className="flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            className="font-bold text-[var(--accent)] underline-offset-2 hover:underline disabled:opacity-60"
            onClick={() => void resend()}
            disabled={resending || busy}
          >
            {resending ? "Sending…" : "Send a new link"}
          </button>
          <button
            type="button"
            className="shrink-0 font-bold text-[var(--accent)] underline-offset-2 hover:underline"
            onClick={onLogin}
          >
            Back to login
          </button>
        </div>
        <SetupNotice />
      </div>
    </AuthCard>
  );
}

// ------------------------------------------------------------------
// Forgot password. Reset codes are NEVER shown to an unauthenticated
// requester — that would let anyone who knows an email address take
// over the account. Sign-up verification email is live via Supabase,
// but an in-app reset-completion flow for workspace password accounts
// is not wired yet, so reset is honestly reported as unavailable
// rather than faked; the panel below gives the two routes that work.
// ------------------------------------------------------------------

export function ForgotScreen({
  initialIdentifier,
  onLogin,
}: {
  initialIdentifier: string;
  onLogin: () => void;
}) {
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (identifier.trim().length < 3)
      return setError("Enter your registered email address.");
    setBusy(true);
    try {
      const res = await withTimeout(
        api.requestPasswordReset({
          identifier: identifier.trim(),
        }),
        AUTH_TIMEOUT_MS,
        AUTH_TIMEOUT_MESSAGE,
      );
      if (!res.ok) {
        setError(res.error ?? "Could not check reset availability. Please try again.");
        return;
      }
      setRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Forgot password"
      subtitle="Password reset protects your account: a reset code is only ever sent to your own email — never shown to whoever asks."
    >
      <form className="space-y-4" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
            Email address
          </span>
          <input
            className="field"
            type="email"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            aria-label="Email address for password reset"
            placeholder="you@example.com"
            autoComplete="username"
            required
          />
        </label>
        <p className="text-xs leading-relaxed text-[var(--dim)]">
          Tap the button and this screen checks the account and shows you
          the result right here — nothing happens silently, and nothing
          is sent anywhere without telling you.
        </p>
        <button
          type="submit"
          className="btn-primary w-full px-6 py-3 text-sm"
          disabled={busy}
        >
          {busy ? "Checking…" : "Request password reset"}
        </button>
      </form>
      {requested ? (
        <div
          className="mt-4 rounded-2xl bg-[var(--warn)] px-4 py-3 text-sm leading-relaxed text-[var(--warn-text)]"
          role="status"
        >
          <p className="font-extrabold">Password reset — result of your check</p>
          <p className="mt-1 font-semibold">
            An in-app password reset for email accounts isn&rsquo;t wired
            yet: sign-up verification email is live, but completing a
            reset inside this app isn&rsquo;t — and for your security a
            reset code is never shown on screen to someone who only
            knows your email address (anyone could take over the account
            that way). Two ways back in that work right now:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-semibold">
            <li>
              Signed up with Google? You never needed this password — use
              “Continue with Google” below and you're straight in.
            </li>
            <li>
              Still remember your password? Go back to login and sign in
              with it — nothing about your account has changed.
            </li>
          </ul>
          <div className="mt-3 rounded-2xl bg-white/70 p-3">
            <GoogleSignIn />
          </div>
          <button
            type="button"
            className="btn-ghost mt-3 w-full px-4 py-2 text-xs"
            onClick={onLogin}
          >
            Back to login
          </button>
        </div>
      ) : null}
      <p className="mt-4 text-center text-sm">
        Remembered it?{" "}
        <button
          type="button"
          className="font-bold text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={onLogin}
        >
          Back to login
        </button>
      </p>
      <div className="mt-5">
        <SetupNotice />
      </div>
    </AuthCard>
  );
}
