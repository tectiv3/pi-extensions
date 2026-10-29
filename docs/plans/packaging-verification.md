# Packaging verification — npm quarantine & `vec0.dylib` arch matrix

Two open questions from `agent-memory-spec.md` / `fork-feasibility.md`, closed by measurement.
Everything below was run on the target machine in a scratch `/tmp` project; every verdict is
backed by pasted output. Nothing here is inferred from documentation.

## TL;DR — verdicts

| Question | Answer | Confidence |
|---|---|---|
| Does `npm install` set `com.apple.quarantine` on shipped Mach-O binaries? | **No.** Registry, local `file:` tarball, HTTP-served tarball, and `git+file://` installs all produce a binary with **only** `com.apple.provenance`, never `com.apple.quarantine` | measured |
| Does the installed binary execute? | **Yes** — `nle-embed` embedded real text and `esbuild --version` ran, from all four install paths | measured |
| Is an `xattr -d com.apple.quarantine` step needed in the extension? | **No** | measured |
| What *does* quarantine a copied binary? | A **quarantined archive** extracted by `/usr/bin/tar`(bsdtar) or `ditto`. Then execution is **killed** (`exit 137`). npm never does this because npm writes extracted files itself in JS | measured |
| `nixpkgs#sqlite-vec` on this pin: arch? | `aarch64-darwin` only. `lib.platforms.darwin` = `["aarch64-darwin"]`; nixpkgs 26.11 **throws** on `--system x86_64-darwin` | measured |
| Does nixpkgs provide `x86_64-darwin` sqlite-vec? | Not on this pin. On the `nixpkgs-26.05-darwin` branch it evaluates (**v0.1.6**, older than 0.1.9) and the output is substitutable from `cache.nixos.org` (HTTP 200 narinfo) | measured |
| Does the **npm** `sqlite-vec` package solve the arch problem? | **Yes.** It ships `darwin-arm64` *and* `darwin-x64` as `optionalDependencies`, npm installs only the matching one, and `index.cjs` picks it at runtime via `process.platform`/`process.arch` + `require.resolve` | measured |
| Is a second arch matrix entry needed in the extension? | **No** — as long as the extension depends on the npm `sqlite-vec` package instead of vendoring a dylib | measured |

---

## Environment

```
sw_vers           macOS 27.0 (build 26A428)
uname -m          arm64
node --version    v24.21.0        (sqlite 3.53.3, per node:sqlite)
npm --version     11.19.0
pnpm --version    12.9.0
nixpkgs pin       /nix/store/bad1m36njkzkk7k0b4n6nh5806l5hz9g-glw7ngr0dwbp3al07rdlqkrbas7w3a02-source  (26.11 train)
```

All scratch projects were created under `/tmp`, and removed at the end.

---

# Q1 — Does npm extraction set `com.apple.quarantine`?

## 1.1 A real registry package that ships a macOS native binary

`sqlite-vec@0.1.9` (ships a `.dylib`) and `esbuild@0.28.2` (ships a Mach-O executable) were
installed into two empty `/tmp` projects.

```console
$ cd /tmp/q1a && npm init -y && npm install sqlite-vec
added 2 packages, and audited 3 packages in 2s

$ cd /tmp/q1b && npm init -y && npm install esbuild
added 2 packages, and audited 3 packages in 1s
```

Extracted artefacts:

```console
$ file node_modules/sqlite-vec-darwin-arm64/vec0.dylib
node_modules/sqlite-vec-darwin-arm64/vec0.dylib: Mach-O 64-bit dynamically linked shared library arm64

$ xattr -p com.apple.quarantine node_modules/sqlite-vec-darwin-arm64/vec0.dylib
xattr: node_modules/sqlite-vec-darwin-arm64/vec0.dylib: No such xattr: com.apple.quarantine
exit=1

$ xattr -l node_modules/sqlite-vec-darwin-arm64/vec0.dylib
com.apple.provenance:
exit=0

# every file in the whole install tree, xattr lines de-duplicated:
$ find node_modules -type f -exec xattr -l {} \; | sort | uniq -c
   9 com.apple.provenance:
# files carrying com.apple.quarantine anywhere in node_modules:
        0
```

