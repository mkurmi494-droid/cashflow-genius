// OpenRouter provider harness — Cashflow Genius AI CFO.
//
// Proves, against a local mock of the OpenRouter endpoint (global
// fetch is replaced in-process; no network, no real key, no DB):
//  (a) the OpenRouter request shape — endpoint, Authorization Bearer
//      header, model, messages, response_format;
//  (b) the rule-based fallback when the provider errors, and when no
//      key is configured (fetch never called);
//  (c) the saved key never appears in any returned object, log line,
//      or thrown error — only in the Authorization header, where the
//      provider requires it;
//  (d) the Gemini path is unchanged (no key → Gemini fallback; a
//      mocked Gemini success still parses);
//  (e) the success path still answers when the database is unreachable
//      (markAiVerified is best-effort and never blocks the answer);
//  (f) a 429 on the selected model automatically tries the next
//      verified-free model (after a ~4s backoff) and the answer parses;
//  (g) tolerant parsing — reasoning-only replies, JSON in markdown
//      fences, JSON wrapped in prose, JSON nested under an "answer"
//      key, and plain free text (used as the answer) all work;
//  (h) an unusable reply on model 1 tries model 2 (vision shape,
//      where free text cannot fill the structured fields);
//  (i) vision calls never send image parts to the text-only model
//      (Ernie) — it is skipped even when selected;
//  (j) a hopeless error (401) does not retry other models;
//  (k) all free models throttled → rule-based fallback, after trying
//      every free model in order, inside the ~50s attempt budget.
//
// Usage: node scripts/openrouter-test.mjs
// Exit 0 = all pass. No key used here is real: the sentinel key is a
// fake string that exists only inside this process.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SENTINEL_KEY = "sk-or-v1-TESTSENTINEL-9f8e7d6c5b4a";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";

// Dummy local DATABASE_URL: markAiVerified's update then fails fast
// with ECONNREFUSED and must be swallowed, never blocking the answer.
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/db";
delete process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;

// ---- bundle server/lib/ai.ts with the repo's esbuild (no tsx needed) ----
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "or-test-"));
const bundle = join(outDir, "ai.mjs");
execSync(
  `node_modules/.bin/esbuild server/lib/ai.ts --bundle --platform=node --format=esm --outfile=${bundle}`,
  { cwd: repoRoot, stdio: "pipe" },
);

// ---- local mock of the provider endpoints ----
const requests = [];
let mockHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  if (mockHandler) return mockHandler(String(url), init);
  throw new Error("mock fetch: no handler set");
};
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// Capture everything the module logs, for the leak audit.
const consoleOutput = [];
const origWarn = console.warn;
const origError = console.error;
console.warn = (...a) => {
  consoleOutput.push(a.map(String).join(" "));
};
console.error = (...a) => {
  consoleOutput.push(a.map(String).join(" "));
};

const { aiComplete, aiExtrasFromRow, DEFAULT_OPENROUTER_MODEL, OPENROUTER_FREE_MODELS } = await import(bundle);

// ---- bundle client/cfoHistory.ts (plain TS, no JSX) for the history tests ----
const cfoBundle = join(outDir, "cfoHistory.mjs");
execSync(
  `node_modules/.bin/esbuild client/cfoHistory.ts --bundle --platform=node --format=esm --outfile=${cfoBundle}`,
  { cwd: repoRoot, stdio: "pipe" },
);
const { parseStoredAnswer, buildTurns, displayRawText } = await import(cfoBundle);

