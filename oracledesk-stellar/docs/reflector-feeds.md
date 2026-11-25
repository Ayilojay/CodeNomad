# Reflector Feed Catalog

This document is the **source-backed catalog** of Reflector oracle feed addresses used by OracleDesk's price-mode resolution. It records, for each supported asset and network, the feed contract address, the feed's update cadence, the timestamp at which the entry was verified, a recommended `max_staleness` bound, and the provenance (official source or on-chain metadata query) backing the entry.

> **No address is hardcoded in contracts.** OracleDesk contracts never embed Reflector addresses. Operators supply feed addresses and staleness bounds at configuration time (price-mode resolution). This catalog exists to give operators *verified, provenance-backed* values to copy from — it is documentation, not a source of truth baked into bytecode. Changing an entry here never requires a contract redeploy.

Related documents:

- [`docs/wave-issues/05-reflector-feed-discovery.md`](./wave-issues/05-reflector-feed-discovery.md) — the discovery process that produced the initial entries below.
- [`deployments/testnet.json`](../deployments/testnet.json) — the deployed testnet configuration that references these feeds.

---

## 1. How to read this catalog

| Column | Meaning |
| --- | --- |
| **Asset** | Asset symbol as reported by the Reflector feed (e.g. `BTC`, `EUR`). |
| **Network** | `testnet` or `mainnet`. |
| **Feed address** | The Reflector contract address (StrKey `C...` for Soroban) serving this asset. |
| **Cadence** | The feed's nominal update interval, as published by Reflector or observed on-chain. |
| **Verified at** | UTC timestamp at which this entry was last verified against the provenance source. |
| **Recommended `max_staleness`** | Suggested upper bound for price-mode resolution, derived from cadence (see §2). |
| **Provenance** | Link to the official Reflector source or the exact on-chain query used to verify the entry. |

### 2. Deriving `max_staleness` from cadence

`max_staleness` is the maximum age a price may have before resolution treats it as stale and refuses to settle. It must be **larger than the feed cadence** (so a normally-updating feed is never spuriously stale) but **small enough** to catch a halted feed.

We derive it with a documented multiplier:

```
recommended_max_staleness = cadence × STALENESS_MULTIPLIER
```

- **`STALENESS_MULTIPLIER = 3`** by default.
  - Rationale: tolerates up to two consecutive missed updates (transient RPC lag, a single skipped tick) while still flagging a feed that has effectively stopped. Operators who need tighter bounds (e.g. high-value settlement) may lower it toward `2`; operators on low-traffic assets may raise it, but should document the deviation.
- Round up to a whole number of seconds.
- If Reflector publishes an explicit heartbeat/staleness recommendation for a feed, **that value wins** and is recorded verbatim in the Provenance column.

> The multiplier is a *recommendation*. The authoritative value is whatever the operator configures; contracts enforce only the bound they are given.

---

## 3. Catalog

> **Status:** The entries below are the verification *slots*. Addresses and cadences must be filled in by following the refresh procedure in §4 against the official Reflector sources. Entries marked `UNVERIFIED` must **not** be used in production price-mode configuration.

### 3.1 Testnet

| Asset | Network | Feed address | Cadence | Verified at (UTC) | Recommended `max_staleness` | Provenance |
| --- | --- | --- | --- | --- | --- | --- |
| BTC | testnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| ETH | testnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| XLM | testnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| EUR | testnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| (add assets) | testnet | `UNVERIFIED` | — | — | — | — |

### 3.2 Mainnet

| Asset | Network | Feed address | Cadence | Verified at (UTC) | Recommended `max_staleness` | Provenance |
| --- | --- | --- | --- | --- | --- | --- |
| BTC | mainnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| ETH | mainnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| XLM | mainnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| EUR | mainnet | `UNVERIFIED` | — | — | — | Reflector official docs / on-chain metadata (§4.1) |
| (add assets) | mainnet | `UNVERIFIED` | — | — | — | — |

