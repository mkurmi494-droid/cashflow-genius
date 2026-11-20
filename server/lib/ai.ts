// AI CFO engine for the Vercel port — replaces ctx.inference.
//
// ONE engine for everyone: ChatGPT (OpenAI) with the server key.
// There is no per-account provider choice and no per-account key
// any more (Settings no longer offers them) — one shared OpenAI key
// in Vercel (OPENAI_API_KEY) answers every account's CFO, briefing
// and Scam Shield vision check. The key is read from the server
// environment only; an account key saved earlier is still honoured
// as a fallback, but no new one can be saved. Replies are parsed
// tolerantly (fences, prose-wrapped JSON, reasoning-only answers).
// One shape is never shown, though: a reasoning trace — the model
//    thinking out loud about producing JSON ("We need answer user's
//    request. Need produce final only valid JSON...") without ever
//    producing an answer. That is rejected and the next free model is
//    tried, so the user never reads the model's thinking as the
//    answer. A reply that DOES answer is never thrown away over form:
//    if the parsed JSON has a real direct answer (or headline +
//    points) but is missing an optional field, or returns key_numbers
//    as a map instead of an array, the missing pieces are filled with
//    honest defaults and the answer is used. Each model gets at most
//    ~12s, so one slow model cannot eat the whole attempt budget, and
//    a timed-out call tries the next free model instead of stopping
//    the chain. Ernie answers last: it is reasoning-mandatory, slow
//    and trace-prone, so the clean models go first.
//
// Without the server key, or whenever the OpenAI call fails,
// answers come from an honest rule-based fallback built from the
// figures already computed by the action (never invented numbers),
// and the fallback says so in the answer itself. No key is ever
// logged or returned to the browser. A successful OpenAI call
// records a verification flag on the account row (best-effort) — the
// Live connections probe shows the engine "Live" only after such a
// call has succeeded for that account.
import { z } from "zod";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { userWorkspaceState } from "../schema";
import { normalizeImageShape } from "./scamShield";

export type AiProvider = "gemini" | "openrouter" | "openai";

export function asAiProvider(v: string | null | undefined): AiProvider {
  if (v === "openrouter") return "openrouter";
  if (v === "openai") return "openai";
  return "gemini";
}

// gemini-2.0-flash was shut down by Google on 1 Jun 2026, so every call
// to it failed and the CFO always fell back. gemini-3.8-flash is the
// replacement Google's own 2.0 model page recommends ("Migrate to Gemini
// 3.8 Flash"), still on the free tier.
const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// OpenRouter's free models carry a ":free" suffix and cost nothing per
// token (capped at 20 requests/min and 50 requests/day without credits).
// The free roster rotates — the list below was verified against
// OpenRouter's live /api/v1/models list on 2026-11-17. Free-model
// calls share an upstream provider pool that throttles (HTTP 429) at
// busy times, so a failed call automatically tries the next free model
// in this list (see callOpenRouter / aiComplete). google/gemma-4-31b-it:free
// is the default because Gemma 4 is a reliable general-purpose model
// with image input (the CFO's screenshot checks need vision); the user
// can change the model in Settings, or use the openrouter/free router id
// instead. Ernie is text-only, so vision calls skip it. Ernie is
// LAST in this list, not third: it is reasoning-mandatory (it thinks
// out loud about producing JSON instead of answering), slow, and
// trace-prone, so the clean non-reasoning models are tried first and
// Ernie only answers when they all fail. The caller tries the
// selected model first, then the rest of the list in this order.
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
export const OPENROUTER_FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "inclusionai/ling-3.2-flash:free",
  "particle-ai/particle-1:free",
  "thinkingmachines/inkling-2-small:free",
  "baidu/ernie-5.5-flash-preview:free",
] as const;
export const OPENROUTER_VISION_FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "inclusionai/ling-3.2-flash:free",
  "particle-ai/particle-1:free",
  "thinkingmachines/inkling-2-small:free",
] as const;
// Models in the free list that cannot take image input.
const OPENROUTER_TEXT_ONLY_MODELS = new Set([
  "baidu/ernie-5.5-flash-preview:free",
]);
// Whole OpenRouter attempt budget (all models + backoff) so a chain of
// retries still fits comfortably inside Vercel Hobby function limits.
// Each model gets at most ~12s: a slow model used to eat the whole
// budget on its own (one live request took 44.56s across 3 calls and
// still timed out), so the chain never reached the later models. Five
// models at ~12s fit the budget with room for the 429 backoff.
const OPENROUTER_TOTAL_BUDGET_MS = 50_000;
const OPENROUTER_CALL_TIMEOUT_MS = 12_000;
const OPENROUTER_RATE_LIMIT_BACKOFF_MS = 4_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_URL = "https://cashflow-genius.vercel.app";

// OpenAI (ChatGPT), direct endpoint. gpt-4o-mini is the default:
// cheap, fast, vision-capable (the CFO's screenshot checks need
// image input) and JSON-mode capable. One attempt with a generous
// timeout — the paid API is reliable, so there is no fallback chain;
// a failure falls back honestly to the rule-based answers.
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_CALL_TIMEOUT_MS = 30_000;

