// AI CFO engine for the Vercel port — replaces ctx.inference.
//
// Two providers, chosen per account in Settings (default: Gemini):
//  - Gemini (Google AI Studio key, gemini-3.8-flash, free tier) — the
//    account's own saved key first, then the server GEMINI_API_KEY.
//  - OpenRouter (OpenRouter key, any model id — default a free :free
//    model) via its OpenAI-compatible chat-completions endpoint — the
//    account's own saved key first, then OPENROUTER_API_KEY. Gemini's
//    free tier is blocked for the user's Google account (HTTP 403
//    "free tier is not available for this project" on every project,
//    2-Step Verification already on), so OpenRouter's free models are
//    the working free engine; a paid model id such as
//    openai/gpt-4o-mini works through the same code path when the
//    account has credits.
//
// Without any key for the selected provider, or whenever the provider
// call fails, answers come from an honest rule-based fallback built
// from the figures already computed by the action (never invented
// numbers), and the fallback says so in the answer itself. No key is
// ever logged or returned to the browser. A successful provider call
// records a verification flag on the account row (best-effort) — the
// Live connections probe shows an engine "Live" only when that flag
// names the currently selected provider.
import { z } from "zod";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { userWorkspaceState } from "../schema";

export type AiProvider = "gemini" | "openrouter";

export function asAiProvider(v: string | null | undefined): AiProvider {
  return v === "openrouter" ? "openrouter" : "gemini";
}

// gemini-2.0-flash was shut down by Google on 1 Jun 2026, so every call
// to it failed and the CFO always fell back. gemini-3.8-flash is the
// replacement Google's own 2.0 model page recommends ("Migrate to Gemini
// 3.8 Flash"), still on the free tier.
const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// OpenRouter's free models carry a ":free" suffix and cost nothing per
// token (capped at 20 requests/min and 50 requests/day without credits).
// The free roster rotates — google/gemma-4-31b-it:free is the default
// because Gemma 4 is a reliable general-purpose model with image input
// (the CFO's screenshot checks need vision); the user can change the
// model in Settings, or use the openrouter/free router id instead.
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_URL = "https://cashflow-genius.vercel.app";

export interface AiCallSettings {
  provider: AiProvider;
  geminiKey: string | null;
  openRouterKey: string | null;
  openRouterModel: string;
  ownerId: string | null;
}

/** The account's AI settings from its state row (account key first,
 *  server env key as fallback), for the provider call sites. */
export function aiExtrasFromRow(
  row: {
    aiProvider?: string | null;
    geminiApiKey?: string | null;
    openRouterApiKey?: string | null;
    openRouterModel?: string | null;
  } | null,
  ownerId: string,
): AiCallSettings {
  return {
    provider: asAiProvider(row?.aiProvider),
    geminiKey: row?.geminiApiKey ?? process.env.GEMINI_API_KEY ?? null,
    openRouterKey:
      row?.openRouterApiKey ?? process.env.OPENROUTER_API_KEY ?? null,
    openRouterModel: row?.openRouterModel || DEFAULT_OPENROUTER_MODEL,
    ownerId,
  };
}

export async function getAiSettings(ownerId: string): Promise<AiCallSettings> {
  let row: typeof userWorkspaceState.$inferSelect | null = null;
  try {
    const rows = await db
      .select()
      .from(userWorkspaceState)
      .where(eq(userWorkspaceState.ownerId, ownerId))
      .limit(1);
    row = rows[0] ?? null;
  } catch {
    row = null;
  }
  return aiExtrasFromRow(row, ownerId);
}

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

/** Best-effort record that a real AI call just succeeded with this
 *  provider, so Live connections can honestly show it Live. Never
 *  throws and never blocks the answer. */
