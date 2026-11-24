/**
 * Behaviour model of the contract calls the agents make (#106). Prices use
 * the production integer FPMM (core/fpmm.ts); the treasury and registry
 * checks mirror the on-chain validations the agents can trip. Error names are
 * the contracts' own `Error` variants, resolved to codes from the WASM spec.
 *
 * `invoke` is pure with respect to `state`: callers simulate on a clone and
 * apply on the real state, which is what lets a test make simulation and
 * application diverge.
 */
import { buyWithinLimit, calcBuy, MathError, seedReserves } from "../../core/fpmm.js";
import type { ContractName } from "./artifacts.js";

export interface ModelMarket {
  id: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: bigint;
  open: boolean;
  creator: string;
  questionHash: string;
  /** `Resolved(Yes)`, `Resolved(No)`, `Void`, or undefined when still open. */
  resolution?: "Resolved(Yes)" | "Resolved(No)" | "Void";
  /** Whether the treasury's settlement call has completed for this market. */
  settled?: boolean;
}

export interface ModelTrace {
  id: bigint;
  agent: string;
  marketId: bigint;
  action: string;
  traceHash: string;
  cid: string;
}

export interface ModelState {
  markets: ModelMarket[];
  /** Agents the treasury lets trade and create markets. */
  treasuryAgents: string[];
  treasuryBalance: bigint;
  maxTrade: bigint;
  positions: Record<string, bigint>;
  /** Agents registered with the reasoning registry. */
  registryAgents: string[];
  traces: ModelTrace[];
}

export interface ModelEvent {
  contract: ContractName;
  topic: string;
  data: Record<string, unknown>;
}

export interface CallContext {
  /** Ledger close time the call executes at, unix seconds. */
  closeTime: bigint;
  treasuryAddress: string;
}

export type CallOutcome =
  | { ok: true; value: unknown; events: ModelEvent[] }
  | { ok: false; error: string };

/** Functions that never write state or need authorization. */
const READS = new Set(["quote_buy", "quote_sell", "market_count", "get_market", "get_config", "trace_count", "get_trace", "state", "open_exposure_page"]);

export function isWrite(fn: string): boolean {
  return !READS.has(fn);
}

export function initialState(opts: { agents: string[]; balance?: bigint; maxTrade?: bigint }): ModelState {
  return {
    markets: [],
    treasuryAgents: [...opts.agents],
    treasuryBalance: opts.balance ?? 10_000_000_000_000n,
    maxTrade: opts.maxTrade ?? 2_000_000_000n,
    positions: {},
    registryAgents: [...opts.agents],
    traces: [],
  };
}

/** Opens a market directly in the model, as a deploy/seed script would. */
export function seedMarket(
  state: ModelState,
  m: { seed: bigint; yesBps: bigint; closeTime: bigint; creator: string; feeBps?: bigint; questionHash?: string },
): ModelMarket {
  const r = seedReserves(m.seed, m.yesBps);
  const market: ModelMarket = {
    id: BigInt(state.markets.length),
    reserveYes: r.reserveYes,
    reserveNo: r.reserveNo,
    feeBps: m.feeBps ?? 100n,
    closeTime: m.closeTime,
    open: true,
    creator: m.creator,
    questionHash: m.questionHash ?? "00".repeat(32),
  };
  state.markets.push(market);
  return market;
}

/** Marks a market as resolved or voided, as the resolver/oracle would. */
export function resolveMarket(state: ModelState, marketId: bigint, resolution: NonNullable<ModelMarket["resolution"]>): void {
  const m = state.markets.find((x) => x.id === marketId);
  if (!m) throw new Error(`resolveMarket: market ${marketId} not found`);
  m.open = false;
  m.resolution = resolution;
}

type Args = Record<string, unknown>;
type Outcome = { tag: "Yes" | "No" };

function market(state: ModelState, id: unknown): ModelMarket | undefined {
  return state.markets.find((m) => m.id === BigInt(id as bigint));
}