export interface AiCallSettings {
  provider: AiProvider;
  geminiKey: string | null;
  openRouterKey: string | null;
  openRouterModel: string;
  openAiKey: string | null;
  openAiModel: string;
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
    openAiApiKey?: string | null;
    openAiModel?: string | null;
  } | null,
  ownerId: string,
): AiCallSettings {
  return {
    // Fixed engine: ChatGPT (OpenAI) for every account. The stored
    // ai_provider is ignored — per-account provider choice is gone.
    provider: "openai",
    geminiKey: row?.geminiApiKey ?? process.env.GEMINI_API_KEY ?? null,
    openRouterKey:
      row?.openRouterApiKey ?? process.env.OPENROUTER_API_KEY ?? null,
    openRouterModel: row?.openRouterModel || DEFAULT_OPENROUTER_MODEL,
    openAiKey: row?.openAiApiKey ?? process.env.OPENAI_API_KEY ?? null,
    openAiModel: row?.openAiModel || DEFAULT_OPENAI_MODEL,
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

export async function getUserOpenAiKey(
  ownerId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(userWorkspaceState)
      .where(eq(userWorkspaceState.ownerId, ownerId))
      .limit(1);
    return rows[0]?.openAiApiKey ?? null;
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
  // zod v3 stored the name in _def.typeName ("ZodString"); zod v4
  // uses _zod.def.type ("string") and _def.typeName is undefined.
  // instanceof covers both versions, so a plain-text answer is
  // returned as-is instead of being forced through JSON parsing
  // (which threw it away and fell back to null).
  return (
    schema instanceof z.ZodString ||
    (schema as unknown as { _def?: { typeName?: string } })._def
      ?.typeName === "ZodString"
  );
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
  const engine =
    provider === "openrouter"
      ? "OpenRouter"
      : provider === "openai"
        ? "OpenAI"
        : "Gemini";
  if (keys.includes("directAnswer")) {
    return {
      directAnswer:
        `The AI CFO could not reach ${engine} just now — the AI service did not answer. This is not an AI analysis. The exact figures behind your question are listed under “What the AI used” below, and on the dashboard.`,
      numbers: [],
      explanation:
        "ChatGPT answers for everyone from one shared key on the server — no key is needed from you, and there is nothing to add in Settings. If this keeps happening, the shared key may be invalid, its OpenAI account may have insufficient credits, or OpenAI's service is having trouble — try again in a bit. You can check the OpenAI status in Settings → Live connections.",
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
      points: [
        "ChatGPT answers for everyone from one shared key on the server — no key is needed from you. If briefings stay unavailable, the shared key may be invalid or out of credits, or OpenAI's service is having trouble.",
        "Your cash, invoices and savings are still up to date on the dashboard.",
      ],
    };
  }
  if (keys.includes("readable")) {
    return {
      readable: false,
      appearsToBePaymentScreenshot: false,
      // Must include every field the action's response shape requires —
      // a missing imageDescription used to fail response validation and
      // the whole Scam Shield check errored out (2026-11-19 live).
      imageDescription: "",
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
  if (keys.includes("reply")) {
    // Home AI chat: the fallback must be a VALID reply shape, not
    // null. A null here used to make askHomeChat read .reply of null
    // and throw a TypeError to the user (live, 2026-11-20) whenever
    // the model call or its parse failed. "chat" with no plan means
    // the chat answers honestly and writes nothing.
    return {
      kind: "chat",
      reply:
        "The AI's answer could not be used just now — nothing was changed. Try again in a bit.",
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
            ? "\n\nRespond with ONLY valid JSON matching the requested shape. No markdown, no extra text. Do not show your reasoning or thinking process — output only the final answer."
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error with a machine-readable kind, so the retry loop can tell a
 *  transient failure (try the next free model) from a hopeless one
 *  (bad key, unknown model — retrying would not help). */
function taggedError(
  code: "rate_limited" | "parse" | "timeout",
  message: string,
): Error {
  const e = new Error(message);
  (e as Error & { code?: string }).code = code;
  return e;
}

function isRetryableOpenRouterError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "rate_limited" || code === "parse" || code === "timeout";
}

function isRateLimitedError(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "rate_limited";
}

/** Pull the reply text out of a chat-completions message (OpenRouter
 *  and OpenAI share the shape), tolerating the shapes real models
 *  return: content as a string, content as a parts array, and — for
 *  reasoning-mandatory models such as Ernie, which may leave content
 *  empty — the reasoning text. Content wins when both are present;
 *  reasoning is only a fallback. */
function contentPartText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function extractChatCompletionsText(data: {
  choices?: {
    message?: Record<string, unknown> | null;
    reasoning?: unknown;
  }[];
}): { content: string; reasoning: string } {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const content = contentPartText(msg?.content);
  const reasoning =
    contentPartText(msg?.reasoning) ||
    contentPartText(msg?.reasoning_content) ||
    contentPartText(choice?.reasoning);
  return { content, reasoning };
}

/** Repair the two ways free models most often break otherwise-valid
 *  JSON: trailing commas before } or ], and raw newlines/tabs inside
 *  string values (a reasoning model streaming prose into a string).
 *  Only the broken characters are touched; a reply that is already
 *  valid JSON comes back unchanged. */
function repairJsonText(text: string): string {
  const noTrailingCommas = text.replace(/,\s*([}\]])/g, "$1");
  let out = "";
  let inString = false;
  for (let i = 0; i < noTrailingCommas.length; i++) {
    const ch = noTrailingCommas[i]!;
    if (inString) {
      if (ch === "\\") {
        out += ch + (noTrailingCommas[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/** Parse a model reply as JSON, tolerating the ways free models wrap
 *  it: markdown code fences, prose around the object, trailing
 *  commas, and raw control characters inside strings. Returns
 *  undefined when no JSON object can be found. */
function parseJsonLoosely(text: string): unknown | undefined {
  const stripped = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  for (const candidate of [stripped, repairJsonText(stripped)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* not bare JSON — try to find an object inside the text */
    }
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = stripped.slice(start, end + 1);
    for (const candidate of [inner, repairJsonText(inner)]) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* keep trying the next repair */
      }
    }
  }
  return undefined;
}

/** True when the text is JSON (or JSON wrapped in fences/prose) rather
 *  than plain prose — used to decide whether the free-text path may
 *  embed it verbatim. Raw JSON must never be shown to the user as the
 *  "direct answer". */
function looksLikeJson(text: string): boolean {
  const stripped = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  return stripped.startsWith("{") || stripped.startsWith("[");
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Aliases free models use for the CFO/briefing shapes' fields, after
 *  snake_case is camelCased: key_numbers → numbers, key_points →
 *  points, briefing_points → points. gpt-4o-mini also sometimes names
 *  the answer field "answer" / "response" / "message" / "result" /
 *  "reply" / "summary" instead of "direct_answer" — seen live
 *  2026-11-17, when three good gpt-4o-mini answers were thrown away
 *  to the rule-based fallback for exactly this. Those map to
 *  directAnswer so the answer survives. */
const ANSWER_KEY_ALIASES: Record<string, string> = {
  keyNumbers: "numbers",
  keyPoints: "points",
  keyFigures: "numbers",
  briefingPoints: "points",
  answer: "directAnswer",
  response: "directAnswer",
  message: "directAnswer",
  result: "directAnswer",
  reply: "directAnswer",
  summary: "directAnswer",
};

/** Normalise one key-numbers item into {label, value}. Accepts
 *  {label,value}, {name,value}, {key,amount} and plain strings —
 *  "Revenue: INR 3,540" splits at the first ": ". Items with neither
 *  a label nor a value are dropped (null). */
function normalizeNumberItem(item: unknown): { label: string; value: string } | null {
  const asStr = (v: unknown): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  if (typeof item === "string") {
    const s = item.trim();
    if (!s) return null;
    const cut = s.indexOf(": ");
    if (cut > 0) return { label: s.slice(0, cut).trim(), value: s.slice(cut + 2).trim() };
    return { label: "", value: s };
  }
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const label = asStr(o.label ?? o.name ?? o.key ?? o.title);
    const value = asStr(o.value ?? o.amount ?? o.text ?? o.figure);
    if (!label && !value) return null;
    return { label, value };
  }
  return null;
}

/** Recursively camelCase a parsed model reply's keys (direct_answer
 *  → directAnswer, supporting_data → supportingData) and map known
 *  aliases, so a valid JSON answer validates against the camelCase
 *  schema even when the model used snake_case. Key-numbers items are
 *  normalised into {label, value}; string arrays keep only strings. */
function normalizeAnswerShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAnswerShape);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const camel = toCamelKey(k);
      const mapped = ANSWER_KEY_ALIASES[camel] ?? camel;
      // Never let an alias overwrite a real directAnswer seen earlier
      // in the same object (a reply that carries both names).
      if (
        mapped === "directAnswer" &&
        typeof out.directAnswer === "string" &&
        out.directAnswer.trim()
      ) {
        continue;
      }
      out[mapped] = normalizeAnswerShape(v);
    }
    if (Array.isArray(out.numbers)) {
      out.numbers = (out.numbers as unknown[])
        .map(normalizeNumberItem)
        .filter((n): n is { label: string; value: string } => n !== null);
    }
    for (const k of ["supportingData", "options", "points"]) {
      if (Array.isArray(out[k])) {
        out[k] = (out[k] as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
      }
    }
    return out;
  }
  return value;
}

/** Last-resort salvage: pull the value of a named string field out of
 *  text that looks like JSON but would not parse (for example a
 *  string cut off mid-way). Handles backslash escapes and returns the
 *  unescaped string; null when the field is not there. */
function extractJsonStringField(text: string, keys: string[]): string | null {
  for (const key of keys) {
    const idx = text.indexOf(`"${key}"`);
    if (idx < 0) continue;
    const colon = text.indexOf(":", idx + key.length + 2);
    if (colon < 0) continue;
    let i = colon + 1;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== '"') continue;
    let j = i + 1;
    let raw = "";
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === "\\" && j + 1 < text.length) {
        raw += ch + text[j + 1];
        j += 2;
        continue;
      }
      if (ch === '"') break;
      raw += ch;
      j++;
    }
    if (raw.trim()) {
      try {
        const decoded = JSON.parse(`"${raw}"`);
        if (typeof decoded === "string" && decoded.trim()) return decoded.trim();
      } catch {
        return raw.trim();
      }
    }
  }
  return null;
}

/** Try a parsed reply (and its single-level wrappers) against the
 *  schema, with key normalisation — the JSON ladder every reply goes
 *  through before any free-text handling. Returns the validated data
 *  or null. */
function tryJsonAnswer(parsed: unknown, schema: z.ZodTypeAny): unknown | null {
  const candidates: unknown[] = [parsed];
  if (parsed && typeof parsed === "object") {
    for (const k of ["answer", "result", "data"]) {
      const v = (parsed as Record<string, unknown>)[k];
      if (v && typeof v === "object") candidates.push(v);
    }
  }
  for (const candidate of candidates) {
    const checked = schema.safeParse(candidate);
    if (checked.success) return checked.data;
    const normalized = normalizeAnswerShape(candidate);
    const rechecked = schema.safeParse(normalized);
    if (rechecked.success) return rechecked.data;
    // Vision answers: the model sometimes invents its own image shape
    // (description / extraction / signs_of_editing). Translate it onto
    // the schema's keys before giving up — see normalizeImageShape.
    if (shapeKeys(schema).includes("readable")) {
      const imageChecked = schema.safeParse(normalizeImageShape(candidate));
      if (imageChecked.success) return imageChecked.data;
    }
  }
  return null;
}

/** Coerce a value into an array of non-empty strings. Accepts an
 *  array (strings kept, numbers stringified), a single string
 *  (split on newlines), or anything else → []. */
function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      else if (typeof item === "number") out.push(String(item));
      else if (Array.isArray(item)) out.push(...asStringList(item));
    }
    return out;
  }
  if (typeof v === "string" && v.trim()) {
    return v
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Coerce key-numbers into {label, value}[]: an array via
 *  normalizeNumberItem; a map object via its entries ("Revenue":
 *  "INR 3,540" → {label, value}); a string via "Label: value"
 *  lines; anything else → []. A model that returns key_numbers as
 *  a map instead of an array no longer loses the whole answer. */
function asNumberList(v: unknown): { label: string; value: string }[] {
  if (Array.isArray(v)) {
    return v
      .map(normalizeNumberItem)
      .filter((n): n is { label: string; value: string } => n !== null);
  }
  if (v && typeof v === "object") {
    const out: { label: string; value: string }[] = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const value =
        typeof val === "string" ? val : typeof val === "number" ? String(val) : "";
      if (k.trim() && value.trim()) {
        out.push({ label: k.trim(), value: value.trim() });
      }
    }
    return out;
  }
  if (typeof v === "string") {
    return v
      .split(/\n+/)
      .map(normalizeNumberItem)
      .filter((n): n is { label: string; value: string } => n !== null);
  }
  return [];
}

