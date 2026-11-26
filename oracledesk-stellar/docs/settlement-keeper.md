# Market settlement keeper

The keeper discovers market IDs from market-core's `market_count` and visits
a bounded range on each run. Its eligibility check simulates the existing
permissionless `finalize_market` call. Market-core decides eligibility using
the ledger timestamp and its existing redemption rules. Finalization sweeps
residual collateral to the configured treasury. The keeper targets
market-core expiry sweeps. Treasury position redemption remains the separate
`settle_market` workflow.

Each run scans at most `KEEPER_LIMIT` markets (default 20, maximum 100).
It records the next ID after each outcome and wraps around at the end of
the inventory, so it revisits markets that become eligible later. A market
can require up to two transactions per run, a restore followed by a
finalization. An archived inventory can require one additional restore.
The keeper restores footprints separately, waits for confirmation, reloads
the account sequence and re-simulates before it submits the sweep. It
accepts either an RPC restore preamble or archived read-write footprint
indexes. Unknown simulation failures are recorded for operator inspection.
An older deployment without the finalization entrypoint will report
simulation errors. No new contract functions, storage formats or
authorization changes are required.

### Local dry run

From `oracledesk-stellar/agents`, point at a local RPC with market-core
deployed and a funded public source account.

```sh
npm ci
KEEPER_RPC_URL=http://localhost:8000/soroban/rpc \
KEEPER_NETWORK_PASSPHRASE='Standalone Network ; February 2017' \
KEEPER_SOURCE="$FUNDED_PUBLIC_ACCOUNT" \
KEEPER_MARKET_CORE="$LOCAL_MARKET_CORE_ID" \
KEEPER_STATE_DIR="$PWD/.local-keeper" \
npm run settlement-keeper
```

The default mode simulates and writes outcomes under `dry-run/`. Exit
with live execution disabled unless the operator is ready to submit.
The deterministic fake-RPC coverage is available with
`npx tsx --test stellar/settlement-keeper.test.ts`.

### Live operation

Use one state directory per network, deployment and source account. Run a
single writer for that directory and dedicate the fee account to the keeper
to avoid sequence races. On Linux, a scheduler can serialize repeat runs
with `flock -n /path/to/keeper.lock npm run settlement-keeper -- --submit`.
Use a current RPC endpoint and keep the host clock synchronized.

Set `KEEPER_MAX_FEE` to the maximum total fee in stroops per transaction
and `KEEPER_SIGNER` to the path of an external signing executable. It
reads one unsigned envelope XDR line from standard input and writes one
signed envelope XDR line to standard output. Put network, fee, account,
operation and contract approval in that signer. The keeper verifies the
returned transaction hash and source signature before broadcasting. It
takes a public account address and does not require an agent hot key.

In `live/`, `outcomes.jsonl` records each market's result,
`transactions.jsonl` records the signed envelopes and confirmation states,
and `cursor` records the next ID. Keep these files across restarts.
An unresolved broadcast stops the batch so the next run can check its hash
or resend the same unexpired envelope before assigning another sequence.
Once a sweep is confirmed, replaying the market only observes its closed
state. Scheduled runs revisit transient per-market failures after wrapping.
