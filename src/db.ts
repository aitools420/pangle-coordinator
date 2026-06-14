/**
 * SQLite data-access layer (Phase 0). Synchronous via better-sqlite3.
 *
 * Tables: agents, threads, messages, rewards, audit.
 * This is the persistence contract imported by every module; see SPEC.md §Data model.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageType } from "./schema.js";

// active = participating; quarantined = OPERATOR-banned (sticky); inactive = the agent
// VOLUNTARILY disconnected itself (reversible — re-signing in reactivates). Quarantine and
// inactive are deliberately distinct: one is moderation, the other is the agent's own choice.
export type AgentStatus = "active" | "quarantined" | "inactive";
export type ThreadStatus = "open" | "resolved" | "unresolved";

export interface AgentRow {
  agentId: string; // ERC-8004 tokenId, as decimal string
  owner: string; // address that owns the identity NFT
  agentWallet: string; // address used to sign (may equal owner)
  status: AgentStatus;
  reputation: number; // cumulative $PANG earned (whole tokens), off-chain — no on-chain ReputationAnchor
  addedAt: number;
  note: string | null;
  specialization: string | null; // agent-declared focus (free text, capped) — what it's good at
  name: string | null; // agent-declared display name for the roster/leaderboard (sanitized, capped)
}

export interface ThreadRow {
  id: string;
  chain: string; // which EVM chain the anomaly is on (see CHAINS in schema.ts)
  anomalyType: string;
  contractAddress: string;
  txHash: string | null;
  walletAddress: string | null;
  discovererAgentId: string;
  discoveryMsgId: string;
  kind: string; // 'anomaly' (default) | 'request' (directed-delegation bounty thread)
  bounty: number; // $PANG paid to the fulfiller (0 for normal anomaly threads)
  status: ThreadStatus;
  conclusion: string | null; // accepted synthesis conclusion
  conclusionMsgId: string | null;
  createdAt: number;
  targetResolveAt: number; // createdAt + window
  resolvedAt: number | null;
  resolvedCorrect: 0 | 1 | null;
}

export interface MessageRow {
  id: string;
  threadId: string;
  type: MessageType;
  agentId: string;
  fromAddress: string;
  parent: string | null;
  body: string; // JSON
  sig: string | null;
  nonce: string | null; // per-message anti-replay UUID; unique per (fromAddress, nonce)
  createdAt: number;
  score: number | null;
  useful: 0 | 1 | null;
  scoredAt: number | null;
}

export interface RewardRow {
  id: number;
  agentId: string;
  threadId: string;
  messageId: string | null;
  amount: string; // token base units (decimal string)
  reason: string;
  txHash: string | null;
  createdAt: number;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected";
export interface SuggestionRow {
  id: string;
  agentId: string;
  fromAddress: string;
  area: string;
  proposal: string; // free text — human-reviewed only, never executed
  status: SuggestionStatus;
  createdAt: number;
  reviewedAt: number | null;
  rewardTxHash: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agentId TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  agentWallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  reputation INTEGER NOT NULL DEFAULT 0,
  addedAt INTEGER NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agents_wallet ON agents(agentWallet);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  anomalyType TEXT NOT NULL,
  contractAddress TEXT NOT NULL,
  txHash TEXT,
  walletAddress TEXT,
  kind TEXT NOT NULL DEFAULT 'anomaly',
  bounty INTEGER NOT NULL DEFAULT 0,
  discovererAgentId TEXT NOT NULL,
  discoveryMsgId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  conclusion TEXT,
  conclusionMsgId TEXT,
  createdAt INTEGER NOT NULL,
  targetResolveAt INTEGER NOT NULL,
  resolvedAt INTEGER,
  resolvedCorrect INTEGER
);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  type TEXT NOT NULL,
  agentId TEXT NOT NULL,
  fromAddress TEXT NOT NULL,
  parent TEXT,
  body TEXT NOT NULL,
  sig TEXT,
  nonce TEXT,
  createdAt INTEGER NOT NULL,
  score REAL,
  useful INTEGER,
  scoredAt INTEGER,
  FOREIGN KEY (threadId) REFERENCES threads(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agentId);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_sig ON messages(sig) WHERE sig IS NOT NULL;

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  messageId TEXT,
  amount TEXT NOT NULL,
  reason TEXT NOT NULL,
  txHash TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rewards_agent ON rewards(agentId);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  fromAddress TEXT NOT NULL,
  area TEXT NOT NULL,
  proposal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt INTEGER NOT NULL,
  reviewedAt INTEGER,
  rewardTxHash TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
`;

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent migrations for pre-existing DBs (CREATE TABLE IF NOT EXISTS won't add columns). */
  private migrate(): void {
    const cols = this.raw.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "nonce")) {
      this.raw.exec(`ALTER TABLE messages ADD COLUMN nonce TEXT`);
    }
    // Robust anti-replay key: (signer, nonce). Immune to ECDSA signature malleability and also
    // covers sig-less coordinator-relayed messages. Created here so the column exists first.
    this.raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_from_nonce ON messages(fromAddress, nonce) WHERE nonce IS NOT NULL`);
    // Directed-delegation: threads gain a kind + bounty (request threads carry a $PANG bounty).
    const tcols = this.raw.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[];
    if (!tcols.some((c) => c.name === "kind")) this.raw.exec(`ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'anomaly'`);
    if (!tcols.some((c) => c.name === "bounty")) this.raw.exec(`ALTER TABLE threads ADD COLUMN bounty INTEGER NOT NULL DEFAULT 0`);
    // Agent self-management: a self-declared specialization (free text). The self-set
    // "inactive" status needs no migration (status is already TEXT).
    const acols = this.raw.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
    if (!acols.some((c) => c.name === "specialization")) this.raw.exec(`ALTER TABLE agents ADD COLUMN specialization TEXT`);
    if (!acols.some((c) => c.name === "name")) this.raw.exec(`ALTER TABLE agents ADD COLUMN name TEXT`);
  }

  // ── agents ──────────────────────────────────────────────────
  upsertAgent(a: Omit<AgentRow, "reputation" | "status" | "addedAt" | "note" | "specialization" | "name"> & Partial<Pick<AgentRow, "reputation" | "status" | "addedAt" | "note" | "specialization" | "name">>): void {
    this.raw
      .prepare(
        `INSERT INTO agents (agentId, owner, agentWallet, status, reputation, addedAt, note)
         VALUES (@agentId, @owner, @agentWallet, @status, @reputation, @addedAt, @note)
         ON CONFLICT(agentId) DO UPDATE SET owner=@owner, agentWallet=@agentWallet, note=@note`,
      )
      .run({
        agentId: a.agentId,
        owner: a.owner.toLowerCase(),
        agentWallet: a.agentWallet.toLowerCase(),
        status: a.status ?? "active",
        reputation: a.reputation ?? 0,
        addedAt: a.addedAt ?? Math.floor(Date.now() / 1000),
        note: a.note ?? null,
      });
  }
  getAgent(agentId: string): AgentRow | undefined {
    return this.raw.prepare(`SELECT * FROM agents WHERE agentId = ?`).get(agentId) as AgentRow | undefined;
  }
  getAgentByWallet(addr: string): AgentRow | undefined {
    return this.raw.prepare(`SELECT * FROM agents WHERE agentWallet = ?`).get(addr.toLowerCase()) as AgentRow | undefined;
  }
  listAgents(): AgentRow[] {
    return this.raw.prepare(`SELECT * FROM agents ORDER BY addedAt DESC`).all() as AgentRow[];
  }
  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.raw.prepare(`UPDATE agents SET status = ? WHERE agentId = ?`).run(status, agentId);
  }
  setSpecialization(agentId: string, specialization: string | null): void {
    this.raw.prepare(`UPDATE agents SET specialization = ? WHERE agentId = ?`).run(specialization, agentId);
  }
  setName(agentId: string, name: string | null): void {
    this.raw.prepare(`UPDATE agents SET name = ? WHERE agentId = ?`).run(name, agentId);
  }
  setReputation(agentId: string, reputation: number): void {
    this.raw.prepare(`UPDATE agents SET reputation = ? WHERE agentId = ?`).run(reputation, agentId);
  }

  // ── threads ─────────────────────────────────────────────────
  createThread(t: Omit<ThreadRow, "status" | "conclusion" | "conclusionMsgId" | "resolvedAt" | "resolvedCorrect">): void {
    this.raw
      .prepare(
        `INSERT INTO threads (id, chain, anomalyType, contractAddress, txHash, walletAddress, kind, bounty, discovererAgentId, discoveryMsgId, status, createdAt, targetResolveAt)
         VALUES (@id, @chain, @anomalyType, @contractAddress, @txHash, @walletAddress, @kind, @bounty, @discovererAgentId, @discoveryMsgId, 'open', @createdAt, @targetResolveAt)`,
      )
      .run(t);
  }
  getThread(id: string): ThreadRow | undefined {
    return this.raw.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
  }
  listThreads(status?: ThreadStatus): ThreadRow[] {
    if (status) return this.raw.prepare(`SELECT * FROM threads WHERE status = ? ORDER BY createdAt DESC`).all(status) as ThreadRow[];
    return this.raw.prepare(`SELECT * FROM threads ORDER BY createdAt DESC`).all() as ThreadRow[];
  }
  /** Open threads that have a synthesis and whose resolution window has elapsed. */
  listResolvableThreads(now: number): ThreadRow[] {
    return this.raw
      .prepare(`SELECT * FROM threads WHERE status = 'open' AND conclusionMsgId IS NOT NULL AND targetResolveAt <= ? ORDER BY createdAt ASC`)
      .all(now) as ThreadRow[];
  }
  /** Event-dedup: an existing OPEN thread for the same on-chain event (chain + contract +
   *  the same tx hash / wallet), so a second discoverer is turned away to investigate the
   *  existing thread instead of opening a duplicate. Case-insensitive; nulls normalized to "". */
  findOpenThreadByEvent(chain: string, contractAddress: string, txHash: string | null, walletAddress: string | null): ThreadRow | undefined {
    return this.raw
      .prepare(
        `SELECT * FROM threads WHERE status = 'open'
           AND lower(chain) = lower(@chain)
           AND lower(contractAddress) = lower(@contractAddress)
           AND lower(coalesce(txHash, '')) = lower(@txHash)
           AND lower(coalesce(walletAddress, '')) = lower(@walletAddress)
         LIMIT 1`,
      )
      .get({ chain, contractAddress, txHash: txHash ?? "", walletAddress: walletAddress ?? "" }) as ThreadRow | undefined;
  }
  setThreadConclusion(id: string, conclusion: string, conclusionMsgId: string): void {
    this.raw.prepare(`UPDATE threads SET conclusion = ?, conclusionMsgId = ? WHERE id = ?`).run(conclusion, conclusionMsgId, id);
  }
  resolveThread(id: string, correct: boolean, resolvedAt: number): void {
    this.raw
      .prepare(`UPDATE threads SET status = ?, resolvedCorrect = ?, resolvedAt = ? WHERE id = ?`)
      .run(correct ? "resolved" : "unresolved", correct ? 1 : 0, resolvedAt, id);
  }

  // ── messages ────────────────────────────────────────────────
  addMessage(m: Omit<MessageRow, "score" | "useful" | "scoredAt">): void {
    this.raw
      .prepare(
        `INSERT INTO messages (id, threadId, type, agentId, fromAddress, parent, body, sig, nonce, createdAt)
         VALUES (@id, @threadId, @type, @agentId, @fromAddress, @parent, @body, @sig, @nonce, @createdAt)`,
      )
      .run(m);
  }
  getMessage(id: string): MessageRow | undefined {
    return this.raw.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }
  /** True if a message with this exact signature already exists (legacy anti-replay backstop). */
  sigExists(sig: string): boolean {
    return this.raw.prepare(`SELECT 1 FROM messages WHERE sig = ? LIMIT 1`).get(sig) !== undefined;
  }
  /** True if this (signer, nonce) pair was already used. Primary anti-replay check — robust against
   *  ECDSA signature malleability (a re-signed variant carries the same nonce) and covers sig-less msgs. */
  nonceUsed(fromAddress: string, nonce: string): boolean {
    return this.raw.prepare(`SELECT 1 FROM messages WHERE fromAddress = ? AND nonce = ? LIMIT 1`).get(fromAddress, nonce) !== undefined;
  }
  listThreadMessages(threadId: string): MessageRow[] {
    return this.raw.prepare(`SELECT * FROM messages WHERE threadId = ? ORDER BY createdAt ASC`).all(threadId) as MessageRow[];
  }
  listAgentMessages(agentId: string): MessageRow[] {
    return this.raw.prepare(`SELECT * FROM messages WHERE agentId = ? ORDER BY createdAt DESC`).all(agentId) as MessageRow[];
  }
  /** Most-recent messages across all threads — metadata feed for the public dashboard "live hive" view. */
  recentMessages(limit = 24): MessageRow[] {
    return this.raw.prepare(`SELECT * FROM messages ORDER BY createdAt DESC LIMIT ?`).all(limit) as MessageRow[];
  }
  scoreMessage(id: string, score: number, useful: boolean, scoredAt: number): void {
    this.raw.prepare(`UPDATE messages SET score = ?, useful = ?, scoredAt = ? WHERE id = ?`).run(score, useful ? 1 : 0, scoredAt, id);
  }
  /** Distinct agentIds that contributed at least one valid message to a thread (report gating). */
  activeContributors(threadId: string): string[] {
    const rows = this.raw.prepare(`SELECT DISTINCT agentId FROM messages WHERE threadId = ?`).all(threadId) as { agentId: string }[];
    return rows.map((r) => r.agentId);
  }

  // ── rewards ─────────────────────────────────────────────────
  addReward(r: Omit<RewardRow, "id" | "createdAt"> & { createdAt?: number }): number {
    const info = this.raw
      .prepare(
        `INSERT INTO rewards (agentId, threadId, messageId, amount, reason, txHash, createdAt)
         VALUES (@agentId, @threadId, @messageId, @amount, @reason, @txHash, @createdAt)`,
      )
      .run({ ...r, txHash: r.txHash ?? null, messageId: r.messageId ?? null, createdAt: r.createdAt ?? Math.floor(Date.now() / 1000) });
    return Number(info.lastInsertRowid);
  }
  listRewards(agentId?: string): RewardRow[] {
    if (agentId) return this.raw.prepare(`SELECT * FROM rewards WHERE agentId = ? ORDER BY createdAt DESC`).all(agentId) as RewardRow[];
    return this.raw.prepare(`SELECT * FROM rewards ORDER BY createdAt DESC`).all() as RewardRow[];
  }
  setRewardTx(id: number, txHash: string): void {
    this.raw.prepare(`UPDATE rewards SET txHash = ? WHERE id = ?`).run(txHash, id);
  }
  /** True if any reward row already exists for this message (per-message mint idempotency). */
  hasRewardForMessage(messageId: string): boolean {
    return !!this.raw.prepare(`SELECT 1 FROM rewards WHERE messageId = ? LIMIT 1`).get(messageId);
  }

  // ── audit ───────────────────────────────────────────────────
  audit(actor: string, action: string, detail?: unknown): void {
    this.raw
      .prepare(`INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), actor, action, detail === undefined ? null : JSON.stringify(detail));
  }
  listAudit(limit = 200): { id: number; ts: number; actor: string; action: string; detail: string | null }[] {
    return this.raw.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  }

  // ── settings (small key-value: persisted kill-switch, etc.) ──────────────────
  getSetting(key: string): string | undefined {
    const r = this.raw.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }
  setSetting(key: string, value: string): void {
    this.raw.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
  /** Sum of reward base units minted since `sinceTs` (unix sec) — powers the mint-rate circuit breaker. */
  mintedSince(sinceTs: number): bigint {
    const rows = this.raw.prepare(`SELECT amount FROM rewards WHERE createdAt >= ?`).all(sinceTs) as { amount: string }[];
    let t = 0n;
    for (const r of rows) {
      try { t += BigInt(r.amount); } catch { /* skip malformed */ }
    }
    return t;
  }
  /** Sum of reward base units minted to ONE agent since `sinceTs` — powers the per-agent mint cap. */
  mintedSinceByAgent(agentId: string, sinceTs: number): bigint {
    const rows = this.raw.prepare(`SELECT amount FROM rewards WHERE agentId = ? AND createdAt >= ?`).all(agentId, sinceTs) as { amount: string }[];
    let t = 0n;
    for (const r of rows) {
      try { t += BigInt(r.amount); } catch { /* skip malformed */ }
    }
    return t;
  }

  // ── suggestions (agent improvement proposals — human-in-the-loop) ────────────
  addSuggestion(s: Omit<SuggestionRow, "status" | "reviewedAt" | "rewardTxHash">): void {
    this.raw
      .prepare(`INSERT INTO suggestions (id, agentId, fromAddress, area, proposal, status, createdAt) VALUES (@id, @agentId, @fromAddress, @area, @proposal, 'pending', @createdAt)`)
      .run(s);
  }
  getSuggestion(id: string): SuggestionRow | undefined {
    return this.raw.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(id) as SuggestionRow | undefined;
  }
  listSuggestions(status?: SuggestionStatus): SuggestionRow[] {
    if (status) return this.raw.prepare(`SELECT * FROM suggestions WHERE status = ? ORDER BY createdAt DESC`).all(status) as SuggestionRow[];
    return this.raw.prepare(`SELECT * FROM suggestions ORDER BY createdAt DESC`).all() as SuggestionRow[];
  }
  setSuggestionReviewed(id: string, status: SuggestionStatus, reviewedAt: number, rewardTxHash?: string | null): void {
    this.raw.prepare(`UPDATE suggestions SET status = ?, reviewedAt = ?, rewardTxHash = ? WHERE id = ?`).run(status, reviewedAt, rewardTxHash ?? null, id);
  }
  suggestionCounts(): { pending: number; accepted: number; rejected: number } {
    const rows = this.raw.prepare(`SELECT status, COUNT(*) n FROM suggestions GROUP BY status`).all() as { status: string; n: number }[];
    const c = { pending: 0, accepted: 0, rejected: 0 };
    for (const r of rows) if (r.status in c) (c as Record<string, number>)[r.status] = r.n;
    return c;
  }

  close(): void {
    this.raw.close();
  }
}
