import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { EMBED_DIM } from '../index/db.ts'
import {
    type EmbedRunRequest,
    type EmbedRunResult,
    embedBatch,
    embedderAvailable,
    isHardMismatch,
    resetEmbedderProbe,
    resolveEmbedBin,
    toWireText,
} from './cli.ts'

function tempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-embed-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/** A JSONL line shaped like the real CLI's, with a 512-dim vector tagged by `i`. */
function line(
    i: number,
    options: {
        lang?: string
        langConfidence?: number
        langCheck?: string
        dim?: number
        vector?: number[]
    } = {}
): string {
    const vector =
        options.vector ??
        Array.from({ length: options.dim ?? EMBED_DIM }, (_, index) =>
            index === 0 ? i + 1 : 0.25
        )
    return JSON.stringify({
        i,
        text: `text ${i}`,
        lang: options.lang ?? 'en',
        langConfidence: options.langConfidence ?? 0.99,
        langCheck: options.langCheck ?? 'match',
        dim: options.dim ?? EMBED_DIM,
        norm: 7.5,
        vector,
    })
}

interface FakeRunner {
    calls: EmbedRunRequest[]
    runner: (request: EmbedRunRequest) => Promise<EmbedRunResult>
}

function fakeRunner(
    respond: (request: EmbedRunRequest) => Partial<EmbedRunResult> & { stdout: string }
): FakeRunner {
    const calls: EmbedRunRequest[] = []
    return {
        calls,
        async runner(request) {
            calls.push(request)
            const result = respond(request)
            return { status: 0, stderr: '', ...result }
        },
    }
}

// ---------------------------------------------------------------------------
// batching
// ---------------------------------------------------------------------------

test('embedBatch spawns once for five texts and aligns vectors to the input', async t => {
    t.after(resetEmbedderProbe)
    const fake = fakeRunner(request => ({
        // Five inputs in one process: this is the whole point of the batch seam.
        stdout: request.input
            .split('\n')
            .filter(text => text !== '')
            .map((_, index) => line(index))
            .join('\n'),
    }))

    const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const vectors = await embedBatch(texts, { runner: fake.runner })

    assert.equal(fake.calls.length, 1)
    assert.ok(vectors !== null)
    assert.equal(vectors.length, texts.length)
    vectors.forEach((vector, index) => {
        assert.ok(vector instanceof Float32Array, `vector ${index} is not a Float32Array`)
        assert.equal(vector.length, EMBED_DIM)
        assert.equal(vector[0], index + 1)
    })
    assert.equal(fake.calls[0].args[0], 'embed')
    assert.equal(fake.calls[0].args[2], 'en')
    assert.equal(fake.calls[0].input.split('\n').filter(text => text !== '').length, 5)
})

test('embedBatch reports null when the binary is absent, without throwing', async t => {
    const dir = tempDir(t)
    const vectors = await embedBatch(['anything'], {
        binPath: path.join(dir, 'missing-nle-embed'),
        timeoutMs: 5_000,
    })
    assert.equal(vectors, null)

    resetEmbedderProbe()
    t.after(resetEmbedderProbe)
    assert.equal(
        embedderAvailable({ binPath: path.join(dir, 'missing-nle-embed') }),
        false,
        'a missing binary must probe as unavailable'
    )
})

test('a newline in the embed text never becomes a second stdin line', () => {
    assert.equal(
        toWireText('auth/session\nrefresh happens hourly'),
        'auth/session refresh happens hourly'
    )
    assert.equal(toWireText('  \r\n spaced \r\n text \n'), 'spaced text')
})

// ---------------------------------------------------------------------------
// language guard (§8.2)
// ---------------------------------------------------------------------------

test('a hard language mismatch drops that vector without a warning', async () => {
    const fake = fakeRunner(() => ({
        stdout: [
            line(0, { langCheck: 'match' }),
            line(1, { lang: 'de', langConfidence: 1, langCheck: 'mismatch' }),
        ].join('\n'),
    }))
    const warnings: string[] = []
    const vectors = await embedBatch(['the build finished', 'die katzen sitzen hier'], {
        runner: fake.runner,
        onWarning: text => warnings.push(text),
    })

    assert.ok(vectors !== null)
    assert.ok(vectors[0] instanceof Float32Array)
    assert.equal(vectors[1], null, 'a mismatch must not be embedded silently')
    assert.deepEqual(
        warnings,
        [],
        `a refused vector is expected, not a warning: ${warnings.join(' | ')}`
    )
})

