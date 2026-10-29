#!/usr/bin/env node
// test.mjs — end-to-end checks for the nle-embed prototype.
//
// Everything here goes through the compiled binary: no mocking, no direct
// NaturalLanguage bindings. The point is to observe what a caller would see.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "bin", "nle-embed");

// A related/unrelated separation below this is treated as a broken embedder.
const MARGIN = 0.05;

const groups = [
  {
    name: "cats",
    base: "The cat sat on the mat",
    related: "A kitten is resting on the rug",
    unrelated: "The stock market crashed today",
  },
  {
    name: "deploy",
    base: "We deployed the new build to production last night",
    related: "The release was shipped to the live servers yesterday",
    unrelated: "My grandmother bakes excellent apple pies",
  },
  {
    name: "errors",
    base: "The compiler reported a type error in the parser module",
    related: "A type mismatch in the parser caused the build to fail",
    unrelated: "The restaurant on the corner serves fresh bread",
  },
  {
    name: "weather",
    base: "Heavy rain is expected across the coast tomorrow",
    related: "Forecasters predict storms along the shoreline next day",
    unrelated: "The library closes at eight on weekdays",
  },
];

const german = [
  {
    name: "katzen",
    base: "Die Katze sitzt auf der Matte",
    related: "Ein Kätzchen ruht auf dem Teppich",
    unrelated: "Die Börse ist heute stark gefallen",
  },
  {
    name: "deploy",
    base: "Wir haben den neuen Build heute Nacht ausgerollt",
    related: "Das Release wurde gestern auf die Server geschoben",
    unrelated: "Meine Großmutter backt hervorragende Apfelkuchen",
  },
];

const failures = [];

