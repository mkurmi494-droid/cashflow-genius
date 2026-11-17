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
//      (markAiVerified is best-effort and never blocks the answer).
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

const { aiComplete, aiExtrasFromRow, DEFAULT_OPENROUTER_MODEL } = await import(bundle);

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
