// NLEmbed.swift — macOS-native sentence embeddings via NaturalLanguage.NLEmbedding.
//
// Single file, no SwiftPM: `swiftc -O -o bin/nle-embed NLEmbed.swift`.
//
// The point of this binary is process reuse: the sentence model costs ~0.5 s to load,
// and `swift script.swift` pays interpreter startup on every call. Loading once and
// streaming newline-delimited texts through stdin amortises both.

import Foundation
import NaturalLanguage

// MARK: - Exit codes

private enum ExitCode: Int32 {
    case ok = 0
    /// Anything other than "the model for this language is missing".
    case error = 1
    /// Requested (or detected) language has no sentence embedding model.
    case noModel = 2
}

private let stderrHandle = FileHandle.standardError
private let stdoutHandle = FileHandle.standardOutput

private func writeError(_ text: String) {
    stderrHandle.write(Data(text.utf8))
}

private func warn(_ message: String) {
    writeError("[nle-embed] warning: \(message)\n")
}

private func note(_ message: String) {
    writeError("[nle-embed] \(message)\n")
}

private func fail(_ message: String, code: ExitCode = .error) -> Never {
    writeError("[nle-embed] error: \(message)\n")
    exit(code.rawValue)
}

private func format(_ value: Double, places: Int = 2) -> String {
    String(format: "%.\(places)f", value)
}

/// Swift strings cannot be handed to C `%s`/`%d` format specifiers safely, so all
/// table padding is done here instead of in the format string.
private func pad(_ text: String, _ width: Int, alignLeft: Bool = false) -> String {
    guard text.count < width else { return text }
    let filler = String(repeating: " ", count: width - text.count)
    return alignLeft ? text + filler : filler + text
}

private func median(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    return sorted.count.isMultiple(of: 2) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

private func mean(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    return values.reduce(0, +) / Double(values.count)
}

private func monotonicNanos() -> UInt64 {
    DispatchTime.now().uptimeNanoseconds
}

// MARK: - JSON

/// Minimal JSON writer. Hand-rolled so key order and float formatting stay stable
/// (test.mjs parses this, and stable output makes README diffs meaningful).
private indirect enum JSON {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSON])
    case object([(String, JSON)])

    func render(pretty: Bool) -> String {
        var out = ""
        render(into: &out, pretty: pretty, depth: 0)
        return out
    }

    private var isScalar: Bool {
        switch self {
        case .string, .int, .double, .bool, .null: return true
        case .array, .object: return false
        }
    }

    private func render(into out: inout String, pretty: Bool, depth: Int) {
        let pad = pretty ? "\n" + String(repeating: "  ", count: depth + 1) : ""
        let closePad = pretty ? "\n" + String(repeating: "  ", count: depth) : ""
        switch self {
        case .string(let value):
            out += JSON.quote(value)
        case .int(let value):
            out += String(value)
        case .double(let value):
            out += value.isFinite ? String(format: "%.6f", value) : "null"
        case .bool(let value):
            out += value ? "true" : "false"
        case .null:
            out += "null"
        case .array(let items):
            guard !items.isEmpty else { out += "[]"; return }
            // Long numeric vectors stay on one line even in pretty mode.
            let inline = items.allSatisfy(\.isScalar)
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                if !inline { out += pad }
                item.render(into: &out, pretty: pretty, depth: depth + 1)
            }
            if !inline { out += closePad }
            out += "]"
        case .object(let members):
            guard !members.isEmpty else { out += "{}"; return }
            out += "{"
            for (index, member) in members.enumerated() {
                if index > 0 { out += "," }
                out += pad
                out += JSON.quote(member.0)
                out += pretty ? ": " : ":"
                member.1.render(into: &out, pretty: pretty, depth: depth + 1)
            }
            out += closePad
            out += "}"
        }
    }

    private static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

private func emit(_ value: JSON, pretty: Bool) {
    stdoutHandle.write(Data((value.render(pretty: pretty) + "\n").utf8))
}

// MARK: - Options

private struct Options {
    var subcommand: String
    var texts: [String] = []
    var lang: String = "en"
    var force = false
    var pretty = false
    var n = 200
}

