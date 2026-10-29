#!/usr/bin/env bash
# Build the nle-embed CLI with the system Swift toolchain.
#
# Deliberately no SwiftPM and no codesigning: a single .swift file plus `swiftc`
# works with Command Line Tools alone, and ad-hoc signatures are enough for a
# locally built binary that never gets copied between machines.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v swiftc >/dev/null 2>&1; then
    echo "build.sh: swiftc not found. Install Command Line Tools (xcode-select --install)." >&2
    exit 1
fi

mkdir -p bin
echo "swiftc: $(swiftc --version | head -n 1)"

# -O is required: unoptimised builds are ~10x slower per vector, which is slower
# than the `swift script.swift` path this binary exists to replace.
# -parse-as-library lets the file keep an explicit @main instead of relying on
# the implicit main-file treatment a lone .swift file would otherwise get.
swiftc -O -parse-as-library -o bin/nle-embed NLEmbed.swift

echo "built: $(cd bin && pwd)/nle-embed"
echo "size:  $(wc -c < bin/nle-embed | tr -d ' ') bytes"
file bin/nle-embed
