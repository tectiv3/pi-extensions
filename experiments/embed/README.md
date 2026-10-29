# nle-embed — macOS-native sentence embeddings, prototype

A single-file Swift CLI over `NaturalLanguage.NLEmbedding.sentenceEmbedding`. No SwiftPM, no
dependencies, no network, no model download: the models ship with macOS.

Built for **batching**. The sentence model costs ~10–90 ms to load and each `swift script.swift`
invocation pays process startup (measured 0.22–0.28 s here), so this binary loads the model once
and streams newline-delimited texts through it.

Measured on: macOS 27.0 (build 26A428), Apple M2 Pro, Swift 6.4 (`swiftlang-6.4.0.34.1`), Node
v24.21.0.

## Build

```bash
$ cd experiments/embed && ./build.sh
swift-driver version: 1.168.6 swiftc: Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)
built: /Users/fenrir/code/pi-extensions/experiments/embed/bin/nle-embed
size:  162696 bytes
bin/nle-embed: Mach-O 64-bit executable arm64
```

Command Line Tools are enough; no Xcode project, no SwiftPM manifest, no codesigning step, no
`./bin` in git (see `.gitignore`). `build.sh` is idempotent — it recreates `bin/` and overwrites
the binary. The build is warning-free, including under `-swift-version 6`.

## Subcommands

| Command | stdout | stderr |
|---|---|---|
| `embed` | one JSON object per input text | model load line + language warnings |
| `similar` | pairwise cosine JSON | human-readable matrix |
| `bench` | timing JSON | timing table |
| `langs` | availability JSON | availability table |

Flags: `--lang <code>` (default `en`), `--text "..."` (repeatable; replaces stdin), `--force`,
`--pretty`, `--n <count>` (bench, default 200), `-h/--help`.

Exit codes: `0` ok, `2` no model for the language (or a confident language mismatch), `1` other
error. The language-mismatch exit happens **after** all output is written, so piped data is never
lost to the non-zero exit.

### `embed`

stdin, one text per line (blank lines are dropped):

```bash
$ printf 'The cat sat on the mat\nThe stock market crashed today\n' | ./bin/nle-embed embed
```

stderr:

```
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 15.31 ms
[nle-embed] warning: text 0: ambiguous detection — top hypothesis 'tr' p=0.531 vs 'en' p=0.294; continuing with the 'en' model
```

stdout (vectors truncated here; the real lines carry all 512 floats):

```json
{"i":0,"text":"The cat sat on the mat","lang":"tr","langConfidence":0.530849,"langCheck":"ambiguous","dim":512,"norm":9.591585,"vector":[-0.011217,0.527735,-0.378083, ...]}
{"i":1,"text":"The stock market crashed today","lang":"en","langConfidence":0.989649,"langCheck":"match","dim":512,"norm":7.562451,"vector":[0.152439,-0.408375,-0.403465, ...]}
```

`--text` (repeatable) and `--pretty`:

```bash
$ ./bin/nle-embed embed --text "The build finished in four minutes" --pretty
{
  "i": 0,
  "text": "The build finished in four minutes",
  "lang": "en",
  "langConfidence": 0.995734,
  "langCheck": "match",
  "dim": 512,
  "norm": 6.830425,
  "vector": [-0.089175,0.518258,-0.335288, ...]
}
```

Fields beyond the minimum contract: `langConfidence` (top hypothesis probability) and `langCheck`
(`match` / `ambiguous` / `mismatch` / `unknown`) — see *Language guard* below.

French uses a different model and dimension:

```bash
$ ./bin/nle-embed embed --lang fr --text "Le chat est assis sur le tapis"
{"i":0,"text":"Le chat est assis sur le tapis","lang":"fr","langConfidence":0.999297,"langCheck":"match","dim":640,"norm":0.054436,"vector":[...]}
```

Note the norm: the French model emits much smaller-magnitude vectors than the English one
(0.054 vs ~7), which is another reason not to compare raw vectors across models.

### `similar`

