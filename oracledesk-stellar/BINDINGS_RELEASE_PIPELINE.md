# Bindings Release Pipeline

This document describes how generated bindings and WASM artifacts are produced,
verified, and released for the OracleDesk Stellar contracts.

## Supported toolchains

The pipeline is validated against a matrix of toolchain versions. The
**minimum** column is the oldest version we support; the **pinned** column is
the version used for release artifacts and determinism checks.

| Tool          | Minimum supported | Pinned CI / release |
| ------------- | ----------------- | ------------------- |
| Rust          | 1.74.0            | 1.79.0              |
| Node.js       | 18.18.0           | 20.11.0             |
| Stellar CLI   | 21.0.0            | 21.1.0              |

Any combination outside these ranges is **unsupported**. The CI matrix job
(`bindings-toolchain-matrix`) runs the focused build/test suite for each
supported combination and fails loudly on unsupported combinations — there is
no silent fallback to a different toolchain.

## CI matrix

The `bindings-toolchain-matrix` workflow job runs the following combinations:

- **minimum**: Rust 1.74.0, Node 18.18.0, Stellar CLI 21.0.0
- **pinned**: Rust 1.79.0, Node 20.11.0, Stellar CLI 21.1.0

```bash
# After the bindings generation and before the jq .name/.version step:
# Merge in fixed metadata
tmp=$(mktemp)
jq --arg name "@oracledesk/bindings-$pkg_name" \
   --arg v "$old_version" \
   --arg repo "https://github.com/OracleDesk/OracleDesk-SmartContract" \
   --arg lic "Apache-2.0" \
   '. + {
     name: $name,
     version: $v,
     description: "TypeScript bindings for OracleDesk \($name) Stellar contract",
     license: $lic,
     repository: {
       type: "git",
       url: $repo,
       directory: "oracledesk-stellar/packages/bindings/\($name)"
     },
     files: ["dist", "src", "README.md", "interface.json"],
     publishConfig: {
       access: "public",
       provenance: true
     },
     keywords: ["stellar", "soroban", "oracledesk", "smart-contract", "bindings"],
     oracledesk: {
       wasmSha256: "",
       sourceCommit: ""
     }
   }' "$OUT_DIR/$pkg_name/package.json" > "$tmp"
mv "$tmp" "$OUT_DIR/$pkg_name/package.json"
```

### 2. Semantic Version Diff Tool

**File:** `oracledesk-stellar/scripts/bindings-semver.ts` (new)

