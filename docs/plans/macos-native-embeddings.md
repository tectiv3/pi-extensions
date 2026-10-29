# macOS-Native Text Embeddings + SQLite Extension Loading

Measured on the target machine, 2025 (single session). Every number below came from a program
that was compiled and executed on this box unless explicitly marked **UNVERIFIED**.

## TL;DR — verdicts

| Question | Answer | Confidence |
|---|---|---|
| Does macOS ship a usable sentence-embedding API? | **Yes, for English only.** `NLEmbedding.sentenceEmbedding(for: .english)`, 512-dim, 6.28 ms/call warm, 165 texts/sec | measured |
| French too? | Yes — 640-dim. **No other language the public API can reach** | measured |
| Is a per-call Swift CLI spawn viable? | Yes **only with batching**. 35 ms for 1 text; 6.22 ms/text at batch 1000 (161/s) | measured |
| Is `NLContextualEmbedding` usable for retrieval? | **No, not via mean pooling.** Unrelated pairs score 0.83 vs 0.94 for related — 0.11 separation | measured |
| Does Foundation Models expose embeddings? | **No.** Generation only. 0 occurrences of "embed" in its 3,647-line interface | measured |
| Is there a text `VNGenerateImageFeaturePrint`? | **No.** Vision is image-only + OCR | measured |
| Is MLX "already there"? | **No.** No `mlx`, no `torch`, no `transformers`. `uv` present, one 128 MB model in HF cache | measured |
| Can a pi extension load `sqlite-vec`? | **Yes** — `node:sqlite` + `{ allowExtension: true }` + `vec0.dylib`, vec v0.1.9 | measured |
| Is `better-sqlite3` an option? | Not installed in this repo; not tested (would require adding a dep) | untested |

---

## Environment (what these numbers apply to)

```
sw_vers  ProductName: macOS   ProductVersion: 27.0   BuildVersion: 26A428
uname -m             arm64
swift --version      Apple Swift 6.4 (swiftlang-6.4.0.34.1), Target arm64-apple-macosx27.0.0
xcrun --show-sdk-version   27.0
node --version       v24.21.0   (nix store nodejs-24.21.0, process.versions.modules=137, napi=10)
node's embedded SQLite      3.53.3
```

> Note on the version string: `sw_vers` reports `27.0` while the build train is `26A428` (an `26A…`
> seed build). The SDK and Swift target both report 27.0. All API availability claims below were
> checked against the **headers shipped in this SDK**, not against memory of the release notes.

`pi` resolves to the nix `nodejs-24.21.0` binary via a pnpm shim, so an extension runs on
**Node 24.21.0 with SQLite 3.53.3** — this matters for Part 3.

---

# Part 1 — What actually ships in the OS

## 1.1 `NLEmbedding` (NaturalLanguage, macOS 10.15+ / sentence 11.0+)

Availability from the SDK header (`NaturalLanguage.framework/Headers/NLEmbedding.h`):

- `wordEmbedding(for:)` — macOS 10.15+
- `sentenceEmbedding(for:)` — macOS 11.0+
- `dimension`, `vocabularySize`, `revision`, `language` properties.

**Sentences are not on-demand.** `NLEmbedding` has **no `requestAssets`** in its public surface.
`NLTagger` has `requestAssets(for:tagScheme:)` and `NLContextualEmbedding` has
`requestEmbeddingAssets(completionHandler:)`; `NLEmbedding` has neither. Runtime enumeration
confirms this:

```
instance selectors: 38 total; asset/download-related: []
class selectors: 27 total; asset/download-related:
  ["assetsAvailableForEmbeddingType:language:",
   "requestAssetsForEmbeddingType:language:withCompletionHandler:"]
NLContextualEmbedding has requestEmbeddingAssetsWithCompletionHandler: true
```

So the asset machinery exists **only on the class, undocumented**. Direct invocation of
`assetsAvailableForEmbeddingType:language:` via `objc_msgSend` **segfaulted** in my harness —
private signature, no public contract. Treat as **UNVERIFIED and unsupported**; do not build on it.

### Which languages actually work here

Probed 15 languages. Sentence embeddings:

| lang | sentence embedding | dim | revision |
|---|---|---|---|
| **en** | **available** | **512** | 1 |
| **fr** | **available** | **640** | 1 |
| de, es, it, pt, zh | `nil` (but `supportedSentenceEmbeddingRevisions` → `[1]`) | — | — |
| ja, ko, ru, ar, th, hi, tr, nl | `nil` (`supportedSentenceEmbeddingRevisions` → `[]`) | — | — |