function run(args, input) {
  const result = spawnSync(BIN, args, {
    input,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJsonLines(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function fmt(value, places = 4) {
  return value.toFixed(places);
}

function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

function heading(text) {
  console.log(`\n=== ${text} ${"=".repeat(Math.max(0, 62 - text.length))}`);
}

// --- 0. binary present -------------------------------------------------------

heading("binary");
if (!existsSync(BIN)) {
  console.error(`missing ${BIN} — run ./build.sh first`);
  process.exit(1);
}
console.log(`using ${BIN}`);

// --- 1. English: related must beat unrelated --------------------------------

heading("english sentence pairs (embed, one process, batched)");
const englishTexts = groups.flatMap((group) => [group.base, group.related, group.unrelated]);
const english = run(["embed"], englishTexts.join("\n") + "\n");
check(english.status === 0, `english embed exited ${english.status}, expected 0\n${english.stderr}`);
const englishVectors = parseJsonLines(english.stdout);
check(
  englishVectors.length === englishTexts.length,
  `english embed returned ${englishVectors.length} vectors for ${englishTexts.length} texts`,
);
console.log(`exit=${english.status} vectors=${englishVectors.length} dim=${englishVectors[0]?.dim}`);
console.log(`model load: ${(english.stderr.match(/loaded .* in ([\d.]+) ms/) ?? [])[0] ?? "not reported"}`);
const detections = englishVectors.map((v) => `${v.lang ?? "nil"}/${v.langCheck}@${fmt(v.langConfidence, 3)}`);
console.log(`detected: ${detections.join(" ")}`);
console.log(`norms: ${englishVectors.map((v) => fmt(v.norm, 3)).join(" ")}`);

console.log(`\n${"group".padEnd(10)} ${"related".padStart(9)} ${"unrelated".padStart(10)} ${"margin".padStart(8)}  result`);
for (const [index, group] of groups.entries()) {
  const base = englishVectors[index * 3];
  const related = englishVectors[index * 3 + 1];
  const unrelated = englishVectors[index * 3 + 2];
  const relatedSimilarity = cosine(base.vector, related.vector);
  const unrelatedSimilarity = cosine(base.vector, unrelated.vector);
  const separation = relatedSimilarity - unrelatedSimilarity;
  const ok = check(
    separation >= MARGIN,
    `english/${group.name}: related ${fmt(relatedSimilarity)} - unrelated ${fmt(unrelatedSimilarity)} = ${fmt(separation)} < margin ${MARGIN}`,
  );
  console.log(
    `${group.name.padEnd(10)} ${fmt(relatedSimilarity).padStart(9)} ${fmt(unrelatedSimilarity).padStart(10)} ${fmt(separation).padStart(8)}  ${ok ? "PASS" : "FAIL"}`,
  );
}

// The `similar` subcommand must agree with the cosine computed above.
heading("similar subcommand cross-check");
const similarArgs = ["similar", ...groups.flatMap((g) => ["--text", g.base, "--text", g.related, "--text", g.unrelated])];
const similar = run(similarArgs);
check(similar.status === 0, `english similar exited ${similar.status}, expected 0\n${similar.stderr}`);
const similarJson = JSON.parse(similar.stdout);
check(similarJson.pairs.length === (englishTexts.length * (englishTexts.length - 1)) / 2, "similar pair count is wrong");
check(similarJson.dims.length === 1 && similarJson.dims[0] === englishVectors[0].dim, "similar dims mismatch");
const pairMaxDrift = similarJson.pairs.reduce((worst, [i, j, value]) => {
  const drift = Math.abs(cosine(englishVectors[i].vector, englishVectors[j].vector) - value);
  return Math.max(worst, drift);
}, 0);
check(pairMaxDrift < 1e-6, `similar pairs disagree with embed vectors by ${pairMaxDrift}`);
console.log(`pairs=${similarJson.pairs.length} max drift vs embed vectors=${pairMaxDrift.toExponential(2)}`);
console.log(similar.stderr.trimEnd());

// --- 2. German under the English model: garbage, but labelled ---------------

heading("german sentences under the 'en' model (expected failure mode)");
const germanTexts = german.flatMap((group) => [group.base, group.related, group.unrelated]);
const germanRun = run(["embed", "--lang", "en"], germanTexts.join("\n") + "\n");
const germanVectors = parseJsonLines(germanRun.stdout);
console.log(`exit=${germanRun.status} (2 = language mismatch flagged, 0 = silent garbage)`);
console.log(germanRun.stderr.trimEnd());

check(germanRun.status === 2, `german embed exited ${germanRun.status}, expected 2 (no model / mismatch)`);
check(
  /meaningless/.test(germanRun.stderr),
  "german embed did not warn that the similarities are meaningless",
);
check(germanVectors.length === germanTexts.length, "german embed dropped texts");

console.log(`\n${"group".padEnd(10)} ${"related".padStart(9)} ${"unrelated".padStart(10)} ${"margin".padStart(8)}`);
for (const [index, group] of german.entries()) {
  const base = germanVectors[index * 3];
  const related = germanVectors[index * 3 + 1];
  const unrelated = germanVectors[index * 3 + 2];
  const relatedSimilarity = cosine(base.vector, related.vector);
  const unrelatedSimilarity = cosine(base.vector, unrelated.vector);
  console.log(
    `${group.name.padEnd(10)} ${fmt(relatedSimilarity).padStart(9)} ${fmt(unrelatedSimilarity).padStart(10)} ${fmt(relatedSimilarity - unrelatedSimilarity).padStart(8)}`,
  );
}

// --force must let the same run through with exit 0 while still warning.
const forced = run(["embed", "--lang", "en", "--force", "--text", german[0].base]);
check(forced.status === 0, `--force exited ${forced.status}, expected 0`);
check(/meaningless/.test(forced.stderr), "--force suppressed the warning, it must not");
console.log(`--force: exit=${forced.status}, warning still printed=${/meaningless/.test(forced.stderr)}`);

// Requesting a language with no model must fail fast.
const noModel = run(["embed", "--lang", "de", "--text", "Die Katze sitzt auf der Matte"]);
check(noModel.status === 2, `--lang de exited ${noModel.status}, expected 2`);
check(/no sentence embedding model/.test(noModel.stderr), "--lang de did not explain the missing model");
console.log(`--lang de: exit=${noModel.status}, stderr=${JSON.stringify(noModel.stderr.trim().split("\n")[0])}`);

// French does have a model (640 dims), so it must not be flagged.
const french = run(["embed", "--text", "Le chat est assis sur le tapis", "--text", "La bourse a chuté aujourd'hui"]);
const frenchVectors = parseJsonLines(french.stdout);
console.log(`french under --lang en: exit=${french.status} langs=${frenchVectors.map((v) => v.lang).join(",")}`);
check(french.status === 2, "french text under the en model should be flagged as a mismatch");

const frenchModel = run(["embed", "--lang", "fr", "--text", "Le chat est assis sur le tapis", "--text", "La bourse a chuté aujourd'hui"]);
const frenchModelVectors = parseJsonLines(frenchModel.stdout);
console.log(`french under --lang fr: exit=${frenchModel.status} dim=${frenchModelVectors[0]?.dim}`);
check(frenchModel.status === 0, `--lang fr exited ${frenchModel.status}, expected 0`);
check(frenchModelVectors[0]?.dim === 640, `--lang fr dim is ${frenchModelVectors[0]?.dim}, expected 640`);

// --- 3. langs ---------------------------------------------------------------

heading("langs");
const langs = run(["langs"]);
check(langs.status === 0, `langs exited ${langs.status}`);
console.log(langs.stderr.trimEnd());
const langsJson = JSON.parse(langs.stdout);
console.log(`json: candidates=${langsJson.candidates} available=${JSON.stringify(langsJson.available)}`);

// --- 4. bench ---------------------------------------------------------------

heading("bench --n 200");
const bench = run(["bench", "--n", "200"]);
check(bench.status === 0, `bench exited ${bench.status}`);
console.log(bench.stderr.trimEnd());
const benchJson = JSON.parse(bench.stdout);
console.log(`json: ${JSON.stringify(benchJson)}`);
check(benchJson.n === 200, `bench reported n=${benchJson.n}`);
check(benchJson.median_ms_per_text > 0 && benchJson.texts_per_sec > 0, "bench reported non-positive timings");

// --- summary ----------------------------------------------------------------

heading("summary");
if (failures.length === 0) {
  console.log("all checks passed");
  process.exit(0);
}
console.log(`${failures.length} check(s) failed:`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