```typescript
#!/usr/bin/env tsx
/**
 * Classifies contract interface changes as major, minor, or patch according to
 * semver rules. Reads interface.json from the last published package and the
 * freshly built wasm, then outputs a changeset file if the diff is non-empty.
 *
 * For pre-1.0 packages, major changes map to minor (semver 0.x convention).
 *
 * Usage:
 *   tsx scripts/bindings-semver.ts <package-name>
 *   # Outputs .changeset/<hash>.md if interface changed
 */

import { readFileSync } from 'fs';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

interface ContractSpec {
  functions: Array<{ name: string; inputs: any[]; outputs: any[] }>;
  structs: Array<{ name: string; fields: any[] }>;
  enums: Array<{ name: string; cases: any[] }>;
  errors: Array<{ name: string; value: number }>;
  events: Array<{ name: string; fields: any[] }>;
}

type BumpType = 'major' | 'minor' | 'patch' | null;

function loadInterface(path: string): ContractSpec {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function classifyDiff(oldSpec: ContractSpec, newSpec: ContractSpec, currentVersion: string): { bump: BumpType; changes: string[] } {
  const changes: string[] = [];
  let bump: BumpType = null;

  // Check functions
  const oldFuncs = new Map(oldSpec.functions.map(f => [f.name, f]));
  const newFuncs = new Map(newSpec.functions.map(f => [f.name, f]));

  // Removed functions = major
  for (const [name, _] of oldFuncs) {
    if (!newFuncs.has(name)) {
      changes.push(`Removed function: ${name}`);
      bump = 'major';
    }
  }

  // Changed function signatures = major
  for (const [name, newFunc] of newFuncs) {
    const oldFunc = oldFuncs.get(name);
    if (oldFunc && JSON.stringify(oldFunc) !== JSON.stringify(newFunc)) {
      changes.push(`Changed function signature: ${name}`);
      bump = 'major';
    }
  }

  // New functions = minor
  for (const [name, _] of newFuncs) {
    if (!oldFuncs.has(name)) {
      changes.push(`Added function: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check errors
  const oldErrors = new Map(oldSpec.errors.map(e => [e.name, e.value]));
  const newErrors = new Map(newSpec.errors.map(e => [e.name, e.value]));

  for (const [name, oldVal] of oldErrors) {
    const newVal = newErrors.get(name);
    if (newVal !== undefined && newVal !== oldVal) {
      changes.push(`Renumbered error code: ${name}`);
      bump = 'major';
    }
    if (newVal === undefined) {
      changes.push(`Removed error: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newErrors) {
    if (!oldErrors.has(name)) {
      changes.push(`Added error: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check structs (field order matters for hashing per ADR-0001)
  const oldStructs = new Map(oldSpec.structs.map(s => [s.name, s]));
  const newStructs = new Map(newSpec.structs.map(s => [s.name, s]));

  for (const [name, oldStruct] of oldStructs) {
    const newStruct = newStructs.get(name);
    if (!newStruct) {
      changes.push(`Removed struct: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldStruct.fields) !== JSON.stringify(newStruct.fields)) {
      changes.push(`Changed struct fields/order: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newStructs) {
    if (!oldStructs.has(name)) {
      changes.push(`Added struct: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check enums
  const oldEnums = new Map(oldSpec.enums.map(e => [e.name, e]));
  const newEnums = new Map(newSpec.enums.map(e => [e.name, e]));

  for (const [name, oldEnum] of oldEnums) {
    const newEnum = newEnums.get(name);
    if (!newEnum) {
      changes.push(`Removed enum: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldEnum.cases) !== JSON.stringify(newEnum.cases)) {
      changes.push(`Changed enum variants: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newEnums) {
    if (!oldEnums.has(name)) {
      changes.push(`Added enum: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check events
  const oldEvents = new Map(oldSpec.events.map(e => [e.name, e]));
  const newEvents = new Map(newSpec.events.map(e => [e.name, e]));

  for (const [name, oldEvent] of oldEvents) {
    const newEvent = newEvents.get(name);
    if (!newEvent) {
      changes.push(`Removed event: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldEvent.fields) !== JSON.stringify(newEvent.fields)) {
      changes.push(`Changed event fields: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newEvents) {
    if (!oldEvents.has(name)) {
      changes.push(`Added event: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // For pre-1.0 packages, map major → minor (semver 0.x convention)
  if (bump === 'major' && currentVersion.startsWith('0.')) {
    bump = 'minor';
  }

  return { bump, changes };
}

function writeChangeset(packageName: string, bump: BumpType, changes: string[]) {
  const hash = createHash('md5').update(Date.now().toString()).digest('hex').slice(0, 8);
  const changesetDir = '.changeset';
  mkdirSync(changesetDir, { recursive: true });

  const content = `---
"@oracledesk/bindings-${packageName}": ${bump}
---

${changes.map(c => `- ${c}`).join('\n')}
`;

  const filename = `${changesetDir}/${hash}-${packageName}.md`;
  writeFileSync(filename, content);
  console.log(`Created changeset: ${filename}`);
}

function main() {
  const packageName = process.argv[2];
  if (!packageName) {
    console.error('Usage: tsx scripts/bindings-semver.ts <package-name>');
    process.exit(1);
  }

  const pkgDir = `packages/bindings/${packageName}`;
  const newInterfacePath = `${pkgDir}/interface.json`;
  const pkgJsonPath = `${pkgDir}/package.json`;

  let currentVersion = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    currentVersion = pkg.version || currentVersion;
  } catch {
    console.warn(`No package.json found at ${pkgJsonPath}, assuming ${currentVersion}`);
  }

  // Fetch the last published interface.json from npm for comparison
  let oldInterfacePath: string | null = null;
  try {
    const tmpDir = execSync('mktemp -d').toString().trim();
    execSync(
      `npm pack @oracledesk/bindings-${packageName}@${currentVersion} --pack-destination ${tmpDir}`,
      { stdio: 'pipe' }
    );
    const tarball = execSync(`ls ${tmpDir}/*.tgz`).toString().trim();
    execSync(`tar -xzf ${tarball} -C ${tmpDir}`);
    oldInterfacePath = `${tmpDir}/package/interface.json`;
  } catch {
    console.warn(`Could not fetch published interface for ${packageName}@${currentVersion}; treating as initial release`);
  }

  if (!oldInterfacePath) {
    console.log(`No previous interface for ${packageName}; skipping semver diff`);
    return;
  }

  const oldSpec = loadInterface(oldInterfacePath);
  const newSpec = loadInterface(newInterfacePath);
  const { bump, changes } = classifyDiff(oldSpec, newSpec, currentVersion);

  if (!bump || changes.length === 0) {
    console.log(`No interface changes for ${packageName}`);
    return;
  }

  writeChangeset(packageName, bump, changes);
}

main();
```

### 3. Release Bundle: Checksums, Manifests, and Build Metadata

**File:** `oracledesk-stellar/scripts/build-release-bundle.sh` (new)

Produces a verifiable release bundle per artifact (WASM + bindings tarball) containing:
- `SHA256SUMS` — checksums for every artifact in the bundle
- `interface.json` — exported surface manifest per bindings package
- `build-metadata.json` — source revision (git commit), toolchain versions, build timestamp, and reproducibility inputs

```bash
#!/usr/bin/env bash
# Builds a verifiable release bundle for WASM + bindings artifacts.
#
# Output layout (under dist/release-bundle/):
#   artifacts/<name>.wasm
#   artifacts/@oracledesk-bindings-<name>-<version>.tgz
#   manifests/<name>.interface.json
#   build-metadata.json
#   SHA256SUMS
#
# Consumers verify with:
#   sha256sum -c SHA256SUMS
#   jq -r '.sourceCommit' build-metadata.json   # compare to expected git rev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/release-bundle"
ARTIFACTS="$OUT/artifacts"
MANIFESTS="$OUT/manifests"

rm -rf "$OUT"
mkdir -p "$ARTIFACTS" "$MANIFESTS"

# --- Source revision & build metadata ---------------------------------------
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
SOURCE_DIRTY="false"
if ! git -C "$ROOT" diff --quiet --ignore-submodules HEAD --; then
  SOURCE_DIRTY="true"
fi
RUSTC_VERSION="$(rustc --version 2>/dev/null || echo unknown)"
CARGO_VERSION="$(cargo --version 2>/dev/null || echo unknown)"
STELLAR_VERSION="$(stellar version 2>/dev/null || echo unknown)"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Collect WASM artifacts -------------------------------------------------
for wasm in "$ROOT"/target/wasm32-unknown-unknown/release/*.wasm; do
  [ -e "$wasm" ] || continue
  cp "$wasm" "$ARTIFACTS/"
done

# --- Collect bindings tarballs + interface manifests ------------------------
for pkg_dir in "$ROOT"/packages/bindings/*/; do
  [ -d "$pkg_dir" ] || continue
  pkg_name="$(basename "$pkg_dir")"
  if [ -f "$pkg_dir/interface.json" ]; then
    cp "$pkg_dir/interface.json" "$MANIFESTS/$pkg_name.interface.json"
  fi
  ( cd "$pkg_dir" && npm pack --pack-destination "$ARTIFACTS" >/dev/null )
done

# --- Build metadata ---------------------------------------------------------
cat > "$OUT/build-metadata.json" <<EOF
{
  "sourceCommit": "$SOURCE_COMMIT",
  "sourceDirty": $SOURCE_DIRTY,
  "buildTimestamp": "$BUILD_TIMESTAMP",
  "toolchain": {
    "rustc": "$RUSTC_VERSION",
    "cargo": "$CARGO_VERSION",
    "stellar": "$STELLAR_VERSION",
    "node": "$NODE_VERSION"
  },
  "reproducibleBuild": {
    "command": "cargo build --release --target wasm32-unknown-unknown",
    "profile": "release",
    "target": "wasm32-unknown-unknown"
  }
}
EOF

# --- Checksums --------------------------------------------------------------
( cd "$OUT" && sha256sum artifacts/* manifests/* build-metadata.json > SHA256SUMS )

echo "Release bundle written to $OUT"
echo "Verify with: (cd $OUT && sha256sum -c SHA256SUMS)"
```

### 4. Consumer Verification

Downstream consumers verify a downloaded bundle without trusting the publisher:

```bash
# 1. Verify checksums match the published SHA256SUMS
(cd release-bundle && sha256sum -c SHA256SUMS)

# 2. Confirm the bundle was built from the expected source revision
jq -e '.sourceCommit == "<expected-git-sha>"' release-bundle/build-metadata.json

# 3. Confirm the build was clean (no uncommitted changes)
jq -e '.sourceDirty == false' release-bundle/build-metadata.json

# 4. Reproduce the WASM locally and compare hashes
cargo build --release --target wasm32-unknown-unknown
sha256sum target/wasm32-unknown-unknown/release/<name>.wasm
# Compare against the matching entry in release-bundle/SHA256SUMS
```

If any check fails, the consumer MUST reject the artifact — there is no silent fallback to unverified output.

### 5. Release Workflow

**File:** `/.github/workflows/release-bindings.yml` (new)

- Trigger on `v*` tags
- Build WASM with pinned toolchain (see CI reproducibility job)
- Run `scripts/build-release-bundle.sh`
- Upload `dist/release-bundle/` as a workflow artifact and attach to the GitHub release
- Publish bindings packages with `npm publish --provenance`

### 6. CI Validation

Add a CI job that:
- Runs `scripts/build-release-bundle.sh` against deterministic fixtures
- Asserts `sha256sum -c SHA256SUMS` passes
- Asserts `build-metadata.json` contains a non-empty `sourceCommit` matching `git rev-parse HEAD`
- Asserts every bindings package has a corresponding `manifests/<name>.interface.json`
- Fails the job if any artifact is missing from `SHA256SUMS`

## Manual Release / Operator Verification

Before publishing a release, an operator MUST:

1. Build from a clean checkout at the tagged commit (`git status` clean).
2. Run `scripts/build-release-bundle.sh` and confirm `sourceDirty` is `false` in `build-metadata.json`.
3. Run `sha256sum -c SHA256SUMS` inside the bundle and confirm all entries pass.
4. Independently rebuild the WASM and confirm the hash matches the bundle entry.
5. Confirm each bindings package has an `interface.json` manifest in `manifests/`.

If any step fails, do not publish — investigate and rebuild from a clean tree.
