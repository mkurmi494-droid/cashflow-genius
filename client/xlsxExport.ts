// Excel (.xlsx) export for the Money Flow transaction list.
//
// Why two libraries: SheetJS community edition (xlsx) builds the workbook —
// real Excel date cells, number formats and column widths — but it cannot
// write cell styles (fills/fonts are a SheetJS Pro feature), so the fills
// it is asked for are silently dropped. The generated file is therefore
// post-processed with fflate: unzip it, replace xl/styles.xml with one
// carrying the green/red fills and a bold header font, rewrite every cell's
// style index in the sheet XML, and zip it back up. The result is a real
// .xlsx that opens in Excel with coloured rows and a date column wide
// enough to show the date (the CSV's "####" was Excel showing a column
// too narrow for the date, not a missing value).
//
// Both libraries are loaded with dynamic import inside txnsToXlsx so the
// ~400 KB of export code is fetched only when the user actually exports;
// the main bundle is untouched.

import type { Txn } from "./lib";

const HEADERS = ["date", "type", "status", "category", "description", "counterparty", "amount", "payment_method"];

// Column widths in characters (SheetJS adds its own ~0.83 padding on top).
// The date column fits "yyyy-mm-dd" (10 chars) with room to spare.
const COLUMN_WIDTHS = [13, 10, 10, 18, 32, 18, 14, 14];

const INCOME_FILL_RGB = "C6EFCE"; // soft green, Excel's standard "good" fill
const EXPENSE_FILL_RGB = "FFC7CE"; // soft red, Excel's standard "bad" fill

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Excel serial for a yyyy-mm-dd date (days since 1899-12-30), computed in
// UTC so the value is an exact integer in every timezone. Passing a JS Date
// lets SheetJS convert via local midnight, which in zones like
// Asia/Calcutta leaves a ~10s residue (the 1899 basedate's historical UTC
// offset had sub-minute seconds) — invisible under a date-only format, but
// not exact, and it made the harness fail 4/115 in IST. A plain number with
// the yyyy-mm-dd format is still a real date cell in Excel.
const dateSerial = (dateStr: string): number | null => {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return Math.round((Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!) - Date.UTC(1899, 11, 30)) / 86400000);
};

// Style (xf) indices in the styles.xml below:
// 0 default · 1 date · 2 header (bold) · 3 income · 4 expense ·
// 5 income + date · 6 expense + date · 7 income + amount (0.00) ·
// 8 expense + amount (0.00)
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${INCOME_FILL_RGB}"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="${EXPENSE_FILL_RGB}"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/></styleSheet>`;

/** Rewrite every cell's style index in one sheet's XML: bold header row,
 *  green fills on income rows, red fills on expense rows; the date column
 *  (A) keeps its yyyy-mm-dd format and the amount column (G) its 0.00. */
function applyRowStyles(sheetXml: string, isIncomeRow: (row: number) => boolean): string {
  return sheetXml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g, (_m, col: string, rowStr: string, attrs: string) => {
    const row = Number(rowStr);
    let s: number;
    if (row === 1) s = 2;
    else if (col === "A") s = isIncomeRow(row) ? 5 : 6;
    else if (col === "G") s = isIncomeRow(row) ? 7 : 8;
    else s = isIncomeRow(row) ? 3 : 4;
    const cleanAttrs = attrs.replace(/\s+s="\d+"/, "");
    return `<c r="${col}${row}"${cleanAttrs} s="${s}">`;
  });
}

/** Build a real .xlsx workbook from the transactions: same 8 columns as
 *  the CSV, dates as real Excel date cells, amounts as real numbers,
 *  income rows green and expense rows red. */
export async function txnsToXlsx(txns: Txn[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");

  const rows: unknown[][] = [HEADERS];
  for (const t of txns) {
    const serial = dateSerial(t.date);
    const dateCell =
      serial === null ? { v: t.date, t: "s" } : { v: serial, t: "n", z: "yyyy-mm-dd" };
    rows.push([
      dateCell,
      t.type,
      t.status,
      t.category,
      t.description,
      t.counterparty,
      { v: t.amountCents / 100, t: "n", z: "0.00" },
      t.paymentMethod ?? "",
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = COLUMN_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transactions");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

  // SheetJS CE wrote the dates/widths/number formats but dropped the fills,
  // so inject the styles by hand: replace styles.xml, rewrite cell styles.
  const files = unzipSync(bytes);
  const sheetPath = Object.keys(files).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetPath) throw new Error("xlsx export: no worksheet found in the generated file");
  const isIncomeRow = (row: number) => txns[row - 2]?.type === "income";
  files["xl/styles.xml"] = strToU8(STYLES_XML);
  files[sheetPath] = strToU8(applyRowStyles(strFromU8(files[sheetPath]!), isIncomeRow));

  return new Blob([zipSync(files)], { type: XLSX_MIME });
}

/** Download a Blob as a file, mirroring downloadFile in lib.ts. */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
