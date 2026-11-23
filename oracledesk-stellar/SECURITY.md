# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OracleDesk, please report it privately to the maintainers rather than opening a public issue. Include a description, reproduction steps, and any relevant logs. We aim to acknowledge reports within 72 hours.

## Admin Rotation Runbook (Multisig / Smart Accounts)

Admin authority is transferred with a **two-step** flow: the current admin *proposes* a new admin, and the proposed admin *accepts*. Until acceptance the transfer is **pending** and can be cancelled by the current admin. This runbook documents a least-privilege rotation procedure for each contract and the timelock, and is validated against localnet.

### Roles and least privilege

- **Current admin** — the only signer allowed to propose or cancel a transfer.
- **Proposed admin** — the only signer allowed to accept a pending transfer.
- **Operators** — read-only monitoring; never hold admin keys.

For multisig and smart-account admins, the *admin address* is the multisig/smart-account contract address, not an individual key. Proposals and acceptances must be executed through that account's own signing policy (threshold approvals), never by a single EOA.

### 1. Verify signers before rotating

Confirm the proposed admin address is the intended multisig/smart-account and that its signer set and threshold are correct **before** proposing:

```bash
# Confirm the proposed admin is a contract (multisig / smart account), not an EOA
stellar contract id asset --asset native >/dev/null 2>&1 || true
stellar contract invoke --id <PROPOSED_ADMIN> --network local -- \
  --help >/dev/null 2>&1 && echo "contract reachable"

# For a multisig, verify signers + threshold via its own read-only entrypoints
stellar contract invoke --id <PROPOSED_ADMIN> --network local -- get_signers
stellar contract invoke --id <PROPOSED_ADMIN> --network local -- get_threshold
```

Record the expected signer set and threshold in the change ticket. Do not proceed if they differ from the approved change.

### 2. Propose the new admin (current admin)

Run from the current admin account. For each contract and the timelock, propose the same approved address:

```bash
# Repeat for each contract id and the timelock id
for ID in <CONTRACT_A> <CONTRACT_B> <TIMELOCK>; do
  stellar contract invoke --id "$ID" --network local \
    --source <CURRENT_ADMIN> -- \
    propose_admin --new_admin <PROPOSED_ADMIN>
done
```

If the current admin is itself a multisig, collect the required threshold of approvals on the proposal transaction before it is submitted.

### 3. Monitor pending transfers

Operators should watch for pending transfers and confirm each one matches the approved change:

```bash
for ID in <CONTRACT_A> <CONTRACT_B> <TIMELOCK>; do
  echo "== $ID =="
  stellar contract invoke --id "$ID" --network local -- get_pending_admin
  stellar contract invoke --id "$ID" --network local -- get_admin
done
```

A pending transfer that does not match the change ticket is an incident: cancel it (step 5) and escalate.

### 4. Accept the transfer (proposed admin)

Once every pending transfer is verified, the proposed admin accepts. For a multisig/smart-account admin this must be executed through that account with its threshold approvals:

```bash
for ID in <CONTRACT_A> <CONTRACT_B> <TIMELOCK>; do
  stellar contract invoke --id "$ID" --network local \
    --source <PROPOSED_ADMIN> -- \
    accept_admin
done
```

After acceptance, re-run the monitoring commands from step 3: `get_admin` must return the new admin and `get_pending_admin` must be empty for every id.

### 5. Cancel a pending transfer (recovery)

If a proposal was made in error, is stale, or does not match the approved change, the **current admin** cancels it. Cancellation is safe and leaves the current admin unchanged:

```bash
for ID in <CONTRACT_A> <CONTRACT_B> <TIMELOCK>; do
  stellar contract invoke --id "$ID" --network local \
    --source <CURRENT_ADMIN> -- \
    cancel_admin_transfer
done
```

### 6. Expiry and recovery

- A pending transfer does **not** change admin authority until accepted; the current admin remains in control throughout.
- If a pending transfer expires or is abandoned, no state changes are required — the current admin simply proposes again (step 2).
- If the proposed admin loses access before accepting, cancel the pending transfer (step 5) and restart the rotation with a verified address.
- Never accept a transfer you did not propose through the approved change ticket.

### Localnet validation

All commands above are exercised against a local network (`--network local`). To reproduce end-to-end:

```bash
# 1. Deploy contracts + timelock to localnet (see Makefile targets)
# 2. Propose, monitor, accept, and cancel as documented above
# 3. Assert get_admin / get_pending_admin after each step
```

Document the observed `get_admin` / `get_pending_admin` values at each step in the change ticket as the reproducible verification record.
