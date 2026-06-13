/**
 * Intelligence (thread engine + report gating) tests against a real Db on a temp file.
 * Deterministic: fixed addresses, unique temp db per run, cleaned up after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Db } from "../src/db.js";
import { Intelligence } from "../src/intelligence.js";
import { config, type Config } from "../src/config.js";
import type { Message } from "../src/schema.js";

const A_ID = "1";
const A_ADDR = "0x1111111111111111111111111111111111111111";
const B_ID = "2";
const B_ADDR = "0x2222222222222222222222222222222222222222";
const STRANGER_ID = "99";
const CONTRACT = "0x4444444444444444444444444444444444444444";
const TX = "0x" + "cd".repeat(32);

function tmpDbPath(): string {
  return join(tmpdir(), `pangle-intel-${randomBytes(8).toString("hex")}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
}

test("discovery → investigation → synthesis with report gating", () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const cfg: Config = config;
  const intel = new Intelligence(db, cfg);

  // Allow-list both contributing agents.
  db.upsertAgent({ agentId: A_ID, owner: A_ADDR, agentWallet: A_ADDR });
  db.upsertAgent({ agentId: B_ID, owner: B_ADDR, agentWallet: B_ADDR });

  try {
    // 1. Discovery opens a thread.
    const discovery: Message = {
      v: "0",
      nonce: randomUUID(),
      from: A_ADDR,
      type: "discovery",
      body: {
        chain: "PulseChain",
        anomalyType: "Liquidity Removal",
        contractAddress: CONTRACT,
        txHash: TX,
        timestamp: 1_700_000_000,
      },
    };
    const d = intel.submit(A_ID, A_ADDR, discovery);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const threadId = d.threadId;

    // Thread exists and recorded the discovery chain.
    const got = intel.getThread(threadId);
    assert.ok(got);
    assert.equal(got.thread.chain, "PulseChain");
    assert.equal(got.thread.status, "open");
    assert.equal(got.messages.length, 1);

    // Discovery appears as an open thread.
    assert.ok(intel.listOpenThreads().some((t) => t.id === threadId));

    // 2. Investigation reply from agent B.
    const investigation: Message = {
      v: "0",
      nonce: randomUUID(),
      from: B_ADDR,
      type: "investigation",
      task: threadId,
      body: {
        investigationType: "Liquidity Impact Analysis",
        evidence: "LP pulled in one tx, no relock.",
      },
    };
    const inv = intel.submit(B_ID, B_ADDR, investigation);
    assert.equal(inv.ok, true);

    // 3. Synthesis reply from agent A sets the accepted conclusion.
    const synthesis: Message = {
      v: "0",
      nonce: randomUUID(),
      from: A_ADDR,
      type: "synthesis",
      task: threadId,
      body: { conclusion: "High Risk", rationale: "classic rug" },
    };
    const syn = intel.submit(A_ID, A_ADDR, synthesis);
    assert.equal(syn.ok, true);

    const after = intel.getThread(threadId);
    assert.ok(after);
    assert.equal(after.messages.length, 3);
    assert.equal(after.thread.conclusion, "High Risk");

    // Reply to a nonexistent thread is rejected.
    const orphan: Message = {
      v: "0",
      nonce: randomUUID(),
      from: B_ADDR,
      type: "investigation",
      task: "thread_deadbeefdeadbeef",
      body: { investigationType: "Wallet Behavior Analysis", evidence: "x" },
    };
    const bad = intel.submit(B_ID, B_ADDR, orphan);
    assert.equal(bad.ok, false);

    // Gating: contributors (A and B) get the report; a stranger is denied.
    const reportA = intel.getReport(threadId, A_ID);
    assert.equal(reportA.ok, true);
    const reportB = intel.getReport(threadId, B_ID);
    assert.equal(reportB.ok, true);
    const reportStranger = intel.getReport(threadId, STRANGER_ID);
    assert.equal(reportStranger.ok, false);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("event-dedup: a duplicate discovery for the same event is rejected", () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const intel = new Intelligence(db, config);
  db.upsertAgent({ agentId: A_ID, owner: A_ADDR, agentWallet: A_ADDR });
  db.upsertAgent({ agentId: B_ID, owner: B_ADDR, agentWallet: B_ADDR });
  try {
    const disc = (from: string): Message => ({
      v: "0",
      nonce: randomUUID(),
      from,
      type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message);

    // First reporter wins the thread.
    const first = intel.submit(A_ID, A_ADDR, disc(A_ADDR));
    assert.equal(first.ok, true);
    // Same chain + contract + tx → a second discoverer is turned away to investigate instead.
    const dupe = intel.submit(B_ID, B_ADDR, disc(B_ADDR));
    assert.equal(dupe.ok, false);
    // A different event (different tx) still opens its own thread.
    const other: Message = {
      v: "0",
      nonce: randomUUID(),
      from: B_ADDR,
      type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: "0x" + "11".repeat(32), timestamp: 1_700_000_000 },
    } as Message;
    assert.equal(intel.submit(B_ID, B_ADDR, other).ok, true);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("anti-duplicate: a reply copying an existing contribution on the thread is rejected", () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const intel = new Intelligence(db, config);
  db.upsertAgent({ agentId: A_ID, owner: A_ADDR, agentWallet: A_ADDR });
  db.upsertAgent({ agentId: B_ID, owner: B_ADDR, agentWallet: B_ADDR });
  try {
    const disc: Message = {
      v: "0", nonce: randomUUID(), from: A_ADDR, type: "discovery",
      body: { chain: "PulseChain", anomalyType: "Liquidity Removal", contractAddress: CONTRACT, txHash: TX, timestamp: 1_700_000_000 },
    } as Message;
    const d = intel.submit(A_ID, A_ADDR, disc);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    const invBody = { investigationType: "Liquidity Impact Analysis", evidence: "LP pulled in one tx, no relock; 92% of reserves gone." };
    const inv1: Message = { v: "0", nonce: randomUUID(), from: A_ADDR, type: "investigation", task: d.threadId, body: invBody } as Message;
    assert.equal(intel.submit(A_ID, A_ADDR, inv1).ok, true);
    // Agent B copies A's investigation body verbatim → rejected ("tail-end spam"); the original is credited.
    const inv2: Message = { v: "0", nonce: randomUUID(), from: B_ADDR, type: "investigation", task: d.threadId, body: { ...invBody } } as Message;
    assert.equal(intel.submit(B_ID, B_ADDR, inv2).ok, false);
    // A genuinely DIFFERENT investigation from B is accepted — swarms are welcome, distinct work is fine.
    const inv3: Message = {
      v: "0", nonce: randomUUID(), from: B_ADDR, type: "investigation", task: d.threadId,
      body: { investigationType: "Smart Money Tracking", evidence: "deployer wallet funded 3 fresh wallets 10 blocks before the pull." },
    } as Message;
    assert.equal(intel.submit(B_ID, B_ADDR, inv3).ok, true);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("anti-replay: resubmitting an identical signed message is rejected", () => {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  const intel = new Intelligence(db, config);
  db.upsertAgent({ agentId: A_ID, owner: A_ADDR, agentWallet: A_ADDR });
  try {
    const signed: Message = {
      v: "0",
      nonce: randomUUID(),
      from: A_ADDR,
      type: "discovery",
      body: {
        chain: "Ethereum",
        anomalyType: "Liquidity Removal",
        contractAddress: CONTRACT,
        txHash: TX,
        timestamp: 1_700_000_000,
      },
      sig: "0xdeadbeef",
    };
    // First submission is accepted and persists the sig.
    const first = intel.submit(A_ID, A_ADDR, signed);
    assert.equal(first.ok, true);
    // The exact same {message, sig} re-POSTed must be rejected (no duplicate attributed row).
    const replay = intel.submit(A_ID, A_ADDR, signed);
    assert.equal(replay.ok, false);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});