Word embeddings: `en` 300-dim / 57,171 vocab; `fr` 300-dim / 44,523 vocab; everything else `nil`.

The `de/es/it/pt/zh` row is the interesting failure: the API *advertises* revision 1 for them but
returns `nil`, i.e. the code path exists and the **assets are simply not resident**, with no
public way to fetch them. On this machine the usable set is exactly `{en, fr}`.

### Latency (512-dim, English)

| measurement | value |
|---|---|
| first-ever call (cold, asset map + model init) | **14.53 ms** |
| warm median over 20 calls | **6.279 ms** (min 5.527, max 6.694) |
| 32 texts, one process | 184.00 ms → 5.750 ms/text |
| 1,000 texts, one process | 6,066 ms → 6.066 ms/text → **165 texts/sec** |
| 2,025-char input | **118.01 ms** (superlinear — must chunk) |
| `""` / `"   "` | `nil` (0.27–0.30 ms) |
| `"🦀🦀🦀"` | 512-dim, 4.18 ms |
| `"a"` | 512-dim, 1.40 ms |

### Is it semantically any good?

It is a real sentence-similarity model, not a bag of noise:

```
cos("memory store…vector similarity", "local-first database…cosine distance") = 0.4720   <- related
cos("memory store…vector similarity", "my cat…canned tuna")                    = 0.1316   <- unrelated
cos("local-first database…",          "my cat…canned tuna")                    = 0.0441
||v|| = 5.3469  (NOT unit-normalised — normalise yourself or cosine is fine, L2 is not)
```

**Trap: it silently accepts non-English text and returns garbage.** English model, German input:

```
DE related pair   (both about "Speicher indexiert Notizen…")   cos = 0.8269
DE unrelated      (storage vs "meine Katze…Thunfisch")         cos = 0.7821
                                                       separation = 0.045
```

0.045 separation is indistinguishable from noise, and it does **not** return `nil`. Any store with
non-English notes must detect language and refuse, or it will populate the index with meaningless
vectors that still look plausible.

## 1.2 `NLContextualEmbedding` (macOS 14+)

Models present on this machine (found by querying per language — see gotcha below):

| model identifier | covers | dim | maxSeqLen | `hasAvailableAssets` |
|---|---|---|---|---|
| `5C45D94E-BAB4-4927-94B6-8B5745C46289` | Latin (en, de, es, fr, it, pt, nl, …) | 512 | 256 | **true** |
| `12784592-5D67-4F4C-83D6-A346519146AE` | zh, ja (CJK) | 512 | 256 | **true** |
| `FCDCF262-68F6-4446-8C4E-371491BC04A2` | Cyrillic (ru…) | 512 | 256 | false |
| `8D8CD1B6-1D0E-4ADF-8D75-B5FD5F125186` | Arabic | 512 | 256 | false |
| `FC4A7469-2001-45D6-9AD7-A7110800DBCA` | Indic (hi…) | 512 | 256 | false |
| `54877656-5B75-40D8-95C8-75759FCBEF2F` | Thai | 512 | 256 | false |

This is the one Apple API with a **real, public on-demand asset path**
(`hasAvailableAssets` / `requestAssets()`), so the `false` rows are fixable at runtime — they
download over the air. It is also the **only native route to German/Spanish/Japanese**, which
`NLEmbedding` cannot reach at all.

**Gotcha:** `NLContextualEmbedding.contextualEmbeddings(forValues: [:])` returns
**0 models** — an empty criteria dictionary does not mean "list all". You must ask by language or
script (`NLContextualEmbedding(language: .english)`, `(script: .latin)`).

**It is per-token, not per-sentence.** A 21-word sentence produced `sequenceLength = 20` vectors
of 512 floats each (leading empty/BOS tokens appear as `""`). Context-dependence is real:

```
"the bank raised interest rates." / "we sat on the river bank"
  cos(bank@finance, bank@river)  = 0.7846   <- < 1.0, genuinely contextual
  cos(the@finance,  the@river)   = 0.8051
```

Latency: **21.29 ms** for the first `embeddingResult`, **9.892 ms/sentence** averaged over 32
(iterating all token vectors). Truncation is real: 3,660 chars → `sequenceLength = 254` against a
256 cap, i.e. the tail was dropped.

