// Scam Shield scoring tests for server/lib/scamShield.ts (pure functions).
// Proves the image cases with FIXTURE vision results — no live AI call:
//   (1) a readable photo that is plainly not a payment screenshot (a car)
//       ends at no_strong_signs with one info note naming what it shows;
//   (2) a payment-looking screenshot keeps the strict treatment
//       (screenshot_not_proof + editing/mismatch signals still score high);
//   (3) an unreadable image caps at suspicious on its own, never high_risk.
// Run: node scripts/scam-shield-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "cg-scam-shield-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};

// Same name-matching as the analyseScamText handler: known customers /
// counterparties, matched on normalised names (either side may contain
// the other, so "rohan" matches "Rohan Mehta").
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const knownNorm = ["Rohan Mehta", "Acme Ltd"].map(norm);
const matchesKnown = (name) => {
  const c = norm(name);
  if (c.length < 3) return false;
  return knownNorm.some((k) => c.includes(k) || k.includes(c));
};
const baseOpts = { matchesKnown, norm };
const codes = (reasons) => reasons.map((r) => r.code);
const severities = (reasons) => reasons.map((r) => r.severity);

const carPhoto = {
  readable: true,
  appearsToBePaymentScreenshot: false,
  imageDescription: "a photo of a red car parked on a street",
  visibleText: "",
  senderOrReceiverName: null,
  upiId: null,
  amountText: null,
  dateText: null,
  statusWording: null,
  editingSigns: "none",
};
const cleanScreenshot = {
  readable: true,
  appearsToBePaymentScreenshot: true,
  imageDescription: "a UPI payment success screen",
  visibleText: "Payment successful ₹5,000 to Rohan Mehta",
  senderOrReceiverName: "Rohan Mehta",
  upiId: "rohan@okaxis",
  amountText: "₹5,000",
  dateText: "19 Nov 2026",
  statusWording: "Payment successful",
  editingSigns: "none",
};

