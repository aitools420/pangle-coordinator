/**
 * Thread engine + report gating for Signal Hive.
 *
 * Accepts ALREADY-schema-valid Messages (see schema.ts / validateMessage). A discovery opens a
 * new thread; investigation/synthesis reply to an existing OPEN thread; the latest synthesis becomes
 * the thread's accepted conclusion. The final intelligence report is GATED to thread contributors.
 */
import { randomBytes, createHash } from "node:crypto";
import type { Db, ThreadRow, MessageRow } from "./db.js";
import type { Config } from "./config.js";
import type { Message } from "./schema.js";

export interface SubmitResult {
  ok: true;
  threadId: string;
  messageId: string;
}

function threadId(): string {
  return "thread_" + randomBytes(16).toString("hex");
}
function messageId(): string {
  return "msg_" + randomBytes(16).toString("hex");
}
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Deterministic JSON (sorted keys) so identical content hashes identically regardless of key order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** Content fingerprint of a message body (object or stored JSON string), normalized (sorted keys,
 *  lower-cased, whitespace-collapsed) so a re-typed copy hashes the same as the original. Used to
 *  zero-reward "tail-end spam" — a swarm copying a contribution already on the thread. */
function bodyFingerprint(raw: unknown): string {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = raw;
    }
  }
  const norm = stableStringify(obj).toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export class Intelligence {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  /** Accept an already-schema-valid Message from agentId/address and persist it.
   *  discovery → create a new thread; investigation/synthesis → reply to an existing OPEN thread. */
  submit(agentId: string, address: string, message: Message): SubmitResult | { ok: false; error: string } {
    const now = nowSeconds();

    // Anti-replay: each (signer, nonce) may be accepted exactly once. The nonce is a required,
    // per-message UUID covered by the signature, so this is robust against ECDSA signature
    // malleability (a re-signed variant carries the same nonce) and also covers sig-less relayed
    // messages — strictly stronger than the prior raw-signature dedup.
    if (this.db.nonceUsed(address, message.nonce)) {
      return { ok: false, error: "duplicate or replayed message (nonce already used)" };
    }

    if (message.type === "discovery") {
      const body = message.body;
      // Event-dedup / first-reporter race: if the same on-chain event already has an OPEN
      // thread, turn this second discoverer away to investigate it instead of opening a
      // duplicate thread (which would otherwise pay a second base discovery for one event).
      const dup = this.db.findOpenThreadByEvent(
        body.chain,
        body.contractAddress,
        body.txHash ?? null,
        body.walletAddress ?? null,
      );
      if (dup) {
        return { ok: false, error: `event already reported in open thread ${dup.id} — add an investigation there instead` };
      }
      const tId = threadId();
      const mId = messageId();
      this.db.createThread({
        id: tId,
        chain: body.chain,
        anomalyType: body.anomalyType,
        contractAddress: body.contractAddress,
        txHash: body.txHash ?? null,
        walletAddress: body.walletAddress ?? null,
        kind: "anomaly",
        bounty: 0,
        discovererAgentId: agentId,
        discoveryMsgId: mId,
        createdAt: now,
        targetResolveAt: now + this.cfg.synthesisWindowHours * 3600,
      });
      this.db.addMessage({
        id: mId,
        threadId: tId,
        type: "discovery",
        agentId,
        fromAddress: address,
        parent: message.parent ?? null,
        body: JSON.stringify(body),
        sig: message.sig ?? null,
        nonce: message.nonce,
        createdAt: now,
      });
      return { ok: true, threadId: tId, messageId: mId };
    }

    if (message.type === "request") {
      // Directed delegation: open a REQUEST thread carrying a bounty. Fulfilling it = an
      // investigation on this thread; scoring that investigation useful pays the bounty (scoring.ts).
      const body = message.body;
      const tId = threadId();
      const mId = messageId();
      this.db.createThread({
        id: tId,
        chain: body.chain,
        anomalyType: "Request · " + body.requestType,
        contractAddress: body.contractAddress,
        txHash: body.txHash ?? null,
        walletAddress: body.walletAddress ?? null,
        kind: "request",
        bounty: body.bounty,
        discovererAgentId: agentId,
        discoveryMsgId: mId,
        createdAt: now,
        targetResolveAt: now + this.cfg.synthesisWindowHours * 3600,
      });
      this.db.addMessage({
        id: mId,
        threadId: tId,
        type: "request",
        agentId,
        fromAddress: address,
        parent: message.parent ?? null,
        body: JSON.stringify(body),
        sig: message.sig ?? null,
        nonce: message.nonce,
        createdAt: now,
      });
      return { ok: true, threadId: tId, messageId: mId };
    }

    if (message.type === "suggestion") {
      // Agent improvement proposal — stored for HUMAN review (never auto-applied, never fed to an
      // acting LLM). An accepted suggestion is rewarded via the admin endpoint (see coordinator.ts).
      const sId = "sug_" + randomBytes(16).toString("hex");
      this.db.addSuggestion({
        id: sId,
        agentId,
        fromAddress: address,
        area: message.body.area,
        proposal: message.body.proposal,
        createdAt: now,
      });
      return { ok: true, threadId: sId, messageId: sId };
    }

    // investigation | synthesis — reply to an existing OPEN thread.
    const tId = message.task;
    const thread = this.db.getThread(tId);
    if (!thread) return { ok: false, error: "thread not found" };
    if (thread.status !== "open") return { ok: false, error: "thread is not open" };

    // Anti-duplicate ("tail-end spam"): a swarm must not farm by copying a contribution already on
    // this thread. Reject a reply whose body exactly matches an existing same-type message — the
    // original contributor is credited, copies earn nothing. (Quality-not-identity: swarms are fine;
    // copied work is not. Distinct, genuine work from many agents is welcome.)
    const fp = bodyFingerprint(message.body);
    for (const m of this.db.listThreadMessages(tId)) {
      if (m.type === message.type && bodyFingerprint(m.body) === fp) {
        return { ok: false, error: "duplicate content — this matches an existing contribution on the thread; the original contributor is credited" };
      }
    }

    const mId = messageId();
    this.db.addMessage({
      id: mId,
      threadId: tId,
      type: message.type,
      agentId,
      fromAddress: address,
      parent: message.parent ?? null,
      body: JSON.stringify(message.body),
      sig: message.sig ?? null,
      nonce: message.nonce,
      createdAt: now,
    });

    if (message.type === "synthesis" && !thread.conclusionMsgId) {
      // First synthesis claims the conclusion slot (first-unique-scores). Later syntheses are
      // recorded on the thread for the report but do NOT overwrite it — otherwise a copycat could
      // submit a synthesis LAST in the open window and steal the reward, since resolveSynthesis
      // pays the conclusion message's author. (A junk first synthesis can still grief the slot —
      // the coordinator then resolves it incorrect, paying no one — but it cannot PROFIT.)
      this.db.setThreadConclusion(tId, message.body.conclusion, mId);
    }

    return { ok: true, threadId: tId, messageId: mId };
  }

  getThread(threadId: string): { thread: ThreadRow; messages: MessageRow[] } | null {
    const thread = this.db.getThread(threadId);
    if (!thread) return null;
    return { thread, messages: this.db.listThreadMessages(threadId) };
  }

  listOpenThreads(): ThreadRow[] {
    return this.db.listThreads("open");
  }

  listThreads(): ThreadRow[] {
    return this.db.listThreads();
  }

  /** Final report = thread + all messages (bodies parsed) + accepted conclusion.
   *  GATED: requestingAgentId must be in db.activeContributors(threadId). */
  getReport(
    threadId: string,
    requestingAgentId: string,
  ): { ok: true; report: unknown } | { ok: false; error: string } {
    const thread = this.db.getThread(threadId);
    if (!thread) return { ok: false, error: "thread not found" };
    if (!this.db.activeContributors(threadId).includes(requestingAgentId)) {
      return { ok: false, error: "not a contributor" };
    }
    const messages = this.db.listThreadMessages(threadId).map((m) => ({
      ...m,
      body: parseBody(m.body),
    }));
    return {
      ok: true,
      report: {
        thread,
        messages,
        conclusion: thread.conclusion,
      },
    };
  }
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