private let usage = """
usage: nle-embed <command> [options]

commands:
  embed      read newline-delimited texts (or repeated --text) and emit one JSON object per line
  similar    embed the same input and emit a pairwise cosine similarity matrix
  bench      time N synthetic English sentences (--n, default 200)
  langs      probe which languages NLEmbedding.sentenceEmbedding supports

options:
  --text <s>     input text; repeatable, replaces stdin
  --lang <code>  BCP-47 language code of the embedding model (default en)
  --force        exit 0 even when detected language has no model / mismatches --lang
  --pretty       indent JSON output
  --n <count>    sentence count for bench (default 200)
  -h, --help     this message

exit codes: 0 ok, 2 no model for language (or language mismatch), 1 other error
"""

private func parseOptions(_ argv: [String]) -> Options {
    guard let first = argv.first else {
        writeError(usage + "\n")
        exit(ExitCode.error.rawValue)
    }
    if first == "-h" || first == "--help" {
        writeError(usage + "\n")
        exit(ExitCode.ok.rawValue)
    }
    guard !first.hasPrefix("-") else {
        writeError(usage + "\n")
        exit(ExitCode.error.rawValue)
    }
    let subcommand = first
    var options = Options(subcommand: subcommand)
    var index = 1

    func takeValue(for flag: String) -> String {
        index += 1
        guard index < argv.count else { fail("\(flag) requires a value") }
        return argv[index]
    }

    while index < argv.count {
        let argument = argv[index]
        // Support both `--lang de` and `--lang=de`.
        let flag: String
        let inlineValue: String?
        if argument.hasPrefix("--"), let equals = argument.firstIndex(of: "=") {
            flag = String(argument[argument.startIndex..<equals])
            inlineValue = String(argument[argument.index(after: equals)...])
        } else {
            flag = argument
            inlineValue = nil
        }

        switch flag {
        case "--text":
            options.texts.append(inlineValue ?? takeValue(for: "--text"))
        case "--lang":
            options.lang = inlineValue ?? takeValue(for: "--lang")
        case "--n":
            let raw = inlineValue ?? takeValue(for: "--n")
            guard let count = Int(raw), count > 0 else { fail("--n expects a positive integer, got '\(raw)'") }
            options.n = count
        case "--force":
            options.force = true
        case "--pretty":
            options.pretty = true
        case "-h", "--help":
            writeError(usage + "\n")
            exit(ExitCode.ok.rawValue)
        default:
            fail("unknown option '\(argument)'\n\n\(usage)")
        }
        index += 1
    }
    return options
}

// MARK: - Models

/// NLEmbedding is expensive to create (~0.5 s of file load), so every command goes
/// through this cache and pays the cost at most once per language.
private final class SentenceModels {
    private var models: [String: NLEmbedding] = [:]
    private var missing: Set<String> = []
    private var loadMillis: [String: Double] = [:]

    func model(for code: String) -> NLEmbedding? {
        if let cached = models[code] { return cached }
        if missing.contains(code) { return nil }

        let start = monotonicNanos()
        let embedding = NLEmbedding.sentenceEmbedding(for: NLLanguage(rawValue: code))
        let elapsed = Double(monotonicNanos() - start) / 1_000_000

        guard let embedding else {
            missing.insert(code)
            return nil
        }
        models[code] = embedding
        loadMillis[code] = elapsed
        note("loaded '\(code)' sentence model dim=\(embedding.dimension) revision=\(embedding.revision) in \(format(elapsed)) ms")
        return embedding
    }

    func loadTime(for code: String) -> Double {
        loadMillis[code] ?? 0
    }
}

// MARK: - Language helpers

private struct Detection {
    let dominant: NLLanguage?
    let dominantProbability: Double
    let requestedProbability: Double
    let code: String?

    /// NLLanguageRecognizer mislabels short English strings ("the cat sat on the mat"
    /// came back `tr=0.531 en=0.294` on macOS 27.0), so a bare dominant-language
    /// comparison would fail valid input. A mismatch only counts as a hard failure
    /// when the recognizer is both confident and does not rank the requested
    /// language as plausible; anything softer is reported as ambiguous.
    enum Verdict {
        case match
        case ambiguous
        case mismatch
        case unknown
    }

    func verdict(requested: String, tokenCount: Int) -> Verdict {
        guard let code else { return .unknown }
        if baseLanguageCode(code) == baseLanguageCode(requested) { return .match }
        let requestedIsPlausible = requestedProbability >= 0.15
        let recognizerIsConfident = dominantProbability >= 0.40
        if requestedIsPlausible || !recognizerIsConfident || tokenCount < 3 {
            return .ambiguous
        }
        return .mismatch
    }
}

