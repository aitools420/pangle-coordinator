/**
 * Auth tests — ERC-8004 signature authentication (no shared secret).
 * Covers the self-signed session token round-trip and per-message contribution signatures,
 * including the negative cases the new design must reject (unsigned / wrong-key / tampered).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { Db } from "../src/db.js";
import { Auth, canonicalMessageToSign, type SessionClaims } from "../src/auth.js";
import { config, type Config } from "../src/config.js";
import type { Message } from "../src/schema.js";

// anvil account #1 / #2 (well-known public test keys) — deterministic fixtures.
const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PK_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);
const A_ID = "1";

function tmpDbPath(): string {
  return join(tmpdir(), `pangle-auth-${randomBytes(8).toString("hex")}.db`);
}
function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

/** A pre-registered, active agent A on a fresh Db, plus its Auth instance (no chain — auth is
 *  pure off-chain ECDSA). */
function setup(): { db: Db; auth: Auth; cfg: Config; dbPath: string } {
  const dbPath = tmpDbPath();
  const db = new Db(dbPath);
  db.upsertAgent({ agentId: A_ID, owner: accountA.address, agentWallet: accountA.address });
  const cfg: Config = config;
  const auth = new Auth(db, cfg);
  return { db, auth, cfg, dbPath };
}

function discoveryFor(from: string): Message {
  return {
    v: "0",
    nonce: randomUUID(),
    from,
    type: "discovery",
    body: {
      chain: "Ethereum",
      anomalyType: "Liquidity Removal",
      contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      txHash: "0x" + "ab".repeat(32),
      timestamp: 1_700_000_000,
    },
  } as Message;
}

test("session token: challenge → sign → verifyAndIssue → verifyToken round-trip", async () => {
  const { db, auth, dbPath } = setup();
  try {
    const ch = auth.challenge(accountA.address);
    const signature = await accountA.signMessage({ message: ch.statement });
    const issued = await auth.verifyAndIssue({ address: accountA.address, signature, nonce: ch.nonce });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const claims = await auth.verifyToken(issued.token);
    assert.ok(claims, "valid token verifies");
    assert.equal(claims!.agentId, A_ID);
    assert.equal(claims!.address.toLowerCase(), accountA.address.toLowerCase());

    // A tampered token (flip a byte of the base64url) must not verify.
    const tampered = issued.token.slice(0, -2) + (issued.token.endsWith("a") ? "bb" : "aa");
    assert.equal(await auth.verifyToken(tampered), null);

    // Garbage token must not verify.
    assert.equal(await auth.verifyToken("not-a-token"), null);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("session token: an unknown signer is auto-registered (permissionless join)", async () => {
  const { db, auth, dbPath } = setup();
  try {
    // accountB was never pre-registered. Permissionless join: a valid signed login registers it.
    assert.equal(db.getAgentByWallet(accountB.address), undefined);
    const ch = auth.challenge(accountB.address);
    const signature = await accountB.signMessage({ message: ch.statement });
    const issued = await auth.verifyAndIssue({ address: accountB.address, signature, nonce: ch.nonce });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const agent = db.getAgentByWallet(accountB.address);
    assert.ok(agent, "signer is auto-registered on first login");
    assert.equal(agent!.agentId, BigInt(accountB.address).toString());
    assert.equal(agent!.status, "active");
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("session token: a quarantined agent is rejected at verifyAndIssue", async () => {
  const { db, auth, dbPath } = setup();
  try {
    db.setAgentStatus(A_ID, "quarantined");
    const ch = auth.challenge(accountA.address);
    const signature = await accountA.signMessage({ message: ch.statement });
    const issued = await auth.verifyAndIssue({ address: accountA.address, signature, nonce: ch.nonce });
    assert.equal(issued.ok, false);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("per-message signature: valid sig from the ERC-8004 key is accepted", async () => {
  const { db, auth, dbPath } = setup();
  try {
    const claims: SessionClaims = { agentId: A_ID, address: accountA.address, scopes: [], jti: "t" };
    const msg = discoveryFor(accountA.address);
    const sig = await accountA.signMessage({ message: canonicalMessageToSign(msg) });
    const res = await auth.verifyMessageSignature({ ...msg, sig } as Message, claims);
    assert.equal(res.ok, true);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("per-message signature: an UNSIGNED contribution is rejected", async () => {
  const { db, auth, dbPath } = setup();
  try {
    const claims: SessionClaims = { agentId: A_ID, address: accountA.address, scopes: [], jti: "t" };
    const res = await auth.verifyMessageSignature(discoveryFor(accountA.address), claims);
    assert.equal(res.ok, false);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});

test("per-message signature: a sig from the WRONG key is rejected", async () => {
  const { db, auth, dbPath } = setup();
  try {
    const claims: SessionClaims = { agentId: A_ID, address: accountA.address, scopes: [], jti: "t" };
    const msg = discoveryFor(accountA.address);
    // Signed by B, but the authenticated caller is A → must be rejected.
    const sig = await accountB.signMessage({ message: canonicalMessageToSign(msg) });
    const res = await auth.verifyMessageSignature({ ...msg, sig } as Message, claims);
    assert.equal(res.ok, false);
  } finally {
    db.close();
    cleanup(dbPath);
  }
});
