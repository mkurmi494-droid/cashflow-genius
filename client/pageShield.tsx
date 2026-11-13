import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
async function fileToBase64(file: File): Promise<{ dataBase64: string; mimeType: string }> {
  const buf = await file.arrayBuffer();
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as unknown as number[]);
  }
  return { dataBase64: btoa(s), mimeType: file.type };
}

import { api, type ApiResponse } from "./api";
import { prettyDate } from "./lib";
import type { PageProps } from "./types";
import { Badge, EmptyState, Field, SectionTitle } from "./components";
import { SAMPLE_SCAM_MESSAGE } from "./parseEntry";

type Analysis = ApiResponse<typeof api, "analyseScamText">;

const VERDICTS: Record<string, { label: string; tone: "err" | "warn" | "mint"; emoji: string; headline: string }> = {
  high_risk: {
    label: "High risk",
    tone: "err",
    emoji: "🛑",
    headline: "This looks like a scam. Do not pay, do not share anything, do not click.",
  },
  suspicious: {
    label: "Suspicious",
    tone: "warn",
    emoji: "⚠️",
    headline: "There are warning signs here. Slow down and verify before you do anything.",
  },
  no_strong_signs: {
    label: "No strong scam signs found",
    tone: "mint",
    emoji: "🔍",
    headline: "Nothing strongly scam-like was found — but that is not a guarantee of safety.",
  },
};

const SEVERITY_TONE: Record<string, "err" | "warn" | "ai" | "grey"> = {
  critical: "err",
  high: "err",
  medium: "warn",
  info: "ai",
};

