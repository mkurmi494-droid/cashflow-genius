// AI CFO engine for the Vercel port — replaces ctx.inference.
//
// Priority: Gemini (free tier, Google AI Studio) when a key is available —
// the account's own saved key first, then the server GEMINI_API_KEY env
// var. Without any key, answers come from an honest rule-based fallback
// built from the figures already computed by the action (never invented
// numbers), and the fallback says so in the answer itself. No key is
// ever logged or returned to the browser.
import { z } from "zod";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { userWorkspaceState } from "../schema";

// gemini-2.0-flash was shut down by Google on 1 Jun 2026, so every call
// to it failed and the CFO always fell back. gemini-3.8-flash is the
// replacement Google's own 2.0 model page recommends ("Migrate to Gemini
// 3.8 Flash"), still on the free tier.
const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function getUserGeminiKey(
  ownerId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(userWorkspaceState)
      .where(eq(userWorkspaceState.ownerId, ownerId))
      .limit(1);
    return rows[0]?.geminiApiKey ?? null;
  } catch {
    return null;
  }
}

function shapeKeys(schema: z.ZodTypeAny): string[] {
  const s = schema as unknown as { shape?: unknown; _def?: { shape?: unknown } };
  const shape =
    (typeof s.shape === "object" && s.shape) ||
    (typeof s._def?.shape === "function"
      ? (s._def.shape as () => Record<string, unknown>)()
      : (s._def?.shape as Record<string, unknown> | undefined));
  return shape ? Object.keys(shape as Record<string, unknown>) : [];
}

function isStringSchema(schema: z.ZodTypeAny): boolean {
  return (schema as unknown as { _def?: { typeName?: string } })._def
    ?.typeName === "ZodString";
}

/** Deterministic fallback used when no Gemini key is configured (or the
 *  Gemini call fails). It never pretends to be an AI answer. */
function ruleBasedFallback(
  schema: z.ZodTypeAny | undefined,
): unknown {
  if (!schema) return null;
  if (isStringSchema(schema)) return "ready";
  const keys = shapeKeys(schema);
  if (keys.includes("directAnswer")) {
    return {
      directAnswer:
        "The AI CFO could not reach Gemini just now — the AI service did not answer. This is not an AI analysis. The exact figures behind your question are listed under “What the AI used” below, and on the dashboard.",
      numbers: [],
      explanation:
        "Check Settings → Live connections for the Gemini status. If no key is saved, add a free Gemini API key there (Google AI Studio, free tier) or set GEMINI_API_KEY in Vercel. If a key is already saved and this keeps happening, the AI call itself is failing — the key, the model, or Google's service.",
      supportingData: [],
      options: [
        "Check the Gemini status in Settings → Live connections.",
        "Check the dashboard, Money Flow and What’s due for the live figures meanwhile.",
      ],
      assumptions:
        "No AI model was used for this answer — it is a fallback notice, not an analysis.",
    };
  }
  if (keys.includes("headline") && keys.includes("points")) {
    return {
      headline: "AI briefing unavailable — Gemini is not connected",
      points: [
        "Set a free Gemini API key in Settings → Live connections to get daily AI briefings.",
        "Your cash, invoices and savings are still up to date on the dashboard.",
      ],
    };
  }
  if (keys.includes("readable")) {
    return {
      readable: false,
      appearsToBePaymentScreenshot: false,
      visibleText: "",
      senderOrReceiverName: null,
      upiId: null,
      amountText: null,
      dateText: null,
      statusWording: null,
      editingSigns:
        "The screenshot could not be read — no AI vision model is connected. Verify the payment directly in your bank/UPI app.",
    };
  }
  return null;
}

async function callGemini(
  key: string,
  prompt: string,
  schema: z.ZodTypeAny | undefined,
  images:
    | { dataBase64: string; mimeType: string; caption?: string }[]
    | undefined,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const parts: Record<string, unknown>[] = [
      {
        text:
          prompt +
          (schema && !isStringSchema(schema)
            ? "\n\nRespond with ONLY valid JSON matching the requested shape. No markdown, no extra text."
            : ""),
      },
    ];
    for (const img of images ?? []) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
      });
    }
    const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          ...(schema && !isStringSchema(schema)
            ? { responseMimeType: "application/json" }
            : {}),
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Capture the error body (bounded, never the key) so the server log
      // shows WHY Gemini refused — e.g. free tier unavailable for the
      // project vs. API not enabled — instead of just the status code.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`Gemini answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("");
    if (!text) throw new Error("Gemini returned no text");
    if (!schema || isStringSchema(schema)) return text;
    const parsed = JSON.parse(text) as unknown;
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new Error("Gemini answer did not match the expected shape");
    return checked.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function aiComplete<T>(
  prompt: string,
  opts: {
    schema?: z.ZodType<T>;
    images?: { dataBase64: string; mimeType: string; caption?: string }[];
  } = {},
  extra: { geminiKey?: string | null } = {},
): Promise<T> {
  const key = extra.geminiKey ?? process.env.GEMINI_API_KEY ?? null;
  if (!key) return ruleBasedFallback(opts.schema) as T;
  try {
    return (await callGemini(key, prompt, opts.schema, opts.images)) as T;
  } catch (e) {
    console.warn("[cashflow-genius] Gemini call failed, using rule-based fallback:", e);
    return ruleBasedFallback(opts.schema) as T;
  }
}