/// BCP-47 subtags ("zh-Hans") should not defeat a comparison against "zh".
private func baseLanguageCode(_ code: String) -> String {
    String(code.split(separator: "-").first ?? Substring(code)).lowercased()
}

private func detectLanguage(_ text: String, requested: String) -> Detection {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    let hypotheses = recognizer.languageHypotheses(withMaximum: 5)
    let dominant = recognizer.dominantLanguage
    let requestedLanguage = NLLanguage(rawValue: requested)
    let requestedProbability = max(
        hypotheses[requestedLanguage] ?? 0,
        hypotheses.first { baseLanguageCode($0.key.rawValue) == baseLanguageCode(requested) }?.value ?? 0
    )
    return Detection(
        dominant: dominant,
        dominantProbability: dominant.flatMap { hypotheses[$0] } ?? 0,
        requestedProbability: requestedProbability,
        code: dominant?.rawValue
    )
}

private func tokenCount(_ text: String) -> Int {
    text.split(whereSeparator: { $0 == " " || $0 == "\t" }).count
}

private func cosineSimilarity(_ a: [Double], _ b: [Double]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 0 }
    var dot = 0.0
    var normA = 0.0
    var normB = 0.0
    for index in 0..<a.count {
        dot += a[index] * b[index]
        normA += a[index] * a[index]
        normB += b[index] * b[index]
    }
    let denominator = (normA.squareRoot() * normB.squareRoot())
    guard denominator > 0 else { return 0 }
    return dot / denominator
}

private func l2Norm(_ vector: [Double]) -> Double {
    vector.reduce(0) { $0 + $1 * $1 }.squareRoot()
}

private func snippet(_ text: String, limit: Int = 44) -> String {
    guard text.count > limit else { return text }
    return String(text.prefix(limit - 1)) + "…"
}

// MARK: - Input

private func readTexts(_ options: Options) -> [String] {
    if !options.texts.isEmpty { return options.texts }
    if isatty(STDIN_FILENO) == 1 {
        fail("no input: pass --text \"...\" or pipe newline-delimited text on stdin")
    }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let raw = String(data: data, encoding: .utf8) else {
        fail("stdin is not valid UTF-8")
    }
    // Blank lines carry no embedding signal; dropping them keeps indices contiguous.
    return raw
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.hasSuffix("\r") ? String($0.dropLast()) : String($0) }
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
}

// MARK: - Shared embedding pass

private struct EmbeddedText {
    let index: Int
    let text: String
    let detection: Detection
    let verdict: Detection.Verdict
    let vector: [Double]
    let norm: Double
}

private func verdictName(_ verdict: Detection.Verdict) -> String {
    switch verdict {
    case .match: return "match"
    case .ambiguous: return "ambiguous"
    case .mismatch: return "mismatch"
    case .unknown: return "unknown"
    }
}

/// Per-text language guard: for non-English input the framework silently returns
/// vectors from whatever model was loaded, which produces cosine values that look
/// plausible and mean nothing. Confident mismatches are always reported, and they
/// turn into a non-zero exit unless --force is passed.
private final class MismatchTracker {
    private(set) var hardMismatches = 0
    private var reportedHard: Set<String> = []
    private var reportedSoft: Set<String> = []

    func check(
        _ detection: Detection,
        verdict: Detection.Verdict,
        index: Int,
        text: String,
        requested: String,
        models: SentenceModels
    ) {
        switch verdict {
        case .match:
            return
        case .unknown:
            guard reportedSoft.insert("unknown").inserted else { return }
            warn("text \(index): no language detected (\(snippet(text))); assuming the '\(requested)' model applies")
        case .ambiguous:
            let code = detection.code ?? "und"
            guard reportedSoft.insert(code).inserted else { return }
            warn(
                "text \(index): ambiguous detection — top hypothesis '\(code)' "
                + "p=\(format(detection.dominantProbability, places: 3)) vs '\(requested)' "
                + "p=\(format(detection.requestedProbability, places: 3)); continuing with the '\(requested)' model"
            )
        case .mismatch:
            hardMismatches += 1
            let code = detection.code ?? "und"
            guard reportedHard.insert(code).inserted else { return }
            let availability = models.model(for: code) != nil
                ? "a '\(code)' model is available — re-run with --lang \(code)"
                : "no '\(code)' sentence embedding model exists on this system"
            warn(
                "text \(index) detected as '\(code)' "
                + "p=\(format(detection.dominantProbability, places: 3)) but the '\(requested)' model is loaded; \(availability)"
            )
            writeError(
                "[nle-embed] warning: '\(code)' text embedded with the '\(requested)' model produces "
                + "meaningless vectors — every cosine similarity below is noise. Use --force to silence this exit code.\n"
            )
        }
    }