function quote(m: ModelMarket, outcome: Outcome, collateralIn: bigint) {
  const yes = outcome.tag === "Yes";
  return calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, collateralIn, m.feeBps);
}

export function invoke(state: ModelState, contract: ContractName, fn: string, a: Args, ctx: CallContext): CallOutcome {
  const fail = (error: string): CallOutcome => ({ ok: false, error });
  try {
    switch (`${contract}.${fn}`) {
      case "market_core.market_count":
        return { ok: true, value: BigInt(state.markets.length), events: [] };

      case "market_core.get_market": {
        const m = market(state, a.market_id);
        if (!m) return fail("MarketNotFound");
        // Build a status value that mirrors what market-core returns.
        let status: unknown;
        if (!m.resolution) {
          status = { tag: "Open", values: undefined };
        } else if (m.resolution === "Resolved(Yes)") {
          status = { tag: "Resolved", values: [{ tag: "Yes", values: undefined }] };
        } else if (m.resolution === "Resolved(No)") {
          status = { tag: "Resolved", values: [{ tag: "No", values: undefined }] };
        } else {
          status = { tag: "Void", values: undefined };
        }
        return {
          ok: true,
          value: {
            creator: m.creator,
            question_hash: Buffer.from(m.questionHash, "hex"),
            resolution_hash: Buffer.alloc(32),
            close_time: m.closeTime,
            status,
            reserve_yes: m.reserveYes,
            reserve_no: m.reserveNo,
            fee_bps: m.feeBps,
            lp_claimed: false,
            meta_uri: "",
          },
          events: [],
        };
      }

      case "market_core.quote_buy": {
        const m = market(state, a.market_id);
        if (!m) return fail("MarketNotFound");
        if (!m.open) return fail("MarketNotOpen");
        if (ctx.closeTime >= m.closeTime) return fail("MarketClosed");
        return { ok: true, value: quote(m, a.outcome as Outcome, a.collateral_in as bigint).sharesOut, events: [] };
      }

      case "treasury.agent_buy":
      case "treasury.agent_buy_v2": {
        const agent = a.agent as string;
        if (!state.treasuryAgents.includes(agent)) return fail("Unauthorized");
        const collateralIn = a.collateral_in as bigint;
        if (collateralIn <= 0n) return fail("InvalidAmount");
        if (collateralIn > state.maxTrade) return fail("TradeCapExceeded");
        if (collateralIn > state.treasuryBalance) return fail("InsufficientBalance");
        const m = market(state, a.market_id);
        if (!m || !m.open || ctx.closeTime >= m.closeTime) return fail("MarketNotOpen");
        if (fn === "agent_buy_v2" && ctx.closeTime > (a.deadline as bigint)) return fail("MarketCoreCallFailed");
        const q = quote(m, a.outcome as Outcome, collateralIn);
        if (q.sharesOut < (a.min_shares_out as bigint)) return fail("SlippageExceeded");
        if (fn === "agent_buy_v2" && !buyWithinLimit(collateralIn, q.sharesOut, BigInt(a.limit_price_bps as number))) {
          return fail("MarketCoreCallFailed");
        }
        const yes = (a.outcome as Outcome).tag === "Yes";
        if (yes) [m.reserveYes, m.reserveNo] = [q.newReserveBought, q.newReserveOther];
        else [m.reserveNo, m.reserveYes] = [q.newReserveBought, q.newReserveOther];
        state.treasuryBalance -= collateralIn;
        const key = `${m.id}:${(a.outcome as Outcome).tag}`;
        state.positions[key] = (state.positions[key] ?? 0n) + q.sharesOut;
        return {
          ok: true,
          value: q.sharesOut,
          events: [{ contract: "treasury", topic: "trade", data: { market_id: m.id, collateral_in: collateralIn, shares_out: q.sharesOut } }],
        };
      }

      case "treasury.agent_create_market": {
        const agent = a.agent as string;
        if (!state.treasuryAgents.includes(agent)) return fail("Unauthorized");
        const seed = a.seed_amount as bigint;
        if (seed <= 0n || seed > state.treasuryBalance) return fail("InsufficientBalance");
        if ((a.close_time as bigint) <= ctx.closeTime) return fail("CloseTimeTooSoon");
        const qh = Buffer.from(a.question_hash as Buffer).toString("hex");
        const m = seedMarket(state, {
          seed,
          yesBps: BigInt(a.initial_yes_bps as number),
          closeTime: a.close_time as bigint,
          creator: ctx.treasuryAddress,
          questionHash: qh,
        });
        state.treasuryBalance -= seed;
        return { ok: true, value: m.id, events: [{ contract: "treasury", topic: "market_created", data: { market_id: m.id } }] };
      }

      case "treasury.settle_market": {
        const m = market(state, a.market_id);
        if (!m) return fail("MarketCoreMarketNotFound");
        if (!m.resolution) return fail("MarketNotFinal");
        if (m.settled) {
          return {
            ok: true,
            value: { redeemed: 0n, lp_claimed: 0n, already_settled: true },
            events: [],
          };
        }
        // Redeem shares the treasury holds.
        const yesKey = `${m.id}:Yes`;
        const noKey = `${m.id}:No`;
        const yesShares = state.positions[yesKey] ?? 0n;
        const noShares = state.positions[noKey] ?? 0n;
        let redeemed = 0n;
        if (m.resolution === "Resolved(Yes)") redeemed = yesShares;
        else if (m.resolution === "Resolved(No)") redeemed = noShares;
        else if (m.resolution === "Void") redeemed = (yesShares + noShares) / 2n;
        delete state.positions[yesKey];
        delete state.positions[noKey];
        state.treasuryBalance += redeemed;
        // LP remainder: if treasury created the market, claim its half of minimum reserve.
        const lpClaimed = m.creator === ctx.treasuryAddress ? m.reserveYes < m.reserveNo ? m.reserveYes : m.reserveNo : 0n;
        state.treasuryBalance += lpClaimed;
        m.settled = true;
        return {
          ok: true,
          value: { redeemed, lp_claimed: lpClaimed, already_settled: false },
          events: [{ contract: "treasury", topic: "market_settled", data: { market_id: m.id, redeemed, lp_claimed: lpClaimed } }],
        };
      }

      case "treasury.open_exposure_page": {
        // Read-only: returns open (unsettled) markets starting at cursor index.
        const cursor = BigInt(a.cursor as bigint);
        const limit = Math.min(Number(a.limit ?? 20), 20);
        const open = state.markets.filter((m) => !m.settled);
        const start = open.findIndex((m) => m.id >= cursor);
        const slice = start === -1 ? [] : open.slice(start, start + limit);
        const next = start === -1 ? [] : open.slice(start + limit);
        const nextCursor = next.length > 0 ? next[0].id : 0n;
        return {
          ok: true,
          value: { entries: slice.map((m) => ({ market_id: m.id })), next_cursor: nextCursor },
          events: [],
        };
      }

      case "reasoning_registry.publish_trace": {
        const agent = a.agent as string;
        if (!state.registryAgents.includes(agent)) return fail("AgentNotRegistered");
        if (!(a.action as string)) return fail("EmptyAction");
        if (!(a.ipfs_cid as string)) return fail("EmptyCid");
        const t: ModelTrace = {
          id: BigInt(state.traces.length),
          agent,
          marketId: a.market_id as bigint,
          action: String(a.action),
          traceHash: Buffer.from(a.trace_hash as Buffer).toString("hex"),
          cid: String(a.ipfs_cid),
        };
        state.traces.push(t);
        return { ok: true, value: t.id, events: [{ contract: "reasoning_registry", topic: "trace", data: { id: t.id, market_id: t.marketId } }] };
      }

      default:
        throw new Error(`fake RPC: no model for ${contract}.${fn}`);
    }
  } catch (err) {
    if (err instanceof MathError) return fail("InvalidAmount");
    throw err;
  }
}
