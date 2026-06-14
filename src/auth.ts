/**
 * Chain-agnostic cryptographic authentication — pure off-chain ECDSA, NO shared secret,
 * NO on-chain calls, NO specific chain required.
 *
 * An agent's identity is simply a keypair: it authenticates by signing, and the coordinator
 * verifies by recovering the signer (viem `recoverMessageAddress`, EIP-191). Signatures are
 * chain-agnostic — an agent can sign from any EVM chain or fully offline, needs no gas and no
 * on-chain identity NFT to participate. (ERC-8004 is an OPTIONAL portable-identity credential,
 * not required for auth and never read on the hot path.) Reputation and token rewards still
 * settle on the one hub chain — see config.ts / chain.ts.
 *
 * Two layers, both pure ECDSA:
 *
 *  1. Connection (session) auth — a SELF-SIGNED SIWE-style assertion.
 *     - challenge(address) → a human-readable statement embedding a one-time nonce + the
 *       resource (audience) + an expiry. The agent signs that exact statement with its key.
 *     - verifyAndIssue({address, signature, nonce}) → recover the signer, confirm it matches
 *       the claimed address, then resolve the agent: PERMISSIONLESS — an unknown signer is
 *       auto-registered (anyone aware of the network can join), a quarantined agent is
 *       rejected. Returns a SELF-CONTAINED bearer token = base64url({address, nonce,
 *       issuedAt, expiresAt, signature}). The coordinator mints/signs NOTHING — the token IS
 *       the agent's own signature over the statement.
 *     - verifyToken(token) → stateless: rebuild the statement, recover the signer, re-check it
 *       against the address + expiry + audience + ACTIVE status. A quarantined agent fails
 *       immediately (status re-checked every request), so no session/revocation store is needed.
 *
 *  2. Per-message auth — every contribution (Discovery / Investigation / Synthesis) carries
 *     `sig`, the agent's signature over the canonical serialization of the message. The
 *     coordinator recovers the signer and confirms it is the authenticated caller — pure
 *     ECDSA, no chain read. See `verifyMessageSignature`.
 *
 * Sybil note: with permissionless join, identity itself is free, so the coordinator's manual
 * usefulness/correctness scoring is the value gate (junk earns nothing) and quarantine is the
 * moderation lever. Real sybil resistance (stake / proof-of-uniqueness) is a pre-token-value
 * item, not part of the MVP.
 *
 * Address comparisons are case-insensitive (lowercased) throughout.
 */
import { randomUUID } from "node:crypto";
import { recoverMessageAddress } from "viem";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import { MCP_SCOPES, type McpScope, type Message } from "./schema.js";

export interface SessionClaims {
  agentId: string;
  address: string;
  scopes: McpScope[];
  jti: string;
}

/** The fields packed into a self-signed bearer token (base64url JSON). */
interface TokenPayload {
  address: string;
  nonce: string;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
  signature: string;
}

/** Server-side nonce record for a pending login challenge (single-use, short-lived). */
interface NonceEntry {
  nonce: string;
  address: string; // lowercased address this challenge was issued for (the nonce is bound to it)
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds (the issued token's expiry — baked into the signed statement)
}

/** How long an agent has to complete the challenge→verify handshake (seconds). ~5 minutes. */
const NONCE_TTL_SECONDS = 300;
/** Small allowance for clock skew when checking a token's issuedAt (seconds). */
const CLOCK_SKEW_SECONDS = 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Deterministic JSON: object keys sorted recursively, so an identical structure always
 * serializes to identical bytes on both the signer (agent) and the verifier (coordinator),
 * independent of key insertion order on the wire.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  // Drop undefined-valued keys (mirror JSON.stringify) so a raw object and a zod-parsed one
  // (which strips undefined optionals) canonicalize identically.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/**
 * The canonical payload an agent signs (and the coordinator verifies) for a contribution.
 * Excludes `sig`; `from` is lowercased. Single source of truth — imported by the agent
 * simulator (to sign) and the MCP server (to verify), so the two can never drift.
 */
export function canonicalMessageToSign(m: Message): string {
  return stableStringify({
    v: m.v,
    from: m.from.toLowerCase(),
    nonce: m.nonce, // signed anti-replay nonce
    type: m.type,
    task: m.task ?? null,
    parent: m.parent ?? null,
    body: m.body,
  });
}

export class Auth {
  private readonly db: Db;
  private readonly cfg: Config;
  /** key = nonce VALUE → pending single-use entry (bound to an address). Keyed by nonce, not
   *  address, so a second/concurrent challenge for the same address can't clobber a victim's
   *  pending nonce (targeted auth-DoS) and concurrent logins from one key both complete. */
  private readonly nonces = new Map<string, NonceEntry>();

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  /** Build a one-time login challenge for an address. Stores the nonce server-side (TTL ~5 min). */
  challenge(address: string): {
    nonce: string;
    statement: string;
    issuedAt: number;
    expiresAt: number;
    audience: string;
  } {
    const key = address.toLowerCase();
    const issuedAt = now();
    // GC expired pending nonces so the in-memory map can't grow unbounded.
    for (const [k, v] of this.nonces) {
      if (issuedAt - v.issuedAt > NONCE_TTL_SECONDS) this.nonces.delete(k);
    }
    const expiresAt = issuedAt + this.cfg.sessionTtlSeconds;
    const nonce = randomUUID();
    this.nonces.set(nonce, { nonce, address: key, issuedAt, expiresAt });
    const statement = this.buildStatement(address, nonce, issuedAt, expiresAt);
    return { nonce, statement, issuedAt, expiresAt, audience: this.cfg.mcpResourceUrl };
  }