```console
$ file node_modules/@esbuild/darwin-arm64/bin/esbuild
node_modules/@esbuild/darwin-arm64/bin/esbuild: Mach-O 64-bit executable arm64

$ xattr -l node_modules/@esbuild/darwin-arm64/bin/esbuild
com.apple.provenance:
$ xattr -p com.apple.quarantine node_modules/@esbuild/darwin-arm64/bin/esbuild
xattr: .../node_modules/@esbuild/darwin-arm64/bin/esbuild: No such xattr: com.apple.quarantine
exit=1
```

### `com.apple.provenance` is noise, not evidence

It is set on **every** file written on this machine, including a plain `echo` redirect:

```console
$ echo hi > /tmp/provtest.txt && xattr -l /tmp/provtest.txt
com.apple.provenance:
$ cp .../experiments/embed/bin/nle-embed /tmp/nle-copy && xattr -l /tmp/nle-copy
com.apple.provenance:
$ xattr -l experiments/embed/bin/nle-embed        # the repo's locally built binary
com.apple.provenance:
```

So `com.apple.provenance` appears on npm-extracted files, `cp`-ed files, and locally compiled
files alike. Only the presence/absence of `com.apple.quarantine` is diagnostic.

## 1.2 The same binary, shipped by us in a packed tarball

A minimal package was packed from the repo's compiled `nle-embed`:

```console
$ cat /tmp/q1pkg/package.json
{ "name": "nle-embed-test", "version": "0.0.1", "bin": { "nle-embed": "bin/nle-embed" } }

$ cd /tmp/q1pkg && npm pack
npm notice total files: 2
nle-embed-test-0.0.1.tgz

$ tar -tvzf nle-embed-test-0.0.1.tgz          # mode survives the tarball
-rwxr-xr-x  0 0      0      162696 Oct 26  1985 package/bin/nle-embed
-rw-r--r--  0 0      0          90 Oct 26  1985 package/package.json
```

### (a) `file:` install

```console
$ cd /tmp/q1file && npm install /tmp/q1pkg/nle-embed-test-0.0.1.tgz
added 1 package, and audited 2 packages in 654ms

$ ls -l node_modules/nle-embed-test/bin
-rwxr-xr-x  1 fenrir  wheel  162696  nle-embed
$ file node_modules/nle-embed-test/bin/nle-embed
node_modules/nle-embed-test/bin/nle-embed: Mach-O 64-bit executable arm64

$ xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed
xattr: ...: No such xattr: com.apple.quarantine        exit=1
$ xattr -l node_modules/nle-embed-test/bin/nle-embed
com.apple.provenance:
```

### (b) HTTP install — the "downloaded over the network" case

A throwaway `python3 -m http.server` on `127.0.0.1:8731` served the tarball, then was killed.

```console
$ python3 -m http.server 8731 &      # pid 36179
$ curl -sI http://127.0.0.1:8731/nle-embed-test-0.0.1.tgz | head -1
HTTP/1.0 200 OK

$ cd /tmp/q1http && npm install "http://127.0.0.1:8731/nle-embed-test-0.0.1.tgz"
added 1 package, and audited 2 packages in 618ms

$ xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed
xattr: ...: No such xattr: com.apple.quarantine        exit=1
$ xattr -l node_modules/nle-embed-test/bin/nle-embed
com.apple.provenance:

$ kill %1 ; wait ; pgrep -fl http.server
no http.server running
```

### (c) `git+file://` install

```console
$ cd /tmp/q1gitrepo && git init -q . && git add -A && git commit -qm init
$ cd /tmp/q1git && npm install "git+file:///tmp/q1gitrepo"
added 1 package, and audited 2 packages in 1s

$ file node_modules/nle-embed-test/bin/nle-embed
node_modules/nle-embed-test/bin/nle-embed: Mach-O 64-bit executable arm64
$ xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed
xattr: ...: No such xattr: com.apple.quarantine        exit=1
$ xattr -l node_modules/nle-embed-test/bin/nle-embed
com.apple.provenance:
```

### (d) pnpm `file:` install

```console
$ cd /tmp/q1pnpm && pnpm add /tmp/q1pkg/nle-embed-test-0.0.1.tgz
Done in 459ms using pnpm v12.9.0
$ B=$(find node_modules/.pnpm -name nle-embed -type f | head -1)
$ file "$B"   -> Mach-O 64-bit executable arm64
$ xattr -p com.apple.quarantine "$B"
xattr: ...: No such xattr: com.apple.quarantine        exit=1
$ xattr -l "$B"
com.apple.provenance:
```