**Asset coverage.** The catalog is intended to cover the asset classes OracleDesk supports in price mode:

- **Crypto majors:** `BTC`, `ETH`, `XLM` (and any additional majors Reflector serves).
- **Forex:** `EUR` and other fiat pairs Reflector serves.

If Reflector does not serve an asset on a given network, record the row as `NOT SERVED` with the provenance link confirming the absence — do not leave it blank.

---

## 4. Refresh procedure

Feed addresses and cadences can change (contract upgrades, new deployments, deprecations). Re-verify this catalog on a fixed schedule and whenever a feed is suspected stale.

### 4.1 Re-verifying an address and cadence

1. **Consult the official Reflector source.** Open Reflector's official documentation / feed registry (link recorded in the Provenance column) and locate the asset + network entry. This is the primary source of truth.
2. **Cross-check on-chain metadata (read-only).** Query the feed contract's metadata to confirm the address serves the expected asset and to read its update cadence / last-update timestamp. Use a read-only query against the network RPC; never submit a transaction. Example shape (adapt to the Reflector interface version):
   - Read the feed's asset/decimals metadata and its most recent update timestamp.
   - Confirm the returned asset symbol matches the catalog row.
3. **Confirm cadence.** Derive cadence from Reflector's published heartbeat, or (if unpublished) from the observed inter-update interval across several recent updates. Record the method used in Provenance.
4. **Compute `max_staleness`** using §2 (or the published heartbeat if one exists).
5. **Record the verification timestamp** (`Verified at`) as the UTC time the check completed.

### 4.2 Updating this document

1. Edit the relevant row(s) in §3. Update **Feed address**, **Cadence**, **Verified at**, **Recommended `max_staleness`**, and **Provenance** together — never update one without the others.
2. If an address changed, note the change in the changelog (§5) with old → new and the reason.
3. If an asset is no longer served, mark the row `NOT SERVED` and link the confirming source.
4. Open a PR titled `docs(reflector): refresh feed catalog (<date>)`.

### 4.3 Sign-off

- **Reviewer:** a maintainer with oracle/price-mode context must review the PR and confirm each changed row's Provenance link resolves and matches the recorded address.
- **Approver:** the release/ops owner signs off before the refreshed values are used in any production price-mode configuration.
- Record the sign-off (reviewer + approver handles) in the PR description.

### 4.4 Refresh cadence

- **Scheduled:** re-verify at least **quarterly**, and always before a mainnet release that changes price-mode configuration.
- **Event-driven:** re-verify immediately on any report of stale or mispriced resolution, or on notice from Reflector of a deployment change.

---

## 5. Changelog

| Date (UTC) | Change | Verified by | Sign-off |
| --- | --- | --- | --- |
| — | Initial catalog scaffold created; entries pending verification per §4. | — | — |

---

## 6. Compatibility & behavior notes

- **No contract changes implied.** This catalog is documentation only. Contracts continue to accept operator-supplied feed addresses and `max_staleness` bounds; nothing here is compiled into or enforced by deployed bytecode.
- **Deployed-interface guarantee unchanged.** The price-mode resolution interface (feed address + staleness bound inputs) is unchanged by this document. Existing deployments remain compatible.
- **Intentional behavior:** none. This change adds documentation and a verification/refresh process; it does not alter runtime behavior. Any future change to the `STALENESS_MULTIPLIER` default or to how operators are expected to source addresses will be documented here and in the changelog.

---

## 7. Validation

- **Documentation review:** a maintainer confirms the procedure in §4 is followable and that every catalog row carries a resolvable Provenance link.
- **Testnet read-only feed query:** when a verified testnet feed is available, perform the read-only metadata query in §4.1 step 2 against it, confirm the returned asset matches the catalog row, and record the `Verified at` timestamp. This is the reproducible verification used in lieu of an automated test (the catalog is data/documentation, not executable code).