/** Coerce a value into prose: a string as-is, an array joined with
 *  spaces, a number stringified, anything else → "". */
function asProse(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return asStringList(v).join(" ");
  return "";
}

/** The single-level wrappers a model reply may hide its answer
 *  under ({ answer: {...} } / { result: {...} } / { data: {...} }),
 *  most useful first. */
function answerCandidates(parsed: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
    }
  };
  push(parsed);
  if (parsed && typeof parsed === "object") {
    for (const k of ["answer", "result", "data"]) {
      push((parsed as Record<string, unknown>)[k]);
    }
  }
  return out;
}

/** Build a CFO answer from a parsed reply that has a real direct
 *  answer but would fail strict schema validation — a missing
 *  explanation, supporting points or assumptions, or key_numbers as
 *  a map instead of an array. Missing fields get honest defaults
 *  (never invented figures); the direct answer is the model's own
 *  words. Returns null when no candidate has a usable direct
 *  answer. */
function tolerantCfoAnswer(
  parsed: unknown,
  schema: z.ZodTypeAny,
  model: string,
): unknown | null {
  for (const candidate of answerCandidates(parsed)) {
    const n = normalizeAnswerShape(candidate) as Record<string, unknown>;
    const direct = asProse(n.directAnswer).trim();
    if (!direct) continue;
    const obj = {
      directAnswer: direct.slice(0, 4000),
      numbers: asNumberList(n.numbers),
      explanation:
        asProse(n.explanation).trim() ||
        "The model gave a direct answer without a separate explanation — the direct answer above carries the full reply.",
      supportingData: asStringList(n.supportingData),
      options: asStringList(n.options),
      assumptions:
        asProse(n.assumptions).trim() ||
        `Answered by ${model}. Figures come only from the data supplied with the question; nothing was invented.`,
    };
    const checked = schema.safeParse(obj);
    if (checked.success) return checked.data;
  }
  return null;
}

