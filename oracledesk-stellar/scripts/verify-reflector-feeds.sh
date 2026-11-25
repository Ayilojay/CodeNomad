#!/usr/bin/env bash
#
# verify-reflector-feeds.sh
#
# Read-only verification of the Reflector feed catalog documented in
# docs/reflector-feeds.md (issue #11).
#
# For a given network and asset this script:
#   1. Looks up the catalog entry (address, cadence, recommended staleness).
#   2. Performs a read-only query against the documented Reflector feed
#      contract address using `stellar contract invoke` (or a raw RPC call).
#   3. Asserts the returned metadata is consistent with the catalog entry:
#        - the contract address responds (i.e. the address is live),
#        - the reported cadence matches the catalog,
#        - the last-updated timestamp is within the recommended staleness.
#
# The script is OPT-IN and hermetic by default:
#   - If no network access / Stellar CLI is available it SKIPS (exit 0)
#     unless REFLECTOR_VERIFY_STRICT=1 is set, in which case it fails.
#   - It never writes to the network; all calls are read-only.
#
# Usage:
#   ./scripts/verify-reflector-feeds.sh [--network testnet|mainnet] [--asset <SYMBOL>] [--all]
#
# Environment:
#   REFLECTOR_VERIFY_STRICT=1   Fail instead of skipping when prerequisites missing.
#   STELLAR_CLI                 Path to the stellar CLI (default: stellar).
#   STELLAR_RPC_URL             Override RPC URL for the selected network.
#   REFLECTOR_CATALOG           Path to catalog file (default: docs/reflector-feeds.md).
#
# Exit codes:
#   0  All requested entries verified (or skipped in non-strict mode).
#   1  A verification assertion failed.
#   2  Usage / configuration error.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CATALOG_FILE="${REFLECTOR_CATALOG:-${REPO_ROOT}/docs/reflector-feeds.md}"
STELLAR_CLI="${STELLAR_CLI:-stellar}"
STRICT="${REFLECTOR_VERIFY_STRICT:-0}"

NETWORK="testnet"
ASSET=""
VERIFY_ALL=0

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="${2:-}"; shift 2 ;;
    --asset)
      ASSET="${2:-}"; shift 2 ;;
    --all)
      VERIFY_ALL=1; shift ;;
    -h|--help)
      usage 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage 2 ;;
  esac
done

case "${NETWORK}" in
  testnet|mainnet) ;;
  *)
    echo "error: --network must be 'testnet' or 'mainnet' (got '${NETWORK}')" >&2
    exit 2 ;;
esac

if [[ "${VERIFY_ALL}" -eq 0 && -z "${ASSET}" ]]; then
  echo "error: specify --asset <SYMBOL> or --all" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
skip() {
  log "SKIP: $*"
  if [[ "${STRICT}" == "1" ]]; then
    log "REFLECTOR_VERIFY_STRICT=1 set; treating skip as failure."
    exit 1
  fi
  exit 0
}

# Default RPC endpoints per network (public, read-only).
default_rpc_url() {
  case "$1" in
    testnet) echo "https://soroban-testnet.stellar.org" ;;
    mainnet) echo "https://soroban.stellar.org" ;;
    *) echo "" ;;
  esac
}

RPC_URL="${STELLAR_RPC_URL:-$(default_rpc_url "${NETWORK}")}"

# ---------------------------------------------------------------------------
# Prerequisite checks (opt-in / hermetic)
# ---------------------------------------------------------------------------
if [[ ! -f "${CATALOG_FILE}" ]]; then
  skip "catalog file not found: ${CATALOG_FILE}"
fi

if ! command -v "${STELLAR_CLI}" >/dev/null 2>&1; then
  skip "stellar CLI ('${STELLAR_CLI}') not available"
fi

# Quick network reachability probe (read-only). If we cannot reach the RPC
# endpoint we skip rather than fail, keeping CI hermetic.
if ! curl -sS --max-time 10 -o /dev/null "${RPC_URL}" 2>/dev/null; then
  skip "RPC endpoint unreachable: ${RPC_URL}"
fi

# ---------------------------------------------------------------------------
# Catalog parsing
#
# The catalog in docs/reflector-feeds.md is a Markdown table with columns:
#   | Asset | Network | Address | Cadence (s) | Recommended Staleness (s) | Provenance |
# We parse rows for the requested network/asset.
# ---------------------------------------------------------------------------
parse_catalog() {
  local want_network="$1" want_asset="$2"
  awk -v net="${want_network}" -v asset="${want_asset}" '
    BEGIN { FS = "|" }
    /^\|/ {
      # Trim leading/trailing empty fields from the pipe-delimited row.
      n = 0
      for (i = 1; i <= NF; i++) {
        f = $i
        gsub(/^[ \t]+|[ \t]+$/, "", f)
        if (f == "" && (i == 1 || i == NF)) continue
        fields[++n] = f
      }
      if (n < 5) next
      # Skip header and separator rows.
      if (fields[1] == "Asset") next
      if (fields[1] ~ /^-+$/) next
      a = fields[1]; nt = fields[2]; addr = fields[3]
      cad = fields[4]; stale = fields[5]
      if (a == asset && nt == net) {
        print a "\t" nt "\t" addr "\t" cad "\t" stale
      }
    }
  ' "${CATALOG_FILE}"
}

