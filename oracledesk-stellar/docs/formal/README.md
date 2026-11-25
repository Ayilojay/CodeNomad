# Formal model: resolution lifecycle, rotation and hybrid fallback

[`resolver.tla`](resolver.tla) is a TLA+ model of how one market goes from
`Open` to a final state, checked with TLC. It is documentation as much as a
proof artifact: each action mirrors one entrypoint of
`contracts/resolver/src/lib.rs` or `contracts/market-core/src/lib.rs`.

The model covers signer-mode resolution, price mode, committee rotation
(`propose_committee` / `accept_committee`), pending resolution proposals
interacting with a rotation, weighted signer keys and the hybrid mode's
fallback opening. Each of these is a separate, switchable part of the state
machine so a config can enable only what it checks.

```bash
make formal            # runs every config, checks each outcome is the expected one
TLA2TOOLS=/path/to/tla2tools.jar make formal
```

`make formal` exits 0 with a skip message when Java is missing, and downloads
`tla2tools.jar` into `docs/formal/.tools/` (git-ignored) when it is not given.
Developed against TLC 2026.10.15 (rev 932d35e) on OpenJDK 17.

**Why TLA+/TLC and not Quint:** TLC checks safety, action properties and
liveness (under fairness) in one tool, needs only a JRE, and its traces map
one-to-one onto the Rust conformance tests below.

## What is modelled

One market, in either mode, with these actors: `N` signers, a guardian
(the resolver admin), an anonymous finalizer/expirer, the oracle, an optional
admin bypass, and time.

| TLA+ action | Rust |
|---|---|
| `RegisterSigners` / `RegisterPrice` | `register_signer_spec` / `register_price_spec` (`assert_unconfigured`; price mode stays `Unconfigured`) |
| `Attest(s, o)` | `attest` → `record_attestation` (per-`(outcome, signer)` dedup, `now >= close_time`, first quorum proposes, Invalid quorum displaces a pending Yes/No) |
| `Cancel` | `cancel_proposal(DisputeUpheld)` (inside the window, ≤ `MAX_CANCELS_PER_MARKET`, keeps counts) |
| `Finalize` | `finalize_signers` (window elapsed, quorum still holds; Yes/No → `resolve`, Invalid → `void_market`) |
| `GuardianVoid` | `guardian_void_market` with each `GuardianReason`'s on-chain precondition |
| `ResolvePrice(o)`, `OracleFlip` | `resolve_price`; the oracle's outcome and availability are environment non-determinism |
| `Expire` | `expire_market` (deadline; settles from a usable price; refuses while a quorum-backed proposal exists; otherwise voids) |
| `AdminBypass` | market-core admin installs another resolver (`propose_resolver`/`accept_resolver`) which resolves; this resolver never sees it |
| `ProposeCommittee(c, w)` | `propose_committee` (admin only, `CommitteeProposal` stored with `accept_after`) |
| `AcceptCommittee` | `accept_committee` (after `accept_after`, replaces `signers`/`weights`, clears pending proposal) |
| `ProposeResolution(o)` | `propose_resolution` (signer-mode proposal recorded without an attestation quorum; opens the dispute window) |
| `FallbackOpen` | hybrid mode: `open_fallback` when the oracle is unavailable past `fallback_after` |
| `WeightedAttest(s, o)` | `attest` with per-signer weights: quorum is `sum(weight) >= threshold`, not a signer count |
| `Tick` | ledger time passing |

**Atomic reverts.** Soroban rolls back an invocation on any error, so an error
is an action that is not enabled. Guard order therefore only decides *which*
error the contract returns (e.g. `attest` checks `AlreadyFinalized` before
`AlreadyAttested`); the model does not distinguish them. market-core's own
guards are folded into the action that calls it (`status = "Open"` for both
`resolve` and `void_market`).