### Why it is still the wrong tool for a memory store

To store one vector per note you must pool the token vectors. Mean pooling destroys the signal:

```
mean-pooled cosines
  s0 "memory store…vector similarity"  vs s1 "local-first database…cosine distance"  = 0.9429  related
  s0                                   vs s2 "my cat…canned tuna"                     = 0.8291  unrelated
  s0                                   vs s3 "kitten only eats wet food from a can"  = 0.8619  unrelated
  s2 "cat…tuna"                        vs s3 "kitten…wet food"                       = 0.9291  related
```

The cat/kitten pair (0.9291) scores **below** the storage pair (0.9429), and unrelated pairs sit at
0.83. Separation is ~0.11 versus `NLEmbedding`'s ~0.34, and the absolute values are compressed
toward 1 — classic anisotropy from mean-pooling a token encoder that was never trained for
sentence similarity. Ranking on this will surface semantically unrelated notes. Apple's own header
says as much: *"For semantic similarity tasks, consider using `NLEmbedding`."*

## 1.3 Foundation Models framework (macOS 26+)

Present in this SDK, and the on-device model is live:

```
canImport(FoundationModels) = true
SystemLanguageModel.default.availability = available
supportedLanguages = fr, en, en, pt, es, zh, ko, en, es, en, de, nl, sv, vi, zh, pt, it, da, es, fr, zh, ja, nb, tr
```

**It exposes no embedding API.** Evidence: its entire public surface is a Swift interface of
**3,647 lines**, and a case-insensitive grep for `embed` returns **zero matches**. The public types
are generation-shaped — `LanguageModel`, `LanguageModelExecutor`, `Generable`, `GeneratedContent`,
`Prompt`, `Instructions`, `Transcript`, `GenerationSchema`, `GenerationOptions`,
`SystemLanguageModel.UseCase (general | contentTagging)`. So: **generation-only**, and its 24
supported languages are irrelevant to vector search.

**Reaching it from Node/TS:** the framework ships **no C or Objective-C headers** — only
`FoundationModels.tbd`, a `.swiftmodule` and `.swiftinterface` files. There is no stable `dlopen` +
symbol surface to bind to, so the only path is a Swift shim binary (exactly the Part 2 pattern), and
even then there is nothing to call for embeddings. Verified by directory listing of
`FoundationModels.framework/Versions/A/`.

## 1.4 Everything else already on the box

**Vision — no text feature print.** The header set contains only
`VNGenerateImageFeaturePrintRequest : VNImageBasedRequest` (image input) and
`VNRecognizeTextRequest` (OCR: image → `String`). There is no `VNGenerateTextFeaturePrintRequest`
and no text-input feature-print request. **Confirmed: the text equivalent does not exist.**

**Spotlight / private frameworks.** These exist as private frameworks:
`SpotlightEmbedding.framework`, `SpotlightEmbeddingCore.framework`, `EmbeddingService.framework`,
`EmbeddingCore.framework`. macOS Spotlight does compute text embeddings for semantic search, and
this is probably where the OS's real multilingual embedding lives — but it is **private API with no
supported entry point**. `mdls` / `NSMetadataQuery` expose `kMDItemTextContent` (raw text) and
metadata, **not vectors**. Not usable from an extension.

**CoreML built-in models.** No general-purpose text-embedding model is bundled; CoreML is a runtime
for models you supply. Nothing to call out of the box. (Nothing further probed — **UNVERIFIED** as to
whether any internal embedding `.mlmodelc` is system-resident.)

## 1.5 MLX — honest answer: not already there

```
python3            /usr/bin/python3 (system)
import mlx         ModuleNotFoundError
import torch       ModuleNotFoundError
import transformers ModuleNotFoundError
import sentence_transformers  ModuleNotFoundError
import objc / AppKit   ModuleNotFoundError   (no PyObjC)
uv                 /run/current-system/sw/bin/uv   (available)
```

What *is* present:

- HF cache: `models--BAAI--bge-small-en-v1.5`, **128 MB on disk** (384-dim, English). Weights only —
  no runtime installed to execute them.
- `LM Studio.app` installed, **11 GB** of models, but the only model is
  `mlx-community/gpt-oss-20b-MXFP4-Q8` — a **generation LLM, not an embedding model**. The local
  server was **not running** (`curl localhost:1234/v1/models` returned nothing).