# ---------------------------------------------------------------------------
# Read-only feed query
#
# Reflector exposes a `lastprice` / `decimals` interface. For metadata
# verification we query `lastprice` for the asset and read the returned
# timestamp. The exact method names are documented in docs/reflector-feeds.md.
# ---------------------------------------------------------------------------
query_feed() {
  local address="$1" asset="$2"
  # Read-only invoke: no --send, no signing. Returns JSON on stdout.
  "${STELLAR_CLI}" contract invoke \
    --id "${address}" \
    --rpc-url "${RPC_URL}" \
    --network "${NETWORK}" \
    -- \
    lastprice \
    --asset "{\"symbol\":\"${asset}\"}" 2>/dev/null
}

# Extract a numeric field from the JSON-ish CLI output without jq.
extract_field() {
  local json="$1" key="$2"
  printf '%s' "${json}" \
    | tr -d '\n' \
    | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+" \
    | head -n1 \
    | grep -oE '[0-9]+$' || true
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
FAILURES=0
VERIFIED=0

verify_entry() {
  local asset="$1" network="$2" address="$3" cadence="$4" staleness="$5"

  log "==> Verifying ${asset} on ${network}"
  log "    address:   ${address}"
  log "    cadence:   ${cadence}s"
  log "    staleness: ${staleness}s"

  if [[ -z "${address}" || "${address}" == "-" ]]; then
    log "    FAIL: catalog has no address for ${asset}/${network}"
    FAILURES=$((FAILURES + 1))
    return
  fi

  local out
  if ! out="$(query_feed "${address}" "${asset}")"; then
    log "    FAIL: read-only query to ${address} failed"
    FAILURES=$((FAILURES + 1))
    return
  fi

  # Address liveness: a successful invoke implies the contract responded.
  log "    OK: contract responded"

  # Cadence check (if the feed reports it).
  local reported_cadence
  reported_cadence="$(extract_field "${out}" "cadence")"
  if [[ -n "${reported_cadence}" && -n "${cadence}" && "${cadence}" != "-" ]]; then
    if [[ "${reported_cadence}" != "${cadence}" ]]; then
      log "    FAIL: cadence mismatch (catalog=${cadence}s, feed=${reported_cadence}s)"
      FAILURES=$((FAILURES + 1))
      return
    fi
    log "    OK: cadence matches (${cadence}s)"
  else
    log "    WARN: cadence not reported by feed; skipping cadence assertion"
  fi

  # Staleness check: last-updated timestamp must be within recommended staleness.
  local last_updated now age
  last_updated="$(extract_field "${out}" "timestamp")"
  if [[ -z "${last_updated}" ]]; then
    last_updated="$(extract_field "${out}" "last_updated")"
  fi

  if [[ -z "${last_updated}" ]]; then
    log "    WARN: feed did not report a timestamp; skipping staleness assertion"
  elif [[ -z "${staleness}" || "${staleness}" == "-" ]]; then
    log "    WARN: catalog has no recommended staleness; skipping staleness assertion"
  else
    now="$(date +%s)"
    # Reflector timestamps are seconds since epoch.
    age=$(( now - last_updated ))
    if [[ "${age}" -lt 0 ]]; then
      log "    WARN: feed timestamp is in the future (age=${age}s); clock skew?"
    fi
    if [[ "${age}" -gt "${staleness}" ]]; then
      log "    FAIL: feed is stale (age=${age}s > recommended ${staleness}s)"
      FAILURES=$((FAILURES + 1))
      return
    fi
    log "    OK: feed fresh (age=${age}s <= ${staleness}s)"
  fi

  VERIFIED=$((VERIFIED + 1))
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [[ "${VERIFY_ALL}" -eq 1 ]]; then
  rows="$(parse_catalog "${NETWORK}" "")"
  # --all: iterate every asset for the selected network.
  mapfile -t entries < <(
    awk -v net="${NETWORK}" '
      BEGIN { FS = "|" }
      /^\|/ {
        n = 0
        for (i = 1; i <= NF; i++) {
          f = $i
          gsub(/^[ \t]+|[ \t]+$/, "", f)
          if (f == "" && (i == 1 || i == NF)) continue
          fields[++n] = f
        }
        if (n < 5) next
        if (fields[1] == "Asset") next
        if (fields[1] ~ /^-+$/) next
        if (fields[2] == net) {
          print fields[1] "\t" fields[2] "\t" fields[3] "\t" fields[4] "\t" fields[5]
        }
      }
    ' "${CATALOG_FILE}"
  )
  if [[ "${#entries[@]}" -eq 0 ]]; then
    skip "no catalog entries for network '${NETWORK}'"
  fi
  for row in "${entries[@]}"; do
    IFS=$'\t' read -r a nt addr cad stale <<< "${row}"
    verify_entry "${a}" "${nt}" "${addr}" "${cad}" "${stale}"
  done
else
  row="$(parse_catalog "${NETWORK}" "${ASSET}" | head -n1)"
  if [[ -z "${row}" ]]; then
    skip "no catalog entry for ${ASSET}/${NETWORK}"
  fi
  IFS=$'\t' read -r a nt addr cad stale <<< "${row}"
  verify_entry "${a}" "${nt}" "${addr}" "${cad}" "${stale}"
fi

log ""
log "Verified ${VERIFIED} entr(ies); ${FAILURES} failure(s)."
if [[ "${FAILURES}" -gt 0 ]]; then
  exit 1
fi
exit 0