**Time.** `now` saturates at `D`: every guard compares it to a threshold `≤ D`
(`C`, `C+RG`, `C+OG`, `C+SG`, `D`), so later times are indistinguishable. A
proposal stores `age` (ticks since it was proposed) saturating at `W` instead
of `proposed_at`, since `now < proposed_at + W ⇔ age < W`. This also keeps
liveness checking finite.

**Rotation.** `ProposeCommittee` stores a candidate committee and an
`accept_after` time; `AcceptCommittee` is enabled only once `now >=
accept_after` and the proposal is still pending. Accepting replaces the signer
set and weights and **clears any pending resolution proposal** (the contract
does this so a proposal backed by the old committee cannot be finalized by the
new one). The model keeps the old committee's attestations in `votes` but they
no longer count toward quorum because quorum is computed over the *current*
signer set; `NoStaleCommitteeFinalize` checks this.

**Pending proposals.** `ProposeResolution` records a proposal without a quorum
(the admin/guardian path). It opens the dispute window exactly like a
quorum-triggered proposal, so `Finalize` and `Cancel` treat both identically.
`NoProposalSurvivesRotation` checks that accepting a committee removes it.

**Weighted keys.** `WeightedAttest` uses `weights[s]` and the quorum predicate
`sum(weights of attesters for o) >= threshold`. With all weights `1` this
reduces to the count model, so the unweighted configs are a special case.
`WeightedQuorumSound` checks that a finalized outcome had weighted quorum.

**Hybrid fallback.** `FallbackOpen` is enabled only in hybrid mode, only while
the oracle is unavailable, and only after `fallback_after`; it switches the
market to signer mode. `NoFallbackBeforeDeadline` and
`NoFallbackWhenOracleAvailable` check the guards. Once open, resolution
proceeds through the signer actions unchanged.

**Not modelled** (deliberately; each is orthogonal to the lifecycle): FPMM
pricing, treasury and tokens, `SignersDisputable` bonds (`Disputed` state),
and `u64` overflow (naturals are used; see Notes). Hybrid, weighted and
committee resolution all end in the same `resolve`/`void_market` calls
modelled here.

