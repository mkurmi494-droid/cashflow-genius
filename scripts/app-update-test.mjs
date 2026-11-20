// In-app update-check tests for client/appVersion.ts (pure).
// Proves: (1) the same version is not an update, (2) a different
// version is, (3) no answer from the server is not an update,
// (4) a "local" server answer is not an update, (5) a "local"
// running build never reports an update, (6) empty versions never
// report an update.
// Run: node scripts/app-update-test.mjs   (exit 1 on any failure)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = join(fileURLToPath(import.meta.url), "..", "..");
const out = mkdtempSync(join(tmpdir(), "app-update-test-"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
};

const src = readFileSync(join(repo, "client/appVersion.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modPath = join(out, "appVersion.mjs");
writeFileSync(modPath, js);
const mod = await import(modPath);
rmSync(out, { recursive: true, force: true });

check("same version is not an update", mod.isUpdateAvailable("abc1234", "abc1234"), false);
check("different version is an update", mod.isUpdateAvailable("abc1234", "def5678"), true);
check("no server answer is not an update", mod.isUpdateAvailable("abc1234", null), false);
check('"local" server answer is not an update', mod.isUpdateAvailable("abc1234", "local"), false);
check('"local" running build never updates', mod.isUpdateAvailable("local", "def5678"), false);
check("empty running version never updates", mod.isUpdateAvailable("", "def5678"), false);
check("empty server version never updates", mod.isUpdateAvailable("abc1234", ""), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