  /**
   * Verify the signature over the statement, confirm the signer matches the claimed address,
   * resolve the agent (PERMISSIONLESS — auto-register an unknown signer; reject a quarantined
   * one), then return a self-contained, self-signed bearer token. Pure ECDSA, no chain read,
   * no shared secret.
   */
  async verifyAndIssue(input: {
    address: string;
    signature: string;
    nonce: string;
  }): Promise<
    | { ok: true; token: string; agentId: string; scopes: McpScope[]; expiresAt: number }
    | { ok: false; error: string }
  > {
    // ── Validate inputs at the boundary ────────────────────────────────
    if (
      typeof input.address !== "string" ||
      typeof input.signature !== "string" ||
      typeof input.nonce !== "string"
    ) {
      return { ok: false, error: "address, signature and nonce are required strings" };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) {
      return { ok: false, error: "invalid address" };
    }
    if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) {
      return { ok: false, error: "invalid signature" };
    }

    const key = input.address.toLowerCase();

    // ── Check the server-side nonce: looked up by VALUE, not expired, bound to this address ─────
    const entry = this.nonces.get(input.nonce);
    if (!entry) {
      return { ok: false, error: "unknown or expired nonce" };
    }
    if (now() - entry.issuedAt > NONCE_TTL_SECONDS) {
      this.nonces.delete(input.nonce);
      return { ok: false, error: "unknown or expired nonce" };
    }
    if (entry.address !== key) {
      return { ok: false, error: "nonce was not issued for this address" };
    }
    // Consume the nonce now so it cannot be reused regardless of outcome below.
    this.nonces.delete(input.nonce);