try {
  const src = readFileSync(join(repo, "server", "lib", "scamShield.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "scamShield.ts",
  }).outputText;
  const modPath = join(out, "scamShield.js");
  writeFileSync(modPath, js);
  const { imageReasons, normalizeImageFindings, normalizeImageShape, scoreReasons } = require(modPath);

  // ---- scoreReasons: thresholds and cap ----
  check("score: no reasons", scoreReasons([]), { riskScore: 0, verdict: "no_strong_signs" });
  check("score: one info", scoreReasons([{ code: "x", title: "t", detail: "d", severity: "info" }]), { riskScore: 5, verdict: "no_strong_signs" });
  check("score: one medium", scoreReasons([{ code: "x", title: "t", detail: "d", severity: "medium" }]), { riskScore: 15, verdict: "suspicious" });
  check("score: one critical", scoreReasons([{ code: "x", title: "t", detail: "d", severity: "critical" }]), { riskScore: 45, verdict: "high_risk" });
  check("score: two high", scoreReasons([
    { code: "a", title: "t", detail: "d", severity: "high" },
    { code: "b", title: "t", detail: "d", severity: "high" },
  ]), { riskScore: 60, verdict: "high_risk" });
  check("score: capped at 100", scoreReasons([
    { code: "a", title: "t", detail: "d", severity: "critical" },
    { code: "b", title: "t", detail: "d", severity: "critical" },
    { code: "c", title: "t", detail: "d", severity: "critical" },
  ]), { riskScore: 100, verdict: "high_risk" });

  // ---- case 1: a car photo (the reported false positive) ----
  const car = imageReasons(carPhoto, baseOpts);
  check("car photo: exactly one reason", codes(car), ["image_not_payment"]);
  check("car photo: reason is info", severities(car), ["info"]);
  check("car photo: reason names the car", car[0].detail.includes("red car"), true);
  check("car photo: score 5 / no_strong_signs", scoreReasons(car), { riskScore: 5, verdict: "no_strong_signs" });

  // Same, with an empty AI description: still one info note, no crash.
  const carNoDesc = imageReasons({ ...carPhoto, imageDescription: "" }, baseOpts);
  check("car photo, no description: one info reason", codes(carNoDesc), ["image_not_payment"]);
  check("car photo, no description: score 5 / no_strong_signs", scoreReasons(carNoDesc), { riskScore: 5, verdict: "no_strong_signs" });

  // Same, even when the user also gave a claimed sender + amount: a
  // non-payment image is never scored on name/amount mismatches.
  const carClaimed = imageReasons(carPhoto, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("car photo with claimed sender/amount: still one info reason", codes(carClaimed), ["image_not_payment"]);
  check("car photo with claimed sender/amount: still no_strong_signs", scoreReasons(carClaimed), { riskScore: 5, verdict: "no_strong_signs" });

  // ---- case 2: a payment-looking screenshot keeps the strict treatment ----
  const clean = imageReasons(cleanScreenshot, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("clean screenshot: screenshot_not_proof only", codes(clean), ["screenshot_not_proof"]);
  check("clean screenshot: score 30 / suspicious", scoreReasons(clean), { riskScore: 30, verdict: "suspicious" });

  const edited = imageReasons({ ...cleanScreenshot, editingSigns: "the amount font looks pasted over a different background" }, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("edited screenshot: proof + editing signs", codes(edited), ["screenshot_not_proof", "image_editing_signs"]);
  check("edited screenshot: score 60 / high_risk", scoreReasons(edited), { riskScore: 60, verdict: "high_risk" });

  const nameMismatch = imageReasons({ ...cleanScreenshot, senderOrReceiverName: "Amit Sharma" }, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("name-mismatch screenshot: proof + name mismatch + unknown name", codes(nameMismatch), ["screenshot_not_proof", "image_name_mismatch", "image_unknown_name"]);
  check("name-mismatch screenshot: score 75 / high_risk", scoreReasons(nameMismatch), { riskScore: 75, verdict: "high_risk" });

  const unknownName = imageReasons({ ...cleanScreenshot, senderOrReceiverName: "Amit Sharma" }, { ...baseOpts, claimedAmountCents: 500000 });
  check("unknown-name screenshot: proof + unknown name", codes(unknownName), ["screenshot_not_proof", "image_unknown_name"]);
  check("unknown-name screenshot: score 45 / high_risk", scoreReasons(unknownName), { riskScore: 45, verdict: "high_risk" });

  const amountMismatch = imageReasons({ ...cleanScreenshot, amountText: "₹4,000" }, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("amount-mismatch screenshot: proof + amount mismatch", codes(amountMismatch), ["screenshot_not_proof", "image_amount_mismatch"]);
  check("amount-mismatch screenshot: score 60 / high_risk", scoreReasons(amountMismatch), { riskScore: 60, verdict: "high_risk" });

  const unknownUpi = imageReasons({ ...cleanScreenshot, upiId: "stranger@okhdfc" }, { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("unknown-UPI screenshot: proof + unknown UPI", codes(unknownUpi), ["screenshot_not_proof", "image_unknown_upi"]);
  check("unknown-UPI screenshot: score 45 / high_risk", scoreReasons(unknownUpi), { riskScore: 45, verdict: "high_risk" });

  // ---- case 3: unreadable image caps at suspicious ----
  const unreadable = imageReasons({ ...carPhoto, readable: false }, baseOpts);
  check("unreadable image: only image_unreadable", codes(unreadable), ["image_unreadable"]);
  check("unreadable image: reason is medium", severities(unreadable), ["medium"]);
  check("unreadable image: score 15 / suspicious", scoreReasons(unreadable), { riskScore: 15, verdict: "suspicious" });

  const failed = imageReasons(null, baseOpts);
  check("vision call failed: only image_unreadable", codes(failed), ["image_unreadable"]);
  check("vision call failed: score 15 / suspicious", scoreReasons(failed), { riskScore: 15, verdict: "suspicious" });

  // ---- normalizeImageFindings: the response contract can never break ----
  // Live failure 2026-11-19: the rule-based fallback object had no
  // imageDescription, so response validation failed and the whole check
  // errored out instead of returning a verdict.
  const fallbackShaped = {
    readable: false,
    appearsToBePaymentScreenshot: false,
    visibleText: "",
    senderOrReceiverName: null,
    upiId: null,
    amountText: null,
    dateText: null,
    statusWording: null,
    editingSigns: "The screenshot could not be read — no AI vision model is connected.",
  };
  check("normalize: fallback-shaped object gains imageDescription", normalizeImageFindings(fallbackShaped).imageDescription, "");
  check("normalize: fallback-shaped object keeps readable false", normalizeImageFindings(fallbackShaped).readable, false);
  check("normalize: fallback-shaped object scores suspicious", scoreReasons(imageReasons(normalizeImageFindings(fallbackShaped), baseOpts)), { riskScore: 15, verdict: "suspicious" });
  check("normalize: null stays null", normalizeImageFindings(null), null);
  check("normalize: non-object stays null", normalizeImageFindings("nope"), null);
  check("normalize: complete object passes through", normalizeImageFindings(carPhoto), carPhoto);

  // ---- description-wins: a description IS the reading ----
  // Live 2026-11-19: the model returned readable:false for a clear
  // cartoon car (no text in it) while describing it perfectly — and the
  // check wrongly scored "unreadable" (15, Suspicious) instead of
  // no_strong_signs (5). A real description overrides a false readable.
  const describedButUnreadableFlag = {
    readable: false,
    appearsToBePaymentScreenshot: false,
    imageDescription: "a cartoon image of a red car on a road",
    visibleText: "",
    senderOrReceiverName: null,
    upiId: null,
    amountText: null,
    dateText: null,
    statusWording: null,
    editingSigns: "none",
  };
  check("description-wins: readable becomes true", normalizeImageFindings(describedButUnreadableFlag).readable, true);
  check("description-wins: score 5 / no_strong_signs", scoreReasons(imageReasons(normalizeImageFindings(describedButUnreadableFlag), baseOpts)), { riskScore: 5, verdict: "no_strong_signs" });
  const blurryDescribed = { ...describedButUnreadableFlag, imageDescription: "a blurry photo, cannot tell what it shows" };
  check("blurry description: readable stays false", normalizeImageFindings(blurryDescribed).readable, false);
  check("blurry description: score 15 / suspicious", scoreReasons(imageReasons(normalizeImageFindings(blurryDescribed), baseOpts)), { riskScore: 15, verdict: "suspicious" });
  const noDescription = { ...describedButUnreadableFlag, imageDescription: "" };
  check("no description: readable stays false", normalizeImageFindings(noDescription).readable, false);

  // ---- normalizeImageShape: the model's invented shapes (from live logs) ----
  // 23:41 IST 2026-11-19, gpt-4o-mini, twice, same car image — the parse
  // ladder threw this away, the fallback lacked imageDescription, and the
  // whole check 500'd. The mapping must turn it into a usable answer.
  const loggedCarShape = {
    description: "a cartoon image of a red car on a road",
    extraction: { payment_amount: null, transaction_id: null, date: null, sender: null, receiver: null },
    signs_of_editing: "none",
  };
  const mappedCar = normalizeImageShape(loggedCarShape);
  check("logged car shape: description mapped", mappedCar.imageDescription, "a cartoon image of a red car on a road");
  check("logged car shape: readable", mappedCar.readable, true);
  check("logged car shape: not a payment screenshot", mappedCar.appearsToBePaymentScreenshot, false);
  check("logged car shape: editing signs mapped", mappedCar.editingSigns, "none");
  check("logged car shape: amount null", mappedCar.amountText, null);
  const mappedCarReasons = imageReasons(normalizeImageFindings(mappedCar), baseOpts);
  check("logged car shape: one info reason", codes(mappedCarReasons), ["image_not_payment"]);
  check("logged car shape: score 5 / no_strong_signs", scoreReasons(mappedCarReasons), { riskScore: 5, verdict: "no_strong_signs" });

  // Older deploy's shape (23:19 IST 2026-11-19): flat, all nulls.
  const loggedFlatShape = { transaction_id: null, amount: null, date: null, time: null, merchant: null, status: null, signs_of_editing: null };
  const mappedFlat = normalizeImageShape(loggedFlatShape);
  check("logged flat shape: readable (structured extraction)", mappedFlat.readable, true);
  check("logged flat shape: not a payment screenshot", mappedFlat.appearsToBePaymentScreenshot, false);
  check("logged flat shape: score 5 / no_strong_signs", scoreReasons(imageReasons(normalizeImageFindings(mappedFlat), baseOpts)), { riskScore: 5, verdict: "no_strong_signs" });

  // Same invented shape, but a real payment screenshot: must stay strict.
  const loggedPaymentShape = {
    description: "a UPI payment success screen",
    extraction: { payment_amount: "₹5,000", transaction_id: "123456789", date: "19 Nov 2026", sender: "Rohan Mehta", receiver: "Acme Ltd" },
    signs_of_editing: "none",
  };
  const mappedPayment = normalizeImageShape(loggedPaymentShape);
  check("logged payment shape: is a payment screenshot", mappedPayment.appearsToBePaymentScreenshot, true);
  check("logged payment shape: amount mapped", mappedPayment.amountText, "₹5,000");
  check("logged payment shape: sender mapped", mappedPayment.senderOrReceiverName, "Rohan Mehta");
  const mappedPaymentReasons = imageReasons(normalizeImageFindings(mappedPayment), { ...baseOpts, claimedFrom: "Rohan Mehta", claimedAmountCents: 500000 });
  check("logged payment shape: screenshot_not_proof only", codes(mappedPaymentReasons), ["screenshot_not_proof"]);
  check("logged payment shape: score 30 / suspicious", scoreReasons(mappedPaymentReasons), { riskScore: 30, verdict: "suspicious" });

  check("normalizeImageShape: unrecognised object passes through", normalizeImageShape({ foo: 1 }), { foo: 1 });
  check("normalizeImageShape: null passes through", normalizeImageShape(null), null);
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
process.exit(fail ? 1 : 0);
