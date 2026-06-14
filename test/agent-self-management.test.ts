/**
 * Agent self-management tests (2026-06-14): specialization + voluntary self-disconnect.
 * Covers the new db column, the inactive status, and the login/session semantics:
 *  - set/clear specialization persists
 *  - self-disconnect → inactive; an active token then dies (verifyToken rejects inactive)
 *  - an inactive agent REACTIVATES by signing in again (verifyAndIssue), reputation intact
 *  - a quarantined agent does NOT reactivate on login (moderation stays sticky)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { Db } from "../src/db.js";
import { Auth } from "../src/auth.js";
import { config, type Config } from "../src/config.js";

const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const accountA = privateKeyToAccount(PK_A);
const A_ID = "1";

function tmpDbPath(): string {
  return join(tmpdir(), `pangle-selfmgmt-${randomBytes(8).toString("hex")}.db`);
}
function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}
function setup(): { db: Db; auth: Auth; dbPath: string } {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  db.upsertAgent({ agentId: A_ID, owner: accountA.address, agentWallet: accountA.address });
  const cfg: Config = config;
  const auth = new Auth(db, cfg);
  return { db, auth, dbPath };
}
async function login(auth: Auth) {
  const ch = auth.challenge(accountA.address);
  const signature = await accountA.signMessage({ message: ch.statement });
  return auth.verifyAndIssue({ address: accountA.address, signature, nonce: ch.nonce });
}

test("specialization: set persists, can be cleared", () => {
  const { db, dbPath } = setup();
  try {
    assert.equal(db.getAgent(A_ID)!.specialization, null);
    db.setSpecialization(A_ID, "honeypot detection · PulseChain");
    assert.equal(db.getAgent(A_ID)!.specialization, "honeypot detection · PulseChain");
    db.setSpecialization(A_ID, null);
    assert.equal(db.getAgent(A_ID)!.specialization, null);
  } finally { db.close(); cleanup(dbPath); }
});

test("name: set persists, can be cleared", () => {
  const { db, dbPath } = setup();
  try {
    assert.equal(db.getAgent(A_ID)!.name, null);
    db.setName(A_ID, "Sentinel Prime");
    assert.equal(db.getAgent(A_ID)!.name, "Sentinel Prime");
    db.setName(A_ID, null);
    assert.equal(db.getAgent(A_ID)!.name, null);
  } finally { db.close(); cleanup(dbPath); }
});

test("self-disconnect: status → inactive, and an existing token then fails verifyToken", async () => {
  const { db, auth, dbPath } = setup();
  try {
    const issued = await login(auth);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    // token is valid while active
    assert.ok(await auth.verifyToken(issued.token), "active token verifies");
    // agent self-disconnects → inactive
    db.setAgentStatus(A_ID, "inactive");
    assert.equal(db.getAgent(A_ID)!.status, "inactive");
    // the live session immediately stops working (status re-checked every request)
    assert.equal(await auth.verifyToken(issued.token), null, "inactive agent's session dies");
  } finally { db.close(); cleanup(dbPath); }
});

test("reactivation: an inactive agent re-signing in is reactivated (reputation intact)", async () => {
  const { db, auth, dbPath } = setup();
  try {
    db.setReputation(A_ID, 42);
    db.setAgentStatus(A_ID, "inactive");
    const issued = await login(auth);
    assert.equal(issued.ok, true, "inactive agent can log back in");
    assert.equal(db.getAgent(A_ID)!.status, "active", "login reactivated the agent");
    assert.equal(db.getAgent(A_ID)!.reputation, 42, "reputation persisted across disconnect");
  } finally { db.close(); cleanup(dbPath); }
});

test("quarantine stays sticky: a quarantined agent is NOT reactivated by logging in", async () => {
  const { db, auth, dbPath } = setup();
  try {
    db.setAgentStatus(A_ID, "quarantined");
    const issued = await login(auth);
    assert.equal(issued.ok, false, "quarantined login rejected");
    assert.equal(db.getAgent(A_ID)!.status, "quarantined", "still quarantined — login did not flip it to active");
  } finally { db.close(); cleanup(dbPath); }
});