## 1.3 Does npm have any quarantine code at all?

```console
$ readlink -f "$(which npm)"
/nix/store/j4b3g1aycfi1ngf6b2plkzw8i3fjfydg-nodejs-slim-24.21.0-npm/lib/node_modules/npm/bin/npm-cli.js
$ node -e 'console.log(require("<that>/package.json").version)'
11.19.0

$ grep -ril -E "quarantine|LSFileQuarantineEnabled|xattr" <npm-package-root>
(no output — 0 files)

$ ls <npm-package-root>/node_modules | grep -E "^(tar|pacote|cacache)$"
cacache
pacote
tar
```

npm's dependency set includes `tar`, `pacote`, `cacache`, and the bundled `tar` unpacker's
documented job is mode handling — `unpack.js` exposes `preservePaths`, `dmode`, `fmode`,
`chmod` — with **no xattr code path** (`grep -rn "xattr|quarantine" <npm>/node_modules` → empty).

`com.apple.quarantine` is set by the *downloading application* when it opts into
`LSFileQuarantineEnabled`, not by the kernel on network I/O. Confirmation from this machine's own
`~/Downloads`, where files saved by real download agents carry it and plain `curl`/`cp` output
does not:

```console
~/Downloads/1000_F_1307840149_...jpg
com.apple.quarantine: 0281;69f559c4;;35ACF81A-6909-45A3-93BC-87BBD2F71860
~/Downloads/2026-02-02 09.45.32.jpg
com.apple.quarantine: 0083;6980723f;Telegram;
~/Downloads/foxsay-main.zip
com.apple.metadata:kMDItemWhereFroms: ... https://codeload.github.com/...
com.apple.provenance:
(no com.apple.quarantine on the curl/cp-produced files in /tmp)
```

## 1.4 The binaries actually *run* — not just "exist"

Quarantine matters only because it blocks execution, so every install was executed.

```console
# registry install, sqlite-vec dylib loaded into node:sqlite (see Q2.3 for the full script)
vec_version() -> v0.1.9
KNN rows: [{"id":1,"distance":0.05000000074505806},{"id":3,"distance":0.11180341988801956},{"id":4,"distance":0.6726812124252319}]

# registry install, esbuild Mach-O binary
$ ./node_modules/@esbuild/darwin-arm64/bin/esbuild --version
0.28.2                                              exec exit=0
$ ./node_modules/.bin/esbuild --version
0.28.2                                              helper exec exit=0

# local file: tarball
$ ./node_modules/nle-embed-test/bin/nle-embed
usage: nle-embed <command> [options] ...             exec exit=1 (no args)

# HTTP-served tarball  (real inference, not just a usage banner)
$ echo "the quick brown fox" | ./node_modules/nle-embed-test/bin/nle-embed embed
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 31.15 ms
{"i":0,"text":"the quick brown fox","lang":"en","langConfidence":0.739189,"langCheck":"match","dim":512,"norm":9.215354,"vector":[0.196289,...]}
exec exit=0

# git+file:// install
$ echo "hello git install" | ./node_modules/nle-embed-test/bin/nle-embed embed
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 16.11 ms
{"i":0,"text":"hello git install",...,"dim":512,"norm":8.603144,...}   exec exit=0

# pnpm file: install
$ echo "pnpm install test" | "$B" embed
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 11.83 ms
{"i":0,...}                                          exec exit=0

# the repo's own locally built binary
$ echo "repo binary direct" | ./experiments/embed/bin/nle-embed embed
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 18.67 ms
{"i":0,...}                                          exec exit=0
```

## 1.5 The contrast case — what *does* quarantine, and what it costs

Quarantine propagates from a **quarantined archive** through `ditto` and `/usr/bin/tar`. Distributing
the same binary as a zip looks like this:

```console
$ ditto -c -k nle-embed plain.zip
$ xattr -w com.apple.quarantine "0083;69f559c4;Safari;" plain.zip     # as a browser download would
$ xattr -p com.apple.quarantine plain.zip
0083;69f559c4;Safari;

$ mkdir outz && ditto -x -k plain.zip outz
$ xattr -p com.apple.quarantine outz/nle-embed
0083;6ae3143a;;                                    exit=0   <- propagated, new stamp, no agent
$ ./outz/nle-embed
exec exit=137                                      <- killed by Gatekeeper
```

