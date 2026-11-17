// CFO conversation history helpers — Cashflow Genius AI CFO.
//
// These live in a plain .ts module (no JSX) so the history logic can be
// unit-tested in the node harness. Two live bugs fixed here (2026-11-17):
//
//  (1) Raw JSON in the answer: a free-text answer whose directAnswer is
//      itself a JSON object ({"direct_answer": ..., "key_numbers": ...})
//      used to render verbatim. parseStoredAnswer unwraps that JSON
//      into structured fields, so an already-stored answer renders as
//      a clean answer card, exactly like a structured one.
//  (2) History showing only the question: the user and assistant rows
//      of one turn are inserted in a single statement, so they share
//      one created_at; ordering by created_at can tie and return the
//      assistant row before its question, which the old positional
//      pairing (assistant must follow its question) dropped. buildTurns
//      pairs by role instead of position, so a flipped pair still
//      renders as one turn with its answer.

export type CfoHistoryAnswer = {
  directAnswer: string;
  numbers: { label: string; value: string }[];
  explanation: string;
  supportingData: string[];
  options: string[];
  assumptions: string;
  sources: string[];
  language: string;
};

export type CfoHistoryMessage = { role: string; content: string };

export type CfoHistoryTurn = {
  q: string;
  a: CfoHistoryAnswer | null;
  raw?: string;
};