```bash
$ ./bin/nle-embed similar \
    --text "The cat sat on the mat" \
    --text "A kitten is resting on the rug" \
    --text "The stock market crashed today"
```

stdout:

```json
{"langs":["tr","en"],"model":"en","dims":[512],"count":3,"texts":["The cat sat on the mat","A kitten is resting on the rug","The stock market crashed today"],"pairs":[[0,1,0.619632],[0,2,0.254774],[1,2,0.273437]]}
```

stderr:

```
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 11.28 ms
[nle-embed] warning: text 0: ambiguous detection — top hypothesis 'tr' p=0.531 vs 'en' p=0.294; continuing with the 'en' model
similarity matrix — model 'en', 3 texts
dims: 512
               0       1       2
     0    1.0000  0.6196  0.2548   The cat sat on the mat
     1    0.6196  1.0000  0.2734   A kitten is resting on the rug
     2    0.2548  0.2734  1.0000   The stock market crashed today

pairs:
  [0,1] 0.6196
  [0,2] 0.2548
  [1,2] 0.2734
```

`pairs` holds the upper triangle only, as `[i, j, cosine]`. `langs` is the deduplicated set of
detected languages in input order; `dims` the deduplicated vector sizes.

### `bench`

```bash
$ ./bin/nle-embed bench --n 200
```

stderr:

```
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 9.48 ms
bench — 200 synthetic 'en' sentences, dim 512
  model load      9.48 ms (outside the timed loop)
  first call      5.24 ms (cold ANE/GPU path)
  median          4.289 ms/text
  mean            4.327 ms/text
  p95             5.007 ms/text
  total wall      865.42 ms
  throughput      231.1 texts/sec
```

stdout:

```json
{"lang":"en","dim":512,"n":200,"median_ms_per_text":4.288979,"mean_ms_per_text":4.3265,"p95_ms_per_text":5.007333,"texts_per_sec":231.10293,"total_wall_ms":865.41525,"first_call_ms":5.242875,"model_load_ms":9.48325}
```

Sentences are generated deterministically from templates (fixed LCG seed), so the input set is
identical between runs.

**These numbers are load-sensitive.** The same command on the same machine measured
`31.4 ms/text / 29.1 texts/sec` at load average 14, and `4.29`–`4.54 ms/text / 220–231 texts/sec`
across repeated runs at load average ~8.6 — a 24× spread. Treat throughput as an order-of-magnitude
figure, not a constant.

End-to-end through the real path (100 newline-delimited texts through one process, wall clock
including process start and model load, measured with `/usr/bin/time -p`): `real 0.73`–`0.74 s`,
i.e. ~7.3 ms/text.

### `langs`

```bash
$ ./bin/nle-embed langs
```

stderr:

```
sentence embedding availability (NLEmbedding.sentenceEmbedding)
lang       status   dim   rev   revs    vocab  revisions
en      available   512     1      1        0          1
fr      available   640     1      1        0          1
de           none     -     -      1        -          -
es           none     -     -      1        -          -
it           none     -     -      1        -          -
pt           none     -     -      1        -          -
nl           none     -     -      0        -          -
zh           none     -     -      1        -          -
ja           none     -     -      0        -          -
ru           none     -     -      0        -          -
... (29 candidates probed)
2/29 candidates available: en fr
```

stdout (abridged):

```json
{"requestedLang":"en","available":["en","fr"],"candidates":29,"langs":[{"code":"en","available":true,"dim":512,"revision":1,"revisionCount":1,"revisions":[1],"vocabularySize":0},{"code":"fr","available":true,"dim":640,"revision":1,"revisionCount":1,"revisions":[1],"vocabularySize":0},{"code":"de","available":false,"dim":null,"revision":null,"revisionCount":1,"revisions":[1],"vocabularySize":null}, ...]}
```

`revs` is `supportedSentenceEmbeddingRevisions(for:).count` — note that `de/es/it/pt/zh` advertise
one revision while `sentenceEmbedding(for:)` still returns `nil`, so revisions are *not* an
availability signal. `vocab` is `vocabularySize`, which sentence embeddings report as `0`.