**Bounds.** `Signers` is 2–4 model values, `T = 2`, `C = 1`, `W = 1`,
`RG = OG = 2`, `SG = 3`, `D = 6`, `MaxCancels = 2` (the contract's value),
`AcceptAfter = 2`, `FallbackAfter = 3`. Small constants are enough because
behaviour only depends on the *order* of the thresholds; symmetry over signers
is used for the safety configs. Rotation configs use two committees of two
signers each (`Signers = {s1, s2, s3, s4}`, `CommitteeA = {s1, s2}`,
`CommitteeB = {s3, s4}`) so a rotation is observable in a short trace.

## Properties

| Name | Meaning | Kind |
|---|---|---|
| `TypeOK` | well-typed state | invariant |
| `AtMostOnceFinal` | market-core leaves `Open` at most once | invariant |
| `StatusMonotone` | after leaving `Open` the status never changes | action property |
| `VoidMeansNoResolve` | a `Void` market is never `Resolved` | action property |
| `FinalImpliesClosed` | resolver `Finalized`/`Expired` ⇒ market status ≠ `Open` | invariant |
| `ResolvedOutcomeHadThreshold` | a Yes/No result of a signer-mode market had quorum | invariant |
| `NoFinalizeAfterCancelWithoutNewProposal` | a cancelled proposal is never the one finalized | invariant |
| `WindowRespected` | signer finalization only after the dispute window | action property |
| `NoResolveBeforeClose` | nothing resolves or voids before `close_time` (except bypass) | invariant |
| `ProposalTimestampStable` | later attestations never replace a pending proposal except by an Invalid quorum | action property |
| `Liveness` | `<>(status ∈ {Yes, No})` under fairness | temporal |
| `NoStrandedQuorum` | witness: quorum exists but no proposal | invariant (expected to fail) |
| `NoInvalidDisplacement` | witness: Invalid never displaces Yes/No | action property (expected to fail) |
| `NoStaleCommitteeFinalize` | a proposal is finalized only by the committee that proposed it | invariant |
| `NoProposalSurvivesRotation` | accepting a committee clears the pending proposal | action property |
| `WeightedQuorumSound` | a Yes/No result had weighted quorum over the current committee | invariant |
| `NoFallbackBeforeDeadline` | hybrid fallback opens only after `fallback_after` | invariant |
| `NoFallbackWhenOracleAvailable` | hybrid fallback opens only while the oracle is unavailable | invariant |
| `RotationLiveness` | `<>(status ∈ {Yes, No})` with a rotation in flight under fairness | temporal |

Liveness assumptions (`LiveSpec`): time passes, the market gets configured,
honest signers (who only ever vote Yes) attest when they can, a ready proposal
is finalized, and the guardian, expiry and bypass are off. `RotationLiveSpec`
adds: a pending committee proposal is eventually accepted, and the accepting
committee's honest members attest after acceptance. Without the acceptance
assumption `RotationLiveness` fails (a rotation can stall the market forever),
which is the documented liveness assumption for rotation.

## Results

| Config | Expected | Result | Distinct states | Time |
|---|---|---|---|---|
| `resolver.cfg` (N=3, all modes, guardian, expiry) | all hold | **No error** | 40,200 | ~1 s |
| `resolver_both_outcomes.cfg` (N=4, T=2) | `ProposalTimestampStable` holds | **No error** | 100,518 | ~4 s |
| `resolver_live.cfg` (N=3, honest = 2) | `Liveness` holds | **No error** | 360 | < 1 s |
| `resolver_cancel.cfg` (N=T=2) | `NoStrandedQuorum` fails | **violated** (exit 12) | 143 | ~1 s |
| `resolver_invalid.cfg` (N=T=2) | `NoInvalidDisplacement` fails | **violated** (exit 13) | 255 | < 1 s |
| `resolver_bypass.cfg` (N=3) | `ResolvedOutcomeHadThreshold` fails | **violated** (exit 12) | 91 | ~1 s |
| `resolver_live_invalid.cfg` (N=4, honest = 2) | `Liveness` fails | **violated** (exit 13) | 4,966 | ~1 s |
| `resolver_rotation.cfg` (two committees, rotation in flight) | `NoStaleCommitteeFinalize`, `NoProposalSurvivesRotation` hold | **No error** | 12,884 | ~2 s |
| `resolver_rotation_live.cfg` (rotation + `RotationLiveSpec`) | `RotationLiveness` holds | **No error** | 1,102 | < 1 s |
| `resolver_weighted.cfg` (weights 1/2, T=3) | `WeightedQuorumSound` holds | **No error** | 8,431 | ~1 s |
| `resolver_hybrid.cfg` (hybrid, oracle unavailable) | `NoFallbackBeforeDeadline`, `NoFallbackWhenOracleAvailable` hold | **No error** | 6,207 | ~1 s |
| `resolver_rotation_stale.cfg` (rotation accepted mid-proposal) | `NoStaleCommitteeFinalize` fails | **violated** (exit 12) | 318 | < 1 s |

State counts for the violated configs vary slightly from run to run (TLC stops
at the first violation while several workers are exploring); the verdicts do not.

The checks have teeth: dropping the window guard from `Finalize`, letting
`Cancel` keep the proposal, dropping the `Open` guard from market-core,
allowing attestation before close, letting `AcceptCommittee` keep the pending
proposal, or counting votes from the pre-rotation committee each make one of
the properties fail (mutation-tested while writing the model).

## Findings

The issue that asked for this model listed four findings to investigate. The
contract has moved since that list was written; each was re-checked against the
current code.

### 1. `cancel_proposal` does not reset votes (confirmed, stranding possible)

`resolver_cancel.cfg`, trace: `RegisterSigners, Tick, Attest(s1,Yes),
Attest(s2,Yes), Cancel`. Counts survive a cancel, so a *new* signer attesting
the quorum outcome re-proposes instantly (a fresh window; the guardian may
cancel at most twice). But when every signer already backs the quorum outcome
(`N = T`, as in the unit-test fixture) nothing can re-propose it: the signers
cannot attest it again (`AlreadyAttested`), and `finalize_signers` fails with
`NoProposal`.

**Assessment: design limitation, doc now accurate.** The doc comment ("the next
attestation that brings any outcome to threshold … proposes again") already
describes the behaviour, but it is not obvious that this can dead-end a
market. The way out is intended: `GuardianReason::SignersStalled` after
`SIGNER_GRACE_SECS`, or `expire_market` after the deadline (which is allowed
because no proposal exists). Replayed by
`model_trace_cancel_strands_quorum_until_stalled_void`.

### 2. "Both outcomes can alternate proposals and delay finalization" (refuted)

`resolver_both_outcomes.cfg` (N=4, T=2, i.e. `T ≤ N/2`): `ProposalTimestampStable`
holds. Current `record_attestation` only proposes when no proposal is pending
(`may_propose`), so later attestations, including a quorum for the other
outcome, never move `proposed_at`. Replayed by
`model_trace_other_outcome_quorum_does_not_reset_window`.

The one exception is intended and was found by `resolver_invalid.cfg`: an
**Invalid** quorum displaces a pending Yes/No proposal and restarts the window,
and an Invalid proposal is never displaced (replayed by
`model_trace_invalid_quorum_displaces_yes_and_restarts_window`). Delay is
therefore bounded to one restart. With `T ≤ N/2`, a coalition of `T` dishonest
signers can force a Void instead of a Yes/No (`resolver_live_invalid.cfg`, the
documented "a quorum saying the question is unanswerable outranks an answer").
That is a property of the m-of-n trust assumption, not a bug.

### 3. Guardian void before close (refuted) and attest-after-void guard (sufficient)

`NoResolveBeforeClose` holds. Every `GuardianReason` other than `DisputeUpheld`
requires `now ≥ close_time`, and `DisputeUpheld` needs a proposal, which needs
an attestation, which needs `now ≥ close_time`. After a guardian void,
`attest` fails with `AlreadyFinalized` and `finalize_signers` (which does not
check `ResolutionState` itself) fails inside market-core with `MarketNotOpen`,
so the guard is sufficient. Replayed by `model_trace_no_void_or_attestation_before_close`
and `model_trace_guardian_void_blocks_later_attest_and_finalize`.

### 4. Admin bypass breaks `ResolvedOutcomeHadThreshold` (confirmed, trust assumption)

`resolver_bypass.cfg`: `RegisterSigners, Tick, AdminBypass(Yes)`. market-core's
admin can propose and accept another resolver, which resolves without this
resolver's signers voting at all; this resolver stays `SignersPending`. This is
the two-step wiring (ADR 0006, 0007) working as designed: the market-core admin
is trusted. Replayed by `model_trace_admin_bypass_resolves_without_threshold`.

### Other observations

- `cancel_proposal` does not check `ResolutionState`, so inside the window it
  also works on an already guardian-voided market (it only removes the
  proposal and spends one of the two cancels). Harmless; mirrored by the model.
- `finalize_signers` computes `proposed_at + dispute_window` with unchecked
  `+` (release builds enable `overflow-checks`, so it traps), while the other
  window checks use `saturating_add`. `dispute_window` is only validated
  non-zero. A huge window therefore means "never finalizable" either way, with
  `expire_market` refused (`ResolutionAvailable`) while a quorum proposal
  exists, so the guardian is the only exit. The model uses naturals and does
  not capture the trap, only the "never" part.
- While writing the bypass test, calling `Resolver::accept_market_core_role`
  on a second resolver in the unit-test environment failed with
  `Error(Context, InvalidAction)` (market-core's `accept_resolver` calls back
  into the same resolver for `market_core()`, which Soroban treats as
  re-entry). This was not investigated further and is not covered by the model;
  worth checking against the testnet deploy flow in
  `scripts/deploy-testnet.sh`.

### 5. Rotation clears pending proposals (confirmed, safety holds)

`resolver_rotation.cfg`: `RegisterSigners, Tick, ProposeResolution(Yes),
ProposeCommittee(B), Tick, Tick, AcceptCommittee`. `NoProposalSurvivesRotation`
holds: `accept_committee` clears the pending proposal, so the old committee's
proposal cannot be finalized by the new one. `resolver_rotation_stale.cfg`
disables that clearing step and `NoStaleCommitteeFinalize` fails, confirming
the guard is load-bearing. Replayed by
`model_trace_rotation_clears_pending_proposal`.

### 6. Rotation liveness needs an acceptance assumption (confirmed)

`resolver_rotation_live.cfg` holds `RotationLiveness` only under
`RotationLiveSpec`; without the "pending committee is eventually accepted"
fairness assumption the market can stall with a proposal pending and no
committee able to finalize. This is a liveness *assumption*, not a safety bug:
the admin is trusted to complete a rotation it started. Documented here so
operators know a half-finished rotation blocks resolution until accepted or
cancelled.

### 7. Weighted quorum is sound but weights are trusted (confirmed)

`resolver_weighted.cfg` (weights `s1=1, s2=2, s3=1`, `T=3`) holds
`WeightedQuorumSound`: a finalized Yes/No had weighted quorum over the current
committee. The model does not check that weights are set sensibly; a single
signer with weight `>= T` can resolve alone. That is the admin's
responsibility (`propose_committee` validates weights are non-zero but not
their distribution). Replayed by `model_trace_weighted_quorum_requires_weights`.

### 8. Hybrid fallback guards hold (confirmed)

`resolver_hybrid.cfg` holds `NoFallbackBeforeDeadline` and
`NoFallbackWhenOracleAvailable`: `open_fallback` is only enabled after
`fallback_after` and only while the oracle is unavailable. Once open, the
market resolves through the signer path with no further oracle dependence.
Replayed by `model_trace_hybrid_fallback_opens_after_deadline_only`.

No contract behaviour was changed by this work.

## Conformance tests

`cargo test -p resolver model_trace_` replays the traces against the real
contracts (two happy paths, plus one test per finding above):

| Test | Model trace |
|---|---|
| `model_trace_signers_happy_path_yes` | `resolver.cfg` signers path |
| `model_trace_price_happy_path_yes` | `resolver.cfg` price path |
| `model_trace_cancel_strands_quorum_until_stalled_void` | `resolver_cancel.cfg` |
| `model_trace_invalid_quorum_displaces_yes_and_restarts_window` | `resolver_invalid.cfg` |
| `model_trace_other_outcome_quorum_does_not_reset_window` | `resolver_both_outcomes.cfg` |
| `model_trace_no_void_or_attestation_before_close` | `NoResolveBeforeClose` |
| `model_trace_guardian_void_blocks_later_attest_and_finalize` | `resolver.cfg` |
| `model_trace_expire_blocked_by_valid_proposal` | `Expire` guard |
| `model_trace_admin_bypass_resolves_without_threshold` | `resolver_bypass.cfg` |
| `model_trace_rotation_clears_pending_proposal` | `resolver_rotation.cfg` |
| `model_trace_weighted_quorum_requires_weights` | `resolver_weighted.cfg` |
| `model_trace_hybrid_fallback_opens_after_deadline_only` | `resolver_hybrid.cfg` |

## Reproducing a counterexample

```bash
cd docs/formal
java -cp tla2tools.jar tlc2.TLC -config resolver_cancel.cfg resolver.tla -workers 1
```

`-workers 1` gives the shortest trace (breadth-first).