So MLX would require: `uv`-managed venv → `mlx` + `mlx-lm`/`sentence-transformers` (hundreds of MB
of wheels) → an embedding model download → a per-call Python process or a long-lived server. That is
a new runtime dependency chain, not something the OS gives you. For a *multilingual* memory store
this is nonetheless the only serious option, because it is the only path to a model like
`bge-m3`/`multilingual-e5` that handles German and Japanese properly.

---

# Part 2 — Calling path from a Node/TypeScript extension

## (a) Precompiled Swift CLI, spawned per call — **measured, viable with batching**

Binary: a 65,560-byte arm64 executable linking only OS-provided libraries — `libSystem`,
`Foundation`, `NaturalLanguage`, `libobjc`, `libswiftCore`. No bundled Swift runtime, no toolchain
needed at runtime. Protocol: JSON in on stdin, JSON out on stdout.

Spawn + embed, 10 runs each, wall-clock from Node:

| workload | total (10 runs) | per-run | per-text |
|---|---|---|---|
| `{"op":"noop"}` — spawn only | 126.3 ms | **12.63 ms** | — |
| 1 text | 349.4 ms | **34.94 ms** | 34.94 ms |
| 32 texts | 2,392.8 ms | **239.28 ms** | 7.48 ms |

Fixed cost breakdown: ~12.6 ms process spawn, ~22 ms one-time model/asset init inside the child,
then ~6 ms per text. So a fresh process pays ~22 ms of model init on every call.

**Batching fixes it.** Single-process throughput curve (one spawn per row):

| batch | total | per-text | throughput |
|---|---|---|---|
| 8 | 135.9 ms | 16.984 ms | 59 /s |
| 32 | 239.3 ms | 7.48 ms | 134 /s |
| 128 | 885.7 ms | **6.920 ms** | 145 /s |
| 512 | 3,222.5 ms | **6.294 ms** | 159 /s |
| 1,000 | 6,217.6 ms | **6.218 ms** | **161 /s** |

At batch ≥128 the CLI converges on in-process performance (161/s vs 165/s in-process — a 2.5%
penalty) because the 12.6 ms spawn and 22 ms init amortise away.

**Projection for indexing:** 1,000 notes ≈ **6.2 s** in one batched spawn; 10,000 notes ≈ **62 s**.
Per-call spawning at 1 text/note would be 35 s per 1,000 notes — 5.6× worse. **Rule: always batch,
never spawn per note.**

**Do not use `swift script.swift` as the path:** measured **532 ms** for a single 1-text call
(compile + typecheck every run). A precompiled binary is mandatory, which in turn means the
extension needs a build step or a checked-in arm64 artifact, and Xcode CLT on the build machine.

## (b) Native addon (`napi-rs` / `objc2`) — not measured

Would run in-process: ~6.28 ms/text, no spawn, no init penalty, and could hold the model resident
for the life of the pi process. Cost is build burden: Rust + napi toolchain, one prebuilt `.node`
per Node ABI (this host is `modules=137`, `napi=10`, arm64), plus codesigning/notarisation if
distributed. **UNVERIFIED** — nothing was built or benchmarked. The only thing that would beat
option (a) is eliminating the 12.6 ms spawn and 22 ms init, which matters only for one-shot lookups,
not for indexing.

## (c) PyObjC via Python — blocked without new deps

`/usr/bin/python3` has **no `objc` and no `AppKit`** module, so PyObjC would be a fresh
`uv`/pip install. It would then pay a Python interpreter startup per call *plus* the same model
init — strictly worse than (a) on every axis. **Not viable, not measured.**

## Verdict for Part 2

Ship option **(a)**: a precompiled arm64 Swift CLI with a **batched JSON protocol**, invoked once
per indexing run (chunk of ≥128 notes), never per note. Keep the same protocol shape so it can be
swapped for a `napi-rs` addon later without touching the TS side.

---

# Part 3 — SQLite extension loading, measured

## What SQLite a pi extension gets

```
node                        v24.21.0
process.versions.modules    137
process.versions.napi       10
process.versions.sqlite     3.53.3
DatabaseSync.prototype      open, close, prepare, exec, function, createTagStore, location,
                            aggregate, createSession, applyChangeset, enableLoadExtension,
                            enableDefensive, loadExtension, serialize, deserialize,
                            setAuthorizer, constructor
```

