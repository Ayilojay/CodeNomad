# Frontend

User-facing surfaces for CodeNomad. This package consumes the generated
bindings in `packages/bindings/*` — it never hardcodes contract addresses,
quotes, or sample values as live data.

## Network selection (#107)

The frontend exposes an explicit network selector with `local`, `testnet`, and
future networks. There is no implicit default that silently falls back after an
error — the selected network is always shown and must be chosen deliberately.

- **Configuration from manifests.** Contract and RPC configuration is loaded
  from validated deployment manifests, never from hardcoded addresses. A
  manifest that fails validation is rejected and surfaced as an error.
- **Network-scoped state.** Caches and wallet state are keyed by the selected
  network. Switching networks does not leak quotes, balances, or wallet state
  across networks.
- **Transaction guard.** Transactions are blocked when the deployment addresses
  in the active manifest do not match the selected network. The mismatch is
  shown to the user; there is no silent fallback to another network's
  addresses.

## Safe transaction flow (#103)

Every trade goes through the same guarded pipeline. Do not bypass any step.

1. **Quote before trade.** Fetch a quote through the generated bindings/SDK
   helpers (`market-core` quote entrypoint). Never display or sign against a
   hardcoded or sample quote.
2. **Explicit slippage and deadline bounds.** The user must supply both a
   slippage tolerance and a deadline. Missing, non-numeric, or out-of-range
   values are rejected before any quote or signature request.
3. **Simulate before signing.** The transaction is simulated first. If
   simulation fails, signing is blocked and the failure is surfaced — there is
   no silent fallback to an un-simulated path.
4. **Distinct transaction states.** The UI shows `pending`, `success`, and
   `failure` as separate states. Errors are shown, never masked as success.

## Validation

CI runs the focused frontend checks (`npm run typecheck`, `npm test`,
`npm run build`) in the `node` job after bindings are generated and built.

### Manual / operator verification

Before testnet use, verify against localnet or deterministic fixtures:

- A quote is fetched from the bindings before the trade form enables signing.
- Submitting with empty or out-of-range slippage/deadline is rejected.
- A failing simulation blocks the signature request and shows a failure state.
- A successful flow shows pending, then success; a rejected signature shows
  failure without claiming success.
- Selecting each network loads configuration from its validated manifest; an
  invalid manifest is rejected rather than silently ignored.
- Switching networks clears network-scoped caches and wallet state.
- A transaction is blocked when deployment addresses do not match the selected
  network.
