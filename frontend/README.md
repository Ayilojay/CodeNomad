# CodeNomad Frontend

User-facing web app for CodeNomad. This document covers the wallet connection
flow, network verification, and the manual verification steps required before
shipping to testnet or mainnet.

## Wallet connection

The frontend connects to a supported Stellar wallet via
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
(which wraps Freighter, xBull, Albedo, and other supported wallets).

On connect the app:

1. Requests the selected public key from the wallet.
2. Reads the wallet's active network (`PUBLIC`, `TESTNET`, `FUTURENET`, or
   `LOCAL`).
3. Compares the wallet network against the expected network configured for the
   build (`NEXT_PUBLIC_STELLAR_NETWORK`, default `TESTNET`).

### Displayed state

When a wallet is connected and the network matches, the UI shows:

- The connected **public key** (truncated, with the full key available on
  hover/copy).
- The **detected network** reported by the wallet.

No sample or placeholder key is ever rendered as if it were live. If no wallet
is connected, the UI shows the disconnected state.

### Network mismatch

If the wallet's network does not match the expected network, the connection is
**rejected**:

- The app surfaces a clear error (e.g. "Wallet is on PUBLIC but this app expects
  TESTNET. Switch networks in your wallet and reconnect.").
- The wallet is **not** treated as connected; no public key is shown as active.
- There is **no silent fallback** to the wallet's network or to a default key.

### Disconnect and errors

Disconnecting (or any connection error) resets UI state so that no wallet is
shown as connected. Errors are surfaced to the user rather than swallowed.

## Automated tests

The wallet flow has focused tests covering:

- Successful connect: public key and network are surfaced.
- Network mismatch: connection is rejected with a clear error and no connected
  state.
- Disconnect: state is reset and no wallet is shown as connected.
- Wallet/API error: error is surfaced and state is not left in a connected
  state.

Run the frontend package tests and build in CI:

```bash
npm test
npm run build
```

## Manual verification (release / operator)

Before using against testnet or mainnet, verify locally with localnet or
Freighter's testnet using deterministic fixtures:

1. Start the app pointed at the expected network
   (`NEXT_PUBLIC_STELLAR_NETWORK=TESTNET`).
2. Connect a wallet on the **matching** network — confirm the public key and
   network are displayed and match the wallet.
3. Connect a wallet on a **mismatched** network — confirm the connection is
   rejected with a clear error and no key is shown as connected.
4. Disconnect — confirm the UI returns to the disconnected state.
5. Trigger a wallet error (e.g. reject the connection prompt) — confirm the
   error is surfaced and no connected state remains.

Only after these checks pass should the build be promoted to testnet, and only
after testnet verification to mainnet.
