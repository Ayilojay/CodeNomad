# Bonded dispute lifecycle

Market authors opt in through `register_disputable_spec`. Existing signer
specifications and their finalization paths retain their behavior. The
resolver holds the configured positive bond in the market collateral token.
Each market has at most one open dispute. The proposal must exist and the
challenge must arrive strictly before the proposal timestamp plus the
dispute window.

| From | Trigger | Market result | Bond entitlement |
| --- | --- | --- | --- |
| Proposed | Window elapses without a dispute and signers finalize | Proposal | No bond |
| Proposed | Dissenting account authenticates and transfers bond | Disputed, finalization frozen | Resolver holds bond |
| Disputed | Guardian ruling or committee quorum upholds proposal | Proposal | Market-core treasury |
| Disputed | Guardian ruling or committee quorum changes outcome | New outcome or void | Disputer |
| Disputed | Permissionless expiry at or after escalation deadline | Void | Disputer |
| Disputed | Authorized guardian emergency void | Void | Disputer |
| Terminal with entitlement | Anyone invokes `claim_dispute_bond` | Same terminal result | Recorded payee receives bond once |

The escalation deadline is the opening timestamp plus the configured timeout,
using saturating addition. Guardian rulings and committee votes now stop at
that timestamp and return the existing `DisputeWindowClosed` error. Expiry
starts at the same timestamp. Emergency void retains its existing safeguards.
The cutoff also applies to open disputes carried over from the previous code.

The resolver specifies the payee separately from payout, so a failed payout
leaves the entitlement available to retry. Token and bond amount are stored
at opening. The treasury address for a slash is read at ruling time and
stored as the payee. This change preserves the deployed function signatures,
event formats, error numbers and persistent storage layouts. It requires
no migration for existing proposals, votes, disputes or unpaid bonds.
Persistent archived entries must be restored before access.

The resolver contract tests cover uncontested finalization, upholding,
overturning, invalidation, timeout and guardian void, including escrow
balances and claim behavior. The deadline regression covers both escalation
authorities at the exact cutoff. Run `cargo test -p resolver` from this
workspace.
