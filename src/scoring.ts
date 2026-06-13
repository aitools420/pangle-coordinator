/**
 * Coordinator-only scoring, 48h synthesis resolution, and reward/reputation writes.
 *
 * The coordinator is the SOLE scorer in the MVP (SPEC §Scoring). A message is marked
 * useful/not; on the FIRST "useful" mark a discovery/investigation mints its per-type
 * reward — but ONLY for the first UNIQUE submission of its slot. A repeat of an
 * already-rewarded slot is still marked useful (recorded) but earns 0:
 *  - discovery   — unique per on-chain event (submit-time dedup opens one thread per event)
 *  - investigation — unique per (thread, investigationType)
 *  - synthesis   — the accepted conclusion is the one unique synthesis per thread
 * Synthesis is rewarded only when the thread is manually resolved CORRECT within the window.
 *
 * Reputation = cumulative $PANG earned (lifetime). It is an earnings record summed from the
 * agent's reward rows, so it is unaffected by token transfers (effectively soulbound even
 * though $PANG is a transferable ERC-20). There is no separate on-chain reputation contract.
 */
import { getAddress } from "viem";
import type { Db, MessageRow } from "./db.js";
import type { ChainAdapter } from "./chain.js";
import type { Config } from "./config.js";
import { verifyEvidence } from "./evidence.js";

/** Per-type reward amounts in token base units (18 decimals). Only the FIRST unique useful
 *  submission per slot is paid; repeats earn 0. */
export const REWARDS = {
  discovery: 10n * 10n ** 18n,
  investigation: 5n * 10n ** 18n,
  synthesis: 20n * 10n ** 18n,
} as const;