`node:sqlite` loads with **no flags and no experimental warning** on this Node (`require('node:sqlite')`
prints nothing). Compile options (57 total) contain **no `OMIT_LOAD_EXTENSION`**, and no
`EXTENSION`-related flags at all → extension loading is compiled in and not restricted.

Node docs (v24.x, `sqlite.html`) state it exactly:

> `database.loadExtension(path[, entryPoint])` — *Added in: v23.5.0, v22.13.0.*
> "It is required to enable the `allowExtension` option when constructing the `DatabaseSync` instance."
>
> `database.enableLoadExtension(allow)` — "When `allowExtension` is `false` when constructing, you
> cannot enable loading extensions for security reasons."

Both halves confirmed by execution:

```
A) allowExtension omitted  -> ERR_INVALID_STATE  "extension loading is not allowed"
B) enableLoadExtension(true) after construction -> ERR_INVALID_STATE
   "Cannot enable extension loading because it was disabled at database creation."
C) new DatabaseSync(':memory:', { allowExtension: true }) + loadExtension(...)  -> LOADED
```

**The constructor flag is mandatory and cannot be repaired afterwards.** This is a real trap for an
extension that opens its DB in a shared helper.

## sqlite-vec

```
nix build --no-link --print-out-paths nixpkgs#sqlite-vec
  -> /nix/store/6pxcxnxm22mq8316lsapsfh886c1gfml-sqlite-vec-0.1.9
     lib/vec0.dylib            176,416 bytes, Mach-O 64-bit arm64
     lib/libsqlite_vec0.a      static
exports: _sqlite3_vec_init, _sqlite3_vec_numpy_init, _sqlite3_vec_static_blobs_init, vec0*
```

`otool -L lib/vec0.dylib` → **only `libSystem`**. It does **not** link `libsqlite3`, so there is no
ABI conflict with the SQLite 3.53.3 embedded in Node. That is the single most important fact here:
the nix dylib is self-contained and loads into a foreign SQLite host.

Measured, end to end:

```
node v24.21.0  sqlite 3.53.3
loadExtension(vec0.dylib) with {allowExtension:true} -> OK
sqlite_version() = 3.53.3
vec_version()    = v0.1.9
CREATE VIRTUAL TABLE v USING vec0(embedding float[512]) -> OK
shadow tables created: v_info, v_chunks, v_rowids, v_vector_chunks00, sqlite_sequence, …
```

Performance (512-dim):

| op | measured |
|---|---|
| insert 1,000 vectors (one transaction) | **52.9 ms** → 0.05 ms/vector |
| KNN `k=10` over 1,000 vectors | **0.146 ms/query** |

**Full stack, real embeddings:** `NLEmbedding` (512-dim) → JSON → `node:sqlite` + `vec0` → KNN:

```
5 notes inserted, query = vector of note 1
  rowid 1 -> distance 0          (self, exact)
  rowid 2 -> distance 5.196460   ("local-first database stores embeddings…" — related)
  rowid 5 -> distance 6.531705   ("sqlite vector extension loading and KNN" — further)
```

Ranking is correct (self at exactly 0, related note second). Note `vec0`'s default metric here is
**L2**, and `NLEmbedding` vectors are **not unit-normalised** (‖v‖ = 5.35), so distances are in the
single digits; normalise on write if you want `distance` to be a cosine.

## better-sqlite3

**Not installed** in `/Users/fenrir/code/pi-extensions/node_modules` (dev deps are only eslint,
prettier, typescript, typescript-eslint and types). Per instructions no dependency was added, so
**this is untested**. Known-good in general (it exposes `loadExtension` and needs no constructor
flag equivalent), but **UNVERIFIED on this box**. It is not needed — `node:sqlite` already works.

## Verdict for Part 3

> **`sqlite-vec` is loadable from a pi extension: YES — via `node:sqlite` (`DatabaseSync`) with
> `{ allowExtension: true }` passed to the constructor, then `db.loadExtension('/path/to/vec0.dylib')`.**
> No native addon, no `better-sqlite3`, no flags. Verified: vec v0.1.9, vec0 KNN returning correct
> neighbours from real `NLEmbedding` vectors.

**Caveats that must be handled in the extension:**

1. The `/nix/store/...` path is a build-time artifact — it is GC-collectable and not portable. Copy
   `vec0.dylib` into the extension's own `vendor/` directory (176 KB) or pin the store path in a
   flake, and resolve the path relative to `import.meta.url`.