test('the language guard honours langCheck and falls back to the numeric rule', () => {
    assert.equal(isHardMismatch({ langCheck: 'mismatch' }, 'one two three'), true)
    assert.equal(
        isHardMismatch({ langCheck: 'ambiguous', lang: 'tr' }, 'one two three'),
        false
    )
    // No `langCheck` field at all: top hypothesis ≥ 0.40, non-en, ≥ 3 tokens.
    assert.equal(isHardMismatch({ lang: 'de', langConfidence: 0.9 }, 'eins zwei drei'), true)
    assert.equal(isHardMismatch({ lang: 'de', langConfidence: 0.9 }, 'eins zwei'), false)
    assert.equal(isHardMismatch({ lang: 'en', langConfidence: 0.3 }, 'one two three'), false)
    // Short English is routinely misdetected as Turkish (measured); 3+ tokens is the
    // threshold that stops the guard from rejecting it.
    assert.equal(
        isHardMismatch({ lang: 'tr', langConfidence: 0.531 }, 'the cat sat on the mat'),
        true
    )
})

// ---------------------------------------------------------------------------
// partial and failed batches
// ---------------------------------------------------------------------------

test('a garbage line yields null in its own slot without shifting later vectors', async () => {
    const fake = fakeRunner(() => ({
        stdout: [line(0), 'not json at all', line(2)].join('\n'),
    }))
    const warnings: string[] = []
    const vectors = await embedBatch(['one', 'two', 'three'], {
        runner: fake.runner,
        onWarning: text => warnings.push(text),
    })

    assert.ok(vectors !== null)
    assert.equal(vectors[0]?.[0], 1)
    assert.equal(vectors[1], null, 'the garbage line must not receive the next vector')
    assert.equal(vectors[2]?.[0], 3)
    assert.ok(warnings.some(text => /2 of 3 vectors/.test(text)))
})

test('a truncated batch leaves the missing texts null and the rest usable', async () => {
    const fake = fakeRunner(() => ({ stdout: [line(0), line(1)].join('\n') }))
    const vectors = await embedBatch(['one', 'two', 'three'], { runner: fake.runner })

    assert.ok(vectors !== null)
    assert.equal(vectors.length, 3)
    assert.ok(vectors[0] instanceof Float32Array)
    assert.ok(vectors[1] instanceof Float32Array)
    assert.equal(vectors[2], null)
})

test('exit 2 keeps the output (the CLI writes it before exiting), exit 1 does not', async () => {
    const mismatch = fakeRunner(() => ({
        status: 2,
        stdout: line(0, { langCheck: 'ambiguous' }),
        stderr: [
            "[nle-embed] warning: text 0: ambiguous detection — top hypothesis 'tr' p=0.531 vs 'en' p=0.294; continuing with the 'en' model",
            "[nle-embed] warning: text 0 detected as 'hu' p=0.999 but the 'en' model is loaded; no 'hu' sentence embedding model exists on this system",
            "[nle-embed] warning: text 0: no language detected (the cat sat…); assuming the 'en' model applies",
            "[nle-embed] warning: 'hu' text embedded with the 'en' model produces meaningless vectors — every cosine similarity below is noise. Use --force to silence this exit code.",
            // Batch-level stderr must survive the per-text filter.
            '[nle-embed] warning: model load failed, retrying once',
        ].join('\n'),
    }))
    const warnings: string[] = []
    const vectors = await embedBatch(['the cat sat on the mat'], {
        runner: mismatch.runner,
        onWarning: text => warnings.push(text),
    })
    assert.ok(vectors !== null)
    assert.ok(vectors[0] instanceof Float32Array)
    assert.ok(
        warnings.some(text => /model load failed/.test(text)),
        `an unrelated warning was swallowed: ${warnings.join(' | ')}`
    )
    assert.ok(
        !warnings.some(text =>
            /ambiguous detection|detected as|no language detected|meaningless vectors/.test(
                text
            )
        ),
        `per-text language diagnostics reached the transcript: ${warnings.join(' | ')}`
    )

    const failed = fakeRunner(() => ({ status: 1, stdout: '', stderr: 'boom' }))
    assert.equal(await embedBatch(['x'], { runner: failed.runner }), null)
})

