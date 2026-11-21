/**
 * Snapshot selector functions: filter and rank markets from chain state.
 *
 * Network/deployment isolation: every selector that reads chain state is
 * scoped to the snapshot's network identity and contract deployment identity.
 * A snapshot whose markets were indexed under a different network or
 * deployment than the one it declares is rejected rather than silently
 * treated as valid, so keys and cursors can never be reused across
 * configurations.
 */
import type { Snapshot, ChainMarket } from "./types.js";

const MIN_RESERVE_STROOPS = BigInt(process.env.AGENT_MIN_RESERVE ?? "100000000"); // 10 XLM
const CLOSE_BUFFER_SEC = Number(process.env.AGENT_CLOSE_BUFFER_SEC ?? 3600);

/**
 * Assert that the snapshot's markets belong to the snapshot's declared
 * network and contract deployment. Throws on missing or mismatched identity
 * so callers cannot fall back to a success-shaped result.
 */
export function assertSnapshotIdentity(snapshot: Snapshot): void {
  const network = snapshot.network;
  const deployment = snapshot.contractId;
  if (!network || !deployment) {
    throw new Error(
      "snapshot identity missing: network and contract deployment are required",
    );
  }
  for (const market of snapshot.markets.values()) {
    if (market.network !== network || market.contractId !== deployment) {
      throw new Error(
        `snapshot identity mismatch: market ${market.marketId} belongs to ` +
          `${market.network}/${market.contractId}, expected ${network}/${deployment}`,
      );
    }
  }
}

/** Markets that are open, have sufficient liquidity, and close in the future. */
export function tradableMarkets(snapshot: Snapshot): ChainMarket[] {
  assertSnapshotIdentity(snapshot);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const bufferSec = BigInt(CLOSE_BUFFER_SEC);

  return Array.from(snapshot.markets.values()).filter(
    (m) =>
      m.status === "open" &&
      m.reserveYes >= MIN_RESERVE_STROOPS &&
      m.reserveNo >= MIN_RESERVE_STROOPS &&
      m.closeTime > nowSec + bufferSec,
  );
}

/** Markets where the agent holds a position. */
export function heldMarkets(snapshot: Snapshot): ChainMarket[] {
  assertSnapshotIdentity(snapshot);
  return Array.from(snapshot.markets.values()).filter((m) => {
    const pos = snapshot.portfolio.positions.get(m.marketId);
    return pos && (pos.yes > 0n || pos.no > 0n);
  });
}

/** Available capital the agent can deploy. */
export function availableCapital(snapshot: Snapshot): bigint {
  const { availableCapital, daily, config } = snapshot.portfolio;
  const dailyRemaining = config.maxDaily - daily.amount;
  return availableCapital < dailyRemaining ? availableCapital : dailyRemaining;
}

/** All unique question hashes already on-chain, used to skip duplicate market proposals. */
export function existingQuestionHashes(snapshot: Snapshot): Set<string> {
  assertSnapshotIdentity(snapshot);
  return new Set(Array.from(snapshot.markets.values()).map((m) => m.questionHash));
}