`/usr/bin/tar` (bsdtar) behaves the same on a quarantined **tarball**:

```console
$ xattr -w com.apple.quarantine "0083;69f559c4;Safari;" nle-embed-test-0.0.1.tgz
$ tar -xzf nle-embed-test-0.0.1.tgz -C /tmp/q1tgzout
$ xattr -l /tmp/q1tgzout/package/bin/nle-embed
com.apple.provenance:
com.apple.quarantine: 0083;6ae3142f;;              <- propagated
```

But **npm's own extraction does not**, even when handed a quarantined tarball:

```console
$ cp nle-embed-test-0.0.1.tgz downloaded.tgz
$ xattr -w com.apple.quarantine "0083;69f559c4;Safari;" downloaded.tgz
$ xattr -p com.apple.quarantine downloaded.tgz
0083;69f559c4;Safari;

$ cd /tmp/q1q && npm install ./downloaded.tgz
added 1 package, and audited 2 packages in 651ms

$ xattr -l node_modules/nle-embed-test/bin/nle-embed
com.apple.provenance:
$ xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed
xattr: ...: No such xattr: com.apple.quarantine    exit=1

$ echo "quarantine propagation probe" | node_modules/nle-embed-test/bin/nle-embed embed
[nle-embed] loaded 'en' sentence model dim=512 revision=1 in 11.98 ms
{"i":0,"text":"quarantine propagation probe",...,"langCheck":"matc..."}   exec exit=0
```

The mechanism is now pinned down: `ditto`/bsdtar forward xattrs from archive to member; npm
decompresses the tarball stream and **writes each file itself** with plain `fs` calls, so no
xattr of the container is inherited. That is why npm installs are immune regardless of how the
`.tgz` arrived on disk.

## 1.6 Q1 verdict

**No `xattr` step is needed anywhere in the extension's install path.** Per install path:

| Install path | Quarantine on `bin/nle-embed` / `vec0.dylib` | Executes | Measured in |
|---|---|---|---|
| npm registry (`npm i <pkg>`) | none | yes | 1.1, 1.4 |
| npm local tarball (`npm i ./x.tgz`) | none | yes | 1.2a, 1.4 |
| npm HTTP tarball (`npm i http://…/x.tgz`) | none | yes | 1.2b, 1.4 |
| npm git install (`npm i git+file://…`) | none | yes | 1.2c, 1.4 |
| pnpm local tarball | none | yes | 1.2d, 1.4 |
| `pi install npm:<pkg>` | none (same npm code path) | not run end-to-end — **derived**, see below | source read |
| `pi install git:<repo>` / `pi install ./local` | none (clone / no copy) | not run end-to-end — **derived** | source read |
| current workflow: symlink into `~/.pi/agent/extensions/` | none (no copying at all) | yes — repo binary executed in place | 1.4 |
| **zip/tar download extracted by hand with `ditto`/`tar`** | **propagated** → killed, exit 137 | **no** | 1.5 |

For the `pi install` rows the mechanism was read from the host source, not executed:
`packages/coding-agent/src/core/package-manager.ts:1880-1896` builds
`npm install <spec> --prefix <installRoot> [--legacy-peer-deps --no-audit --no-fund]`, and
`getNpmInstallRoot()` (`:2117-2126`) resolves to `~/.pi/agent/npm` (global) or `<cwd>/.pi/npm`
(local). That is the same npm extraction measured above. The git path runs the package manager
`install` with `--omit=dev` inside a clone (`:1849-1865`).

Residual risk, and it is not npm's: if a prebuilt binary ever reaches a user's disk inside a
**quarantined** archive that they unpack with `ditto`/Finder/`tar` (a GitHub release `.zip`, a
`curl`-then-unzip is fine, a browser download is not), Gatekeeper kills it. That argues for
shipping the binary *inside the npm tarball* rather than asking users to download a zip.

---

# Q2 — Does `vec0.dylib` need more than an arm64 build?

## 2.1 This machine and the nixpkgs artefact

