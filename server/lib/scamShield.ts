// Scam Shield scoring — pure functions, no DB, no AI calls.
//
// The verdict/score math and the image-related reasons live here (instead
// of inline in the analyseScamText action) so the harness can prove the
// image cases with fixture vision results, without calling the live AI.
//
// The "don't cry wolf" rule: an image only earns a serious score when the
// AI judges it actually looks like a payment screenshot. A readable photo
// of a car (or anything else that is plainly not a payment receipt) ends
// at no_strong_signs with one info note naming what the image shows.
// An image the AI cannot read caps at suspicious on its own. A
// payment-looking screenshot keeps the strict treatment: a screenshot
// alone never proves a payment, and editing signs / name / UPI / amount
// mismatches still score high.

export type ScamSeverity = "critical" | "high" | "medium" | "info";

export type ScamReason = {
  code: string;
  title: string;
  detail: string;
  severity: ScamSeverity;
};

// What the vision model reports about an uploaded image. Every field is
// "what the image appears to show" — never proof of a payment.
export type ImageFindings = {
  readable: boolean;
  appearsToBePaymentScreenshot: boolean;
  imageDescription: string;
  visibleText: string;
  senderOrReceiverName: string | null;
  upiId: string | null;
  amountText: string | null;
  dateText: string | null;
  statusWording: string | null;
  editingSigns: string;
};

export const SCAM_WEIGHTS: Record<ScamSeverity, number> = {
  critical: 45,
  high: 30,
  medium: 15,
  info: 5,
};

export function scoreReasons(reasons: ScamReason[]): {
  riskScore: number;
  verdict: "high_risk" | "suspicious" | "no_strong_signs";
} {
  const riskScore = Math.min(
    100,
    reasons.reduce((s, r) => s + SCAM_WEIGHTS[r.severity], 0),
  );
  const verdict =
    riskScore >= 45 ? "high_risk" : riskScore >= 15 ? "suspicious" : "no_strong_signs";
  return { riskScore, verdict };
}

// Image-related reasons for one vision result. `findings === null` means
// the vision call itself failed. `matchesKnown` / `norm` are the
// workspace-aware helpers from the action (names are checked against the
// user's saved customers and counterparties).
export function imageReasons(
  findings: ImageFindings | null,
  opts: {
    claimedFrom?: string;
    claimedAmountCents?: number;
    matchesKnown: (name: string) => boolean;
    norm: (s: string) => string;
  },
): ScamReason[] {
  const out: ScamReason[] = [];
  const push = (r: ScamReason) => {
    if (!out.some((x) => x.code === r.code)) out.push(r);
  };

  // The AI could not read the image at all: say so, and nothing more.
  // On its own this is suspicious at most — an unreadable image is not
  // evidence of a scam, and it must never reach high_risk by itself.
  if (!findings || !findings.readable) {
    push({
      code: "image_unreadable",
      title: "The screenshot could not be read clearly",
      detail:
        "The analysis could not read this image reliably, so nothing in it could be checked. That is one more reason to verify directly in your bank/UPI app rather than trusting the image.",
      severity: "medium",
    });
    return out;
  }

  // Readable, but the AI judges it is not a payment screenshot at all:
  // judge what it actually is. One info note, no score that matters —
  // a photo of a car is not a scam.
  if (!findings.appearsToBePaymentScreenshot) {
    const what = (findings.imageDescription ?? "").trim();
    push({
      code: "image_not_payment",
      title: "This image is not a payment screenshot",
      detail: what
        ? `The AI looked at the image: ${what}. It is not a UPI/bank payment confirmation, so it says nothing about any payment — and there is nothing scam-like in the image itself.`
        : "The image does not resemble a UPI/bank payment confirmation, so it cannot support a claim that money was paid — and there is nothing scam-like in the image itself.",
      severity: "info",
    });
    return out;
  }

  // It really looks like a payment screenshot: keep the strict treatment.
  push({
    code: "screenshot_not_proof",
    title: "A screenshot alone never proves a payment",
    detail:
      "Payment screenshots are trivial to fake with free editor apps — the tick, amount and name can all be fabricated. Even a genuine-looking screenshot is not evidence. The payment counts only when it appears in your own bank/UPI app with a matching UTR/reference number.",
    severity: "high",
  });
  if (
    findings.editingSigns.trim() &&
    !/^(none|no\b|not )/i.test(findings.editingSigns.trim())
  ) {
    push({
      code: "image_editing_signs",
      title: "Signs the screenshot may have been edited",
      detail: `The image check noted: ${findings.editingSigns}`,
      severity: "high",
    });
  }
  const imgName = findings.senderOrReceiverName;
  if (
    imgName &&
    opts.claimedFrom &&
    opts.norm(imgName) !== opts.norm(opts.claimedFrom) &&
    !opts.norm(imgName).includes(opts.norm(opts.claimedFrom)) &&
    !opts.norm(opts.claimedFrom).includes(opts.norm(imgName))
  ) {
    push({
      code: "image_name_mismatch",
      title: "Name on the screenshot differs from the claimed sender",
      detail: `The screenshot appears to show "${imgName}", but you were told the payment was from "${opts.claimedFrom}". A mismatch like this is a strong fake-screenshot sign.`,
      severity: "high",
    });
  }
  if (imgName && !opts.matchesKnown(imgName)) {
    push({
      code: "image_unknown_name",
      title: "Name on the screenshot is not in your records",
      detail: `"${imgName}" does not match any customer or counterparty in your Cashflow Genius records. Verify the payer inside your bank/UPI app instead of trusting the name printed on an image.`,
      severity: "medium",
    });
  }
  const imgUpi = findings.upiId;
  if (imgUpi && !opts.matchesKnown(imgUpi.split("@")[0] ?? imgUpi)) {
    push({
      code: "image_unknown_upi",
      title: "UPI ID on the screenshot is not in your records",
      detail: `"${imgUpi}" does not match your saved customers or counterparties. UPI apps show the registered bank name for an ID before payment — check it there.`,
      severity: "medium",
    });
  }
  if (findings.amountText && opts.claimedAmountCents != null) {
    const m = findings.amountText.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (m) {
      const imgCents = Math.round(parseFloat(m[1] ?? "0") * 100);
      if (imgCents > 0 && imgCents !== opts.claimedAmountCents) {
        push({
          code: "image_amount_mismatch",
          title: "Amount on the screenshot differs from the expected amount",
          detail: `The screenshot appears to show ₹${(imgCents / 100).toLocaleString("en-IN")}, but you expected ₹${(opts.claimedAmountCents / 100).toLocaleString("en-IN")}.`,
          severity: "high",
        });
      }
    }
  }
  return out;
}