    func finalExitCode(force: Bool) -> ExitCode {
        guard hardMismatches > 0 else { return .ok }
        return force ? .ok : .noModel
    }
}

private func embedTexts(
    _ texts: [String],
    requested: String,
    model: NLEmbedding,
    models: SentenceModels
) -> (embedded: [EmbeddedText], tracker: MismatchTracker) {
    let tracker = MismatchTracker()
    var embedded: [EmbeddedText] = []
    embedded.reserveCapacity(texts.count)

    for (index, text) in texts.enumerated() {
        let detection = detectLanguage(text, requested: requested)
        let verdict = detection.verdict(requested: requested, tokenCount: tokenCount(text))
        tracker.check(detection, verdict: verdict, index: index, text: text, requested: requested, models: models)

        let vector = model.vector(for: text) ?? []
        if vector.isEmpty {
            warn("no vector for text \(index) (\(snippet(text))) — the '\(requested)' model returned nil")
        } else if vector.count != model.dimension {
            warn("text \(index) produced \(vector.count) dims, model reports \(model.dimension)")
        }
        embedded.append(
            EmbeddedText(
                index: index,
                text: text,
                detection: detection,
                verdict: verdict,
                vector: vector,
                norm: l2Norm(vector)
            )
        )
    }
    return (embedded, tracker)
}

private func requireModel(_ models: SentenceModels, for code: String) -> NLEmbedding {
    guard let model = models.model(for: code) else {
        writeError("[nle-embed] error: no sentence embedding model for language '\(code)'\n")
        writeError("[nle-embed] error: run `nle-embed langs` to list supported languages\n")
        exit(ExitCode.noModel.rawValue)
    }
    return model
}

// MARK: - embed

private func runEmbed(_ options: Options) -> ExitCode {
    let models = SentenceModels()
    let model = requireModel(models, for: options.lang)
    let texts = readTexts(options)
    guard !texts.isEmpty else { fail("no non-empty input texts") }

    let (embedded, tracker) = embedTexts(texts, requested: options.lang, model: model, models: models)

    for item in embedded {
        emit(
            .object([
                ("i", .int(item.index)),
                ("text", .string(item.text)),
                ("lang", item.detection.code.map { JSON.string($0) } ?? .null),
                ("langConfidence", .double(item.detection.dominantProbability)),
                ("langCheck", .string(verdictName(item.verdict))),
                ("dim", .int(item.vector.count)),
                ("norm", .double(item.norm)),
                ("vector", .array(item.vector.map { JSON.double($0) })),
            ]),
            pretty: options.pretty
        )
    }
    return tracker.finalExitCode(force: options.force)
}

// MARK: - similar