    // ── Recover the signer over the exact human-readable statement ─────
    const statement = this.buildStatement(input.address, entry.nonce, entry.issuedAt, entry.expiresAt);
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: statement,
        signature: input.signature as `0x${string}`,
      });
    } catch {
      return { ok: false, error: "could not recover signer from signature" };
    }
    if (recovered.toLowerCase() !== key) {
      return { ok: false, error: "signature does not match address" };
    }

    // ── Resolve the agent — PERMISSIONLESS join ────────────────────────
    // Anyone aware of the network can join: an unknown signer is auto-registered on first
    // login (identity = the address; agentId = a deterministic numeric derived from it, so
    // on-chain reputation/rewards key consistently). A quarantined agent stays rejected.
    let agent = this.db.getAgentByWallet(recovered);
    if (!agent) {
      const agentId = BigInt(recovered).toString();
      this.db.upsertAgent({ agentId, owner: recovered, agentWallet: recovered });
      this.db.audit("auth", "agent.self-register", { agentId, address: recovered });
      agent = this.db.getAgentByWallet(recovered);
    }
    // A self-disconnected ("inactive") agent reactivates simply by signing in again — its
    // reputation + earned rewards persist. Quarantine (operator moderation) is NOT reversible
    // this way: it stays rejected below.
    if (agent && agent.status === "inactive") {
      this.db.setAgentStatus(agent.agentId, "active");
      this.db.audit("auth", "agent.reactivate", { agentId: agent.agentId, address: recovered });
      agent = this.db.getAgentByWallet(recovered);
    }
    if (!agent || agent.status !== "active") {
      return { ok: false, error: "agent is not active" };
    }

    // ── Pack the self-signed token. Nothing here is signed by the coordinator. ──
    const payload: TokenPayload = {
      address: input.address,
      nonce: entry.nonce,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      signature: input.signature,
    };
    const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const scopes: McpScope[] = [...MCP_SCOPES];

    return { ok: true, token, agentId: agent.agentId, scopes, expiresAt: entry.expiresAt };
  }

  /**
   * Verify a bearer token statelessly: decode it, rebuild the signed statement, recover the
   * signer, and re-check it against the address + ACTIVE agent status + expiry. Pure ECDSA,
   * no chain read, no server secret, no session store — the token is the agent's own signature.
   */
  async verifyToken(token: string): Promise<SessionClaims | null> {
    if (typeof token !== "string" || token.length === 0) return null;

    let payload: TokenPayload;
    try {
      const json = Buffer.from(token, "base64url").toString("utf8");
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (
        typeof parsed.address !== "string" ||
        typeof parsed.nonce !== "string" ||
        typeof parsed.issuedAt !== "number" ||
        typeof parsed.expiresAt !== "number" ||
        typeof parsed.signature !== "string"
      ) {
        return null;
      }
      payload = {
        address: parsed.address,
        nonce: parsed.nonce,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
        signature: parsed.signature,
      };
    } catch {
      return null;
    }

    // ── Expiry / sanity (the assertion is short-lived) ──
    const t = now();
    if (payload.expiresAt <= t) return null;
    if (payload.issuedAt > t + CLOCK_SKEW_SECONDS) return null;
    if (payload.expiresAt - payload.issuedAt > this.cfg.sessionTtlSeconds) return null;

    // ── Recover the signer over the rebuilt statement (binds address + audience + expiry) ──
    const statement = this.buildStatement(
      payload.address,
      payload.nonce,
      payload.issuedAt,
      payload.expiresAt,
    );
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: statement,
        signature: payload.signature as `0x${string}`,
      });
    } catch {
      return null;
    }
    if (recovered.toLowerCase() !== payload.address.toLowerCase()) return null;

    // ── Re-derive the agent server-side (never trust a wallet→agentId mapping from the token) ──
    const agent = this.db.getAgentByWallet(recovered);
    if (!agent || agent.status !== "active") return null;

    return {
      agentId: agent.agentId,
      address: agent.agentWallet,
      scopes: [...MCP_SCOPES],
      jti: payload.nonce,
    };
  }

  /**
   * Verify a contribution's per-message signature — pure off-chain ECDSA. The agent signs the
   * canonical serialization of the message with its key; the coordinator recovers that key and
   * confirms it is the authenticated caller. No chain read, chain-agnostic.
   */
  async verifyMessageSignature(
    message: Message,
    claims: SessionClaims,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const sig = message.sig;
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) {
      return { ok: false, error: "contribution must be signed (missing or malformed sig)" };
    }
    const canonical = canonicalMessageToSign(message);
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: canonical, signature: sig as `0x${string}` });
    } catch {
      return { ok: false, error: "could not recover signer from message signature" };
    }
    if (recovered.toLowerCase() !== claims.address.toLowerCase()) {
      return { ok: false, error: "message signature does not match the authenticated agent" };
    }
    return { ok: true };
  }

  /**
   * Human-readable, nonce-embedding login statement (SIWE-style). The signer signs this exact
   * text with its agent key. It binds the audience (resource) and expiry, so the resulting
   * token cannot be replayed against another server and stops verifying after `expiresAt`.
   * Deliberately chain-agnostic — no chain id is bound, so an agent on any EVM chain (or none)
   * signs the same way; verification is pure off-chain ECDSA.
   */
  private buildStatement(address: string, nonce: string, issuedAt: number, expiresAt: number): string {
    return [
      "Pangle wants you to sign in with your agent key:",
      address,
      "",
      "Sign in to the Pangle coordinator. This is an off-chain signature — it will not trigger a blockchain transaction, cost any gas, or require any specific chain.",
      "",
      `URI: ${this.cfg.mcpResourceUrl}`,
      "Version: 1",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issuedAt * 1000).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
    ].join("\n");
  }
}
