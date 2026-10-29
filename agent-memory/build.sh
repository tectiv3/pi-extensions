#!/usr/bin/env bash
# Build the packaged embedding CLI: ../experiments/embed/NLEmbed.swift -> bin/nle-embed.
#
# Command Line Tools are enough. A single .swift file plus `swiftc` needs no SwiftPM
# manifest, no Xcode project and no codesigning step: the linker ad-hoc signs what it
# emits, and this binary is only ever run on the machine that built it.
# Idempotent: bin/ is created if missing and the binary is overwritten every run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SRC="$(cd .. && pwd)/experiments/embed/NLEmbed.swift"
OUT="bin/nle-embed"

if ! command -v swiftc >/dev/null 2>&1; then
    echo "build.sh: swiftc not found. Install the Command Line Tools: xcode-select --install" >&2
    exit 1
fi

if [[ ! -f "$SRC" ]]; then
    echo "build.sh: source not found: $SRC" >&2
    exit 1
fi

mkdir -p bin
echo "swiftc: $(swiftc --version | head -n 1)"

# -O is required: unoptimised builds cost ~10x per vector, which is slower than the
# `swift script.swift` path this binary exists to replace.
# -parse-as-library keeps the file's explicit @main instead of the implicit main-file
# treatment a lone .swift file would otherwise get.
swiftc -O -parse-as-library -o "$OUT" "$SRC"
chmod +x "$OUT"

echo "built:  $(cd bin && pwd)/nle-embed"
echo "size:   $(wc -c < "$OUT" | tr -d ' ') bytes"
file "$OUT"