async function markAiVerified(
  ownerId: string | null,
  provider: AiProvider,
): Promise<void> {
  if (!ownerId) return;
  try {
    await db
      .update(userWorkspaceState)
      .set({ aiVerifiedAt: new Date(), aiVerifiedProvider: provider })
      .where(eq(userWorkspaceState.ownerId, ownerId));
  } catch {
    /* verification flag is advisory — never fail the answer for it */
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

/** Deterministic fallback used when no key is configured for the
 *  selected provider (or the provider call fails). It never pretends
 *  to be an AI answer, and it names the provider that was tried. */
function ruleBasedFallback(
  schema: z.ZodTypeAny | undefined,
  provider: AiProvider,
): unknown {
  if (!schema) return null;
  if (isStringSchema(schema)) return "ready";
  const keys = shapeKeys(schema);
  const engine = provider === "openrouter" ? "OpenRouter" : "Gemini";
  if (keys.includes("directAnswer")) {
    return {
      directAnswer:
        `The AI CFO could not reach ${engine} just now — the AI service did not answer. This is not an AI analysis. The exact figures behind your question are listed under “What the AI used” below, and on the dashboard.`,
      numbers: [],
      explanation:
        provider === "openrouter"
          ? "Check Settings → Live connections for the OpenRouter status. If no key is saved, add a free OpenRouter API key there (openrouter.ai — free :free models, no payment needed) or set OPENROUTER_API_KEY in Vercel. If a key is already saved and this keeps happening, the AI call itself is failing — the key, the model, or OpenRouter's service. Free models are capped at 50 requests a day."
          : "Check Settings → Live connections for the Gemini status. If no key is saved, add a free Gemini API key there (Google AI Studio, free tier) or set GEMINI_API_KEY in Vercel. If a key is already saved and this keeps happening, the AI call itself is failing — the key, the model, or Google's service.",
      supportingData: [],
      options: [
        `Check the ${engine} status in Settings → Live connections.`,
        "Check the dashboard, Money Flow and What’s due for the live figures meanwhile.",
      ],
      assumptions:
        "No AI model was used for this answer — it is a fallback notice, not an analysis.",
    };
  }
  if (keys.includes("headline") && keys.includes("points")) {
    return {
      headline: `AI briefing unavailable — ${engine} is not connected`,
      points:
        provider === "openrouter"
          ? [
              "Set a free OpenRouter API key in Settings → Live connections to get daily AI briefings. Free :free models cost nothing and are capped at 50 requests a day.",
              "Your cash, invoices and savings are still up to date on the dashboard.",
            ]
          : [
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

/** OpenRouter via its OpenAI-compatible chat-completions endpoint.
 *  The key travels ONLY in the Authorization header — never in the
 *  URL, body, or logs. Images (Scam Shield screenshots) are sent as
 *  data-URL image parts; a model without vision fails the call and
 *  the caller falls back honestly. */
async function callOpenRouter(
  key: string,
  model: string,
  prompt: string,
  schema: z.ZodTypeAny | undefined,
  images:
    | { dataBase64: string; mimeType: string; caption?: string }[]
    | undefined,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const jsonInstruction =
      schema && !isStringSchema(schema)
        ? "\n\nRespond with ONLY valid JSON matching the requested shape. No markdown, no extra text."
        : "";
    const userContent: unknown =
      images && images.length > 0
        ? [
            { type: "text", text: prompt + jsonInstruction },
            ...images.map((img) => ({
              type: "image_url",
              image_url: {
                url: `data:${img.mimeType};base64,${img.dataBase64}`,
              },
            })),
          ]
        : prompt + jsonInstruction;
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": APP_URL,
        "X-Title": "Cashflow Genius",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a careful financial assistant. Answer only from the figures given in the user message; never invent numbers. If the figures cannot answer the question, say so.",
          },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        ...(schema && !isStringSchema(schema)
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Same bounded-error rule as Gemini: status + body, never the key.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`OpenRouter answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | { text?: string }[] | null } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const text = typeof raw === "string"
      ? raw
      : raw.map((p) => p.text ?? "").join("");
    if (!text) throw new Error("OpenRouter returned no text");
    if (!schema || isStringSchema(schema)) return text;
    const parsed = JSON.parse(text) as unknown;
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new Error("OpenRouter answer did not match the expected shape");
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
  settings: Partial<AiCallSettings> = {},
): Promise<T> {
  const provider = settings.provider ?? "gemini";
  if (provider === "openrouter") {
    const key = settings.openRouterKey ?? process.env.OPENROUTER_API_KEY ?? null;
    const model = settings.openRouterModel || DEFAULT_OPENROUTER_MODEL;
    if (!key) return ruleBasedFallback(opts.schema, provider) as T;
    try {
      const out = (await callOpenRouter(
        key,
        model,
        prompt,
        opts.schema,
        opts.images,
      )) as T;
      await markAiVerified(settings.ownerId ?? null, provider);
      return out;
    } catch (e) {
      console.warn("[cashflow-genius] OpenRouter call failed, using rule-based fallback:", e);
      return ruleBasedFallback(opts.schema, provider) as T;
    }
  }
  const key = settings.geminiKey ?? process.env.GEMINI_API_KEY ?? null;
  if (!key) return ruleBasedFallback(opts.schema, provider) as T;
  try {
    const out = (await callGemini(key, prompt, opts.schema, opts.images)) as T;
    await markAiVerified(settings.ownerId ?? null, provider);
    return out;
  } catch (e) {
    console.warn("[cashflow-genius] Gemini call failed, using rule-based fallback:", e);
    return ruleBasedFallback(opts.schema, provider) as T;
  }
}