const cfoSchema = z.object({
  directAnswer: z.string(),
  numbers: z.array(z.object({ label: z.string(), value: z.string() })),
  explanation: z.string(),
  supportingData: z.array(z.string()),
  options: z.array(z.string()),
  assumptions: z.string(),
});
const cannedCfo = {
  directAnswer: "Mocked AI answer: cash is fine.",
  numbers: [{ label: "Available cash", value: "₹3,440" }],
  explanation: "Mocked explanation.",
  supportingData: ["Available cash ₹3,440"],
  options: ["Mocked option."],
  assumptions: "Mocked assumptions.",
};
const openRouterOk = (content) => ({
  choices: [{ message: { role: "assistant", content } }],
});
const geminiOk = (text) => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok ${passed} — ${name}`);
};
const resultsDump = [];
const resetMock = () => {
  requests.length = 0;
  mockHandler = null;
};

console.log("OpenRouter provider harness");

// (a) request shape, default model, JSON response_format, parsed result
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk(JSON.stringify(cannedCfo)));
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: DEFAULT_MODEL,
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("OpenRouter happy path returns parsed schema answer", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
    assert.equal(res.numbers[0].value, "₹3,440");
  });
  check("request hits the OpenRouter chat-completions endpoint", () => {
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, OPENROUTER_URL);
    assert.equal(requests[0].init.method, "POST");
  });
  check("Authorization Bearer carries the key; key nowhere else in the request", () => {
    const headers = requests[0].init.headers;
    assert.equal(headers.Authorization, `Bearer ${SENTINEL_KEY}`);
    assert.equal(headers["Content-Type"], "application/json");
    assert.ok(headers["HTTP-Referer"]);
    assert.equal(headers["X-Title"], "Cashflow Genius");
    const body = JSON.parse(requests[0].init.body);
    assert.ok(!requests[0].url.includes(SENTINEL_KEY));
    assert.ok(!requests[0].init.body.includes(SENTINEL_KEY));
  });
  check("body carries model, system+user messages, json_object format", () => {
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.ok(body.messages[1].content.includes("How is my cashflow this month?"));
    assert.equal(body.response_format.type, "json_object");
  });
}

// (a2) images travel as data-URL image parts
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk(JSON.stringify(cannedCfo)));
{
  await aiComplete(
    "Read this screenshot.",
    {
      schema: cfoSchema,
      images: [{ dataBase64: "aGVsbG8=", mimeType: "image/jpeg" }],
    },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: DEFAULT_MODEL,
      ownerId: "test-owner",
    },
  );
  check("screenshot is sent as an image_url data-URL part", () => {
    const body = JSON.parse(requests[0].init.body);
    const content = body.messages[1].content;
    assert.ok(Array.isArray(content));
    const img = content.find((p) => p.type === "image_url");
    assert.ok(img);
    assert.equal(img.image_url.url, "data:image/jpeg;base64,aGVsbG8=");
  });
}

// (b) provider error → OpenRouter fallback (never a Gemini message)
resetMock();
mockHandler = () =>
  jsonResponse(403, {
    error: { code: 403, message: "free tier not available (mocked)" },
  });
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: DEFAULT_MODEL,
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("403 from OpenRouter falls back and names OpenRouter", () => {
    assert.ok(res.directAnswer.includes("OpenRouter"));
    assert.ok(res.directAnswer.includes("not an AI analysis"));
    assert.ok(!res.directAnswer.includes("Gemini"));
  });
  check("error body is logged with the status, never the key", () => {
    const warn = consoleOutput.join("\n");
    assert.ok(warn.includes("403"));
    assert.ok(!warn.includes(SENTINEL_KEY));
  });
}

// (b2) no key configured → fallback without any fetch
resetMock();
{
  const before = requests.length;
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "openrouter", openRouterKey: null, ownerId: "test-owner" },
  );
  resultsDump.push(JSON.stringify(res));
  check("no OpenRouter key → fallback, fetch never called", () => {
    assert.equal(requests.length, before);
    assert.ok(res.directAnswer.includes("OpenRouter"));
  });
}

// (a3) env key is used when no account key is passed
resetMock();
process.env.OPENROUTER_API_KEY = "sk-or-v1-ENVKEY-0000";
mockHandler = () => jsonResponse(200, openRouterOk(JSON.stringify(cannedCfo)));
{
  await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "openrouter", ownerId: "test-owner" },
  );
  check("OPENROUTER_API_KEY env is used as fallback", () => {
    assert.equal(requests[0].init.headers.Authorization, "Bearer sk-or-v1-ENVKEY-0000");
  });
}
delete process.env.OPENROUTER_API_KEY;

// (a4) model defaults to the free model when none is passed
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk(JSON.stringify(cannedCfo)));
{
  await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "openrouter", openRouterKey: SENTINEL_KEY, ownerId: "test-owner" },
  );
  check("model defaults to google/gemma-4-31b-it:free", () => {
    assert.equal(DEFAULT_OPENROUTER_MODEL, "google/gemma-4-31b-it:free");
    assert.equal(JSON.parse(requests[0].init.body).model, "google/gemma-4-31b-it:free");
  });
}

// (f) 429 on the selected model → automatic fallback to the next free
//     model (with the ~4s backoff), and the answer still parses
resetMock();
mockHandler = (url, init) => {
  const body = JSON.parse(init.body);
  if (body.model === "google/gemma-4-31b-it:free") {
    return jsonResponse(429, {
      error: { message: "Provider returned error", code: 429 },
    });
  }
  return jsonResponse(200, openRouterOk(JSON.stringify(cannedCfo)));
};
{
  const t0 = Date.now();
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  const elapsed = Date.now() - t0;
  resultsDump.push(JSON.stringify(res));
  check("429 on model 1 → success on model 2, answer parsed", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(requests[0].init.body).model, "google/gemma-4-31b-it:free");
    assert.equal(JSON.parse(requests[1].init.body).model, "inclusionai/ling-3.2-flash:free");
  });
  check("rate-limit backoff waits ~4s before the next model", () => {
    assert.ok(elapsed >= 3000, `expected >=3s backoff, got ${elapsed}ms`);
  });
}

// (g) tolerant parsing: reasoning-only, fenced, prose-wrapped and
//     wrapper-object replies all parse; free text becomes the answer
const reasoningOnly = () => ({
  choices: [{ message: { role: "assistant", content: "", reasoning: JSON.stringify(cannedCfo) } }],
});
const fenced = () => openRouterOk("```json\n" + JSON.stringify(cannedCfo) + "\n```");
const proseWrapped = () =>
  openRouterOk("Here is my analysis: " + JSON.stringify(cannedCfo) + " Hope this helps.");
const wrapperObject = () => openRouterOk(JSON.stringify({ answer: cannedCfo }));
for (const [name, body] of [
  ["reasoning-only reply (empty content + reasoning JSON)", reasoningOnly()],
  ["JSON wrapped in markdown code fences", fenced()],
  ["JSON wrapped in prose", proseWrapped()],
  ["JSON nested under an 'answer' key", wrapperObject()],
]) {
  resetMock();
  mockHandler = () => jsonResponse(200, body);
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check(`tolerant parse: ${name}`, () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
    assert.equal(requests.length, 1);
  });
}
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk("Aapka cash theek hai, ₹3,440 available hai."));
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("free-text reply (no JSON) is used as the answer, not discarded", () => {
    assert.ok(res.directAnswer.includes("₹3,440"));
    assert.ok(!res.directAnswer.includes("could not reach"));
    assert.equal(requests.length, 1);
  });
}
{
  const briefingSchema = z.object({
    headline: z.string(),
    points: z.array(z.string()).min(1).max(5),
  });
  resetMock();
  mockHandler = () =>
    jsonResponse(200, openRouterOk("Cash is steady.\nIncome is ahead of spending.\nNo overdue invoices."));
  const res = await aiComplete(
    "Daily briefing.",
    { schema: briefingSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("free-text briefing becomes headline + points", () => {
    assert.ok(res.headline.length > 0);
    assert.ok(res.points.length >= 1 && res.points.length <= 5);
    assert.ok(res.points.join(" ").includes("Cash is steady"));
  });
}

// (h) parse failure on model 1 → next model (vision shape, where free
//     text cannot fill the structured fields)
const imageOutSchema = z.object({
  readable: z.boolean(),
  appearsToBePaymentScreenshot: z.boolean(),
  visibleText: z.string(),
  senderOrReceiverName: z.string().nullable(),
  upiId: z.string().nullable(),
  amountText: z.string().nullable(),
  dateText: z.string().nullable(),
  statusWording: z.string().nullable(),
  editingSigns: z.string(),
});
const cannedImage = {
  readable: true,
  appearsToBePaymentScreenshot: true,
  visibleText: "Paid ₹500",
  senderOrReceiverName: null,
  upiId: null,
  amountText: "₹500",
  dateText: null,
  statusWording: null,
  editingSigns: "none",
};
resetMock();
mockHandler = (url, init) => {
  const body = JSON.parse(init.body);
  if (body.model === "google/gemma-4-31b-it:free") {
    return jsonResponse(200, openRouterOk("I can see a payment screenshot but cannot structure it."));
  }
  return jsonResponse(200, openRouterOk(JSON.stringify(cannedImage)));
};
{
  const res = await aiComplete(
    "Read this screenshot.",
    {
      schema: imageOutSchema,
      images: [{ dataBase64: "aGVsbG8=", mimeType: "image/jpeg" }],
    },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("unusable reply on model 1 → structured answer from model 2", () => {
    assert.equal(res.readable, true);
    assert.equal(res.amountText, "₹500");
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(requests[1].init.body).model, "inclusionai/ling-3.2-flash:free");
  });
}

// (i) vision calls never send image parts to the text-only model
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk(JSON.stringify(cannedImage)));
{
  const res = await aiComplete(
    "Read this screenshot.",
    {
      schema: imageOutSchema,
      images: [{ dataBase64: "aGVsbG8=", mimeType: "image/jpeg" }],
    },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "baidu/ernie-5.5-flash-preview:free",
      ownerId: "test-owner",
    },
  );
  check("text-only selected model is skipped for vision; images go to a vision model", () => {
    assert.equal(res.readable, true);
    const models = requests.map((r) => JSON.parse(r.init.body).model);
    assert.ok(!models.includes("baidu/ernie-5.5-flash-preview:free"));
    assert.equal(models[0], "google/gemma-4-31b-it:free");
    const body = JSON.parse(requests[0].init.body);
    const content = body.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some((p) => p.type === "image_url"));
  });
}

// (j) a hopeless error (401 bad key) does NOT retry other models
resetMock();
mockHandler = () =>
  jsonResponse(401, { error: { message: "No auth credentials found", code: 401 } });
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("401 stops at once — no pointless retries, fallback names OpenRouter", () => {
    assert.equal(requests.length, 1);
    assert.ok(res.directAnswer.includes("OpenRouter"));
  });
}

// (k) every free model throttled → rule-based fallback after trying all
resetMock();
mockHandler = () =>
  jsonResponse(429, { error: { message: "Provider returned error", code: 429 } });
{
  const t0 = Date.now();
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  const elapsed = Date.now() - t0;
  resultsDump.push(JSON.stringify(res));
  check("all models 429 → fallback after trying every free model in order", () => {
    assert.ok(res.directAnswer.includes("OpenRouter"));
    assert.ok(res.directAnswer.includes("not an AI analysis"));
    const models = requests.map((r) => JSON.parse(r.init.body).model);
    assert.deepEqual(models, [...OPENROUTER_FREE_MODELS]);
    assert.equal(requests.length, OPENROUTER_FREE_MODELS.length);
  });
  check("whole chain stays inside the ~50s attempt budget", () => {
    assert.ok(elapsed < 50000, `chain took ${elapsed}ms`);
  });
}

// (g2) snake_case JSON (the live Ernie reply) becomes structured fields,
//      never raw JSON in the direct answer — Quirk 1
const ernieReply = JSON.stringify({
  direct_answer:
    "Bilkul sahi — is mahine aapka cashflow strong hai. Revenue INR 3,540 hai aur expenses sirf INR 100, isliye net profit INR 3,440 bacha hai.",
  key_numbers: [
    { label: "Revenue", value: "INR 3,540" },
    { label: "Expenses", value: "INR 100" },
    { label: "Net profit", value: "INR 3,440" },
  ],
  explanation: "Cashflow strong hai kyunki revenue expenses se bahut zyada hai.",
  supporting_data: ["Available cash INR 3,440"],
  options: ["Agle mahine bhi aise hi chalao."],
  assumptions: "Figures code se calculate kiye gaye hain.",
});
resetMock();
mockHandler = () => jsonResponse(200, openRouterOk(ernieReply));
{
  const res = await aiComplete(
    "mera cashflow is mahine kaisa hai?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "baidu/ernie-5.5-flash-preview:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("snake_case JSON reply parses as structured fields, not raw JSON", () => {
    assert.ok(res.directAnswer.startsWith("Bilkul sahi"));
    assert.ok(!res.directAnswer.includes("direct_answer"));
    assert.ok(!res.directAnswer.includes("{"));
    assert.equal(res.numbers.length, 3);
    assert.equal(res.numbers[0].label, "Revenue");
    assert.equal(res.numbers[0].value, "INR 3,540");
    assert.equal(res.explanation, "Cashflow strong hai kyunki revenue expenses se bahut zyada hai.");
    assert.equal(requests.length, 1);
  });
}
resetMock();
mockHandler = () =>
  jsonResponse(
    200,
    openRouterOk(
      JSON.stringify({
        direct_answer: "Short answer.",
        key_numbers: [
          "Revenue: INR 3,540",
          { name: "Expenses", amount: "INR 100" },
        ],
      }),
    ),
  );
{
  const res = await aiComplete(
    "mera cashflow is mahine kaisa hai?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "baidu/ernie-5.5-flash-preview:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("key_numbers items as strings / {name, amount} normalise to label+value", () => {
    assert.equal(res.directAnswer, "Short answer.");
    assert.equal(res.numbers.length, 2);
    assert.deepEqual(res.numbers[0], { label: "Revenue", value: "INR 3,540" });
    assert.deepEqual(res.numbers[1], { label: "Expenses", value: "INR 100" });
  });
}

// (g3) broken JSON is repaired, not dropped — trailing comma, raw
//      newline inside a string value
resetMock();
mockHandler = () =>
  jsonResponse(
    200,
    openRouterOk(
      '{"directAnswer": "line one\nline two", "numbers": [], "explanation": "e", "supportingData": [], "options": [], "assumptions": "a",}',
    ),
  );
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    {
      provider: "openrouter",
      openRouterKey: SENTINEL_KEY,
      openRouterModel: "google/gemma-4-31b-it:free",
      ownerId: "test-owner",
    },
  );
  resultsDump.push(JSON.stringify(res));
  check("JSON with trailing comma + raw newline in a string is repaired and parsed", () => {
    assert.ok(res.directAnswer.includes("line one"));
    assert.ok(res.directAnswer.includes("line two"));
    assert.ok(!res.directAnswer.includes("could not reach"));
  });
}

// (g4) a stored free-text conversation renders its answer from history —
//      Quirk 2 (data/render level: the client's history helpers)
{
  const storedFreeText = JSON.stringify({
    directAnswer: ernieReply,
    numbers: [],
    explanation:
      "The model answered as free text rather than the usual structured JSON, so the key numbers could not be separated out — the direct answer above carries the full reply.",
    supportingData: [],
    options: [],
    assumptions: "Answered by baidu/ernie-5.5-flash-preview:free as free text.",
    sources: ["Available cash INR 3,440 = opening 0 + income INR 3,540 − expenses INR 100"],
    language: "hinglish",
  });
  check("stored free-text answer unwraps to structured fields on re-open", () => {
    const a = parseStoredAnswer(storedFreeText);
    assert.ok(a);
    assert.ok(a.directAnswer.startsWith("Bilkul sahi"));
    assert.ok(!a.directAnswer.includes("direct_answer"));
    assert.equal(a.numbers.length, 3);
    assert.equal(a.numbers[2].value, "INR 3,440");
    assert.equal(a.language, "hinglish");
    assert.equal(a.sources.length, 1);
  });
  const storedStructured = JSON.stringify({
    ...cannedCfo,
    sources: ["Available cash INR 3,440"],
    language: "en",
  });
  check("stored structured answer is unchanged on re-open", () => {
    const a = parseStoredAnswer(storedStructured);
    assert.ok(a);
    assert.equal(a.directAnswer, cannedCfo.directAnswer);
    assert.equal(a.numbers[0].value, "₹3,440");
  });
  check("history pairing works in normal message order", () => {
    const turns = buildTurns([
      { role: "user", content: "mera cashflow is mahine kaisa hai?" },
      { role: "assistant", content: storedFreeText },
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].q, "mera cashflow is mahine kaisa hai?");
    assert.ok(turns[0].a);
    assert.ok(turns[0].a.directAnswer.startsWith("Bilkul sahi"));
  });
  check("history pairing works when the assistant row precedes its question (created_at tie)", () => {
    const turns = buildTurns([
      { role: "assistant", content: storedFreeText },
      { role: "user", content: "mera cashflow is mahine kaisa hai?" },
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].q, "mera cashflow is mahine kaisa hai?");
    assert.ok(turns[0].a);
    assert.ok(turns[0].a.directAnswer.startsWith("Bilkul sahi"));
  });
  check("multi-turn history pairs each answer with its question, in order", () => {
    const turns = buildTurns([
      { role: "user", content: "q1" },
      { role: "assistant", content: storedStructured },
      { role: "assistant", content: storedFreeText },
      { role: "user", content: "q2" },
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].q, "q1");
    assert.ok(turns[0].a);
    assert.equal(turns[0].a.directAnswer, cannedCfo.directAnswer);
    assert.equal(turns[1].q, "q2");
    assert.ok(turns[1].a);
    assert.ok(turns[1].a.directAnswer.startsWith("Bilkul sahi"));
  });
  check("fallback display text never shows raw JSON", () => {
    const shown = displayRawText(ernieReply);
    assert.ok(shown.startsWith("Bilkul sahi"));
    assert.ok(!shown.includes("direct_answer"));
    assert.ok(!shown.includes("{"));
    assert.equal(displayRawText("plain prose, no JSON"), "plain prose, no JSON");
  });
}

// (d) Gemini path unchanged
resetMock();
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "gemini", geminiKey: null, ownerId: "test-owner" },
  );
  check("Gemini with no key → Gemini fallback", () => {
    assert.equal(requests.length, 0);
    assert.ok(res.directAnswer.includes("Gemini"));
  });
}
resetMock();
mockHandler = (url) => {
  assert.ok(url.startsWith("https://generativelanguage.googleapis.com/"));
  return jsonResponse(200, geminiOk(JSON.stringify(cannedCfo)));
};
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "gemini", geminiKey: "AIzaTESTKEY", ownerId: "test-owner" },
  );
  check("mocked Gemini success still parses", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
  });
}

// (e) settings defaults from a row (no DB needed)
check("aiExtrasFromRow(null) defaults to gemini + free model", () => {
  const s = aiExtrasFromRow(null, "o1");
  assert.equal(s.provider, "gemini");
  assert.equal(s.openRouterModel, "google/gemma-4-31b-it:free");
  assert.equal(s.geminiKey, null);
  assert.equal(s.openRouterKey, null);
});
check("aiExtrasFromRow(openrouter row) honours provider + model", () => {
  const s = aiExtrasFromRow(
    {
      aiProvider: "openrouter",
      geminiApiKey: null,
      openRouterApiKey: "sk-or-v1-ROWKEY",
      openRouterModel: "openrouter/free",
    },
    "o1",
  );
  assert.equal(s.provider, "openrouter");
  assert.equal(s.openRouterModel, "openrouter/free");
  assert.equal(s.openRouterKey, "sk-or-v1-ROWKEY");
});

// (c) leak audit: the sentinel key appears ONLY in the Authorization header
{
  const haystack = resultsDump.join("\n") + "\n" + consoleOutput.join("\n");
  check("saved key never appears in results, logs, or errors", () => {
    assert.ok(!haystack.includes(SENTINEL_KEY));
  });
  const authHeaders = requests
    .map((r) => r.init.headers?.Authorization)
    .filter(Boolean);
  check("key was sent exactly once per call, only as Bearer", () => {
    assert.ok(authHeaders.every((h) => h === `Bearer ${SENTINEL_KEY}` || h === "Bearer sk-or-v1-ENVKEY-0000"));
  });
}

globalThis.fetch = realFetch;
console.warn = origWarn;
console.error = origError;
console.log(`\nOpenRouter harness: ${passed}/${passed} passed.`);