private func runSimilar(_ options: Options) -> ExitCode {
    let models = SentenceModels()
    let model = requireModel(models, for: options.lang)
    let texts = readTexts(options)
    guard texts.count >= 2 else { fail("similar needs at least 2 texts, got \(texts.count)") }

    let (embedded, tracker) = embedTexts(texts, requested: options.lang, model: model, models: models)
    let usable = embedded.filter { !$0.vector.isEmpty }
    guard usable.count >= 2 else { fail("fewer than 2 texts produced a vector") }

    var pairs: [(Int, Int, Double)] = []
    for first in 0..<usable.count {
        for second in (first + 1)..<usable.count {
            let similarity = cosineSimilarity(usable[first].vector, usable[second].vector)
            pairs.append((usable[first].index, usable[second].index, similarity))
        }
    }

    var seenLangs: [String] = []
    for item in embedded {
        let code = item.detection.code ?? "und"
        if !seenLangs.contains(code) { seenLangs.append(code) }
    }
    var dims: [Int] = []
    for item in usable where !dims.contains(item.vector.count) {
        dims.append(item.vector.count)
    }

    emit(
        .object([
            ("langs", .array(seenLangs.map { JSON.string($0) })),
            ("model", .string(options.lang)),
            ("dims", .array(dims.map { JSON.int($0) })),
            ("count", .int(embedded.count)),
            ("texts", .array(embedded.map { JSON.string($0.text) })),
            ("pairs", .array(pairs.map { JSON.array([.int($0.0), .int($0.1), .double($0.2)]) })),
        ]),
        pretty: options.pretty
    )

    // Human-readable matrix on stderr so stdout stays machine-parseable.
    writeError("similarity matrix — model '\(options.lang)', \(usable.count) texts\n")
    if dims.count == 1 {
        writeError("dims: \(dims[0])\n")
    }
    writeError(pad("", 8))
    for item in usable { writeError(pad(String(item.index), 8)) }
    writeError("\n")
    for row in usable {
        writeError(pad(String(row.index), 6) + "  ")
        for column in usable {
            let value = row.index == column.index
                ? 1.0
                : cosineSimilarity(row.vector, column.vector)
            writeError(" " + pad(format(value, places: 4), 7))
        }
        writeError("   \(snippet(row.text))\n")
    }
    writeError("\npairs:\n")
    for pair in pairs {
        writeError("  [\(pair.0),\(pair.1)] \(format(pair.2, places: 4))\n")
    }
    return tracker.finalExitCode(force: options.force)
}

// MARK: - bench

private struct LinearCongruential {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next(upperBound: Int) -> Int {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Int((state >> 33) % UInt64(upperBound))
    }
}

private func syntheticSentences(_ count: Int) -> [String] {
    let subjects = [
        "the engineer", "a researcher", "the parser", "our compiler", "the reviewer",
        "the retrieval pipeline", "a nightly job", "the index builder", "the scheduler",
        "an intern", "the analyzer", "our test harness",
    ]
    let verbs = [
        "optimizes", "reviews", "rewrites", "benchmarks", "documents", "profiles",
        "rewires", "summarizes", "validates", "caches",
    ]
    let objects = [
        "the latency budget", "the tokenizer", "the embedding cache", "the build graph",
        "the regression suite", "the memory profile", "the query planner", "the shard layout",
        "the serialization format", "the warmup path",
    ]
    let tails = [
        "before the release", "on a cold cache", "during the nightly build", "under load",
        "when the disk is full", "after the migration", "in the staging cluster",
        "while the queue drains", "for the second time today", "at peak throughput",
    ]

    var rng = LinearCongruential(seed: 0x5EED_1234)
    return (0..<count).map { _ in
        let subject = subjects[rng.next(upperBound: subjects.count)]
        let verb = verbs[rng.next(upperBound: verbs.count)]
        let object = objects[rng.next(upperBound: objects.count)]
        let tail = tails[rng.next(upperBound: tails.count)]
        return "\(subject) \(verb) \(object) \(tail)."
    }
}

private func runBench(_ options: Options) -> ExitCode {
    let models = SentenceModels()
    let model = requireModel(models, for: options.lang)
    let sentences = syntheticSentences(options.n)
    let modelLoadMillis = models.loadTime(for: options.lang)

    var durations: [Double] = []
    durations.reserveCapacity(sentences.count)

    let wallStart = monotonicNanos()
    var firstCallMillis = 0.0
    for (index, sentence) in sentences.enumerated() {
        let start = monotonicNanos()
        _ = model.vector(for: sentence)
        let elapsed = Double(monotonicNanos() - start) / 1_000_000
        if index == 0 { firstCallMillis = elapsed }
        durations.append(elapsed)
    }
    let totalMillis = Double(monotonicNanos() - wallStart) / 1_000_000
    let totalSeconds = totalMillis / 1000

    let medianMillis = median(durations)
    let meanMillis = mean(durations)
    let textsPerSecond = totalSeconds > 0 ? Double(sentences.count) / totalSeconds : 0
    let p95 = durations.sorted()[min(durations.count - 1, Int(Double(durations.count) * 0.95))]

    emit(
        .object([
            ("lang", .string(options.lang)),
            ("dim", .int(model.dimension)),
            ("n", .int(sentences.count)),
            ("median_ms_per_text", .double(medianMillis)),
            ("mean_ms_per_text", .double(meanMillis)),
            ("p95_ms_per_text", .double(p95)),
            ("texts_per_sec", .double(textsPerSecond)),
            ("total_wall_ms", .double(totalMillis)),
            ("first_call_ms", .double(firstCallMillis)),
            ("model_load_ms", .double(modelLoadMillis)),
        ]),
        pretty: options.pretty
    )

    writeError("bench — \(sentences.count) synthetic '\(options.lang)' sentences, dim \(model.dimension)\n")
    writeError("  model load      \(format(modelLoadMillis)) ms (outside the timed loop)\n")
    writeError("  first call      \(format(firstCallMillis)) ms (cold ANE/GPU path)\n")
    writeError("  median          \(format(medianMillis, places: 3)) ms/text\n")
    writeError("  mean            \(format(meanMillis, places: 3)) ms/text\n")
    writeError("  p95             \(format(p95, places: 3)) ms/text\n")
    writeError("  total wall      \(format(totalMillis)) ms\n")
    writeError("  throughput      \(format(textsPerSecond, places: 1)) texts/sec\n")
    return .ok
}