/** Build a daily briefing from a parsed reply that has a headline
 *  and/or points under any of the names models use (points,
 *  briefing_points, key_points). Accepts headline + points, points
 *  alone (the first point becomes the headline), or headline alone
 *  (the headline becomes the single point). Returns null when
 *  neither a headline nor any point can be found. */
function tolerantBriefingAnswer(
  parsed: unknown,
  schema: z.ZodTypeAny,
): unknown | null {
  for (const candidate of answerCandidates(parsed)) {
    const n = normalizeAnswerShape(candidate) as Record<string, unknown>;
    const headline = asProse(n.headline).trim();
    const points = asStringList(n.points);
    if (!headline && points.length === 0) continue;
    const finalHeadline = ((headline || points[0]) ?? "").slice(0, 200);
    const finalPoints = (points.length > 0 ? points : [finalHeadline]).slice(0, 5);
    if (!finalHeadline || finalPoints.length === 0) continue;
    const checked = schema.safeParse({
      headline: finalHeadline,
      points: finalPoints,
    });
    if (checked.success) return checked.data;
  }
  return null;
}

/** Last-chance acceptance for a parsed reply: a real direct answer
 *  (CFO) or a real headline + points (briefing) is never thrown
 *  away over a missing optional field or an oddly-shaped numbers
 *  list. Returns the validated answer or null. */