```console
$ uname -m
arm64
$ sw_vers
ProductName: macOS   ProductVersion: 27.0   BuildVersion: 26A428

$ nix build nixpkgs#sqlite-vec --print-out-paths
/nix/store/6pxcxnxm22mq8316lsapsfh886c1gfml-sqlite-vec-0.1.9

$ ls -l /nix/store/6pxcxnx…-sqlite-vec-0.1.9/lib/
-r--r--r--  1 root  nixbld  173792  libsqlite_vec0.a
-r--r--r--  1 root  nixbld  176416  vec0.dylib

$ file /nix/store/6pxcxnx…-sqlite-vec-0.1.9/lib/vec0.dylib
.../vec0.dylib: Mach-O 64-bit dynamically linked shared library arm64

$ otool -L .../vec0.dylib
	dist/vec0.dylib (compatibility version 0.0.0, current version 0.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)
```

Notes that matter for vendoring: the store file is mode **0444** (read-only, can't be patched
in place) and lives in `/nix/store`, i.e. garbage-collectable — exactly the reason
`agent-memory-spec.md` §474 says to vendor rather than reference it.

## 2.2 Is there an `x86_64-darwin` build in nixpkgs?

Not on this pin. Evaluating sqlite-vec *as* `x86_64-darwin` throws before it even reaches the
package:

```console
$ nix eval --system x86_64-darwin --json nixpkgs#sqlite-vec.meta.available
warning: ignoring the client-specified setting 'system', because it is a restricted setting and you are not a trusted user
error: Nixpkgs 26.11 has dropped support for x86_64-darwin.
       The 26.05 stable branch still supports x86_64-darwin, and will
       receive security fixes until the end of 2026.
       ...
       https://nixos.org/manual/nixpkgs/unstable/release-notes#x86_64-darwin-26.11
```

The platform set on this pin contains **no** `x86_64-darwin` at all:

```console
$ nix eval --json nixpkgs#lib.platforms.darwin
["aarch64-darwin"]
$ nix eval --raw nixpkgs#sqlite-vec.system
aarch64-darwin
$ nix eval --json nixpkgs#sqlite-vec.meta.platforms        # = lib.platforms.unix, truncated
["x86_64-linux","aarch64-darwin","aarch64-linux","i686-cygwin",... ]
# grep darwin over that list:
1        <- aarch64-darwin only
```

The package definition itself (`pkgs/by-name/sq/sqlite-vec/package.nix`) is arch-agnostic —
`platforms = lib.platforms.unix`, `makeFlags = [ "loadable" "static" ]`, install of
`dist/vec0${extensions.sharedLibrary}` — so it *would* build anywhere the platform is in
`lib.platforms`.

On the still-supported 26.05 branch an `x86_64-darwin` derivation exists, and is substitutable
from the binary cache:

```console
$ nix eval --raw "github:NixOS/nixpkgs/nixpkgs-26.05-darwin#legacyPackages.x86_64-darwin.sqlite-vec.drvPath"
evaluation warning: Nixpkgs 26.05 will be the last release to support x86_64-darwin; ...
/nix/store/xlgxamidzshq0a53zhlkkxn9c5a9zzap-sqlite-vec-0.1.6.drv

$ nix eval --json "github:NixOS/nixpkgs/nixpkgs-26.05-darwin#legacyPackages.x86_64-darwin.sqlite-vec.meta.platforms" | grep darwin
"x86_64-darwin"
"aarch64-darwin"

$ nix eval --raw "...#legacyPackages.aarch64-darwin.sqlite-vec.version"
0.1.6

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" https://cache.nixos.org/c9mwr4cgnihzbyrgvwf458ffc14669ln.narinfo
HTTP 200

$ nix build --dry-run --no-link "...#legacyPackages.x86_64-darwin.sqlite-vec"
this path will be fetched (87.0 KiB download, 274.0 KiB unpacked):
  /nix/store/c9mwr4cgnihzbyrgvwf458ffc14669ln-sqlite-vec-0.1.6
```

