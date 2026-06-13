/**
 * Automated on-chain evidence verification — the "ensure the work is good" half of Pangle's
 * quality-based sybil posture (we welcome agent swarms; we just don't reward bad or copied work).
 *
 * Given a discovery's cited evidence, this does cheap read-only RPC checks against the named chain:
 *  - the cited txHash actually exists on that chain;
 *  - the contractAddress actually has bytecode (not an EOA / nonexistent);
 *  - the cited tx's logs actually contain an event matching the CLAIMED anomaly type
 *    (e.g. "Liquidity Removal" must carry a Burn/Sync log) — so a discovery can't mislabel a
 *    random or trivial tx as a high-value anomaly.
 *
 * It is both an AID to scoring and a HARD GATE on a definitive failure: a check that is verifiably
 * false (`ok:false`) blocks the mint; anything unverifiable — no RPC for the chain, an RPC/network
 * error, a still-pending tx, or an anomaly type with no standard event — returns `null` and never
 * blocks. Configure EVIDENCE_RPCS (config.ts) to enable; coverage is per-chain.
 */
import { createPublicClient, http, getAddress, keccak256, toBytes, TransactionNotFoundError, type PublicClient } from "viem";
import type { Config } from "./config.js";

export interface EvidenceResult {
  ok: boolean | null; // true = checks passed, false = a check definitively failed, null = unverified
  chain: string;
  checks: { txExists: boolean | null; contractHasCode: boolean | null; eventConsistent: boolean | null };
  detail: string;
}

/** keccak256 of an event signature = its log topic0. Computed (not hardcoded) so it can't drift. */
export function eventTopic0(sig: string): string {
  return keccak256(toBytes(sig));
}

/**
 * Expected log topic0s per anomaly type — the cited tx must contain at least one matching log.
 * Anomaly types tied to a standard event are listed; STATE-based types with no universal event
 * (e.g. "Tax or Blacklist Change") are intentionally absent → their event check is `null` and never
 * blocks. Covers Uniswap-V2/V3 + OpenZeppelin / EIP-1967 standard events. Keep keys in sync with
 * ANOMALY_TYPES in schema.ts.
 */
const ANOMALY_EVENT_TOPICS: Record<string, string[]> = {
  "Large Token Transfer": [eventTopic0("Transfer(address,address,uint256)")],
  "Liquidity Removal": [
    eventTopic0("Burn(address,uint256,uint256,address)"), // UniV2 pair
    eventTopic0("Burn(address,int24,int24,uint128,uint256,uint256)"), // UniV3 pool
    eventTopic0("Sync(uint112,uint112)"),
  ],
  "Liquidity Addition": [
    eventTopic0("Mint(address,uint256,uint256)"), // UniV2 pair
    eventTopic0("Mint(address,address,int24,int24,uint128,uint256,uint256)"), // UniV3 pool
    eventTopic0("Sync(uint112,uint112)"),
  ],
  "Suspicious Approval": [eventTopic0("Approval(address,address,uint256)")],
  "Proxy Implementation Changed": [
    eventTopic0("Upgraded(address)"), // EIP-1967
    eventTopic0("AdminChanged(address,address)"),
  ],
  "Significant Holder Threshold Crossed": [eventTopic0("Transfer(address,address,uint256)")],
  "Smart Money / Whale Accumulation": [
    eventTopic0("Transfer(address,address,uint256)"),
    eventTopic0("Swap(address,uint256,uint256,uint256,uint256,address)"), // UniV2
    eventTopic0("Swap(address,address,int256,int256,uint160,uint128,int24)"), // UniV3
  ],
  "New Liquidity Pool Created": [
    eventTopic0("PairCreated(address,address,address,uint256)"), // UniV2 factory
    eventTopic0("PoolCreated(address,address,uint24,int24,address)"), // UniV3 factory
  ],
  "Ownership / Admin Change": [
    eventTopic0("OwnershipTransferred(address,address)"),
    eventTopic0("RoleGranted(bytes32,address,address)"),
    eventTopic0("AdminChanged(address,address)"),
  ],
  // "Tax or Blacklist Change": no standard event — left unverified (null), never blocks.
};

/** The expected topic0 set (lowercased) for an anomaly type, or null if it has no standard event. */
export function expectedTopicsFor(anomalyType?: string | null): Set<string> | null {
  if (!anomalyType) return null;
  const list = ANOMALY_EVENT_TOPICS[anomalyType];
  return list ? new Set(list.map((t) => t.toLowerCase())) : null;
}