## Test

```bash
$ node test.mjs
```

Real output (exit code 0, all checks passed):

```
=== binary ========================================================
using /Users/fenrir/code/pi-extensions/experiments/embed/bin/nle-embed

=== english sentence pairs (embed, one process, batched) ==========
exit=0 vectors=12 dim=512
model load: loaded 'en' sentence model dim=512 revision=1 in 15.92 ms
detected: tr/ambiguous@0.531 en/match@0.976 en/match@0.990 en/match@0.994 en/match@0.997 en/match@0.962 en/match@0.998 en/match@0.995 en/match@0.984 en/match@0.994 en/match@0.997 en/match@0.996
norms: 9.285 7.163 7.515 6.733 6.254 8.867 6.532 6.195 6.970 7.171 7.844 8.434

group        related  unrelated   margin  result
cats          0.6196     0.2548   0.3649  PASS
deploy        0.4613     0.0554   0.4059  PASS
errors        0.5012     0.0886   0.4126  PASS
weather       0.5537     0.1947   0.3590  PASS

=== similar subcommand cross-check ================================
pairs=66 max drift vs embed vectors=6.53e-7
...
=== german sentences under the 'en' model (expected failure mode) =
exit=2 (2 = language mismatch flagged, 0 = silent garbage)
[nle-embed] warning: text 0 detected as 'de' p=1.000 but the 'en' model is loaded; no 'de' sentence embedding model exists on this system
[nle-embed] warning: 'de' text embedded with the 'en' model produces meaningless vectors — every cosine similarity below is noise. Use --force to silence this exit code.

group        related  unrelated   margin
katzen        0.8692     0.7381   0.1311
deploy        0.7672     0.7724  -0.0051
--force: exit=0, warning still printed=true
--lang de: exit=2, stderr="[nle-embed] error: no sentence embedding model for language 'de'"
french under --lang en: exit=2 langs=fr,fr
french under --lang fr: exit=0 dim=640
...
=== summary =======================================================
all checks passed
```

What the test asserts:

- 4 English sentence-pair groups, embedded in **one** process. Related similarity must beat the
  unrelated one by at least 0.05. Observed margins: 0.359–0.413.
- `similar`'s `pairs` must agree with cosine recomputed in Node from the `embed` vectors
  (max drift 6.5e-7, which is float→JSON rounding).
- German under the English model must exit `2` and must print the "meaningless" warning; `--force`
  must exit `0` while still printing it; `--lang de` must fail fast with exit `2`.
- French must be flagged under `--lang en` and must succeed at 640 dims under `--lang fr`.
- `bench --n 200` must report a positive median and throughput.
- Only English (and the German/mismatch) assertions gate the exit code; the German numbers are
  printed for their own sake — see below.

### The German failure mode is visible in the numbers

```
group        related  unrelated   margin
katzen        0.8692     0.7381  +0.1311
deploy        0.7672     0.7724  -0.0051
```

`katzen` looks like a plausible embedding (related above unrelated, by a margin in the same range
as English), while `deploy` is inverted. Nothing in the numbers themselves separates "working"
from "garbage" — one group looks fine, one does not, both are noise. That is why the language
guard exists and why these runs exit non-zero instead of relying on the caller to notice.

## Language guard

`NLLanguageRecognizer` is noisy on short input: `"The cat sat on the mat"` is classified as
**Turkish** (p=0.531) over English (p=0.294) on this machine. A naive "dominant language must equal
`--lang`" check would therefore reject valid English. Per text:

- `match` — detected base code equals `--lang` (BCP-47 subtags ignored, so `zh-Hans` vs `zh` match).
- `ambiguous` — the requested language is a plausible hypothesis (p ≥ 0.15), or the recognizer is
  not confident (top p < 0.40), or the text has fewer than 3 tokens. A warning is printed; the
  exit code is unaffected.