2. `loadExtension` must be called per connection, not once globally.
3. `vec0` stores raw floats; dimension is fixed at `CREATE VIRTUAL TABLE` time (`float[512]` for
   `NLEmbedding`, `float[384]` for bge-small). Pick deliberately — changing it later means a rebuild.

---

# Recommended architecture (what the evidence supports)

**Storage / search: `node:sqlite` + `sqlite-vec`.** This is solved and measured. 0.05 ms/vector
insert, 0.146 ms KNN — the vector layer will never be the bottleneck.

**Embedding, English-only notes: `NLEmbedding.sentenceEmbedding(for: .english)` via a batched Swift
CLI.** 512-dim, 6.2 ms/text batched, genuinely discriminative (0.47 related vs 0.04 unrelated), zero
downloads, zero new runtime deps. Guard `nil` returns (empty/whitespace input) and do not exceed
~1–2 KB per chunk (2 KB cost 118 ms).

**Do not use:**
- `NLContextualEmbedding` mean-pooled — 0.11 separation, ranks cat/kitten below storage/vectors.
  (Its *token* vectors are fine, and its `requestAssets` is the only public download path, so it is
  the right answer only if you need token-level vectors or German/Spanish without a real model.)
- The English `NLEmbedding` on non-English text — 0.045 separation, silent garbage.
- Foundation Models — no embedding API at all.
- Vision — image-only.
- The private `SpotlightEmbedding`/`EmbeddingService` frameworks — no supported entry point.

**Gap the OS does not fill: multilingual semantic search.** `NLEmbedding` reaches `{en, fr}` only,
its `de/es/zh` revisions are advertised but not resident, and the only public download hook is
undocumented (and crashed when probed). `NLContextualEmbedding` covers Latin/CJK/… but only per-token
and it pools badly. If the memory store must handle mixed-language notes, plan on an external model
(`bge-m3` / `multilingual-e5` via MLX or `llama.cpp`) — nothing on this box provides it today:
no `mlx`, no `torch`, no embedding model in LM Studio.

---

# Reproduction

All artifacts are throwaway in `/tmp/nlprobe` (nothing was added to the repo). Snippets:

```swift
// NLEmbedding — the viable path
let emb = NLEmbedding.sentenceEmbedding(for: .english)!   // nil-check in real code
let v: [Double]? = emb.vector(for: text)                  // 512-d, NOT unit norm

// NLContextualEmbedding — per-token, must pool
let ce = NLContextualEmbedding(language: .english)!        // forValues:[:] returns 0 models!
if !ce.hasAvailableAssets { _ = try await ce.requestAssets() }
try ce.load()
let res = try ce.embeddingResult(for: text, language: .english)  // non-optional in Swift
res.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vec, range in … }
```

```js
// sqlite-vec — the viable path
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(path, { allowExtension: true });   // flag is mandatory
db.loadExtension('/abs/path/to/vec0.dylib');                   // self-contained, libSystem only
db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[512])');
```

# NOT COVERED / UNVERIFIED

- **`napi-rs` / `objc2` addon (Part 2b)** — not built, not benchmarked. Its claimed advantage
  (no spawn, model resident) is inferred from the measured in-process 6.28 ms/text, not measured
  through an addon.
- **`better-sqlite3`** — not installed, deliberately not added; load compatibility untested here.
- **`requestAssetsForEmbeddingType:language:withCompletionHandler:`** — selector confirmed to exist
  on `NLEmbedding`'s class at runtime, but invocation **segfaulted**; whether it could download
  `de/es/zh` sentence assets is **UNVERIFIED**. Not usable as a design assumption.
- **`NLContextualEmbedding.requestAssets()` for ru/ar/hi/th** — `hasAvailableAssets = false` was
  measured; the actual download was **not** triggered (network side effect avoided).
- **Non-Latin German/Japanese quality of `NLContextualEmbedding`** per-token vectors — only English
  token behaviour was probed.
- **CoreML** — whether any internal system-resident text-embedding `.mlmodelc` exists was not
  enumerated.
- **MLX end-to-end** — nothing installed, so no latency or quality numbers.
- **Durability/locking behaviour of `vec0` under concurrent pi processes** — not tested.
- Apple's web documentation was not fetched; all API claims come from the **headers and Swift
  interfaces shipped in the macOS 27.0 SDK on this machine**, plus runtime execution, which is
  stronger evidence than prose docs for availability questions.
