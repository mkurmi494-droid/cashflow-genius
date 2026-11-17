// OpenAI (ChatGPT) provider harness — Cashflow Genius AI CFO.
//
// Proves, against a local mock of the OpenAI endpoint (global
// fetch is replaced in-process; no network, no real key, no DB):
//  (a) the OpenAI request shape — endpoint, Authorization Bearer
//      header, model, messages, response_format;
//  (b) the rule-based fallback when the provider errors (401 bad key,
//      429 insufficient credits), and when no key is configured
//      (fetch never called); the fallback names OpenAI, never Gemini
//      or OpenRouter;
//  (c) a 429 is NOT retried — one attempt only, no fallback chain;
//  (d) images travel as data-URL image parts (gpt-4o-mini takes
//      image input, so vision calls need no model skipping);
//  (e) the success path still answers when the database is
//      unreachable (markAiVerified is best-effort and never blocks
//      the answer);
//  (f) tolerant parsing — JSON in markdown fences and a reasoning-
//      only reply both still parse to a structured answer;
//  (g) aiExtrasFromRow maps the OpenAI fields (provider, key, model,
//      defaults) and asAiProvider accepts "openai";
//  (h) a string schema returns raw text; the Gemini path is unchanged
//      (no key → Gemini fallback).
//
// Usage: node scripts/openai-test.mjs
// Exit 0 = all pass. No key used here is real: the sentinel key is a
// fake string that exists only inside this process.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SENTINEL_KEY = "<redacted>";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

// Dummy local DATABASE_URL: markAiVerified's update then fails fast
// with ECONNREFUSED and must be swallowed, never blocking the answer.
process.env.DATABASE_URL = "postgresql://cgtest:cgtest@127.0.0.1:1/postgres";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;

// ---- bundle server/lib/ai.ts with the repo's esbuild (no tsx needed) ----
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "oa-test-"));
const bundle = join(outDir, "ai.mjs");
execSync(
  `node_modules/.bin/esbuild server/lib/ai.ts --bundle --platform=node --format=esm --outfile=${bundle}`,
  { cwd: repoRoot, stdio: "pipe" },
);

// ---- local mock of the provider endpoints ----
const requests = [];
const allRequests = [];
let mockHandler = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  allRequests.push({ url: String(url), init });
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

const { aiComplete, aiExtrasFromRow, asAiProvider, DEFAULT_OPENAI_MODEL } =
  await import(bundle);

const cfoSchema = z.object({
  directAnswer: z.string(),
  numbers: z.array(z.object({ label: z.string(), value: z.string() })),
  explanation: z.string(),
  supportingData: z.array(z.string()),
  options: z.array(z.string()),
  assumptions: z.string(),
});
const cannedCfo = {
  directAnswer: "Mocked ChatGPT answer: cash is fine.",
  numbers: [{ label: "Available cash", value: "₹3,440" }],
  explanation: "Mocked explanation.",
  supportingData: ["Available cash ₹3,440"],
  options: ["Mocked option."],
  assumptions: "Mocked assumptions.",
};
const openAiOk = (content) => ({
  choices: [{ message: { role: "assistant", content } }],
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

console.log("OpenAI provider harness");

const openAiSettings = {
  provider: "openai",
  openAiKey: SENTINEL_KEY,
  openAiModel: DEFAULT_MODEL,
  ownerId: "test-owner",
};

// (a) request shape, default model, JSON response_format, parsed result
resetMock();
mockHandler = () => jsonResponse(200, openAiOk(JSON.stringify(cannedCfo)));
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    openAiSettings,
  );
  resultsDump.push(JSON.stringify(res));
  check("OpenAI happy path returns parsed schema answer", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
    assert.equal(res.numbers[0].value, "₹3,440");
  });
  check("request hits the OpenAI chat-completions endpoint", () => {
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, OPENAI_URL);
    assert.equal(requests[0].init.method, "POST");
  });
  check("Authorization Bearer carries the key; key nowhere else in the request", () => {
    const headers = requests[0].init.headers;
    assert.equal(headers.Authorization, `Bearer ${SENTINEL_KEY}`);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["HTTP-Referer"], undefined);
    assert.equal(headers["X-Title"], undefined);
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
mockHandler = () => jsonResponse(200, openAiOk(JSON.stringify(cannedCfo)));
{
  await aiComplete(
    "Read this screenshot.",
    {
      schema: cfoSchema,
      images: [{ dataBase64: "aGVsbG8=", mimeType: "image/jpeg" }],
    },
    openAiSettings,
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

// (b) 401 bad key → fallback naming OpenAI
resetMock();
mockHandler = () =>
  jsonResponse(401, { error: { code: "invalid_api_key", message: "Incorrect API key provided (mocked)" } });
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    openAiSettings,
  );
  resultsDump.push(JSON.stringify(res));
  check("401 from OpenAI falls back and names OpenAI", () => {
    assert.ok(res.directAnswer.includes("OpenAI"));
    assert.ok(res.directAnswer.includes("not an AI analysis"));
    assert.ok(!res.directAnswer.includes("Gemini"));
    assert.ok(!res.directAnswer.includes("OpenRouter"));
  });
  check("error body is logged with the status, never the key", () => {
    const warn = consoleOutput.join("\n");
    assert.ok(warn.includes("401"));
    assert.ok(!warn.includes(SENTINEL_KEY));
  });
  check("401 is a single attempt — no retry, no chain", () => {
    assert.equal(requests.length, 1);
  });
}

// (b2) no key configured → fallback without any fetch
resetMock();
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "openai", openAiKey: null, ownerId: "test-owner" },
  );
  resultsDump.push(JSON.stringify(res));
  check("no OpenAI key → fallback, fetch never called", () => {
    assert.equal(requests.length, 0);
    assert.ok(res.directAnswer.includes("OpenAI"));
  });
}

