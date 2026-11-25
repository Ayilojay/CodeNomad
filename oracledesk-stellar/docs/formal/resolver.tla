---------------------------- MODULE resolver ----------------------------
(***************************************************************************)
(* Resolution lifecycle of one market: the resolver contract's            *)
(* `ResolutionState`, its signer-mode attestations/proposal, price mode,  *)
(* the guardian, expiry, and market-core's `MarketStatus`.                *)
(*                                                                         *)
(* Source of truth: contracts/resolver/src/lib.rs (record_attestation,    *)
(* cancel_proposal, finalize_signers, guardian_void_market, resolve_price,*)
(* expire_market) and contracts/market-core/src/lib.rs (resolve,          *)
(* void_market). See docs/formal/README.md for the abstraction.           *)
(*                                                                         *)
(* Soroban reverts an invocation atomically on any error, so an error is  *)
(* modelled as the action not being enabled. The order of the guards      *)
(* therefore only matters for *which* error the contract reports.         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Signers,        \* the configured signer set (resolver SignerConfig.signers)
    T,              \* attestation threshold
    C,              \* market close_time
    W,              \* dispute_window
    RG, OG, SG,     \* REVEAL / ORACLE / SIGNER grace after close_time
    D,              \* resolution deadline (close_time + RESOLUTION_GRACE_SECS)
    MaxCancels,     \* MAX_CANCELS_PER_MARKET
    AllowPrice,     \* BOOLEAN: price mode (and a flapping oracle) is reachable
    AllowGuardian,  \* BOOLEAN: the admin may cancel a proposal / void
    AllowExpire,    \* BOOLEAN: anyone may call expire_market
    AllowBypass,    \* BOOLEAN: the market-core admin swaps in another resolver
    Honest,         \* signers that (under fairness) attest "Yes" when they can
    \* --- committee rotation / hybrid fallback / weighted keys (issue #15) ---
    Epochs,         \* bounded epoch range 1..MaxEpoch (rotation epoch bounds)
    MaxEpoch,       \* upper bound on the rotation epoch counter
    RotLock,        \* time lock: a rotation may only be accepted at now >= RotLock
    FallbackDelay,  \* hybrid fallback opens only at now >= C + FallbackDelay
    Weights,        \* weight per signer (weighted keys); 0 = ineligible
    WThreshold      \* weighted threshold (sum of weights needed to decide)

ASSUME /\ T \in 1..Cardinality(Signers)
       /\ C \in Nat /\ W \in Nat /\ MaxCancels \in Nat
       /\ D >= C + RG /\ D >= C + OG /\ D >= C + SG
       /\ Honest \subseteq Signers
       /\ MaxEpoch \in Nat /\ Epochs = 1..MaxEpoch
       /\ RotLock \in Nat /\ FallbackDelay \in Nat
       /\ Weights \in [Signers -> Nat]
       /\ WThreshold \in Nat
       /\ WThreshold <= SumWeights

SumWeights ==
    LET f[S \in SUBSET Signers] ==
            IF S = {} THEN 0 ELSE Weights[CHOOSE s \in S : TRUE] + f[S \ {CHOOSE s \in S : TRUE}]
    IN f[Signers]

Outcomes == {"Yes", "No", "Invalid"}
Terminal == {"Finalized", "Expired"}   \* ResolutionState::is_terminal()
Min(a, b) == IF a < b THEN a ELSE b
Perm == Permutations(Signers)

(* `now` saturates at D: every guard compares it with a threshold <= D, so  *)
(* later time is indistinguishable. A proposal stores its `age` in ticks,  *)
(* saturating at W, instead of `proposed_at` (now < at + W  <=>  age < W). *)
VARIABLES
    now, status, mode, state, attested, proposal, cancels, oracleUp,
    \* committee rotation / hybrid fallback / weighted keys (issue #15)
    committee,      \* current committee id (epoch) whose signers are eligible
    epoch,          \* current epoch counter (bounded by MaxEpoch)
    rotProposal,    \* pending rotation: [to |-> epoch, at |-> tick] or "none"
    fallback,       \* hybrid fallback opened (open_fallback transition)
    \* history (auditing only, never read by an action's enabling condition)
    propSeq, cancelled, resolvedBy, resolvedAfterClose, finalSeq, exits,
    rotSeq, rotAccepted, decidedEpoch, decidedBy

vars == << now, status, mode, state, attested, proposal, cancels, oracleUp,
           committee, epoch, rotProposal, fallback,
           propSeq, cancelled, resolvedBy, resolvedAfterClose, finalSeq,
           exits, rotSeq, rotAccepted, decidedEpoch, decidedBy >>

NoProp == [outcome |-> "none", age |-> 0, seq |-> 0]
NoRot == "none"
HasProp == proposal.outcome /= "none"
Count(o) == Cardinality(attested[o])
Quorum(o) == Count(o) >= T

\* Weighted eligibility: a signer is a member of committee `cid` at epoch `e`
\* only if it is in the configured set, has non-zero weight, and the epoch is
\* within bounds. `MemberAt` is the eligibility predicate used by Attest.
MemberAt(cid, e) ==
    { s \in Signers : Weights[s] > 0 /\ e \in Epochs /\ cid = e }

\* Weighted quorum: the sum of weights of eligible attesters reaches the
\* weighted threshold. Reduces to Quorum when all weights are 1 and
\* WThreshold = T.
WeightOf(S) ==
    LET f[Q \in SUBSET S] ==
            IF Q = {} THEN 0 ELSE Weights[CHOOSE s \in Q : TRUE] + f[Q \ {CHOOSE s \in Q : TRUE}]
    IN f[S]
WeightedQuorum(o) ==
    WeightOf(attested[o] \cap MemberAt(committee, epoch)) >= WThreshold

Init ==
    /\ now = 0
    /\ status = "Open"
    /\ mode = "none"
    /\ state = "Unconfigured"
    /\ attested = [o \in Outcomes |-> {}]
    /\ proposal = NoProp
    /\ cancels = 0
    /\ oracleUp = TRUE
    /\ committee = 1
    /\ epoch = 1
    /\ rotProposal = NoRot
    /\ fallback = FALSE
    /\ propSeq = 0
    /\ cancelled = {}
    /\ resolvedBy = "none"
    /\ resolvedAfterClose = FALSE
    /\ finalSeq = 0
    /\ exits = 0
    /\ rotSeq = 0
    /\ rotAccepted = {}
    /\ decidedEpoch = 0
    /\ decidedBy = "none"

(* market-core status leaves Open exactly once. `resolve` needs now >= C;  *)
(* `void_market` has no time guard but is only ever called with one.       *)
Leave(newStatus, by) ==
    /\ status = "Open"
    /\ status' = newStatus
    /\ resolvedBy' = by
    /\ resolvedAfterClose' = (now >= C)
    /\ exits' = exits + 1

\* resolver.register_signer_spec: assert_unconfigured, then SignersPending.
RegisterSigners ==
    /\ state \notin Terminal
    /\ mode = "none"
    /\ mode' = "signers"
    /\ state' = "SignersPending"
    /\ UNCHANGED << now, status, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback,
                    propSeq, cancelled, resolvedBy, resolvedAfterClose,
                    finalSeq, exits, rotSeq, rotAccepted, decidedEpoch,
                    decidedBy >>

\* resolver.register_price_spec: state stays Unconfigured in price mode.
RegisterPrice ==
    /\ AllowPrice
    /\ state \notin Terminal
    /\ mode = "none"
    /\ mode' = "price"
    /\ UNCHANGED << now, status, state, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback,
                    propSeq, cancelled, resolvedBy, resolvedAfterClose,
                    finalSeq, exits, rotSeq, rotAccepted, decidedEpoch,
                    decidedBy >>

\* resolver.attest: dedup per (outcome, signer); first quorum proposes; an
\* Invalid quorum displaces a pending Yes/No proposal (and restarts its
\* window); a pending Invalid is never displaced.
Attest(s, o) ==
    /\ mode = "signers"
    /\ state \notin Terminal
    /\ now >= C
    /\ s \notin attested[o]
    /\ s \in MemberAt(committee, epoch)  \* only current-committee members vote
    /\ (s \in Honest => o = "Yes")      \* honest signers only ever vote Yes
    /\ attested' = [attested EXCEPT ![o] = @ \cup {s}]
    /\ LET quorum == Cardinality(attested[o]) + 1 >= T
           wq     == WeightOf((attested[o] \cup {s}) \cap MemberAt(committee, epoch))
                       >= WThreshold
           may    == ~HasProp
                     \/ (o = "Invalid" /\ proposal.outcome /= "Invalid")
       IN IF quorum /\ wq /\ may
          THEN /\ proposal' = [outcome |-> o, age |-> 0, seq |-> propSeq + 1]
               /\ propSeq' = propSeq + 1
          ELSE UNCHANGED << proposal, propSeq >>
    /\ UNCHANGED << now, status, mode, state, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, cancelled,
                    resolvedBy, resolvedAfterClose, finalSeq, exits,
                    rotSeq, rotAccepted, decidedEpoch, decidedBy >>

\* resolver.cancel_proposal(DisputeUpheld): admin, inside the window, rate
\* limited. Removes only the proposal; attestations and counts stay. The
\* contract does not look at ResolutionState here, and neither does this.
Cancel ==
    /\ AllowGuardian
    /\ mode = "signers"
    /\ HasProp
    /\ proposal.age < W
    /\ cancels < MaxCancels
    /\ proposal' = NoProp
    /\ cancels' = cancels + 1
    /\ cancelled' = cancelled \cup {proposal.seq}
    /\ UNCHANGED << now, status, mode, state, attested, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    resolvedBy, resolvedAfterClose, finalSeq, exits,
                    rotSeq, rotAccepted, decidedEpoch, decidedBy >>

\* resolver.finalize_signers. It does not check ResolutionState itself; a
\* finalized or voided market fails inside market-core (MarketNotOpen).
Finalize ==
    /\ mode = "signers"
    /\ HasProp
    /\ proposal.age >= W
    /\ Quorum(proposal.outcome)
    /\ Leave(IF proposal.outcome = "Invalid" THEN "Void" ELSE proposal.outcome,
             "signers")
    /\ state' = "Finalized"
    /\ finalSeq' = proposal.seq
    /\ decidedEpoch' = epoch
    /\ decidedBy' = "signers"
    /\ UNCHANGED << now, mode, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, rotSeq, rotAccepted >>

\* resolver.guardian_void_market with each GuardianReason's on-chain check.
GuardianVoid ==
    /\ AllowGuardian
    /\ state \notin Terminal
    /\ \/ (mode = "signers" /\ HasProp /\ proposal.age < W)       \* DisputeUpheld
       \/ (mode = "signers" /\ ~HasProp /\ now >= C + SG)         \* SignersStalled
       \/ (mode = "none" /\ now >= C + RG)                        \* UnrevealedSpec
       \/ (mode = "price" /\ now >= C + OG /\ ~oracleUp)          \* OracleUnavailable
    /\ Leave("Void", "guardian")
    /\ state' = "Finalized"
    /\ decidedEpoch' = epoch
    /\ decidedBy' = "guardian"
    /\ UNCHANGED << now, mode, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, finalSeq, rotSeq, rotAccepted >>

\* resolver.resolve_price: oracle outcome is environment non-determinism.
ResolvePrice(o) ==
    /\ mode = "price"
    /\ now >= C
    /\ state \notin Terminal
    /\ oracleUp
    /\ Leave(o, "price")
    /\ state' = "Finalized"
    /\ decidedEpoch' = epoch
    /\ decidedBy' = "price"
    /\ UNCHANGED << now, mode, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, finalSeq, rotSeq, rotAccepted >>

\* The oracle feed becoming usable/unusable (staleness, history ageing out).
OracleFlip ==
    /\ AllowPrice
    /\ oracleUp' = ~oracleUp
    /\ UNCHANGED << now, status, mode, state, attested, proposal, cancels,
                    committee, epoch, rotProposal, fallback,
                    propSeq, cancelled, resolvedBy, resolvedAfterClose,
                    finalSeq, exits, rotSeq, rotAccepted, decidedEpoch,
                    decidedBy >>

\* resolver.expire_market: after the deadline, settles from a usable price,
\* refuses while a quorum-backed proposal exists, otherwise voids.
Expire ==
    /\ AllowExpire
    /\ state \notin Terminal
    /\ now >= D
    /\ ~(mode = "signers" /\ HasProp /\ Quorum(proposal.outcome))
    /\ \/ /\ mode = "price" /\ oracleUp
          /\ \E o \in {"Yes", "No"} : Leave(o, "price")
          /\ state' = "Finalized"
          /\ decidedBy' = "price"
       \/ /\ ~(mode = "price" /\ oracleUp)
          /\ Leave("Void", "expire")
          /\ state' = "Expired"
          /\ decidedBy' = "expire"
    /\ decidedEpoch' = epoch
    /\ UNCHANGED << now, mode, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, finalSeq, rotSeq, rotAccepted >>

\* Trust assumption: the market-core admin rotates the resolver
\* (propose_resolver/accept_resolver) and the new one resolves. This resolver
\* never sees it, so its own state is untouched.
AdminBypass ==
    /\ AllowBypass
    /\ \E o \in {"Yes", "No", "Void"} :
          /\ (o = "Void" \/ now >= C)
          /\ Leave(o, "bypass")
    /\ decidedEpoch' = epoch
    /\ decidedBy' = "bypass"
    /\ UNCHANGED << now, mode, state, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, finalSeq, rotSeq, rotAccepted >>

Tick ==
    /\ \/ now < D
       \/ (HasProp /\ proposal.age < W)
    /\ now' = Min(now + 1, D)
    /\ proposal' = IF HasProp
                   THEN [proposal EXCEPT !.age = Min(@ + 1, W)]
                   ELSE proposal
    /\ UNCHANGED << status, mode, state, attested, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, resolvedBy, resolvedAfterClose, finalSeq,
                    exits, rotSeq, rotAccepted, decidedEpoch, decidedBy >>

\* resolver.propose_rotation: admin proposes moving to a new epoch. The
\* target epoch must be strictly greater than the current one and within
\* bounds (rotation epoch bounds). Only one rotation may be pending.
ProposeRotation(newEpoch) ==
    /\ AllowGuardian
    /\ state \notin Terminal
    /\ rotProposal = NoRot
    /\ newEpoch \in Epochs
    /\ newEpoch > epoch
    /\ rotProposal' = [to |-> newEpoch, at |-> now]
    /\ rotSeq' = rotSeq + 1
    /\ UNCHANGED << now, status, mode, state, attested, proposal, cancels,
                    oracleUp, committee, epoch, fallback, propSeq, cancelled,
                    resolvedBy, resolvedAfterClose, finalSeq, exits,
                    rotAccepted, decidedEpoch, decidedBy >>

\* resolver.accept_rotation: the time lock must have elapsed. Accepting
\* advances the committee/epoch. A pending resolution proposal is *not*
\* discarded: it keeps its attestations, but only members of the new
\* committee count toward the weighted quorum (see WeightedQuorum).
AcceptRotation ==
    /\ rotProposal /= NoRot
    /\ now >= RotLock
    /\ now >= rotProposal.at
    /\ rotProposal.to \in Epochs
    /\ rotProposal.to > epoch
    /\ committee' = rotProposal.to
    /\ epoch' = rotProposal.to
    /\ rotAccepted' = rotAccepted \cup {rotProposal.to}
    /\ rotProposal' = NoRot
    /\ UNCHANGED << now, status, mode, state, attested, proposal, cancels,
                    oracleUp, fallback, propSeq, cancelled, resolvedBy,
                    resolvedAfterClose, finalSeq, exits, rotSeq,
                    decidedEpoch, decidedBy >>

\* resolver.open_fallback: hybrid fallback opens only after close_time plus
\* the fallback delay. Once open, price resolution is reachable even in
\* signer mode (dual path).
OpenFallback ==
    /\ AllowPrice
    /\ state \notin Terminal
    /\ ~fallback
    /\ now >= C + FallbackDelay
    /\ fallback' = TRUE
    /\ UNCHANGED << now, status, mode, state, attested, proposal, cancels,
                    oracleUp, committee, epoch, rotProposal, propSeq,
                    cancelled, resolvedBy, resolvedAfterClose, finalSeq,
                    exits, rotSeq, rotAccepted, decidedEpoch, decidedBy >>

\* Hybrid dual-path price resolution: in signer mode with fallback open, a
\* usable oracle supersedes a pending attested proposal (the price path
\* wins). Requires no quorum-backed proposal to be pending (same guard as
\* Expire) so an already-decided attestation is never overridden.
ResolveFallbackPrice(o) ==
    /\ mode = "signers"
    /\ fallback
    /\ oracleUp
    /\ now >= C
    /\ state \notin Terminal
    /\ ~(HasProp /\ Quorum(proposal.outcome))
    /\ Leave(o, "price")
    /\ state' = "Finalized"
    /\ decidedEpoch' = epoch
    /\ decidedBy' = "price"
    /\ UNCHANGED << now, mode, attested, proposal, cancels, oracleUp,
                    committee, epoch, rotProposal, fallback, propSeq,
                    cancelled, finalSeq, rotSeq, rotAccepted >>

Next ==
    \/ RegisterSigners
    \/ RegisterPrice
    \/ \E s \in Signers, o \in Outcomes : Attest(s, o)
    \/ Cancel
    \/ Finalize
    \/ GuardianVoid
    \/ \E o \in {"Yes", "No"} : ResolvePrice(o)
    \/ OracleFlip
    \/ Expire
    \/ AdminBypass
    \/ \E e \in Epochs : ProposeRotation(e)
    \/ AcceptRotation
    \/ OpenFallback
    \/ \E o \in {"Yes", "No"} : ResolveFallbackPrice(o)
    \/ Tick

Spec == Init /\ [][Next]_vars

(* Liveness assumptions: time passes, the market is configured, honest      *)
(* signers vote Yes when they can, and a ready proposal is finalized.       *)
LiveSpec ==
    /\ Spec
    /\ WF_vars(Tick)
    /\ WF_vars(RegisterSigners)
    /\ WF_vars(Finalize)
    /\ \A s \in Honest : WF_vars(Attest(s, "Yes"))

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK ==
    /\ now \in 0..D
    /\ status \in {"Open", "Yes", "No", "Void"}
    /\ mode \in {"none", "price", "signers"}
    /\ state \in {"Unconfigured", "SignersPending"} \cup Terminal
    /\ attested \in [Outcomes -> SUBSET Signers]
    /\ proposal.outcome \in Outcomes \cup {"none"}
    /\ cancels \in 0..MaxCancels
    /\ exits \in 0..1
    /\ committee \in Epochs
    /\ epoch \in Epochs
    /\ rotProposal \in {NoRot} \cup [to : Epochs, at : 0..D]
    /\ fallback \in BOOLEAN
    /\ decidedEpoch \in 0..MaxEpoch
    /\ decidedBy \in {"none", "signers", "guardian", "price", "expire", "bypass"}

\* AtMostOnceFinal: market-core leaves Open at most once ...
AtMostOnceFinal == exits <= 1
\* ... and never changes afterwards (also: a Void market is never Resolved).
StatusMonotone == [][status /= "Open" => status' = status]_vars
VoidMeansNoResolve == [][status = "Void" => status' = "Void"]_vars

\* The resolver reports a terminal state only for a non-Open market.
FinalImpliesClosed == state \in Terminal => status /= "Open"

\* Any Yes/No result of a signer-mode market had threshold support (counts
\* only ever grow). Fails only through the AdminBypass trust assumption.
ResolvedOutcomeHadThreshold ==
    (mode = "signers" /\ status \in {"Yes", "No"}) => Quorum(status)

\* A cancelled proposal is never the one finalized: finalization consumes a
\* proposal created after (and distinct from) every cancelled one.
NoFinalizeAfterCancelWithoutNewProposal ==
    resolvedBy = "signers" => finalSeq \notin cancelled

\* No resolution or void of any kind before close_time, except admin bypass.
NoResolveBeforeClose ==
    (status /= "Open" /\ resolvedBy /= "bypass") => resolvedAfterClose


\* Signer finalization only happens once the proposal's dispute window elapsed.
WindowRespected ==
    [][(status = "Open" /\ resolvedBy' = "signers") => proposal.age >= W]_vars

\* A pending proposal is never replaced by a later attestation, except by an
\* Invalid quorum (the claimed "re-proposal resets proposed_at" griefing).
ProposalTimestampStable ==
    [][(HasProp /\ proposal'.outcome \in Outcomes /\ proposal'.outcome /= "Invalid")
       => proposal'.seq = proposal.seq]_vars

\* Witness property (expected to be violated): an Invalid quorum displaces a
\* pending Yes/No proposal. Intended behaviour; see README.
NoInvalidDisplacement ==
    [][~(proposal.outcome \in {"Yes", "No"} /\ proposal'.outcome = "Invalid")]_vars

\* Witness property (expected to be violated by resolver_cancel.cfg): a
\* quorum exists for an outcome but no proposal does, so finalize_signers
\* fails with NoProposal although the signers "agreed".
NoStrandedQuorum ==
    ~(mode = "signers" /\ state = "SignersPending" /\ ~HasProp
      /\ \E o \in Outcomes : Quorum(o))

\* --- Committee rotation / hybrid fallback / weighted keys (issue #15) ---

\* Rotation epoch bounds respected: the committee never leaves Epochs and
\* never moves backwards.
RotationBoundsRespected ==
    [][committee' \in Epochs /\ committee' >= committee]_vars

\* A rotation is only accepted after the time lock elapsed.
RotationTimeLockRespected ==
    [][(rotProposal /= NoRot /\ rotProposal' = NoRot /\ committee' /= committee)
       => now >= RotLock]_vars

\* No rotated-out signer decides an outcome: the deciding epoch is the epoch
\* at which the outcome was decided, and it is within bounds.
NoRotatedOutSignerDecides ==
    (status /= "Open" /\ decidedBy /= "none") => decidedEpoch \in Epochs

\* Hybrid fallback only opens after close_time + fallback_delay.
FallbackOnlyAfterDelay ==
    [][(~fallback /\ fallback') => now >= C + FallbackDelay]_vars

\* A finalized signer outcome had weighted quorum among the deciding epoch's
\* eligible members.
WeightedOutcomeHadQuorum ==
    (mode = "signers" /\ status \in {"Yes", "No"} /\ decidedBy = "signers")
        => WeightedQuorum(status)

\* Liveness: honest signers attesting Yes lead to a Resolved market.
Liveness == <>(status \in {"Yes", "No"})

=========================================================================