function tolerantAnswerFromParsed(
  parsed: unknown,
  schema: z.ZodTypeAny,
  model: string,
): unknown | null {
  const keys = shapeKeys(schema);
  if (keys.includes("directAnswer")) {
    return tolerantCfoAnswer(parsed, schema, model);
  }
  if (keys.includes("headline") && keys.includes("points")) {
    return tolerantBriefingAnswer(parsed, schema);
  }
  return null;
}

/** Pull a JSON array field out of text that looks like JSON but
 *  would not parse (for example a reply cut off mid-way): find
 *  "key", scan to the matching "]" respecting strings, and parse
 *  just that array. Returns null when the field or a complete array
 *  is not there. */
function extractJsonArrayField(text: string, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const idx = text.indexOf(`"${key}"`);
    if (idx < 0) continue;
    const colon = text.indexOf(":", idx + key.length + 2);
    if (colon < 0) continue;
    let i = colon + 1;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== "[") continue;
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[") depth++;
      if (ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i, j + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not a parseable array — try the next key */
    }
  }
  return null;
}

/** Salvage an answer from JSON-looking text that would not parse —
 *  typically a reply cut off mid-string (a model that stopped early
 *  or the old 4000-character cap). Pulls the direct answer /
 *  headline and the key-numbers / points arrays field-by-field;
 *  anything missing gets honest defaults. Returns null when no
 *  direct answer or headline can be found. */
function salvageTruncatedJsonAnswer(
  clean: string,
  schema: z.ZodTypeAny,
  model: string,
): unknown | null {
  const keys = shapeKeys(schema);
  if (keys.includes("directAnswer")) {
    const direct = extractJsonStringField(clean, [
      "direct_answer",
      "directAnswer",
      "answer",
      "response",
      "message",
      "result",
      "reply",
      "summary",
    ]);
    if (!direct) return null;
    const numbersRaw = extractJsonArrayField(clean, [
      "key_numbers",
      "keyNumbers",
      "numbers",
    ]);
    const explanation = extractJsonStringField(clean, ["explanation"]);
    const supportingRaw = extractJsonArrayField(clean, [
      "supporting_data_points",
      "supporting_data",
      "supportingData",
    ]);
    const optionsRaw = extractJsonArrayField(clean, ["suggested_options", "options"]);
    const assumptions = extractJsonStringField(clean, [
      "assumptions_and_limitations",
      "assumptions",
    ]);
    const obj = {
      directAnswer: direct.trim().slice(0, 4000),
      numbers: numbersRaw ? asNumberList(numbersRaw) : [],
      explanation:
        explanation?.trim() ||
        "The model gave a direct answer without a separate explanation — the direct answer above carries the full reply.",
      supportingData: supportingRaw ? asStringList(supportingRaw) : [],
      options: optionsRaw ? asStringList(optionsRaw) : [],
      assumptions:
        assumptions?.trim() ||
        `Answered by ${model}. Figures come only from the data supplied with the question; nothing was invented.`,
    };
    const checked = schema.safeParse(obj);
    return checked.success ? checked.data : null;
  }
  if (keys.includes("headline") && keys.includes("points")) {
    const headline = extractJsonStringField(clean, ["headline"]);
    const pointsRaw = extractJsonArrayField(clean, [
      "briefing_points",
      "briefingPoints",
      "points",
      "key_points",
      "keyPoints",
    ]);
    const points = pointsRaw ? asStringList(pointsRaw) : [];
    if (!headline && points.length === 0) return null;
    const finalHeadline = ((headline?.trim() || points[0]) ?? "").slice(0, 200);
    const finalPoints = (points.length > 0 ? points : [finalHeadline]).slice(0, 5);
    const checked = schema.safeParse({
      headline: finalHeadline,
      points: finalPoints,
    });
    return checked.success ? checked.data : null;
  }
  return null;
}

