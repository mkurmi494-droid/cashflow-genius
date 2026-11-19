// Excel-export tests for client/xlsxExport.ts.
// Builds a workbook from fixture transactions (2 income + 2 expense,
// one row with an empty description/counterparty) and asserts, by
// unzipping the .xlsx and reading its XML:
//   (1) date cells are real Excel date serials with the yyyy-mm-dd format,
//   (2) income rows carry the green fill (C6EFCE), expense rows the red
//       fill (FFC7CE), header row is bold,
//   (3) the date column width is set wide enough for the date,
//   (4) amounts are real numbers with a 0.00 format.
// Then, if python3 + openpyxl is available, the same file is opened with
// openpyxl and the values/fills are confirmed independently of the XML
// parsing above; otherwise that section is skipped with a plain message.
// Run: node scripts/xlsx-export-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fflate = require("fflate");
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// Transpiled output must live INSIDE the repo: the module's dynamic
// import("xlsx") / import("fflate") resolves against its own location,
// so a /tmp dir would not find node_modules.
const out = join(repo, "scripts", ".xlsx-test-tmp");
mkdirSync(out, { recursive: true });

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
};

// Excel serial for a yyyy-mm-dd date (days since 1899-12-30).
const serial = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
};

const fixtures = [
  { id: "1", date: "2026-11-19", type: "income", status: "posted", category: "Salary", description: "November salary", counterparty: "Acme Ltd", amountCents: 780546800, paymentMethod: "UPI" },
  { id: "2", date: "2026-11-15", type: "expense", status: "posted", category: "Food & groceries", description: "Weekly shop", counterparty: "Kirana Store", amountCents: 1080700, paymentMethod: "UPI" },
  { id: "3", date: "2026-11-14", type: "income", status: "posted", category: "Other income", description: "", counterparty: "", amountCents: 17000000, paymentMethod: "Cash" },
  { id: "4", date: "2026-11-14", type: "expense", status: "posted", category: "Food & groceries", description: "Chai", counterparty: "Tea stall", amountCents: 10000, paymentMethod: "UPI" },
];