function stripFences(text: string): string {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

/** Repair the two ways free models most often break otherwise-valid
 *  JSON: trailing commas before } or ], and raw newlines/tabs inside
 *  string values. */
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

function tryParseJson(text: string): unknown | undefined {
  const stripped = stripFences(text);
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

function toCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const KEY_ALIASES: Record<string, string> = {
  keyNumbers: "numbers",
  keyPoints: "points",
  keyFigures: "numbers",
};

function normalizeNumberItem(
  item: unknown,
): { label: string; value: string } | null {
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

function normalizeAnswerShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAnswerShape);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const camel = toCamelKey(k);
      const mapped = KEY_ALIASES[camel] ?? camel;
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

/** Pull the value of a named string field out of text that looks like
 *  JSON but would not parse. Handles backslash escapes; null when the
 *  field is not there. */
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

/** Last resort for JSON-looking text that yielded nothing else: join
 *  every string value in the object, so the user sees prose, never
 *  raw JSON syntax. */
function extractAllJsonStrings(text: string): string {
  const values: string[] = [];
  const re = /"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? "";
    try {
      const decoded = JSON.parse(`"${raw}"`);
      if (typeof decoded === "string" && decoded.trim()) values.push(decoded.trim());
    } catch {
      if (raw.trim()) values.push(raw.trim());
    }
  }
  return values.join(" ");
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? (v as unknown[]).filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      )
    : [];

const asNumberArray = (
  v: unknown,
): { label: string; value: string }[] =>
  Array.isArray(v)
    ? (v as unknown[])
        .map(normalizeNumberItem)
        .filter((n): n is { label: string; value: string } => n !== null)
    : [];

/** Parse one stored assistant message back into a renderable answer.
 *  The stored content is JSON.stringify(answer); older free-text
 *  answers carry the model's raw JSON inside directAnswer, which is
 *  unwrapped here into structured fields. Returns null only when the
 *  content is not a parseable stored answer at all. */
export function parseStoredAnswer(content: string): CfoHistoryAnswer | null {
  let outer: unknown;
  try {
    outer = JSON.parse(content);
  } catch {
    return null;
  }
  if (!outer || typeof outer !== "object") return null;
  const o = outer as Record<string, unknown>;
  if (typeof o.directAnswer !== "string") return null;
  let direct = o.directAnswer;
  let numbers = asNumberArray(o.numbers);
  let explanation = typeof o.explanation === "string" ? o.explanation : "";
  let supportingData = asStringArray(o.supportingData);
  let options = asStringArray(o.options);
  let assumptions = typeof o.assumptions === "string" ? o.assumptions : "";
  const sources = asStringArray(o.sources);
  const language = typeof o.language === "string" ? o.language : "en";
  // JSON-in-JSON: unwrap a raw model reply stored inside directAnswer.
  const trimmed = direct.trim();
  if (trimmed.startsWith("{")) {
    const inner = tryParseJson(trimmed);
    if (inner !== undefined) {
      const norm = normalizeAnswerShape(inner) as Record<string, unknown>;
      if (typeof norm.directAnswer === "string" && norm.directAnswer.trim()) {
        direct = norm.directAnswer.trim();
        if (Array.isArray(norm.numbers)) numbers = asNumberArray(norm.numbers);
        if (typeof norm.explanation === "string" && norm.explanation) {
          explanation = norm.explanation;
        }
        if (Array.isArray(norm.supportingData)) {
          supportingData = asStringArray(norm.supportingData);
        }
        if (Array.isArray(norm.options)) options = asStringArray(norm.options);
        if (typeof norm.assumptions === "string" && norm.assumptions) {
          assumptions = norm.assumptions;
        }
      } else {
        const salvaged = extractJsonStringField(trimmed, [
          "direct_answer",
          "directAnswer",
        ]);
        if (salvaged) direct = salvaged;
      }
    } else {
      const salvaged = extractJsonStringField(trimmed, [
        "direct_answer",
        "directAnswer",
      ]);
      if (salvaged) direct = salvaged;
    }
  }
  // Final guard: after every unwrap attempt, a direct answer that is
  // still raw JSON must not render. Join its string values as prose;
  // if even that yields nothing, return null so the caller shows the
  // cleaned fallback text instead of raw JSON.
  if (direct.trim().startsWith("{")) {
    const joined = extractAllJsonStrings(direct);
    if (joined) {
      direct = joined;
    } else {
      return null;
    }
  }
  return {
    directAnswer: direct,
    numbers,
    explanation,
    supportingData,
    options,
    assumptions,
    sources,
    language,
  };
}

/** Plain-text display for a stored answer that could not be parsed
 *  into a structured card. JSON-looking text is unwrapped to its
 *  prose first — raw JSON is never shown to the user. */
export function displayRawText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  const parsed = tryParseJson(trimmed);
  if (parsed !== undefined) {
    const norm = normalizeAnswerShape(parsed) as Record<string, unknown>;
    if (typeof norm.directAnswer === "string" && norm.directAnswer.trim()) {
      return norm.directAnswer.trim();
    }
  }
  const salvaged = extractJsonStringField(trimmed, [
    "direct_answer",
    "directAnswer",
  ]);
  if (salvaged) return salvaged;
  const joined = extractAllJsonStrings(trimmed);
  return joined || raw;
}

/** Pair a conversation's messages into turns, by role rather than by
 *  position. An assistant message attaches to the most recent turn
 *  still missing an answer; when it arrives BEFORE its question (the
 *  two rows of one turn share a created_at, so ordering can tie), it
 *  is held and attached to the next user message instead. A judge
 *  re-opening a past conversation therefore always sees its answer,
 *  whichever order the rows came back in. */
export function buildTurns(messages: CfoHistoryMessage[]): CfoHistoryTurn[] {
  const turns: CfoHistoryTurn[] = [];
  let pendingAnswer: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      const turn: CfoHistoryTurn = { q: m.content, a: null };
      if (pendingAnswer !== null) {
        turn.a = parseStoredAnswer(pendingAnswer);
        turn.raw = pendingAnswer;
        pendingAnswer = null;
      }
      turns.push(turn);
    } else if (m.role === "assistant") {
      const open = [...turns]
        .reverse()
        .find((t) => t.a === null && t.raw === undefined);
      if (open) {
        open.a = parseStoredAnswer(m.content);
        open.raw = m.content;
      } else {
        pendingAnswer = m.content;
      }
    }
  }
  return turns;
}
