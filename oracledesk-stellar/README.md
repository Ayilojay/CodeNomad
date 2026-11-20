# OracleDesk Stellar

OracleDesk Stellar is the agent and x402 payment layer for OracleDesk. It runs the
market-data agents, the x402 payment middleware, and the payment ledger that
records settled payments, idempotency keys, and unresolved payment intents.

## Packages

- `agents/` — market-data agents (trader, events, dispatch, subscriber).
- `x402/` — payment middleware, ledger, and settlement helpers.

## Payment ledger: backup, migration and recovery

The payment ledger is persisted state. It carries an explicit schema version so
that operators can upgrade safely and restore from backups without losing
payment integrity.

### Schema versioning and migration

- Every persisted ledger records a `schemaVersion`.
- On load, the ledger is migrated forward to the current version through an
  ordered migration path. Older versions are upgraded in place; payment records,
  idempotency keys, and unresolved intents are preserved across the upgrade.
- A ledger whose `schemaVersion` is newer than the running code supports is
  rejected rather than silently downgraded. Operators must upgrade the code
  before opening a ledger written by a newer release.
- Migration is deterministic and idempotent: re-running it on an already-current
  ledger is a no-op.

### Backup and restore

- Backups capture the full ledger: settled payment records, idempotency records,
  and unresolved payment intents.
- Restore validates the backup before applying it. A corrupted or partial backup
  is rejected; the existing ledger is left untouched.
- A restored ledger preserves idempotency records so that replayed requests are
  still deduplicated, and preserves unresolved intents so that in-flight
  payments are not lost.

### Recovery guarantees

- Recovery never fabricates success. Unresolved intents remain unresolved after
  a restore; they are not marked settled without on-chain confirmation.
- Contract verification guarantees are preserved: a payment is only recorded as
  settled when its contract verification succeeds. There is no success-shaped
  fallback for unverified or unresolved payments.
- Duplicate idempotency keys are rejected on restore and on replay, consistent
  with live settlement behavior.

### Configuration

- `LEDGER_PATH` — filesystem location of the persisted payment ledger.
- `LEDGER_BACKUP_PATH` — location used for backup snapshots.

No external prerequisite is required beyond a writable ledger path. Tests use
in-memory and deterministic fixtures and do not require a live network.

### Validation

Run the focused ledger tests for the x402 package:

```
npm test --workspace x402 -- ledger
```

These cover successful migration, backup/restore, and recovery, plus failure and
boundary cases: unknown future schema versions, corrupted or partial backups,
and duplicate idempotency keys.