try {
  // Transpile the TS module into the repo (so its dynamic import("xlsx") /
  // import("fflate") resolve against the repo's node_modules) and load it.
  const src = readFileSync(join(repo, "client", "xlsxExport.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: "xlsxExport.ts",
  }).outputText;
  writeFileSync(join(out, "xlsxExport.cjs"), js);
  const { txnsToXlsx } = require(join(out, "xlsxExport.cjs"));

  const blob = await txnsToXlsx(fixtures);
  check("returns a Blob", blob instanceof Blob, true);
  check("blob MIME type", blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  check("xlsx is non-empty", bytes.length > 1000, true);
  const xlsxPath = join(out, "cashflow-transactions.xlsx");
  writeFileSync(xlsxPath, bytes);

  // ---- XML assertions ----
  const files = fflate.unzipSync(bytes);
  const sheetName = Object.keys(files).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  check("worksheet present", typeof sheetName, "string");
  const sheetXml = fflate.strFromU8(files[sheetName]);
  const stylesXml = fflate.strFromU8(files["xl/styles.xml"]);
  check("styles.xml present", typeof files["xl/styles.xml"] !== "undefined", true);

  // Parse fills, fonts and cellXfs out of styles.xml. NOTE: only the
  // <cellXfs> block is parsed — the <cellStyleXfs> block also contains
  // <xf> elements, and including it would shift every index by one.
  const fillBlocks = stylesXml.split("<fill>").slice(1).map((b) => b.split("</fill>")[0]);
  const greenIdx = fillBlocks.findIndex((b) => b.includes("C6EFCE"));
  const redIdx = fillBlocks.findIndex((b) => b.includes("FFC7CE"));
  check("green fill C6EFCE in styles", greenIdx >= 2, true);
  check("red fill FFC7CE in styles", redIdx >= 2, true);
  check("yyyy-mm-dd number format in styles", stylesXml.includes('formatCode="yyyy-mm-dd"'), true);
  const cellXfsBlock = /<cellXfs count="\d+">(.*?)<\/cellXfs>/s.exec(stylesXml)?.[1] ?? "";
  const xfFillIds = [...cellXfsBlock.matchAll(/<xf [^>]*fillId="(\d+)"[^>]*>/g)].map((m) => Number(m[1]));
  const xfNumFmtIds = [...cellXfsBlock.matchAll(/<xf numFmtId="(\d+)"[^>]*>/g)].map((m) => Number(m[1]));
  const xfFontIds = [...cellXfsBlock.matchAll(/<xf [^>]*fontId="(\d+)"[^>]*>/g)].map((m) => Number(m[1]));
  check("cellXfs has 9 entries", xfFillIds.length, 9);
  const fontsBlock = /<fonts count="\d+">(.*?)<\/fonts>/s.exec(stylesXml)?.[1] ?? "";
  const fontIsBold = fontsBlock.split("<font>").slice(1).map((b) => b.split("</font>")[0].includes("<b/>"));
  check("font 1 is bold", fontIsBold[1], true);

  // Cell lookup: map "A2" -> { attrs, value }.
  const cells = {};
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(?:<v>([^<]*)<\/v>)?/g)) {
    const s = / s="(\d+)"/.exec(m[2]);
    cells[m[1]] = { s: s ? Number(s[1]) : 0, v: m[3] ?? null, attrs: m[2] };
  }
  const cellFill = (ref) => {
    const s = cells[ref]?.s ?? 0;
    return xfFillIds[s];
  };
  const cellNumFmt = (ref) => {
    const s = cells[ref]?.s ?? 0;
    return xfNumFmtIds[s];
  };

  // Header row: bold font (fontId 1) on every header cell.
  for (const col of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    const s = cells[`${col}1`]?.s ?? 0;
    check(`header ${col}1 is bold`, fontIsBold[xfFontIds[s] ?? 0], true);
  }

  // Date cells are real serials with the yyyy-mm-dd format (numFmtId 164).
  for (let i = 0; i < fixtures.length; i++) {
    const row = i + 2;
    check(`row ${row} date is a real serial`, Number(cells[`A${row}`]?.v), serial(fixtures[i].date));
    check(`row ${row} date has yyyy-mm-dd format`, cellNumFmt(`A${row}`), 164);
  }

  // Amounts are real numbers with a 0.00 format (built-in numFmtId 2).
  for (let i = 0; i < fixtures.length; i++) {
    const row = i + 2;
    check(`row ${row} amount is a number`, Number(cells[`G${row}`]?.v), fixtures[i].amountCents / 100);
    check(`row ${row} amount has 0.00 format`, cellNumFmt(`G${row}`), 2);
  }

  // Row fills: income green on every cell, expense red on every cell.
  for (let i = 0; i < fixtures.length; i++) {
    const row = i + 2;
    const want = fixtures[i].type === "income" ? greenIdx : redIdx;
    for (const col of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      check(`row ${row} (${fixtures[i].type}) ${col} fill`, cellFill(`${col}${row}`), want);
    }
  }

  // Date column width is set and fits the date.
  const colAMatch = /<col min="1" max="1" width="([\d.]+)"/.exec(sheetXml);
  check("date column width present", colAMatch !== null, true);
  check("date column width >= 13", colAMatch ? Number(colAMatch[1]) >= 13 : false, true);

  // ---- openpyxl cross-check (independent of the XML parsing above) ----
  let haveOpenpyxl = false;
  try {
    execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" });
    haveOpenpyxl = true;
  } catch {
    skipped++;
    console.log("SKIP  openpyxl cross-check — python3/openpyxl not available");
  }
  if (haveOpenpyxl) {
    const py = `
import json, openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(xlsxPath)})
ws = wb.active
out = {"headers": [c.value for c in ws[1]], "widths": {k: v.width for k, v in ws.column_dimensions.items()}, "rows": []}
for row in ws.iter_rows(min_row=2, max_row=5):
    out["rows"].append([{"value": (c.value.strftime("%Y-%m-%d") if hasattr(c.value, "strftime") else c.value), "fmt": c.number_format, "fill": (c.fill.fgColor.rgb if c.fill and c.fill.patternType == "solid" else None), "bold": bool(c.font and c.font.b)} for c in row])
print(json.dumps(out))
`;
    const pyPath = join(out, "check.py");
    writeFileSync(pyPath, py);
    const result = JSON.parse(execFileSync("python3", [pyPath], { encoding: "utf8" }));
    check("openpyxl headers", JSON.stringify(result.headers), JSON.stringify(["date", "type", "status", "category", "description", "counterparty", "amount", "payment_method"]));
    check("openpyxl date column width >= 13", (result.widths.A ?? 0) >= 13, true);
    for (let i = 0; i < fixtures.length; i++) {
      const r = result.rows[i];
      check(`openpyxl row ${i + 2} date value`, r[0].value, fixtures[i].date);
      check(`openpyxl row ${i + 2} date format`, r[0].fmt, "yyyy-mm-dd");
      check(`openpyxl row ${i + 2} amount value`, r[6].value, fixtures[i].amountCents / 100);
      const wantFill = fixtures[i].type === "income" ? "C6EFCE" : "FFC7CE";
      for (let c = 0; c < 8; c++) {
        check(`openpyxl row ${i + 2} (${fixtures[i].type}) col ${c + 1} fill`, (r[c].fill ?? "").endsWith(wantFill), true);
      }
    }
    const wb2 = JSON.parse(execFileSync("python3", ["-c", `
import json, openpyxl
ws = openpyxl.load_workbook(${JSON.stringify(xlsxPath)}).active
print(json.dumps([bool(c.font.b) for c in ws[1]]))
`], { encoding: "utf8" }));
    check("openpyxl header cells bold", JSON.stringify(wb2), JSON.stringify([true, true, true, true, true, true, true, true]));
  }
} catch (e) {
  fail++;
  console.log(`FAIL  harness threw — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