// (c) 429 insufficient credits → fallback, exactly one request
resetMock();
mockHandler = () =>
  jsonResponse(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota (mocked)" } });
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    openAiSettings,
  );
  resultsDump.push(JSON.stringify(res));
  check("429 insufficient_quota falls back and is not retried", () => {
    assert.equal(requests.length, 1);
    assert.ok(res.directAnswer.includes("OpenAI"));
    assert.ok(res.explanation.includes("insufficient credits"));
  });
}

// (e) success still answers when the database is unreachable
// (the dummy DATABASE_URL above makes markAiVerified fail fast;
// the answer must still come back — verified by the happy-path
// checks above, which already ran against the same dummy DB.)
check("success path answers despite unreachable database (happy path above)", () => {
  assert.ok(resultsDump.some((r) => r.includes("Mocked ChatGPT answer")));
});

// (f) tolerant parsing — fenced JSON and reasoning-only replies
resetMock();
mockHandler = () =>
  jsonResponse(200, openAiOk("```json\n" + JSON.stringify(cannedCfo) + "\n```"));
{
  const res = await aiComplete("How is my cashflow?", { schema: cfoSchema }, openAiSettings);
  resultsDump.push(JSON.stringify(res));
  check("JSON wrapped in markdown fences still parses", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
  });
}
resetMock();
mockHandler = () =>
  jsonResponse(200, {
    choices: [
      { message: { role: "assistant", content: "", reasoning_content: JSON.stringify(cannedCfo) } },
    ],
  });
{
  const res = await aiComplete("How is my cashflow?", { schema: cfoSchema }, openAiSettings);
  resultsDump.push(JSON.stringify(res));
  check("reasoning-only reply still parses to a structured answer", () => {
    assert.equal(res.directAnswer, cannedCfo.directAnswer);
  });
}
// Live regression 2026-11-17: gpt-4o-mini answered three real questions
// but named the answer field "answer" instead of "direct_answer", with
// key_numbers as a map of INR strings — all three were thrown away to
// the rule-based fallback with { code: 'parse' }. The answer must survive.
resetMock();
mockHandler = () =>
  jsonResponse(
    200,
    openAiOk(
      JSON.stringify({
        answer: "Yes, everything is fine.",
        key_numbers: {
          available_cash: "INR 2,00,00,000",
          total_revenue: "INR 44,74,94,859",
        },
        explanation: "Your cash covers your dues.",
        supporting_data: ["Cash INR 2,00,00,000"],
        suggested_options: ["Check the dashboard."],
        assumptions_and_limitations: "Answered by gpt-4o-mini.",
      }),
    ),
  );
{
  const res = await aiComplete("r u okay", { schema: cfoSchema }, openAiSettings);
  resultsDump.push(JSON.stringify(res));
  check("answer field named 'answer' + key_numbers map still parses", () => {
    assert.equal(res.directAnswer, "Yes, everything is fine.");
    assert.equal(res.numbers[0].label, "availableCash");
    assert.equal(res.numbers[0].value, "INR 2,00,00,000");
  });
}