type ScoringResult = { ok: true } | { ok: false; error: string };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class Scoring {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainAdapter,
    private readonly cfg: Config,
  ) {}

  /**
   * Coordinator marks a message useful/not, with an optional explicit numeric score. On the first
   * "useful" mark for a discovery/investigation, mints the per-type reward to the agent wallet —
   * but ONLY if this is the first UNIQUE submission for its slot (repeats are recorded useful but
   * earn 0). Synthesis is never rewarded here — only via resolveSynthesis on a correct resolution.
   */
  async scoreMessage(messageId: string, useful: boolean, score?: number): Promise<ScoringResult> {
    const msg = this.db.getMessage(messageId);
    if (!msg) return { ok: false, error: "message not found" };
    const agent = this.db.getAgent(msg.agentId);
    if (!agent) return { ok: false, error: "agent not found" };

    const wasUseful = msg.useful === 1;

    // Would this scoring action mint? (first transition to useful, discovery/investigation, first
    // UNIQUE submission of its slot — discovery is unique per on-chain event via submit-time dedup;
    // investigation is unique per (thread, investigationType); a repeat earns 0.)
    const isRewardableType = msg.type === "discovery" || msg.type === "investigation";
    const isFirstUnique = msg.type === "discovery" || this.isFirstRewardedInvestigationType(msg);
    const wouldMint = useful && !wasUseful && !this.db.hasRewardForMessage(messageId) && isRewardableType && isFirstUnique;

    // Mint-rate circuit breaker: if a mint would push past the rolling-24h cap, refuse BEFORE marking
    // useful so the contribution stays re-scorable after the window (don't silently lose legit work).
    if (wouldMint && !this.mintAllowed(REWARDS[msg.type as "discovery" | "investigation"], msg.agentId)) {
      this.db.audit("coordinator", "mint-cap-tripped", { messageId, type: msg.type });
      return { ok: false, error: "daily mint-rate cap reached — mints paused; re-score after the 24h window resets" };
    }

    const finalScore = score ?? (useful ? 1 : 0);

    if (wouldMint) {
      const amount = REWARDS[msg.type as "discovery" | "investigation"];
      let to;
      try {
        to = getAddress(agent.agentWallet);
      } catch {
        return { ok: false, error: "invalid agent wallet address" };
      }

      // Evidence gate: for a discovery, refuse the mint if the thread's cited on-chain evidence
      // VERIFIABLY fails (tx missing / contract is an EOA / the cited tx carries no log matching the
      // claimed anomaly type). Unverifiable chains (no RPC) and state-based anomalies return ok:null
      // and are NOT blocked.
      if (msg.type === "discovery") {
        const t = this.db.getThread(msg.threadId);
        if (t) {
          const ev = await verifyEvidence(this.cfg, { chain: t.chain, anomalyType: t.anomalyType, contractAddress: t.contractAddress, txHash: t.txHash, walletAddress: t.walletAddress });
          if (ev.ok === false) {
            this.db.audit("coordinator", "evidence-gate-blocked", { messageId, threadId: msg.threadId, detail: ev.detail });
            return { ok: false, error: `evidence verification failed: ${ev.detail} — mint blocked, message not scored useful` };
          }
        }
      }

      // Mint FIRST; record the reward and mark useful only AFTER the mint confirms, so a failed/
      // timed-out mint leaves NO "useful" flag (the contribution stays cleanly re-scorable instead of
      // stranded done-but-unpaid — the receipt-timeout bug). The !hasRewardForMessage guard in
      // wouldMint keeps a retry idempotent.
      const txHash = await this.chain.mintReward(to, amount);
      this.db.addReward({
        agentId: msg.agentId,
        threadId: msg.threadId,
        messageId,
        amount: amount.toString(),
        reason: `${msg.type} useful`,
        txHash,
      });
      this.db.scoreMessage(messageId, finalScore, useful, nowSeconds());

      // Directed delegation: a first-unique useful investigation that fulfils an open REQUEST thread
      // also pays its bounty (same mint mechanism), then marks the request fulfilled. The bounty mint
      // is cap-checked separately; if it trips the cap the request stays open + the normal reward stands.
      if (msg.type === "investigation") {
        const reqThread = this.db.getThread(msg.threadId);
        if (reqThread && reqThread.kind === "request" && reqThread.bounty > 0 && reqThread.status === "open") {
          const bountyAmt = BigInt(reqThread.bounty) * 10n ** 18n;
          if (this.mintAllowed(bountyAmt, msg.agentId)) {
            const btx = await this.chain.mintReward(to, bountyAmt);
            this.db.addReward({ agentId: msg.agentId, threadId: reqThread.id, messageId, amount: bountyAmt.toString(), reason: "request bounty", txHash: btx });
            this.db.resolveThread(reqThread.id, true, nowSeconds());
            this.db.audit("coordinator", "request-fulfilled", { threadId: reqThread.id, fulfiller: msg.agentId, bounty: reqThread.bounty });
          }
        }
      }
    } else {
      this.db.scoreMessage(messageId, finalScore, useful, nowSeconds());
    }

    await this.recomputeReputation(msg.agentId);
    return { ok: true };
  }

  /** True if no other investigation of the SAME investigationType on this thread has already been
   *  rewarded — i.e. this is the first unique investigation of its kind. Repeats earn 0. */
  private isFirstRewardedInvestigationType(msg: Pick<MessageRow, "id" | "threadId" | "body">): boolean {
    let myType: unknown;
    try {
      myType = (JSON.parse(msg.body) as { investigationType?: unknown }).investigationType;
    } catch {
      return false; // unparseable body (shouldn't happen — schema-validated): fail CLOSED, earn 0
    }
    for (const m of this.db.listThreadMessages(msg.threadId)) {
      if (m.id === msg.id || m.type !== "investigation") continue;
      if (!this.db.hasRewardForMessage(m.id)) continue;
      let t: unknown;
      try {
        t = (JSON.parse(m.body) as { investigationType?: unknown }).investigationType;
      } catch {
        continue;
      }
      if (t === myType) return false; // a same-type investigation already earned on this thread
    }
    return true;
  }

  /**
   * Manual 48h synthesis correctness check. Resolves the thread; if correct, mints the synthesis
   * reward to the synthesizer (the agent of the accepted conclusion — the one unique synthesis per
   * thread) and recomputes reputation. Idempotent: an already-resolved thread is left untouched.
   */
  async resolveSynthesis(threadId: string, correct: boolean): Promise<ScoringResult> {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "thread not found" };
    if (!thread.conclusionMsgId) return { ok: false, error: "thread has no synthesis to resolve" };
    if (thread.status !== "open") return { ok: false, error: "thread already resolved" };

    // Mint-rate circuit breaker: if a correct resolution would mint past the global OR the
    // synthesizer's per-agent daily cap, refuse before resolving so the thread stays open +
    // re-resolvable after the window resets.
    if (correct && thread.conclusionMsgId && !this.db.hasRewardForMessage(thread.conclusionMsgId)) {
      const author = this.db.getMessage(thread.conclusionMsgId);
      if (author && !this.mintAllowed(REWARDS.synthesis, author.agentId)) {
        this.db.audit("coordinator", "mint-cap-tripped", { threadId, type: "synthesis" });
        return { ok: false, error: "daily mint-rate cap reached — mints paused; re-resolve after the 24h window resets" };
      }
    }

    if (!correct) {
      this.db.resolveThread(threadId, false, nowSeconds());
      return { ok: true };
    }

    const conclusionMsg = this.db.getMessage(thread.conclusionMsgId);
    if (!conclusionMsg) return { ok: false, error: "synthesis message not found" };
    const synth = this.db.getAgent(conclusionMsg.agentId);
    if (!synth) return { ok: false, error: "synthesizer agent not found" };

    let to;
    try {
      to = getAddress(synth.agentWallet);
    } catch {
      return { ok: false, error: "invalid synthesizer wallet address" };
    }

    // Idempotent recovery: if a prior attempt already minted+recorded the reward but failed to mark
    // the thread resolved (e.g. a crash between the two writes), just resolve it now — never re-mint.
    if (this.db.hasRewardForMessage(thread.conclusionMsgId)) {
      this.db.resolveThread(threadId, true, nowSeconds());
      await this.recomputeReputation(conclusionMsg.agentId);
      return { ok: true };
    }

    // Evidence gate: don't pay a "correct" synthesis whose thread evidence VERIFIABLY fails (cited tx
    // missing / contract is an EOA). Unverifiable chains (no RPC) return ok:null and are NOT blocked.
    const ev = await verifyEvidence(this.cfg, { chain: thread.chain, anomalyType: thread.anomalyType, contractAddress: thread.contractAddress, txHash: thread.txHash, walletAddress: thread.walletAddress });
    if (ev.ok === false) {
      this.db.audit("coordinator", "evidence-gate-blocked", { threadId, type: "synthesis", detail: ev.detail });
      return { ok: false, error: `evidence verification failed: ${ev.detail} — resolution blocked, thread left open` };
    }

    // Mint FIRST; record the reward and mark the thread resolved only AFTER the mint confirms. A
    // failed/timed-out mint therefore leaves the thread OPEN (re-resolvable), never stranded
    // resolved-but-unpaid (the receipt-timeout bug).
    const txHash = await this.chain.mintReward(to, REWARDS.synthesis);
    this.db.addReward({
      agentId: conclusionMsg.agentId,
      threadId,
      messageId: thread.conclusionMsgId,
      amount: REWARDS.synthesis.toString(),
      reason: "synthesis correct",
      txHash,
    });
    this.db.resolveThread(threadId, true, nowSeconds());
    await this.recomputeReputation(conclusionMsg.agentId);
    return { ok: true };
  }

  /**
   * Full-auto synthesis resolution. For each OPEN thread whose synthesis window has elapsed, decide
   * correctness automatically and resolve it — minting the synthesis reward when correct via
   * resolveSynthesis (which re-applies the evidence gate, mint caps, and idempotency).
   *
   * v1 correctness is "complete-verified-work" and is deliberately domain-agnostic (not rug- or
   * conclusion-specific): a synthesis is CORRECT when (a) the thread's cited evidence does not
   * VERIFIABLY fail, AND (b) the thread has >=1 rewarded (useful, first-unique) investigation — i.e.
   * the conclusion rests on real, credited work. A verifiably-false discovery, or a thread with no
   * credited investigation, resolves INCORRECT (no synthesis mint). This pays thoroughness of
   * verified work rather than proven prediction accuracy — acceptable while $PANG is valueless, and
   * a richer per-conclusion on-chain outcome oracle can layer on top later. A mint-cap trip leaves a
   * thread OPEN (resolveSynthesis returns !ok) so it is retried on a later tick.
   */
  async autoResolveDue(limit = this.cfg.resolverBatch): Promise<{ resolved: number; considered: number }> {
    const due = this.db.listResolvableThreads(nowSeconds()).slice(0, Math.max(1, limit));
    let resolved = 0;
    for (const thread of due) {
      let evOk: boolean | null = null;
      try {
        const ev = await verifyEvidence(this.cfg, { chain: thread.chain, anomalyType: thread.anomalyType, contractAddress: thread.contractAddress, txHash: thread.txHash, walletAddress: thread.walletAddress });
        evOk = ev.ok;
      } catch {
        evOk = null; // unverifiable (RPC error) — do not block; fall through to the work check
      }
      let correct: boolean;
      let source: string;
      if (evOk === false) {
        correct = false;
        source = "evidence-false";
      } else {
        const hasCreditedInvestigation = this.db
          .listThreadMessages(thread.id)
          .some((m) => m.type === "investigation" && this.db.hasRewardForMessage(m.id));
        correct = hasCreditedInvestigation;
        source = hasCreditedInvestigation ? "complete-verified-work" : "no-credited-investigation";
      }
      const r = await this.resolveSynthesis(thread.id, correct);
      this.db.audit("coordinator", "synthesis-auto-resolve", { threadId: thread.id, correct, source, ok: r.ok, error: r.ok ? undefined : (r as { error: string }).error });
      if (r.ok) resolved++;
    }
    return { resolved, considered: due.length };
  }

  /**
   * Reputation = cumulative $PANG earned (whole tokens), summed from the agent's reward rows.
   * An earnings record — unaffected by token transfers. Written to the db mirror (read by the
   * /agent + coordinator_talk{standing} endpoints). No separate on-chain reputation contract.
   */
  async recomputeReputation(agentId: string): Promise<number> {
    let totalWei = 0n;
    for (const r of this.db.listRewards(agentId)) {
      try {
        totalWei += BigInt(r.amount);
      } catch {
        /* skip malformed */
      }
    }
    const rep = Number(totalWei / 10n ** 18n);
    this.db.setReputation(agentId, rep);
    return rep;
  }

  /** Mint-rate circuit breaker: true if minting `amount` keeps both the GLOBAL rolling-24h issuance
   *  (cfg.mintCapPerDay) AND this AGENT's rolling-24h issuance (cfg.mintCapPerAgentPerDay) within
   *  their caps (whole $PANG; 0 = that cap off). A trip pauses the mint, not scoring. */
  private mintAllowed(amount: bigint, agentId: string): boolean {
    const since = nowSeconds() - 86_400;
    const globalCap = this.cfg.mintCapPerDay;
    if (globalCap && globalCap > 0) {
      const cap = BigInt(Math.floor(globalCap)) * 10n ** 18n;
      if (this.db.mintedSince(since) + amount > cap) return false;
    }
    const agentCap = this.cfg.mintCapPerAgentPerDay;
    if (agentCap && agentCap > 0) {
      const cap = BigInt(Math.floor(agentCap)) * 10n ** 18n;
      if (this.db.mintedSinceByAgent(agentId, since) + amount > cap) return false;
    }
    return true;
  }

  /**
   * Heuristic suggestions (NOT auto-applied): provenance/sourcing hints per message in a
   * thread. Discovery with a txHash is likely useful; an investigation with substantial
   * evidence (>40 chars) is likely useful. Syntheses are left to manual judgement.
   */
  suggestScores(threadId: string): { messageId: string; suggestUseful: boolean; reason: string }[] {
    const out: { messageId: string; suggestUseful: boolean; reason: string }[] = [];
    for (const m of this.db.listThreadMessages(threadId)) {
      let body: unknown;
      try {
        body = JSON.parse(m.body);
      } catch {
        body = {};
      }
      if (m.type === "discovery") {
        const txHash = (body as { txHash?: unknown }).txHash;
        const hasTx = typeof txHash === "string" && txHash.length > 0;
        out.push({
          messageId: m.id,
          suggestUseful: hasTx,
          reason: hasTx ? "discovery cites a tx hash (verifiable provenance)" : "discovery lacks a tx hash",
        });
      } else if (m.type === "investigation") {
        const evidence = (body as { evidence?: unknown }).evidence;
        const len = typeof evidence === "string" ? evidence.length : 0;
        out.push({
          messageId: m.id,
          suggestUseful: len > 40,
          reason: len > 40 ? `investigation has substantial evidence (${len} chars)` : "investigation evidence is thin",
        });
      } else {
        out.push({
          messageId: m.id,
          suggestUseful: false,
          reason: "synthesis correctness requires manual judgement",
        });
      }
    }
    return out;
  }
}
