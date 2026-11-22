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

## Independent review checklist (release gate)

Every contract release must be accompanied by a completed copy of the
checklist below. The checklist is the **release gate**: a release tag MUST NOT
be created until every item is checked and its evidence is linked. Any
unchecked item, or any item whose evidence cannot be reproduced from CI
artifacts, **blocks tagging**. There is no override path — a missing item is a
hard stop, not a warning.

Copy this template into the release PR description and fill in each evidence
cell with a link to the CI artifact, commit, or command output that proves the
item.

| # | Area | What to verify | Required evidence | Blocks tag |
| - | ---- | -------------- | ----------------- | ---------- |
| 1 | Auth matrix | Every entry point's authorization (who may call, required signers, admin/role checks) matches the documented auth matrix; no new privileged path is unguarded. | Link to auth-matrix test run + diff of the matrix if changed. | Yes |
| 2 | Budget deltas | CPU/memory instruction budgets for each entry point are within the agreed thresholds; any increase is justified and recorded. | Link to budget report artifact with before/after deltas. | Yes |
| 3 | Interface manifests | `interface.json` for each package is regenerated, committed, and matches the built WASM; semver classification is correct. | Link to `bindings-semver` output + committed `interface.json` diff. | Yes |
| 4 | Vendored WASM | Any vendored/checked-in WASM is byte-identical to a reproducible build from the tagged source commit; SHA-256 recorded. | Link to build artifact + `sha256sum` comparison. | Yes |
| 5 | Formal checks | All formal/spec checks (invariants, property tests, fuzzing) pass on the release commit. | Link to formal-check CI job. | Yes |
| 6 | Migration compatibility | Storage layout and interface changes are backward compatible, or a migration is included and tested. | Link to migration test run or explicit "no migration needed" justification. | Yes |
| 7 | Testnet verification | The release candidate is deployed to testnet and the smoke-test suite passes against it. | Link to testnet deploy log + smoke-test results. | Yes |

### Gate semantics (operator-visible behavior)

- The release workflow reads the checklist from the release PR and **fails the
  release job** if any row is unchecked or its evidence link is missing.
- A failed gate leaves the release **untagged**; the operator sees a job failure
  naming the missing rows. Re-running after supplying evidence is the only way
  forward.
- Tagging is performed only by the release job after the gate passes; manual
  tagging that bypasses the gate is out of policy and must be reverted.

### Reproducible verification (dry-run release + CI artifacts)

To validate the checklist itself against a dry-run release:

1. Open a dry-run release PR using the checklist template above.
2. Trigger the release workflow in dry-run mode (no tag push). Confirm the job
   **fails** while any row is unchecked, and that the failure message names the
   missing rows.
3. Fill in each evidence cell with links to the corresponding CI artifacts
   (auth-matrix, budget report, interface manifest diff, WASM SHA-256, formal
   checks, migration tests, testnet smoke tests).
4. Re-run the workflow and confirm it **passes** and would tag.
5. Record the dry-run PR link and both job runs (fail then pass) as the
   verification evidence for the checklist change itself.

This procedure is the documented, reproducible coverage for the release gate;
it can be re-run for any release to confirm the gate still blocks on missing
evidence.

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
    console.error('Usage: tsx scripts

/* … truncated 6877 chars — edit only what you need near the top … */