/** A reasoning-mandatory model thinking out loud instead of
 *  answering: meta-talk about producing the JSON shape ("We need
 *  answer user's request. Need produce final only valid JSON matching
 *  requested shape. Need infer shape? Need likely JSON object with
 *  fields: direct_answer, key_numbers, ...") that never becomes an
 *  answer. True when the text opens with that planning language,
 *  quotes the JSON-shape instruction back, or is made of two or more
 *  short imperative sentences starting with "Need ..." / "We need
 *  ...". A genuine answer does not plan the reply out loud — it starts
 *  with the answer itself — and a mid-sentence "you need to ..." is
 *  never counted, so real advice is not mistaken for a trace. */
const REASONING_TRACE_PATTERNS = [
  /need\s+(produce|infer|figure out|determine|likely)\b.{0,80}json/i,
  /need answer question:/i,
  /valid json matching (the )?requested shape/i,
  /fields?:\s*direct_answer/i,
  /field labels stay as they are/i,
];

function isReasoningTrace(text: string): boolean {
  const t = text.trim();
  if (
    /^(we need (to )?(answer|produce|infer|figure|determine)|need (produce|infer|figure|determine|answer|likely))/i.test(
      t,
    )
  ) {
    return true;
  }
  if (REASONING_TRACE_PATTERNS.some((re) => re.test(t))) return true;
  const sentences = t.split(/(?<=[.!?])\s+/);
  const planning = sentences.filter((s) =>
    /^(need|we need|i need)\b/i.test(s.trim()),
  ).length;
  return planning >= 2;
}

/** Build a best-effort answer from the model's free-text reply when
 *  no JSON matching the schema could be extracted. A real grounded
 *  text answer beats the rule-based fallback. The JSON ladder runs
 *  FIRST: a reply that is valid JSON with direct_answer/key_numbers
 *  is used as structured fields, never embedded raw. Only genuinely
 *  non-JSON prose goes down the free-text path, and text that looks
 *  like JSON but would not parse is salvaged field-by-field instead
 *  of being shown raw. Returns null for shapes free text cannot
 *  honestly fill — the vision extraction shape (readable/…) needs
 *  structured fields, so a text reply there is not usable and the
 *  caller tries the next model instead. It also returns null for a
 *  reasoning trace (see isReasoningTrace): the model thinking out
 *  loud is not an answer, so the caller tries the next model. */