function ResultPanel({ result }: { result: Analysis }) {
  const v = VERDICTS[result.verdict] ?? VERDICTS.suspicious!;
  return (
    <div
      className={`rounded-3xl border p-5 ${
        result.verdict === "high_risk"
          ? "border-[#e3b7b4] bg-[var(--err)]"
          : result.verdict === "suspicious"
            ? "border-[#e8d9ac] bg-[var(--warn)]"
            : "border-[var(--border)] bg-[var(--surface-soft)]"
      }`}
      role="alert"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-3xl">{v.emoji}</span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-extrabold">{v.label} — risk score {result.riskScore}/100</p>
          <p className="text-sm font-semibold">{v.headline}</p>
        </div>
        <Badge tone={v.tone}>{v.label}</Badge>
      </div>

      {result.reasons.length > 0 ? (
        <ul className="mt-4 space-y-2.5">
          {result.reasons.map((r) => (
            <li key={r.code} className="rounded-2xl bg-white/85 px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-extrabold">
                {r.title}
                <Badge tone={SEVERITY_TONE[r.severity] ?? "grey"}>{r.severity}</Badge>
              </p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{r.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm leading-relaxed">
          No known scam patterns matched. Scammers change tactics constantly, so still confirm the
          payment inside your own bank/UPI app before you hand over goods or services.
        </p>
      )}

      {result.imageFindings ? (
        <div className="mt-4 rounded-2xl bg-white/85 px-4 py-3">
          <p className="text-sm font-extrabold">What the screenshot appears to show</p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
            Read by AI from the image — it can misread, and none of this proves a payment happened.
          </p>
          <dl className="mt-2 grid gap-1.5 text-sm sm:grid-cols-2">
            <div><dt className="font-bold">Looks like a payment screenshot</dt><dd>{result.imageFindings.appearsToBePaymentScreenshot ? "Yes" : "No"}</dd></div>
            <div><dt className="font-bold">Name shown</dt><dd>{result.imageFindings.senderOrReceiverName ?? "Not readable"}</dd></div>
            <div><dt className="font-bold">UPI ID shown</dt><dd>{result.imageFindings.upiId ?? "Not readable"}</dd></div>
            <div><dt className="font-bold">Amount shown</dt><dd>{result.imageFindings.amountText ?? "Not readable"}</dd></div>
            <div><dt className="font-bold">Date shown</dt><dd>{result.imageFindings.dateText ?? "Not readable"}</dd></div>
            <div><dt className="font-bold">Status wording</dt><dd>{result.imageFindings.statusWording ?? "Not readable"}</dd></div>
          </dl>
          {result.imageFindings.visibleText ? (
            <p className="mt-2 rounded-xl bg-[var(--surface-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--dim)]">
              Text read from the image: “{result.imageFindings.visibleText.slice(0, 300)}”
            </p>
          ) : null}
        </div>
      ) : null}

      {result.foundUpiIds.length > 0 || result.foundLinks.length > 0 ? (
        <p className="mt-3 text-xs font-semibold text-[var(--dim)]">
          {result.foundUpiIds.length > 0 ? `UPI ID(s) found: ${result.foundUpiIds.join(", ")}. ` : ""}
          {result.foundLinks.length > 0 ? `Link(s) found: ${result.foundLinks.join(", ")}.` : ""}
        </p>
      ) : null}

      <div className="mt-4 rounded-2xl bg-[var(--text)] px-4 py-3 text-sm font-semibold leading-relaxed text-white">
        ✅ Final verification hamesha apne bank / UPI app mein khud karo — apni transaction history
        aur UTR/reference number wahan check karo. Message ya screenshot kabhi proof nahi hota.
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">{result.disclaimer}</p>
      {result.checksPerformed.length > 0 ? (
        <p className="mt-2 text-xs text-[var(--dim)]">
          Checks performed: {result.checksPerformed.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

export function ScamShieldPage({ state }: PageProps) {
  const queryClient = useQueryClient();
  const currency = state.business.currency;
  const [text, setText] = useState("");
  const [claimedFrom, setClaimedFrom] = useState("");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [image, setImage] = useState<{ base64: string; mime: "image/jpeg" | "image/png"; name: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImage = async (file: File | undefined) => {
    setImageError(null);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setImageError("Please choose a JPG or PNG screenshot.");
      return;
    }
    if (file.size > 6_000_000) {
      setImageError("That image is larger than 6 MB — please use a smaller screenshot.");
      return;
    }
    try {
      const data = await fileToBase64(file);
      setImage({ base64: data.dataBase64, mime: data.mimeType as "image/jpeg" | "image/png", name: file.name });
    } catch {
      setImageError("That image could not be read. Try another screenshot.");
    }
  };

  const analyse = useMutation({
    mutationFn: async () => {
      const amountCents = claimedAmount.trim()
        ? Math.round((parseFloat(claimedAmount) || 0) * 100)
        : undefined;
      return await api.analyseScamText({
        text: text.trim() || undefined,
        claimedFrom: claimedFrom.trim() || undefined,
        claimedAmountCents: amountCents && amountCents > 0 ? amountCents : undefined,
        imageBase64: image?.base64,
        imageMimeType: image?.mime,
      });
    },
    onSuccess: (res) => {
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ["cg-state"] });
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="page-anim space-y-7">
      <div>
        <h1 className="display-font text-[27px] font-semibold tracking-tight">🛡️ Scam Shield</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--dim)]">
          Koi suspicious UPI message, fake payment screenshot ya phishing text mila? Yahan paste ya
          upload karo — Scam Shield uske danger signals check karke reasons ke saath warning dega.
        </p>
      </div>

      <div className="rounded-3xl border border-[#e8d9ac] bg-[var(--warn)] px-5 py-4 text-sm leading-relaxed">
        <p className="font-extrabold text-[var(--warn-text)]">Pehle ye samajh lo — honestly:</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[var(--warn-text)]">
          <li>Scam Shield sirf known scam patterns check karta hai. Ye <strong>kabhi confirm nahi karta</strong> ki payment sach mein hua hai.</li>
          <li>Payment screenshot akele <strong>kuch prove nahi karta</strong> — fake screenshots banana bahut aasan hai.</li>
          <li>Final verification sirf <strong>apne bank / UPI app</strong> mein hoti hai — wahan apni history aur UTR number check karo.</li>
          <li>Cashflow Genius <strong>kabhi tumse OTP, UPI PIN ya password nahi maangega</strong>. Jo maange, wahi scam hai.</li>
        </ul>
      </div>

      <section aria-label="Run a scam check">
        <div className="card space-y-4 p-5">
          <Field label="Suspicious message / text (paste karo)">
            <textarea
              className="field min-h-32"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Suspicious message text"
              placeholder="e.g. URGENT! Your account will be blocked. Update KYC now: https://… Share the OTP sent to your mobile to receive your refund of ₹4,999…"
              maxLength={6000}
            />
          </Field>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-xs"
            onClick={() => setText(SAMPLE_SCAM_MESSAGE)}
            aria-label="Fill in a sample fake UPI message to try Scam Shield"
          >
            Try a sample fake message
          </button>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Payment kisne bheja, ye bola gaya? (optional)">
              <input
                className="field"
                value={claimedFrom}
                onChange={(e) => setClaimedFrom(e.target.value)}
                aria-label="Claimed sender name"
                placeholder="e.g. Rohan Mehta"
                maxLength={120}
              />
            </Field>
            <Field label={`Kitna amount bola gaya? (${currency}, optional)`}>
              <input
                className="field tnum"
                type="number"
                inputMode="decimal"
                step="1"
                min="0"
                value={claimedAmount}
                onChange={(e) => setClaimedAmount(e.target.value)}
                aria-label="Claimed amount"
                placeholder="0.00"
              />
            </Field>
          </div>
          <div>
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
              Payment screenshot (optional)
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => fileRef.current?.click()}>
                📷 Upload screenshot
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                aria-label="Upload a payment screenshot for checking"
                onChange={(e) => void onPickImage(e.target.files?.[0])}
              />
              {image ? (
                <>
                  <span className="text-sm font-semibold">{image.name}</span>
                  <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setImage(null)}>
                    Remove
                  </button>
                </>
              ) : (
                <span className="text-xs text-[var(--dim)]">JPG or PNG, up to 6 MB. The image is checked and not stored.</span>
              )}
            </div>
            {imageError ? (
              <p className="mt-2 rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{imageError}</p>
            ) : null}
          </div>
          {formError ? (
            <p className="rounded-xl bg-[var(--err)] px-3 py-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>
          ) : null}
          <button
            type="button"
            className="btn-primary w-full px-6 py-3.5 text-sm"
            disabled={analyse.isPending || (!text.trim() && !image)}
            onClick={() => {
              setFormError(null);
              setResult(null);
              analyse.mutate();
            }}
          >
            {analyse.isPending ? "Checking…" : "🛡️ Check this for scam signs"}
          </button>
          <p className="text-center text-xs text-[var(--dim)]">
            Tip: pehle message paste karo ya screenshot upload karo, phir check dabao. Dono diye to dono check honge.
          </p>
        </div>
      </section>

      {result ? <ResultPanel result={result} /> : null}

      <section aria-label="Previous scam checks">
        <SectionTitle title="Your recent checks" hint="Sirf tumhare checks, tumhare account mein saved — taaki purani warnings dobara dekh sako." />
        {state.scamChecks.length === 0 ? (
          <EmptyState
            title="No checks yet"
            body="Jab bhi koi message ya screenshot suspicious lage, yahan check karo. Tumhari check history yahan dikhegi."
          />
        ) : (
          <ul className="space-y-2">
            {state.scamChecks.map((c) => {
              const v = VERDICTS[c.verdict] ?? VERDICTS.suspicious!;
              return (
                <li key={c.id} className="card px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={v.tone}>{v.emoji} {v.label} · {c.riskScore}/100</Badge>
                    <Badge tone="grey">{c.kind === "both" ? "Message + screenshot" : c.kind === "screenshot" ? "Screenshot" : "Message"}</Badge>
                    <span className="text-xs text-[var(--dim)]">{prettyDate(c.createdAt.slice(0, 10))}</span>
                  </div>
                  {c.excerpt ? (
                    <p className="mt-1.5 line-clamp-2 text-sm text-[var(--dim)]">“{c.excerpt}”</p>
                  ) : null}
                  {c.reasons.length > 0 ? (
                    <p className="mt-1 text-xs font-semibold text-[var(--dim)]">
                      Flagged: {c.reasons.map((r) => r.title).join(" · ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-xs leading-relaxed text-[var(--dim)]">
        Agar paisa already chala gaya hai: turant apne bank ko call karo, UPI app mein transaction
        report karo, aur cybercrime helpline <strong>1930</strong> par complaint karo. Jitni jaldi
        report karoge, recovery ke chances utne zyada.
      </p>
    </div>
  );
}