// MARK: - langs

private func runLangs(_ options: Options) -> ExitCode {
    let candidates = [
        "en", "fr", "de", "es", "it", "pt", "nl", "zh", "ja", "ru",
        "ko", "ar", "tr", "sv", "da", "fi", "nb", "pl", "cs", "hi",
        "he", "th", "vi", "uk", "el", "ro", "hu", "id", "ms",
    ]

    var entries: [(String, JSON)] = []
    var available: [String] = []

    func row(_ cells: [String]) -> String {
        let widths = [6, 10, 5, 5, 6, 8, 10]
        var line = ""
        for (index, cell) in cells.enumerated() {
            line += index == 0 ? pad(cell, widths[index], alignLeft: true) : pad(cell, widths[index])
            if index < cells.count - 1 { line += " " }
        }
        return line + "\n"
    }

    writeError("sentence embedding availability (NLEmbedding.sentenceEmbedding)\n")
    writeError(row(["lang", "status", "dim", "rev", "revs", "vocab", "revisions"]))

    for code in candidates {
        let language = NLLanguage(rawValue: code)
        let revisions = NLEmbedding.supportedSentenceEmbeddingRevisions(for: language)
        let model = NLEmbedding.sentenceEmbedding(for: language)

        if let model {
            available.append(code)
            writeError(row([
                code, "available", String(model.dimension), String(model.revision),
                String(revisions.count), String(model.vocabularySize),
                revisions.map(String.init).joined(separator: ","),
            ]))
            entries.append((
                code,
                .object([
                    ("code", .string(code)),
                    ("available", .bool(true)),
                    ("dim", .int(model.dimension)),
                    ("revision", .int(model.revision)),
                    ("revisionCount", .int(revisions.count)),
                    ("revisions", .array(revisions.map { JSON.int($0) })),
                    ("vocabularySize", .int(model.vocabularySize)),
                ])
            ))
        } else {
            writeError(row([code, "none", "-", "-", String(revisions.count), "-", "-"]))
            entries.append((
                code,
                .object([
                    ("code", .string(code)),
                    ("available", .bool(false)),
                    ("dim", .null),
                    ("revision", .null),
                    ("revisionCount", .int(revisions.count)),
                    ("revisions", .array(revisions.map { JSON.int($0) })),
                    ("vocabularySize", .null),
                ])
            ))
        }
    }

    emit(
        .object([
            ("requestedLang", .string(options.lang)),
            ("available", .array(available.map { JSON.string($0) })),
            ("candidates", .int(candidates.count)),
            ("langs", .array(entries.map { $0.1 })),
        ]),
        pretty: options.pretty
    )
    writeError("\n\(available.count)/\(candidates.count) candidates available: \(available.joined(separator: " "))\n")
    return .ok
}

// MARK: - Entry point

@main
private struct NLEmbedCLI {
    static func main() {
        let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
        let code: ExitCode
        switch options.subcommand {
        case "embed": code = runEmbed(options)
        case "similar": code = runSimilar(options)
        case "bench": code = runBench(options)
        case "langs": code = runLangs(options)
        default:
            fail("unknown command '\(options.subcommand)'\n\n\(usage)")
        }
        exit(code.rawValue)
    }
}