So: **x86_64-darwin nixpkgs output = v0.1.6 only, on a branch this repo does not pin, fetched from
the cache rather than built.** It is not a free second matrix entry — it costs a second nixpkgs
pin (or a 26.05-only overlay) and delivers a *different, older* sqlite-vec version than the
0.1.9 the spec assumes. No Rosetta involvement: `sysctl -n sysctl.proc_translated` → `0`, this
process tree is native arm64, and an `x86_64` dylib cannot be loaded into an arm64 process
anyway (Rosetta 2 translates whole processes, not single in-process dlopen of foreign-arch code —
the load attempt below fails on path resolution before arch, so treat the "Rosetta can load an
x64 dylib into an arm64 node" idea as **UNVERIFIED and not relied upon**).

## 2.3 The npm package already solves the arch problem

Layout of `sqlite-vec@0.1.9` — one tiny JS shim plus one platform package per arch:

```console
$ find node_modules/sqlite-vec -type f | sort
node_modules/sqlite-vec/index.cjs
node_modules/sqlite-vec/index.d.ts
node_modules/sqlite-vec/index.mjs
node_modules/sqlite-vec/package.json
node_modules/sqlite-vec/README.md

$ node -e 'console.log(JSON.stringify(require("./node_modules/sqlite-vec/package.json").optionalDependencies,null,2))'
{
  "sqlite-vec-darwin-x64": "0.1.9",
  "sqlite-vec-linux-x64": "0.1.9",
  "sqlite-vec-darwin-arm64": "0.1.9",
  "sqlite-vec-windows-x64": "0.1.9",
  "sqlite-vec-linux-arm64": "0.1.9"
}
```

npm's own platform filtering installed exactly one of them:

```console
$ ls node_modules
sqlite-vec  sqlite-vec-darwin-arm64
$ node -e 'const j=require("./node_modules/sqlite-vec-darwin-arm64/package.json");console.log(j.name,j.version,j.os,j.cpu)'
sqlite-vec-darwin-arm64 0.1.9 [ 'darwin' ] [ 'arm64' ]
```

The loader (`node_modules/sqlite-vec/index.cjs`, verbatim):

```js
const { arch, platform } = require("node:process");

const BASE_PACKAGE_NAME = "sqlite-vec";
const ENTRYPOINT_BASE_NAME = "vec0";
const supportedPlatforms = [["darwin","x64"],["linux","x64"],["darwin","arm64"],["win32","x64"],["linux","arm64"]];

function validPlatform(platform, arch) {
  return supportedPlatforms.find(([p, a]) => platform === p && arch === a) !== undefined;
}
function extensionSuffix(platform) {
  if (platform === "win32") return "dll";
  if (platform === "darwin") return "dylib";
  return "so";
}
function platformPackageName(platform, arch) {
  const os = platform === "win32" ? "windows" : platform;
  return `${BASE_PACKAGE_NAME}-${os}-${arch}`;
}
function getLoadablePath() {
  if (!validPlatform(platform, arch)) throw new Error(invalidPlatformErrorMessage);
  const packageName = platformPackageName(platform, arch);
  return require.resolve(packageName + "/" + ENTRYPOINT_BASE_NAME + "." + extensionSuffix(platform));
}
function load(db) {
  db.loadExtension(getLoadablePath());
}
module.exports = {getLoadablePath, load};
```

### Working end-to-end test: `node:sqlite` + `allowExtension` + KNN

`/tmp/q1a/knn.mjs` (ESM, the shape a pi extension would use):

```js
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

console.log("node", process.version, "| sqlite", new DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v);
console.log("getLoadablePath() ->", sqliteVec.getLoadablePath());

const db = new DatabaseSync(":memory:", { allowExtension: true });
sqliteVec.load(db);
console.log("vec_version() ->", db.prepare("select vec_version() v").get().v);

db.exec("create virtual table v using vec0(id integer primary key, emb float[4])");
const ins = db.prepare("insert into v(id, emb) values (?, ?)");
const blob = (a) => new Uint8Array(new Float32Array(a).buffer);
ins.run(1n, blob([1, 0, 0, 0]));
ins.run(2n, blob([0, 1, 0, 0]));
ins.run(3n, blob([0.9, 0.1, 0, 0]));
ins.run(4n, blob([0.5, 0.5, 0, 0]));

const rows = db.prepare("select id, distance from v where emb match ? order by distance limit 3")
  .all(blob([1, 0.05, 0, 0]));
console.log("KNN rows:", JSON.stringify(rows, (k, v) => typeof v === "bigint" ? v.toString() : v));
```

Output (verbatim):

```console
$ node knn.mjs
node v24.21.0 | sqlite 3.53.3
getLoadablePath() -> /private/tmp/q1a/node_modules/sqlite-vec-darwin-arm64/vec0.dylib
vec_version() -> v0.1.9
KNN rows: [{"id":1,"distance":0.05000000074505806},{"id":3,"distance":0.11180341988801956},{"id":4,"distance":0.6726812124252319}]
exit=0
```

Two integration facts learned while making that run:

1. **`vec0` primary keys must be bound as `BigInt`.** `ins.run(1, …)` fails with
   `Error: Only integers are allows for primary key values on v` — `node:sqlite` binds JS numbers
   as REAL. `1n` works, and reading rows back yields `bigint` ids (hence the JSON replacer).
2. `sqliteVec.load(db)` needs no path plumbing: `require.resolve` is resolved from
   `sqlite-vec`'s own install location, so it works wherever the extension lives, as long as
   `sqlite-vec` is resolvable from the extension's module graph.

### Does the npm arm64 dylib match nixpkgs'?

Different builds, both fine — so nothing is lost by dropping the nix artefact:

```console
$ shasum -a 256 .../nix/store/6pxcxnx…-sqlite-vec-0.1.9/lib/vec0.dylib node_modules/sqlite-vec-darwin-arm64/vec0.dylib
d928efd3e65b8df641f8f2f6f0d15f8e60721ea289277f025b203a2a4a413a11  .../lib/vec0.dylib
193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793  node_modules/sqlite-vec-darwin-arm64/vec0.dylib

sizes: 176416 (nix, 0444)   161896 (npm, 0644)
otool -L (nix) : dist/vec0.dylib, /usr/lib/libSystem.B.dylib (1345.100.2)
otool -L (npm) : dist/vec0.dylib, /usr/lib/libSystem.B.dylib (1345.120.2)
```

Both link **only `libSystem`** — no libsqlite3 dependency, so they load into `node:sqlite`'s
embedded SQLite 3.53.3 either way.

## 2.4 Versions and the x64 artefact

```console
$ npm view sqlite-vec dist-tags --json
{ "latest": "0.1.9", "alpha": "0.1.10-alpha.4" }

$ npm view sqlite-vec versions --json | tail -6
  "0.1.9", "0.1.10-alpha.1", "0.1.10-alpha.2", "0.1.10-alpha.3", "0.1.10-alpha.4"

$ npm view sqlite-vec@0.1.10-alpha.4 optionalDependencies --json
{ "sqlite-vec-linux-arm64": "0.1.10-alpha.4", "sqlite-vec-windows-x64": "0.1.10-alpha.4",
  "sqlite-vec-darwin-arm64": "0.1.10-alpha.4", "sqlite-vec-linux-x64": "0.1.10-alpha.4",
  "sqlite-vec-darwin-x64": "0.1.10-alpha.4" }
```

So: **0.1.9 is the newest stable**; there is no 0.1.10 stable yet. Both `darwin-arm64` and
`darwin-x64` ship for it, and the alpha keeps the same five-platform set.

The x64 artefact is real, and x86_64 (fetched with `npm pack`, since `npm install` correctly
refuses it on this arm64 host):

```console
$ npm install sqlite-vec-darwin-x64@0.1.9
npm error notsup Valid cpu:  x64
npm error notsup Actual cpu: arm64            <- npm's platform filter doing its job

$ npm pack sqlite-vec-darwin-x64@0.1.9 && tar -xzf sqlite-vec-darwin-x64-0.1.9.tgz
$ find package -type f
package/package.json   package/README.md   package/vec0.dylib
$ file package/vec0.dylib
package/vec0.dylib: Mach-O 64-bit dynamically linked shared library x86_64
$ node -e 'console.log(require("./package/package.json").cpu)'
[ 'x64' ]
$ xattr -l package/vec0.dylib
com.apple.provenance:            <- no quarantine, Q1 applies to the dylib too
```

## 2.5 Q2 verdict

**The extension should not ship a dylib at all. Depend on the npm `sqlite-vec` package.**

- What the extension must ship: `bin/nle-embed` (per-arch Mach-O — arm64 measured; an x86_64
  build is *not* covered here, see NOT COVERED), plus JS. Nothing else.
- What it can delegate: the whole `vec0` extension and the entire arch matrix. `sqlite-vec`
  declares `optionalDependencies` for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
  `windows-x64`; npm installs only the host's; `sqliteVec.load(db)` selects it at runtime. A
  `napi-rs`-style manual loader is unnecessary.
- **Is a second arch matrix entry needed?** For `vec0.dylib`: **no** — deleting
  `vendor/vec0.dylib` and the nix `sqlite-vec` build step removes the arch question entirely, and
  also removes the `/nix/store` GC hazard and the 0444 read-only file. The one remaining
  per-arch artefact is the Swift `nle-embed` binary; if that is shipped prebuilt rather than
  built by `build.sh` at install time, *it* needs an arm64/x86_64 matrix entry — that is the only
  place a second matrix entry is still required.
- Consequence for the spec's fallback (`absent vec0.dylib → BM25-only`): it becomes
  "absent `sqlite-vec` dependency → BM25-only", and the trigger is an install failure
  (`npm error notsup` on an unsupported platform pair like `darwin-ia32`), not a missing file.

---

# NOT COVERED

- **An `x86_64` build of `nle-embed` was never produced or executed** on this arm64 box
  (`swiftc -target x86_64-apple-macos27.0` was not attempted). "arm64 only" for that binary is
  measured; x86_64 support is unverified.
- **`pi install npm:<pkg>` / `pi install git:<repo>` were not executed end-to-end.** The
  install mechanism was read from the host source (`package-manager.ts:1849-1901, 2117-2126`);
  the underlying npm extraction is the one measured in Q1.
- **`nix build` of the `x86_64-darwin` derivation was not attempted** (this machine cannot build
  for that platform; only substitution was confirmed, via narinfo HTTP 200 and `--dry-run`).
- **Gatekeeper verdict on an unnotarised *quarantined* binary** was measured as `exit 137` for one
  build; whether a `spctl`-assessed notarisation changes the message was not explored.
- Rosetta-translated execution (`arch -x86_64 node`) was not tested.

# Reproduce

Scratch-only; nothing was installed globally and the repo was not modified.

```bash
# Q1
mkdir -p /tmp/q1a && cd /tmp/q1a && npm init -y && npm install sqlite-vec esbuild
xattr -l node_modules/sqlite-vec-darwin-arm64/vec0.dylib
xattr -p com.apple.quarantine node_modules/sqlite-vec-darwin-arm64/vec0.dylib; echo $?
./node_modules/@esbuild/darwin-arm64/bin/esbuild --version

# tarball paths
mkdir -p /tmp/q1pkg/bin && cp experiments/embed/bin/nle-embed /tmp/q1pkg/bin/
printf '{"name":"nle-embed-test","version":"0.0.1","bin":{"nle-embed":"bin/nle-embed"}}' > /tmp/q1pkg/package.json
cd /tmp/q1pkg && npm pack
mkdir -p /tmp/q1file && cd /tmp/q1file && npm init -y && npm install /tmp/q1pkg/nle-embed-test-0.0.1.tgz
xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed; echo $?
echo hi | ./node_modules/nle-embed-test/bin/nle-embed embed

# HTTP variant (kill the server afterwards — the harness must not leave it running)
cd /tmp/q1pkg && python3 -m http.server 8731 &
mkdir -p /tmp/q1http && cd /tmp/q1http && npm init -y \
  && npm install http://127.0.0.1:8731/nle-embed-test-0.0.1.tgz
xattr -p com.apple.quarantine node_modules/nle-embed-test/bin/nle-embed; echo $?
kill %1

# npm source audit
grep -ril -E "quarantine|LSFileQuarantineEnabled|xattr" "$(readlink -f "$(which npm)" | xargs dirname)/.."; echo $?

# Q2
nix build nixpkgs#sqlite-vec --print-out-paths
file /nix/store/*-sqlite-vec-0.1.9/lib/vec0.dylib
nix eval --json nixpkgs#lib.platforms.darwin
nix eval --system x86_64-darwin --json nixpkgs#sqlite-vec.meta.available   # throws on 26.11
nix eval --raw "github:NixOS/nixpkgs/nixpkgs-26.05-darwin#legacyPackages.x86_64-darwin.sqlite-vec.drvPath"
npm view sqlite-vec dist-tags --json
node knn.mjs   # node:sqlite + allowExtension + vec0 KNN, script above
```
