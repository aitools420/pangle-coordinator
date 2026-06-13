/**
 * Scoring tests: reward minting (first-unique-only — repeats earn 0) + reputation (= cumulative
 * $PANG earned) against a real Db (temp file) and MockChain. Deterministic — no timers/network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { Db } from "../src/db.js";
import { MockChain } from "../src/chain.js";
import { Intelligence } from "../src/intelligence.js";
import { Scoring } from "../src/scoring.js";
import { config, type Config } from "../src/config.js";
import type { Message } from "../src/schema.js";

const A_ID = "1";
const A_WALLET = getAddress("0x1111111111111111111111111111111111111111") as Address;
const A_OWNER = getAddress("0x1111111111111111111111111111111111111111") as Address;
const B_ID = "2";
const B_WALLET = getAddress("0x2222222222222222222222222222222222222222") as Address;
const CONTRACT = "0x4444444444444444444444444444444444444444";
const TX = "0x" + "ef".repeat(32);
const PANG = 10n ** 18n; // one whole $PANG in base units

function tmpDbPath(): string {
  return join(tmpdir(), `pangle-scoring-${randomBytes(8).toString("hex")}.db`);
}
function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

test("first-unique useful submissions mint 10/5/20; reputation = cumulative $PANG earned", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const cfg: Config = { ...config, evidenceRpcs: {} }; // unit-isolate from live RPCs (reward logic, not the evidence gate)
  const intel = new Intelligence(db, cfg);
  const scoring = new Scoring(db, mock, cfg);

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET });
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET });
  mock.registerMock(A_ID, A_OWNER, A_WALLET);
  mock.registerMock(B_ID, B_WALLET, B_WALLET);

  try {
    // Build a thread: discovery (A) → investigation (B) → synthesis (A).
    const d = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const threadId = d.threadId;

    const inv = intel.submit(B_ID, B_WALLET, {
      v: "0", nonce: randomUUID(), from: B_WALLET, type: "investigation", task: threadId,
      body: { investigationType: "Liquidity Impact Analysis", evidence: "LP pulled, no relock." },
    } as Message);
    assert.equal(inv.ok, true);
    if (!inv.ok) return;

    const syn = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "synthesis", task: threadId,
      body: { conclusion: "High Risk", rationale: "rug" },
    } as Message);
    assert.equal(syn.ok, true);

    assert.equal(await mock.tokenBalanceOf(A_WALLET), 0n);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 0n);

    // Score discovery (A) + investigation (B) useful → first-unique mints 10 / 5.
    assert.equal((await scoring.scoreMessage(d.messageId, true)).ok, true);
    assert.equal((await scoring.scoreMessage(inv.messageId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 10n * PANG, "discovery reward = 10 PANG");
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 5n * PANG, "investigation reward = 5 PANG");

    // Resolve synthesis correct → synthesizer (A) earns 20 (NO first-reporter bonus).
    assert.equal((await scoring.resolveSynthesis(threadId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 30n * PANG, "A = discovery 10 + synthesis 20 (no bonus)");

    // Reputation = cumulative $PANG earned (whole tokens): A = 30, B = 5.
    assert.equal(db.getAgent(A_ID)!.reputation, 30, "A reputation = 30 PANG earned");
    assert.equal(db.getAgent(B_ID)!.reputation, 5, "B reputation = 5 PANG earned");

    // Idempotent resolution: a second resolve does not mint again.
    const before = await mock.tokenBalanceOf(A_WALLET);
    await scoring.resolveSynthesis(threadId, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), before, "second resolve does not re-mint");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("repeats earn 0: a same-type investigation pays only once; a new type pays again", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const intel = new Intelligence(db, config);
  const scoring = new Scoring(db, mock, { ...config, evidenceRpcs: {} });

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET });
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET });

  try {
    const d = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const threadId = d.threadId;

    // Two investigations of the SAME type, then one of a DIFFERENT type — all by B.
    function inv(investigationType: string, evidence: string): string {
      const r = intel.submit(B_ID, B_WALLET, {
        v: "0", nonce: randomUUID(), from: B_WALLET, type: "investigation", task: threadId,
        body: { investigationType, evidence },
      } as Message);
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("investigation submit failed");
      return r.messageId;
    }
    const i1 = inv("Liquidity Impact Analysis", "first of its type — substantial evidence here");
    const i2 = inv("Liquidity Impact Analysis", "a repeat of the same investigation type");
    const i3 = inv("Wallet Behavior Analysis", "a new, unique investigation angle entirely");

    // First useful of a type → 5; same-type repeat → 0; a new unique type → 5. Total B = 10.
    assert.equal((await scoring.scoreMessage(i1, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 5n * PANG, "first of a type earns 5");
    assert.equal((await scoring.scoreMessage(i2, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 5n * PANG, "same-type repeat earns 0");
    assert.equal((await scoring.scoreMessage(i3, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 10n * PANG, "a new unique type earns 5");

    assert.equal(db.getAgent(B_ID)!.reputation, 10, "B reputation = 10 PANG earned");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("synthesis reward goes to the FIRST synthesizer; a late copycat cannot steal it", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const intel = new Intelligence(db, config);
  const scoring = new Scoring(db, mock, { ...config, evidenceRpcs: {} });

  db.upsertAgent({ agentId: A_ID, owner: A_WALLET, agentWallet: A_WALLET }); // first/honest synthesizer
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET }); // late copycat

  try {
    const d = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const threadId = d.threadId;

    // A posts the real synthesis FIRST → claims the conclusion slot.
    assert.equal(intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "synthesis", task: threadId,
      body: { conclusion: "High Risk", rationale: "the genuine analysis" },
    } as Message).ok, true);

    // B posts a copycat synthesis LAST with a different rationale (defeats the body-fingerprint dedup).
    assert.equal(intel.submit(B_ID, B_WALLET, {
      v: "0", nonce: randomUUID(), from: B_WALLET, type: "synthesis", task: threadId,
      body: { conclusion: "High Risk", rationale: "thief changed this text to dodge the dup check" },
    } as Message).ok, true);

    // Resolve correct → the 20 PANG must go to the FIRST synthesizer (A), never the late copycat (B).
    assert.equal((await scoring.resolveSynthesis(threadId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 20n * PANG, "first synthesizer earns the 20 PANG");
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 0n, "late copycat earns 0 — cannot steal the conclusion slot");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("auto-resolver: complete-verified-work resolves correct (mints synthesis); no credited investigation resolves incorrect", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const cfg: Config = { ...config, evidenceRpcs: {}, resolverBatch: 10 };
  const intel = new Intelligence(db, cfg);
  const scoring = new Scoring(db, mock, cfg);

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET });
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET });
  mock.registerMock(A_ID, A_OWNER, A_WALLET);
  mock.registerMock(B_ID, B_WALLET, B_WALLET);

  // Force a thread's resolution window to have elapsed (createdAt+window is otherwise ~48h out).
  const forceDue = (threadId: string) => db.raw.prepare("UPDATE threads SET targetResolveAt = 0 WHERE id = ?").run(threadId);

  try {
    // Thread 1 — complete: discovery(A) + a REWARDED investigation(B) + synthesis(A).
    const d1 = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message);
    assert.equal(d1.ok, true); if (!d1.ok) return;
    const inv1 = intel.submit(B_ID, B_WALLET, {
      v: "0", nonce: randomUUID(), from: B_WALLET, type: "investigation", task: d1.threadId,
      body: { investigationType: "Liquidity Impact Analysis", evidence: "LP pulled, no relock — substantial evidence." },
    } as Message);
    assert.equal(inv1.ok, true); if (!inv1.ok) return;
    assert.equal((await scoring.scoreMessage(inv1.messageId, true)).ok, true); // credit the investigation
    assert.equal(intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "synthesis", task: d1.threadId,
      body: { conclusion: "High Risk", rationale: "rug" },
    } as Message).ok, true);
    forceDue(d1.threadId);

    // Thread 2 — no credited investigation: discovery(A) + synthesis(A) only.
    const d2 = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: "0x" + "cd".repeat(32), timestamp: 1_700_000_500 },
    } as Message);
    assert.equal(d2.ok, true); if (!d2.ok) return;
    assert.equal(intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "synthesis", task: d2.threadId,
      body: { conclusion: "Benign Activity" },
    } as Message).ok, true);
    forceDue(d2.threadId);

    const balBefore = await mock.tokenBalanceOf(A_WALLET); // 0 — nothing minted to A yet
    const res = await scoring.autoResolveDue();
    assert.equal(res.resolved, 2, "both due threads resolved");

    // Thread 1 → correct: synthesizer A earns +20; thread marked resolved/correct.
    assert.equal(await mock.tokenBalanceOf(A_WALLET), balBefore + 20n * PANG, "complete thread pays the 20 synthesis");
    assert.equal(db.getThread(d1.threadId)!.status, "resolved");
    assert.equal(db.getThread(d1.threadId)!.resolvedCorrect, 1);
    // Thread 2 → incorrect: no synthesis mint; thread marked unresolved.
    assert.equal(db.getThread(d2.threadId)!.status, "unresolved");
    assert.equal(db.getThread(d2.threadId)!.resolvedCorrect, 0);

    // Idempotent: nothing left due, no double-mint on a re-run.
    const res2 = await scoring.autoResolveDue();
    assert.equal(res2.considered, 0, "no threads left due after resolution");
    assert.equal(await mock.tokenBalanceOf(A_WALLET), balBefore + 20n * PANG, "no re-mint on re-run");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("directed delegation: a fulfilling investigation earns the normal reward + the request bounty", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const cfg: Config = { ...config, evidenceRpcs: {} };
  const intel = new Intelligence(db, cfg);
  const scoring = new Scoring(db, mock, cfg);

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET }); // requester
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET }); // fulfiller

  try {
    // A posts a directed REQUEST with a 5 $PANG bounty.
    const req = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "request",
      body: { requestType: "Contract Risk Assessment", chain: "PulseChain", contractAddress: CONTRACT, txHash: TX, bounty: 5 },
    } as Message);
    assert.equal(req.ok, true); if (!req.ok) return;
    assert.equal(db.getThread(req.threadId)!.kind, "request");
    assert.equal(db.getThread(req.threadId)!.bounty, 5);
    assert.equal(db.getThread(req.threadId)!.status, "open");

    // B fulfils it with an investigation on the request thread.
    const inv = intel.submit(B_ID, B_WALLET, {
      v: "0", nonce: randomUUID(), from: B_WALLET, type: "investigation", task: req.threadId,
      body: { investigationType: "Contract Risk Assessment", evidence: "owner can mint and tax is togglable — high risk." },
    } as Message);
    assert.equal(inv.ok, true); if (!inv.ok) return;

    assert.equal(await mock.tokenBalanceOf(B_WALLET), 0n);
    // Score it useful → B earns investigation 5 + bounty 5 = 10; the request is marked fulfilled.
    assert.equal((await scoring.scoreMessage(inv.messageId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 10n * PANG, "fulfiller earns investigation (5) + bounty (5)");
    assert.equal(db.getThread(req.threadId)!.status, "resolved", "request marked fulfilled");
    assert.equal(db.getAgent(B_ID)!.reputation, 10, "B reputation = 10 PANG earned (5 + 5 bounty)");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("agent suggestions: an accepted improvement proposal mints the 100 $PANG acceptance reward", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const cfg: Config = { ...config, evidenceRpcs: {} };
  const intel = new Intelligence(db, cfg);
  const scoring = new Scoring(db, mock, cfg);

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET });

  try {
    const s = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "suggestion",
      body: { area: "scoring", proposal: "Weight the synthesis reward by the agent's verified track record." },
    } as Message);
    assert.equal(s.ok, true); if (!s.ok) return;
    const sId = s.messageId;
    assert.equal(db.getSuggestion(sId)!.status, "pending");
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 0n);

    // Operator accepts → 100 $PANG minted via the same reward mechanism; status -> accepted.
    assert.equal((await scoring.awardSuggestion(sId)).ok, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 100n * PANG, "accepted suggestion mints 100 $PANG");
    assert.equal(db.getSuggestion(sId)!.status, "accepted");
    assert.equal(db.getAgent(A_ID)!.reputation, 100);

    // Idempotent: a second accept does not re-mint.
    assert.equal((await scoring.awardSuggestion(sId)).ok, false);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 100n * PANG, "no double-mint on re-accept");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("per-agent mint cap: one agent's daily issuance is capped; a different agent under cap still mints", async () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const mock = new MockChain();
  const cfg: Config = { ...config, evidenceRpcs: {}, mintCapPerAgentPerDay: 10 }; // 10 whole $PANG / agent / day
  const intel = new Intelligence(db, cfg);
  const scoring = new Scoring(db, mock, cfg);

  db.upsertAgent({ agentId: A_ID, owner: A_OWNER, agentWallet: A_WALLET });
  db.upsertAgent({ agentId: B_ID, owner: B_WALLET, agentWallet: B_WALLET });
  mock.registerMock(A_ID, A_OWNER, A_WALLET);
  mock.registerMock(B_ID, B_WALLET, B_WALLET);

  try {
    // A's first discovery (distinct event) → mints 10 (== per-agent cap, allowed).
    const d1 = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: "0x" + "a1".repeat(32), timestamp: 1_700_000_000 },
    } as Message);
    assert.equal(d1.ok, true); if (!d1.ok) return;
    assert.equal((await scoring.scoreMessage(d1.messageId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 10n * PANG, "A first discovery mints 10 (at cap)");

    // A's second discovery (distinct event) → would push A to 20 > 10/day → REFUSED; balance unchanged.
    const d2 = intel.submit(A_ID, A_WALLET, {
      v: "0", nonce: randomUUID(), from: A_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: "0x" + "a2".repeat(32), timestamp: 1_700_000_100 },
    } as Message);
    assert.equal(d2.ok, true); if (!d2.ok) return;
    const r = await scoring.scoreMessage(d2.messageId, true);
    assert.equal(r.ok, false, "A second mint exceeds per-agent cap → refused");
    if (!r.ok) assert.match(r.error, /cap/i);
    assert.equal(await mock.tokenBalanceOf(A_WALLET), 10n * PANG, "A balance unchanged after cap trip");

    // A DIFFERENT agent (B), under its own cap, still mints — proves the cap is per-identity, not global-only.
    const dB = intel.submit(B_ID, B_WALLET, {
      v: "0", nonce: randomUUID(), from: B_WALLET, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: "0x" + "b1".repeat(32), timestamp: 1_700_000_200 },
    } as Message);
    assert.equal(dB.ok, true); if (!dB.ok) return;
    assert.equal((await scoring.scoreMessage(dB.messageId, true)).ok, true);
    assert.equal(await mock.tokenBalanceOf(B_WALLET), 10n * PANG, "B mints 10 — per-agent cap is per-identity");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});