test('every language-diagnostic shape is filtered; other warnings are not', async () => {
    const diagnostics = [
        "[nle-embed] warning: text 1 detected as 'hu' p=0.999 but the 'en' model is loaded; no 'hu' sentence embedding model exists on this system",
        "[nle-embed] warning: text 1: ambiguous detection — top hypothesis 'tr' p=0.531 vs 'en' p=0.294; continuing with the 'en' model",
        "[nle-embed] warning: 'hu' text embedded with the 'en' model produces meaningless vectors — every cosine similarity below is noise. Use --force to silence this exit code.",
    ]
    const unrelated = [
        '[nle-embed] warning: failed to load the en model; falling back to the system default',
        '[nle-embed] warning: model download timed out after 30 s',
    ]
    const fake = fakeRunner(() => ({
        stdout: line(0),
        stderr: [...diagnostics, ...unrelated].join('\n'),
    }))
    const warnings: string[] = []
    const vectors = await embedBatch(['a single english text'], {
        runner: fake.runner,
        onWarning: text => warnings.push(text),
    })

    assert.ok(vectors?.[0] instanceof Float32Array)
    assert.deepEqual(
        warnings,
        unrelated.map(text => text.replace(/^\[nle-embed\]\s*/i, '')),
        `only the language diagnostics may be dropped: ${warnings.join(' | ')}`
    )
})

test('a wrong-dimension vector is a per-line failure, not a batch failure', async () => {
    const fake = fakeRunner(() => ({
        stdout: [line(0), line(1, { dim: 640 })].join('\n'),
    }))
    const vectors = await embedBatch(['one', 'two'], { runner: fake.runner })
    assert.ok(vectors !== null)
    assert.ok(vectors[0] instanceof Float32Array)
    assert.equal(vectors[1], null)
})

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

test(
    'embedderAvailable probes once and caches the answer',
    { skip: process.platform !== 'darwin' },
    t => {
        resetEmbedderProbe()
        t.after(resetEmbedderProbe)

        let probes = 0
        const options = {
            // An existing, executable file so the fs.access gate passes; the probe runner
            // stands in for the binary itself.
            binPath: process.execPath,
            probeRunner: () => {
                probes++
                return { status: 0, stdout: line(0), stderr: '' }
            },
        }
        assert.equal(embedderAvailable(options), true)
        assert.equal(embedderAvailable(options), true)
        assert.equal(probes, 1, 'the probe must be cached, not run per call')
    }
)

test('resolveEmbedBin prefers an explicit path over the packaged candidates', () => {
    assert.equal(resolveEmbedBin('/tmp/explicit/nle-embed'), '/tmp/explicit/nle-embed')
    assert.equal(typeof resolveEmbedBin(), 'string')
})

// ---------------------------------------------------------------------------
// the real binary, when this machine has one (§8.1)
// ---------------------------------------------------------------------------

const REAL_BIN = path.resolve('experiments/embed/bin/nle-embed')

test(
    'the real binary embeds a batch through the same code path',
    { skip: !fs.existsSync(REAL_BIN) },
    async () => {
        const vectors = await embedBatch(
            ['The cat sat on the mat', 'The build finished in four minutes'],
            { binPath: REAL_BIN, timeoutMs: 20_000 }
        )
        assert.ok(vectors !== null, 'the real binary produced no vectors')
        assert.equal(vectors.length, 2)
        for (const vector of vectors) {
            assert.ok(vector instanceof Float32Array)
            assert.equal(vector.length, EMBED_DIM)
        }
        // Unnormalised NLEmbedding output (norms 6.2–9.3) is what the store normalises.
        assert.ok(Math.hypot(...(vectors[0] ?? new Float32Array())) > 0)
    }
)