// (g) aiExtrasFromRow maps the OpenAI fields
{
  const s = aiExtrasFromRow(
    {
      aiProvider: "openai",
      geminiApiKey: null,
      openRouterApiKey: null,
      openRouterModel: null,
      openAiApiKey: SENTINEL_KEY,
      openAiModel: "gpt-4o",
    },
    "o1",
  );
  check("aiExtrasFromRow maps provider/key/model for OpenAI", () => {
    assert.equal(s.provider, "openai");
    assert.equal(s.openAiKey, SENTINEL_KEY);
    assert.equal(s.openAiModel, "gpt-4o");
  });
  const d = aiExtrasFromRow(
    { aiProvider: "openai", geminiApiKey: null, openRouterApiKey: null, openRouterModel: null, openAiApiKey: SENTINEL_KEY, openAiModel: null },
    "o1",
  );
  check("OpenAI model defaults to gpt-4o-mini when unset", () => {
    assert.equal(d.openAiModel, "gpt-4o-mini");
    assert.equal(DEFAULT_OPENAI_MODEL, "gpt-4o-mini");
  });
  check("asAiProvider accepts openai, gemini stays the default", () => {
    assert.equal(asAiProvider("openai"), "openai");
    assert.equal(asAiProvider("openrouter"), "openrouter");
    assert.equal(asAiProvider("bogus"), "gemini");
    assert.equal(asAiProvider(null), "gemini");
  });
}

// (h) string schema returns raw text; Gemini path unchanged
resetMock();
mockHandler = () => jsonResponse(200, openAiOk("plain text answer"));
{
  const res = await aiComplete(
    "Say hello.",
    { schema: z.string() },
    openAiSettings,
  );
  check("string schema returns the raw text, no json_object format", () => {
    assert.equal(res, "plain text answer");
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.response_format, undefined);
  });
}
resetMock();
{
  const res = await aiComplete(
    "How is my cashflow this month?",
    { schema: cfoSchema },
    { provider: "gemini", geminiKey: null, ownerId: "test-owner" },
  );
  check("Gemini path unchanged: no key → Gemini fallback, no fetch", () => {
    assert.equal(requests.length, 0);
    assert.ok(res.directAnswer.includes("Gemini"));
  });
}

// (i) state-row batch selects carry the OpenAI columns — regression
// guard for the live bug found 2026-11-17: loadWorkspacePrelude and
// loadCombinedBatch select the state row column-by-column, and the
// OpenAI columns were missing, so getState (Settings key section,
// CFO page status) and getBriefing (dashboard daily briefing) saw
// no OpenAI key even though the CFO itself worked (askCfo reads the
// full row). Both selects must list both columns.
{
  const { readFileSync } = await import("node:fs");
  const batchSrc = readFileSync(join(repoRoot, "server/lib/batch.ts"), "utf8");
  const keyCols = (batchSrc.match(/openai_api_key as "openAiApiKey"/g) ?? []).length;
  const modelCols = (batchSrc.match(/openai_model as "openAiModel"/g) ?? []).length;
  check("both batch state selects list openai_api_key and openai_model", () => {
    assert.equal(keyCols, 2);
    assert.equal(modelCols, 2);
  });
}

// (c) leak audit: the sentinel key appears ONLY in the Authorization header
{
  const haystack = resultsDump.join("\n") + "\n" + consoleOutput.join("\n");
  check("saved key never appears in results, logs, or errors", () => {
    assert.ok(!haystack.includes(SENTINEL_KEY));
  });
  const authHeaders = allRequests
    .map((r) => r.init.headers?.Authorization)
    .filter(Boolean);
  check("key was sent only as Bearer, never in URL or body", () => {
    assert.ok(authHeaders.length > 0);
    assert.ok(authHeaders.every((h) => h === `Bearer ${SENTINEL_KEY}`));
    for (const r of allRequests) {
      assert.ok(!r.url.includes(SENTINEL_KEY));
      assert.ok(!String(r.init.body ?? "").includes(SENTINEL_KEY));
    }
  });
}

globalThis.fetch = realFetch;
console.warn = origWarn;
console.error = origError;
console.log(`\nOpenAI harness: ${passed}/${passed} passed.`);