function textAnswerForSchema(
  schema: z.ZodTypeAny | undefined,
  text: string,
  model: string,
): unknown | null {
  if (!schema) return null;
  const clean = text.slice(0, 4000).trim();
  if (!clean) return null;
  const keys = shapeKeys(schema);
  // 1. JSON first: valid JSON (snake_case included) becomes structured
  //    fields — this is the Ernie case, whose reply was JSON with
  //    direct_answer/key_numbers but failed validation as-is.
  const loose = parseJsonLoosely(clean);
  if (loose !== undefined) {
    const jsonAnswer = tryJsonAnswer(loose, schema);
    if (jsonAnswer !== null) return jsonAnswer;
    // 2. JSON that would not fully validate: a real direct answer
    //    (or headline + points) is still an answer — fill the missing
    //    fields with honest defaults instead of dropping it. This is
    //    the live Ernie case: a direct_answer was produced but the
    //    strict shape check threw the whole answer away.
    const tolerant = tolerantAnswerFromParsed(loose, schema, model);
    if (tolerant !== null) return tolerant;
  }
  // 3. Text that looks like JSON but would not parse (cut off
  //    mid-string): salvage the fields one by one instead of showing
  //    it raw or dropping it. Only when nothing can be salvaged does
  //    the caller try the next model.
  if (looksLikeJson(clean)) {
    const salvaged = salvageTruncatedJsonAnswer(clean, schema, model);
    if (salvaged !== null) return salvaged;
    return null;
  }
  // 3b. A reasoning trace is not an answer: the model thought out loud
  //     about producing JSON and never produced one. Return null so the
  //     caller tries the next free model instead of showing the model's
  //     thinking as the answer.
  if (isReasoningTrace(clean)) return null;
  // 4. Genuinely non-JSON prose: use it as the answer.
  if (keys.includes("directAnswer")) {
    const obj = {
      directAnswer: clean,
      numbers: [],
      explanation:
        "The model answered as free text rather than the usual structured JSON, so the key numbers could not be separated out — the direct answer above carries the full reply.",
      supportingData: [],
      options: [],
      assumptions: `Answered by ${model} as free text. Figures come only from the data supplied with the question; nothing was invented.`,
    };
    const checked = schema.safeParse(obj);
    return checked.success ? checked.data : null;
  }
  if (keys.includes("headline") && keys.includes("points")) {
    const lines = clean
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const sentences = clean
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const points = (lines.length >= 2 ? lines : sentences).slice(0, 5);
    const obj = {
      headline: (points[0] ?? clean).slice(0, 120),
      points: points.length > 0 ? points : [clean.slice(0, 200)],
    };
    const checked = schema.safeParse(obj);
    return checked.success ? checked.data : null;
  }
  return null;
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
  timeoutMs: number = OPENROUTER_CALL_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const jsonInstruction =
      schema && !isStringSchema(schema)
        ? "\n\nRespond with ONLY valid JSON matching the requested shape. No markdown, no extra text. Do not show your reasoning or thinking process — output only the final answer."
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
              "You are a careful financial assistant. Answer only from the figures given in the user message; never invent numbers. If the figures cannot answer the question, say so. Output only the final answer — do not include your reasoning, thinking, or planning.",
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
      // 429 means the free model's upstream pool is throttling — the
      // caller retries with the next free model after a short backoff.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = "";
      }
      const message = `OpenRouter answered ${res.status}${detail ? `: ${detail}` : ""}`;
      if (res.status === 429) throw taggedError("rate_limited", message);
      throw new Error(message);
    }
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | { text?: string }[] | null;
          reasoning?: unknown;
          reasoning_content?: unknown;
        } | null;
        reasoning?: unknown;
      }[];
    };
    // Tolerant extraction: some free models (notably reasoning-mandatory
    // ones such as Ernie) return an empty content with the answer in the
    // reasoning field, or wrap JSON in fences/prose.
    const { content, reasoning } = extractChatCompletionsText(data);
    const text = (content || reasoning).trim();
    if (!text) {
      console.warn(
        `[cashflow-genius] OpenRouter returned no usable text (model ${model}): ${JSON.stringify(
          data.choices?.[0]?.message ?? null,
        ).slice(0, 300)}`,
      );
      throw taggedError("parse", "OpenRouter returned no usable text");
    }
    if (!schema || isStringSchema(schema)) return text;
    const parsed = parseJsonLoosely(text);
    if (parsed !== undefined) {
      // Try the object itself, then a single-level wrapper
      // ({ answer: {...} } / { result: {...} } / { data: {...} }),
      // each as-is and with keys normalised (snake_case → camelCase,
      // key_numbers → numbers) — a valid JSON reply whose keys do not
      // match the schema's case must still land as structured fields.
      const jsonAnswer = tryJsonAnswer(parsed, schema);
      if (jsonAnswer !== null) return jsonAnswer;
      // A real direct answer (or headline + points) with a missing
      // optional field or oddly-shaped numbers is still an answer —
      // fill the gaps with honest defaults instead of burning the
      // next model on a retry.
      const tolerant = tolerantAnswerFromParsed(parsed, schema, model);
      if (tolerant !== null) return tolerant;
    }
    // No JSON matching the schema — but there IS a real answer in text.
    // Use it rather than throwing the work away.
    const textAnswer = textAnswerForSchema(schema, text, model);
    if (textAnswer !== null) return textAnswer;
    // Genuinely unusable: log a truncated shape summary (never the key)
    // so the server log shows what the model actually returned.
    console.warn(
      `[cashflow-genius] OpenRouter answer did not match the expected shape (model ${model}): ${text.slice(0, 300)}`,
    );
    throw taggedError("parse", "OpenRouter answer did not match the expected shape");
  } catch (e) {
    // A timed-out call used to kill the whole chain: AbortError has
    // no retry code, so aiComplete stopped at the first slow model.
    // A timeout is transient — the next free model may answer fast —
    // so tag it retryable and name the model that was too slow
    // (never the key).
    if (
      (e as { name?: unknown } | null)?.name === "AbortError" ||
      ctrl.signal.aborted
    ) {
      console.warn(
        `[cashflow-genius] OpenRouter call to ${model} timed out after ${timeoutMs}ms — trying the next free model`,
      );
      throw taggedError(
        "timeout",
        `OpenRouter call to ${model} timed out after ${timeoutMs}ms`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI (ChatGPT) via its own chat-completions endpoint — the same
 *  OpenAI-compatible shape as OpenRouter, so the same tolerant
 *  parsing applies. The key travels ONLY in the Authorization header
 *  — never in the URL, body, or logs. Images (Scam Shield
 *  screenshots) are sent as data-URL image parts; gpt-4o-mini takes
 *  image input, so no model needs skipping. One attempt: the paid
 *  API is reliable, and a 401 (bad key) or 429 (insufficient credits)
 *  would fail identically on a retry, so the caller falls back
 *  honestly instead. */
async function callOpenAI(
  key: string,
  model: string,
  prompt: string,
  schema: z.ZodTypeAny | undefined,
  images:
    | { dataBase64: string; mimeType: string; caption?: string }[]
    | undefined,
  timeoutMs: number = OPENAI_CALL_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const jsonInstruction =
      schema && !isStringSchema(schema)
        ? "\n\nRespond with ONLY valid JSON matching the requested shape. No markdown, no extra text. Do not show your reasoning or thinking process — output only the final answer."
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
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a careful financial assistant. Answer only from the figures given in the user message; never invent numbers. If the figures cannot answer the question, say so. Output only the final answer — do not include your reasoning, thinking, or planning.",
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
      // Same bounded-error rule as the other providers: status +
      // body, never the key. A 429 from OpenAI usually means
      // insufficient credits/quota — retrying would not help.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = "";
      }
      const message = `OpenAI answered ${res.status}${detail ? `: ${detail}` : ""}`;
      if (res.status === 429) throw taggedError("rate_limited", message);
      throw new Error(message);
    }
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | { text?: string }[] | null;
          reasoning?: unknown;
          reasoning_content?: unknown;
        } | null;
        reasoning?: unknown;
      }[];
    };
    const { content, reasoning } = extractChatCompletionsText(data);
    const text = (content || reasoning).trim();
    if (!text) {
      console.warn(
        `[cashflow-genius] OpenAI returned no usable text (model ${model}): ${JSON.stringify(
          data.choices?.[0]?.message ?? null,
        ).slice(0, 300)}`,
      );
      throw taggedError("parse", "OpenAI returned no usable text");
    }
    if (!schema || isStringSchema(schema)) return text;
    const parsed = parseJsonLoosely(text);
    if (parsed !== undefined) {
      const jsonAnswer = tryJsonAnswer(parsed, schema);
      if (jsonAnswer !== null) return jsonAnswer;
      const tolerant = tolerantAnswerFromParsed(parsed, schema, model);
      if (tolerant !== null) return tolerant;
    }
    const textAnswer = textAnswerForSchema(schema, text, model);
    if (textAnswer !== null) return textAnswer;
    console.warn(
      `[cashflow-genius] OpenAI answer did not match the expected shape (model ${model}): ${text.slice(0, 300)}`,
    );
    throw taggedError("parse", "OpenAI answer did not match the expected shape");
  } catch (e) {
    // A timed-out call is transient, but there is no second model to
    // try — tag it and let the caller fall back honestly.
    if (
      (e as { name?: unknown } | null)?.name === "AbortError" ||
      ctrl.signal.aborted
    ) {
      console.warn(
        `[cashflow-genius] OpenAI call to ${model} timed out after ${timeoutMs}ms`,
      );
      throw taggedError(
        "timeout",
        `OpenAI call to ${model} timed out after ${timeoutMs}ms`,
      );
    }
    throw e;
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
  if (provider === "openai") {
    const key = settings.openAiKey ?? process.env.OPENAI_API_KEY ?? null;
    const model = settings.openAiModel || DEFAULT_OPENAI_MODEL;
    if (!key) return ruleBasedFallback(opts.schema, provider) as T;
    // One attempt: the paid API is reliable, and a 401 (bad key) or
    // 429 (insufficient credits) would fail identically on a retry.
    // gpt-4o-mini takes image input, so vision calls need no skip.
    try {
      const out = (await callOpenAI(
        key,
        model,
        prompt,
        opts.schema,
        opts.images,
      )) as T;
      await markAiVerified(settings.ownerId ?? null, provider);
      return out;
    } catch (e) {
      console.warn("[cashflow-genius] OpenAI call failed, using rule-based fallback:", e);
      return ruleBasedFallback(opts.schema, provider) as T;
    }
  }
  if (provider === "openrouter") {
    const key = settings.openRouterKey ?? process.env.OPENROUTER_API_KEY ?? null;
    const selectedModel = settings.openRouterModel || DEFAULT_OPENROUTER_MODEL;
    if (!key) return ruleBasedFallback(opts.schema, provider) as T;
    // Try the selected model first, then the other verified-free models
    // in list order, skipping duplicates. Vision calls (an image is
    // attached) only try models that accept images — Ernie is text-only.
    const hasImages = (opts.images?.length ?? 0) > 0;
    const pool = hasImages
      ? OPENROUTER_VISION_FREE_MODELS
      : OPENROUTER_FREE_MODELS;
    const candidates = [
      selectedModel,
      ...pool.filter((m) => m !== selectedModel),
    ].filter((m) => !hasImages || !OPENROUTER_TEXT_ONLY_MODELS.has(m));
    // Whole-attempt budget: per-call timeouts shrink as the budget runs
    // down, so a chain of 429s and parse failures still finishes well
    // inside Vercel Hobby function limits.
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (const model of candidates) {
      const remaining = OPENROUTER_TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 3000) break; // not enough time left for a useful call
      try {
        const out = (await callOpenRouter(
          key,
          model,
          prompt,
          opts.schema,
          opts.images,
          Math.min(OPENROUTER_CALL_TIMEOUT_MS, remaining),
        )) as T;
        await markAiVerified(settings.ownerId ?? null, provider);
        return out;
      } catch (e) {
        lastError = e;
        // Only a throttled pool (429), a timed-out call, or an
        // unusable reply shape is worth another model: a 401 (bad
        // key) or 404 (unknown model) would fail identically on every
        // model, so stop at once.
        if (!isRetryableOpenRouterError(e)) break;
        if (isRateLimitedError(e)) {
          // Short backoff before the next model — but only if the
          // budget still leaves time for a useful call afterwards.
          if (Date.now() - startedAt + OPENROUTER_RATE_LIMIT_BACKOFF_MS + 3000 > OPENROUTER_TOTAL_BUDGET_MS) break;
          await sleep(OPENROUTER_RATE_LIMIT_BACKOFF_MS);
        }
        // Parse failure → next model immediately, no backoff.
      }
    }
    console.warn("[cashflow-genius] OpenRouter call failed, using rule-based fallback:", lastError);
    return ruleBasedFallback(opts.schema, provider) as T;
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