const clients = new Map<string, PublicClient>();
function clientFor(chain: string, rpcs: Record<string, string>): PublicClient | null {
  const url = rpcs[chain];
  if (!url) return null;
  let c = clients.get(chain);
  if (!c) {
    c = createPublicClient({ transport: http(url, { timeout: 6000 }) });
    clients.set(chain, c);
  }
  return c;
}

export async function verifyEvidence(
  cfg: Config,
  ev: { chain: string; contractAddress: string; txHash?: string | null; walletAddress?: string | null; anomalyType?: string | null },
): Promise<EvidenceResult> {
  const client = clientFor(ev.chain, cfg.evidenceRpcs);
  if (!client) {
    return { ok: null, chain: ev.chain, checks: { txExists: null, contractHasCode: null, eventConsistent: null }, detail: `no RPC configured for ${ev.chain} — unverified` };
  }

  let txExists: boolean | null = null;
  let contractHasCode: boolean | null = null;
  let eventConsistent: boolean | null = null;
  const notes: string[] = [];

  if (ev.txHash) {
    try {
      const tx = await client.getTransaction({ hash: ev.txHash as `0x${string}` });
      txExists = Boolean(tx);
      if (!txExists) notes.push("cited txHash not found on-chain");
    } catch (e) {
      if (e instanceof TransactionNotFoundError) {
        txExists = false; // genuinely absent on-chain — a real evidence failure
        notes.push("cited txHash not found on-chain");
      } else {
        // RPC/network error — do NOT treat as a failed check, so a transient RPC issue never blocks a
        // legitimate mint. Leave it unverified (null); the gate only blocks on a definitive false.
        txExists = null;
        notes.push("tx lookup errored (treated as unverified): " + (e as Error).message);
      }
    }
  }

  try {
    const code = await client.getCode({ address: getAddress(ev.contractAddress) });
    contractHasCode = Boolean(code) && code !== "0x";
    if (!contractHasCode) notes.push("contractAddress has no code (EOA or nonexistent)");
  } catch (e) {
    contractHasCode = null;
    notes.push("could not read contract code: " + (e as Error).message);
  }

  // Anomaly-type ↔ event-log consistency: the cited tx must carry at least one log matching the
  // CLAIMED anomaly. Only checked when the tx plausibly exists AND the type has a standard event;
  // state-based types (no standard event) and any RPC/pending error stay `null` (never block).
  const expected = expectedTopicsFor(ev.anomalyType);
  if (expected && ev.txHash && txExists !== false) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: ev.txHash as `0x${string}` });
      // The matching event must be BOUND to the cited subject — either emitted BY the cited
      // contract/wallet, OR carrying it as an indexed/data arg — so a discovery can't satisfy the
      // gate by citing an unrelated high-traffic tx whose stray Transfer/Swap/Sync log happens to
      // match the topic. (Factory/pair events like PairCreated emit from the factory but carry the
      // subject token as an arg, so the "appears as an arg" branch covers them.)
      const subjects = new Set<string>();
      const subjectHexes: string[] = [];
      for (const a of [ev.contractAddress, ev.walletAddress]) {
        if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) {
          subjects.add(a.toLowerCase());
          subjectHexes.push(a.slice(2).toLowerCase());
        }
      }
      eventConsistent = receipt.logs.some((l) => {
        const t0 = l.topics[0];
        if (!t0 || !expected.has(t0.toLowerCase())) return false;
        if (subjects.has(l.address.toLowerCase())) return true; // emitted by the cited subject
        const hay = (l.topics.join("") + (l.data ?? "")).toLowerCase();
        return subjectHexes.some((h) => hay.includes(h)); // subject appears as an indexed/data arg
      });
      if (!eventConsistent) {
        notes.push(`cited tx has no log matching the claimed anomaly "${ev.anomalyType}" that involves the cited address`);
      }
    } catch (e) {
      eventConsistent = null; // receipt not found (pending) or RPC error → unverified, never block
      notes.push("event-log check unverified: " + (e as Error).message);
    }
  }

  const ok = txExists !== false && contractHasCode !== false && eventConsistent !== false;
  return {
    ok,
    chain: ev.chain,
    checks: { txExists, contractHasCode, eventConsistent },
    detail: notes.length ? notes.join("; ") : "evidence checks passed",
  };
}