- `mismatch` — confident detection of another language, requested language implausible. A warning
  naming the detected language and its availability is printed, plus an explicit "every cosine
  similarity below is noise" line, and the process exits `2` unless `--force`.
- `unknown` — no dominant language. Treated as a soft warning.

An English batch therefore exits `0` even when one sentence is misdetected as Turkish, while a
German batch under `--lang en` exits `2` (German is detected at p=1.000).

## Measured numbers

| Metric | Value | Notes |
|---|---|---|
| `en` dimension | 512 | `revision` 1 |
| `fr` dimension | 640 | `revision` 1 |
| language candidates with a model | 2 of 29 | `en`, `fr` |
| warm embed, `bench` median | 4.29 ms/text | load avg 8.6 |
| warm embed, same binary under load | 31.4–103 ms/text | load avg 14, 24× spread |
| throughput | 231 texts/sec (idle-ish) / 8.8–29 texts/sec (loaded) | |
| model load | 9.5–90 ms | per process, per language |
| first call (cold ANE path) | 5.2–49 ms | |
| 100 texts, one process, wall | 0.73 s | ~7.3 ms/text incl. startup |
| one text, one process, wall | 20–30 ms | process floor |
| `swift script.swift`, same work | 220–280 ms | measured, not the 532 ms from earlier notes |
| English related vs unrelated margin | 0.359–0.413 | 4 groups |
| German under `en` model | +0.131 / −0.005 | garbage |
| vector L2 norm | 6.2–9.3 (`en`), 0.054 (`fr`) | **not** unit-normalised, and model-specific |
| binary size | 162,696 bytes | `Mach-O 64-bit executable arm64` |

Vector norms vary per text and per model, and are nowhere near 1.0; if you need unit vectors,
normalise downstream. Cosine similarity is scale-invariant, so this does not affect `similar`.

## Known limits

- **Only English and French.** `sentenceEmbedding(for:)` is non-nil for exactly `en` (512) and
  `fr` (640) among 29 probed languages; `de/es/it/pt/zh` return `nil` despite advertising a
  revision. Nothing can be downloaded to change this — the models are part of macOS.
- **Non-English input is silently garbage under the wrong model.** German text embedded with the
  `en` model produces plausible-looking cosines (0.8692 related vs 0.7381 unrelated). The CLI
  warns and exits `2`; it cannot make the numbers meaningful.
- **macOS-only.** `NaturalLanguage` is an Apple framework. No Linux port, no WASM, no fallback.
  The embedding models are tied to the OS version, so scores are not comparable across machines
  running different macOS releases.
- **The binary must be precompiled.** `swift NLEmbed.swift` reinterprets the whole file per call
  (220–280 ms here); the point of `build.sh` is that the model load and startup are paid once.
  Any host that shells out to this per text loses the entire benefit.
- **Gatekeeper.** The binary is built locally and ad-hoc signed by the linker, so it runs where it
  was built. If you copy it to another machine (AirDrop, download, `scp` of an archive), the
  quarantine attribute blocks it: `xattr -d com.apple.quarantine bin/nle-embed`, or just rebuild
  from source there. No notarisation, no entitlements, no `spctl` policy is involved when running
  it from the build directory.
- **Language detection thresholds are empirical.** The 0.15 / 0.40 / 3-token cutoffs were set from
  observed `NLLanguageRecognizer` output on this macOS build; they will misfile some inputs. Use
  `--lang` plus `--force` when the caller already knows the language.
- **`--text` and stdin are exclusive**: if any `--text` is given, stdin is ignored entirely.
- **No caching across processes, no GPU batching, no token-level embeddings.** One call per text,
  sequential. `NLContextualEmbedding` (token-level, different API) is not used here.

## Files

| Path | Purpose |
|---|---|
| `NLEmbed.swift` | the whole CLI (`@main`, `import NaturalLanguage`) |
| `build.sh` | `swiftc -O -parse-as-library`, prints size and `file` output |
| `test.mjs` | end-to-end checks against the compiled binary (no deps) |
| `bin/nle-embed` | build artifact, not committed |
