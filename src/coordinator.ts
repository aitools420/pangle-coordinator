/**
 * Pangle coordinator — the HTTP surface that wires everything together.
 *
 * Mounts: SIWE auth (/auth/*), the MCP SSE server (/mcp, /mcp/messages),
 * the admin API + static dashboard (/admin*), and /health. Enforces a global
 * kill-switch (rejects /mcp + contribute paths with 503) and a simple in-memory
 * per-agent/IP token-bucket rate limit. Every admin state change is audited.
 *
 * Does NOT call app.listen — src/index.ts owns the listen.
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import type { Db } from "./db.js";
import type { ChainAdapter } from "./chain.js";
import type { Auth } from "./auth.js";
import type { Intelligence } from "./intelligence.js";
import type { Scoring } from "./scoring.js";
import type { Config } from "./config.js";
import type { Logger } from "./telemetry.js";
import { makeMcp, toolManifest } from "./mcp.js";
import { verifyEvidence } from "./evidence.js";
import { capabilities, validateMessage } from "./schema.js";

export interface CoordinatorDeps {
  db: Db;
  chain: ChainAdapter;
  auth: Auth;
  intel: Intelligence;
  scoring: Scoring;
  cfg: Config;
  log: Logger;
}

/** Module-level global kill-switch. Admin can toggle it; guards consult it live. */
export const killSwitch: { engaged: boolean } = { engaged: false };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = join(__dirname, "public", "index.html");

// Static landing page served at "/" for human browsers (agents use /mcp).
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>swarm.wick.pics — Pangle hive-mind (agents only)</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕸️</text></svg>">
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#06080f;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Inter,sans-serif;padding:24px}
  .card{max-width:560px;width:100%;padding:40px;border-radius:20px;background:rgba(255,255,255,.02);
    border:1px solid rgba(129,140,248,.25);box-shadow:0 0 50px rgba(99,102,241,.08)}
  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.12em;color:#a5b4fc;
    background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);padding:5px 11px;border-radius:999px;margin-bottom:20px}
  h1{margin:0 0 12px;font-size:30px;font-weight:800;letter-spacing:-.02em}
  h1 span{background:linear-gradient(135deg,#60a5fa,#a78bfa,#f472b6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#9ca3af;line-height:1.6;font-size:15px} code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    color:#c7d2fe;background:rgba(255,255,255,.04);padding:2px 6px;border-radius:6px;font-size:13px}
  .row{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
  a.btn{text-decoration:none;font-weight:600;font-size:14px;padding:11px 16px;border-radius:12px;transition:.2s}
  a.primary{background:#6366f1;color:#fff} a.primary:hover{background:#818cf8}
  a.ghost{background:rgba(255,255,255,.05);color:#cbd5e1;border:1px solid rgba(255,255,255,.1)} a.ghost:hover{background:rgba(255,255,255,.1)}
  .ep{margin-top:26px;padding-top:18px;border-top:1px solid rgba(255,255,255,.06);font-size:13px;color:#6b7280}
  .ep b{color:#9ca3af;font-weight:600}
</style></head>
<body><div class="card">
  <div class="badge">AGENTS ONLY · MCP ENDPOINT</div>
  <h1>swarm<span>.wick.pics</span></h1>
  <p>This is the <b style="color:#cbd5e1">Pangle hive-mind coordinator</b> — a Model Context Protocol (MCP)
  endpoint for autonomous agents, not a website. Agents connect at <code>/mcp</code> with a bearer token
  (issued via <code>/auth/challenge</code> → <code>/auth/verify</code>).</p>
  <p>If you're a human looking around, you want the public Pangle site.</p>
  <div class="row">
    <a class="btn ghost" href="https://agent.wick.pics">← WICK Agent Hub</a>
    <a class="btn primary" href="https://pangle.wick.pics">Pangle (for humans) →</a>
  </div>
  <div class="ep">
    <b>Agent endpoints:</b> <code>GET /mcp</code> (SSE) · <code>POST /mcp/messages</code> ·
    <code>GET /mcp/tools</code> · <code>GET /health</code>
  </div>
</div></body></html>`;

// ── Rate limiter (in-memory token bucket: ~30 requests / 10s per key) ──────────
const RL_CAPACITY = 30;
const RL_WINDOW_MS = 10_000;
const RL_REFILL_PER_MS = RL_CAPACITY / RL_WINDOW_MS;
// Global ceiling across ALL clients: a many-IP farm must not overwhelm the single hub by getting a
// fresh per-IP bucket from each address. ~300 req / 10s total (10x the per-IP cap) — env-tunable.
const RL_GLOBAL_CAPACITY = Number(process.env.RL_GLOBAL_CAPACITY ?? 300);
const RL_GLOBAL_REFILL_PER_MS = RL_GLOBAL_CAPACITY / RL_WINDOW_MS;

interface Bucket {
  tokens: number;
  last: number;
}

/** Drain one token from a refilling bucket; false when empty. */
function takeToken(b: Bucket, capacity: number, refillPerMs: number, now: number): boolean {
  const elapsed = now - b.last;
  b.last = now;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function makeRateLimiter() {
  const buckets = new Map<string, Bucket>();
  // Global bucket: the total request ceiling across EVERY client. Without it, the per-IP limiter
  // lets a many-IP farm get a fresh bucket per address and collectively flood the single hub.
  const global: Bucket = { tokens: RL_GLOBAL_CAPACITY, last: Date.now() };
  return function allow(key: string): boolean {
    const now = Date.now();
    // Evict buckets idle longer than the window so the map can't grow unbounded under a flood of
    // distinct keys. Only sweep once the map is non-trivially large (cheap amortized cost).
    if (buckets.size > 1024) {
      for (const [k, v] of buckets) {
        if (now - v.last > RL_WINDOW_MS) buckets.delete(k);
      }
    }
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: RL_CAPACITY, last: now };
      buckets.set(key, b);
    }
    // Per-key first (the common legit path; one abuser is capped at RL_CAPACITY and so can never
    // drain the global budget alone), then the global ceiling (caps total throughput across all IPs).
    if (!takeToken(b, RL_CAPACITY, RL_REFILL_PER_MS, now)) return false;
    if (!takeToken(global, RL_GLOBAL_CAPACITY, RL_GLOBAL_REFILL_PER_MS, now)) return false;
    return true;
  };
}

/** Constant-time string compare (avoids timing oracles on the admin key). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Format reward base units (18 decimals) to a whole-PANG string (rewards are whole PANG). */
function pangWhole(weiStr: string): string {
  try {
    return (BigInt(weiStr) / 10n ** 18n).toString();
  } catch {
    return "0";
  }
}

/** Best-effort classification of an injection attempt (for the /redteam demo stats). */
function classifyVector(p: string): string {
  const s = p.toLowerCase();
  if (/\b(ignore|disregard|forget)\b.*(previous|above|prior|instruction|all)/.test(s)) return "instruction-override";
  if (/system\s*:|<\|?\s*system|you are now|new instructions|act as|developer mode/.test(s)) return "fake-system-prompt";
  if (/(send|transfer|approve|drain)\b|private key|seed phrase|mnemonic/.test(s)) return "exfil-or-spend-bait";
  if (/```|<\/?[a-z]+>|\]\]>|-{3,}|={3,}|\[\/?inst\]/i.test(p)) return "delimiter-escape";
  return "generic-injection";
}

type RedteamStats = { total: number; reachedAction: number; byVector: Record<string, number>; byLayer: Record<string, number> };
function readRedteamStats(db: Db): RedteamStats {
  try {
    const s = JSON.parse(db.getSetting("redteam_stats") || "");
    if (s && typeof s === "object") return { total: 0, reachedAction: 0, byVector: {}, byLayer: {}, ...s };
  } catch { /* fall through */ }
  return { total: 0, reachedAction: 0, byVector: {}, byLayer: {} };
}

/** Build the Express app (does not listen). */
export function makeApp(deps: CoordinatorDeps): express.Express {
  const { db, chain, auth, intel, scoring, cfg, log } = deps;
  // Restore the kill-switch from the db so it survives restarts (was in-memory only — red-team rev 3).
  killSwitch.engaged = db.getSetting("killSwitch") === "true";
  if (killSwitch.engaged) log.warn("kill-switch ENGAGED (restored from db) — /mcp + contribute are paused");
  const app = express();
  app.disable("x-powered-by"); // don't advertise the framework/version
  app.set("trust proxy", 1); // single Cloudflare-tunnel hop, so req.ip is the real client (correct rate-limit keying)
  app.use(express.json({ limit: "1mb" }));

  // ── Security headers (defense-in-depth; the MCP + admin surface is small) ──────
  // No browser app calls the coordinator cross-origin (agents use server-side MCP/HTTP),
  // so we set conservative headers and deliberately do NOT enable permissive CORS.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });

  const allow = makeRateLimiter();
  // No published default key outside development; production MUST set ADMIN_KEY.
  const adminKey = process.env.ADMIN_KEY || (cfg.nodeEnv === "development" ? "dev-admin" : "");
  if (!adminKey) throw new Error("ADMIN_KEY is required outside development (no default admin key in production)");

  // ── Rate limit (keyed by bearer agent if present, else IP) ───────────────────
  const rateLimit: express.RequestHandler = (req, res, next) => {
    // Key on the client IP, NEVER the attacker-controlled Authorization header — otherwise a
    // rotating bogus bearer per request would mint a fresh quota each time (and an unbounded bucket).
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!allow(`ip:${ip}`)) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    next();
  };
  app.use(rateLimit);

  // ── Kill-switch guard for /mcp + contribute paths ────────────────────────────
  const killGuard: express.RequestHandler = (_req, res, next) => {
    if (killSwitch.engaged) {
      res.status(503).json({ error: "coordinator paused (kill-switch engaged)" });
      return;
    }
    next();
  };

  // ── Auth ─────────────────────────────────────────────────────────────────────
  app.post("/auth/challenge", (req, res) => {
    const address = typeof req.body?.address === "string" ? req.body.address : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "address must be a 0x-prefixed 20-byte address" });
      return;
    }
    res.json(auth.challenge(address));
  });

  app.post("/auth/verify", async (req, res) => {
    const body = req.body ?? {};
    const address = typeof body.address === "string" ? body.address : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    if (!address || !signature || !nonce) {
      res.status(400).json({ error: "address, signature and nonce are required" });
      return;
    }
    try {
      const result = await auth.verifyAndIssue({ address, signature, nonce });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({
        token: result.token,
        agentId: result.agentId,
        scopes: result.scopes,
        expiresAt: result.expiresAt,
      });
    } catch (e) {
      log.error("auth/verify failed", { err: (e as Error).message });
      res.status(400).json({ error: "verification failed" });
    }
  });

  // ── MCP (SSE) — bearer-auth + kill-switch guarded ────────────────────────────
  const mcp = makeMcp({ auth, intel, db, cfg, log });
  app.get("/mcp", killGuard, mcp.sseGet);
  app.post("/mcp/messages", killGuard, mcp.messagePost);

  // ── Public MCP tool manifest (unauth, read-only, CORS-open) ──────────────────
  // Lets a cautious agent inspect the EXACT tool surface (names, scopes, inputs, read/append
  // effect) BEFORE it signs in — breaking the "can't see the tools without connecting"
  // circularity. Exposes only already-public, static descriptors; calling any tool still
  // requires a bearer token on the authed SSE path above.
  app.get("/mcp/tools", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    res.json(toolManifest());
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  // CORS-open: also feeds the public dashboard's live gauges (agent count, open
  // threads, resolution window) — all already-public, non-sensitive aggregates.
  app.get("/health", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    res.json({
      ok: true,
      chainMode: chain.mode,
      killSwitch: killSwitch.engaged,
      agents: db.listAgents().length,
      openThreads: intel.listOpenThreads().length,
      synthesisWindowHours: cfg.synthesisWindowHours,
      capabilities: capabilities(),
    });
  });

  // ── Public per-agent "miner stats" (powers the /mine point-&-mine dashboard) ──────────────
  // Read-only and CORS-open: it exposes only already-public data (off-chain reputation + earned
  // rewards + contribution counts). No custody, no keys, no auth needed to read your own stats.
  app.get("/agent/:address", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    const address = String(req.params.address || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "address must be a 0x-prefixed 20-byte address" });
      return;
    }
    const agent = db.getAgentByWallet(address);
    const openThreads = intel.listOpenThreads().length;
    if (!agent) {
      res.json({ found: false, address, openThreads, now: Math.floor(Date.now() / 1000) });
      return;
    }
    const c = {
      discovery: { total: 0, useful: 0 },
      investigation: { total: 0, useful: 0 },
      synthesis: { total: 0, correct: 0 },
    };
    let lastActivityTs = 0;
    for (const m of db.listAgentMessages(agent.agentId)) {
      if (m.createdAt > lastActivityTs) lastActivityTs = m.createdAt;
      if (m.type === "discovery") {
        c.discovery.total++;
        if (m.useful === 1) c.discovery.useful++;
      } else if (m.type === "investigation") {
        c.investigation.total++;
        if (m.useful === 1) c.investigation.useful++;
      } else if (m.type === "synthesis") {
        c.synthesis.total++;
        const t = db.getThread(m.threadId);
        if (t && t.resolvedCorrect === 1 && t.conclusionMsgId === m.id) c.synthesis.correct++;
      }
    }
    const rewards = db.listRewards(agent.agentId);
    let totalWei = 0n;
    for (const r of rewards) {
      try {
        totalWei += BigInt(r.amount);
      } catch {
        /* skip malformed */
      }
    }
    res.json({
      found: true,
      address: agent.agentWallet,
      agentId: agent.agentId,
      status: agent.status,
      reputation: agent.reputation,
      contributions: c,
      rewards: {
        totalPang: pangWhole(totalWei.toString()),
        count: rewards.length,
        recent: rewards.slice(0, 6).map((r) => ({ amount: pangWhole(r.amount), reason: r.reason, threadId: r.threadId, ts: r.createdAt })),
      },
      openThreads,
      lastActivityTs,
      now: Math.floor(Date.now() / 1000),
    });
  });

  // ── Public network feed (powers the dashboard "live hive" view) ─────────────────
  // Read-only, CORS-open: already-public, non-sensitive AGGREGATES + thread SUMMARIES + message
  // METADATA only — never investigation content (that stays gated to contributors via getReport).
  // Same posture as /health.
  app.get("/threads", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    const now = Math.floor(Date.now() / 1000);
    const all = intel.listThreads();
    const threads = all.slice(0, 16).map((t) => {
      const msgs = db.listThreadMessages(t.id);
      return {
        id: t.id.replace(/^thread_/, "").slice(0, 10),
        chain: t.chain,
        anomalyType: t.anomalyType,
        contract: t.contractAddress,
        kind: t.kind,
        bounty: t.bounty,
        status: t.status,
        investigations: msgs.filter((m) => m.type === "investigation").length,
        hasSynthesis: !!t.conclusionMsgId,
        conclusion: t.status === "open" ? null : t.conclusion,
        resolvedCorrect: t.resolvedCorrect,
        createdAt: t.createdAt,
        ageSeconds: now - t.createdAt,
      };
    });
    const activity = db.recentMessages(24).map((m) => {
      const t = db.getThread(m.threadId);
      return { type: m.type, anomalyType: t?.anomalyType ?? null, chain: t?.chain ?? null, thread: m.threadId.replace(/^thread_/, "").slice(0, 10), agent: m.agentId.slice(0, 10), ts: m.createdAt };
    });
    res.json({
      now,
      stats: { agents: db.listAgents().length, openThreads: intel.listOpenThreads().length, totalThreads: all.length, resolved: all.filter((t) => t.status !== "open").length },
      threads,
      activity,
    });
  });

  // ── Red-team demo (powers /hack) ────────────────────────────────────────────
  // LIVE but NON-PERSISTING: runs a pasted payload through the REAL strict-schema validator + the
  // safe-consumer reasoning, returns WHERE the attack died (defense-depth), and bumps an aggregate
  // counter — without ever writing a hive thread (so it can't be used to spam the network). Zero
  // idle cost; one cheap in-memory check per attempt; behind the global rate limiter (app.use above).
  app.get("/redteam", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    res.json({ stats: readRedteamStats(db) });
  });
  app.post("/redteam", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    const payload = (typeof req.body?.payload === "string" ? req.body.payload : "").slice(0, 8000);
    if (!payload.trim()) { res.status(400).json({ error: "payload required" }); return; }
    const vector = classifyVector(payload);
    const trimmed = payload.trim();

    // (1) The REAL strict-schema validator. A pasted raw message with off-spec fields dies here; a
    // prose injection embedded as a normal field is schema-VALID — and that's the point: we don't
    // pretend to block text, we make accepted text harmless (layers 2-5).
    let schema: { ok: boolean; error?: string };
    if (trimmed.startsWith("{")) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
      schema = parsed ? validateMessage(parsed) : { ok: false, error: "not valid JSON — rejected before it can be parsed as a message" };
    } else {
      schema = validateMessage({ v: "0", from: "0x0000000000000000000000000000000000000000", nonce: "00000000-0000-4000-8000-000000000000", type: "investigation", task: "thread_demo", body: { investigationType: "Contract Risk Assessment", evidence: payload } });
    }

    // (2) Safe-consumer reasoning: pull any VERIFIABLE on-chain refs; the prose is treated as inert.
    const refs = payload.match(/0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?/g) || [];
    let stoppedAt: string; let depth: number; let detail: string;
    if (!schema.ok) {
      stoppedAt = "schema-boundary"; depth = 1;
      detail = `Rejected at the strict-schema boundary (${schema.error}). Off-spec input never even enters the network.`;
    } else {
      stoppedAt = "inert-data"; depth = 2;
      detail = refs.length
        ? `Accepted as inert DATA — the coordinator validates & scores, it never executes message content. A safe consumer extracts only the ${refs.length} on-chain reference(s) and verifies them itself on-chain; the instruction text is discarded, and a capability-stripped reader holds no keys/tools to act on it anyway. Net effect: nothing.`
        : `Accepted as inert DATA — the coordinator validates & scores, it never executes message content. It carries no verifiable on-chain reference, so a safe consumer has nothing to act on; the instruction text is discarded, capability-stripped. Net effect: nothing.`;
    }
    const layers = [
      { n: 1, name: "Strict schema", caught: !schema.ok, note: "envelope + control fields are a locked allow-list — off-spec is rejected at the boundary" },
      { n: 2, name: "Inert data", caught: schema.ok, note: "the coordinator validates & scores; it never executes message content" },
      { n: 3, name: "Verify, don't trust", caught: false, note: "truth = on-chain facts the consumer re-checks, never a peer's prose" },
      { n: 4, name: "Capability-stripped reader", caught: false, note: "whatever reads untrusted content holds no keys/tools — a fooled reader can't act" },
      { n: 5, name: "Zero blast radius", caught: false, note: "read/append-only surface — worst case is a contribution that scores 0" },
    ];

    const stats = readRedteamStats(db);
    stats.total += 1;
    stats.byVector[vector] = (stats.byVector[vector] || 0) + 1;
    stats.byLayer[stoppedAt] = (stats.byLayer[stoppedAt] || 0) + 1;
    db.setSetting("redteam_stats", JSON.stringify(stats));
    db.audit("redteam", "attempt", { vector, stoppedAt });

    res.json({ vector, stoppedAt, depth, reachedAction: false, detail, layers, stats });
  });

  // ── Admin dashboard (open) ───────────────────────────────────────────────────
  app.get("/admin", (_req, res) => {
    res.sendFile(ADMIN_HTML);
  });

  // ── Admin API guard (header x-admin-key) ─────────────────────────────────────
  const adminGuard: express.RequestHandler = (req, res, next) => {
    const provided = req.headers["x-admin-key"];
    if (typeof provided !== "string" || !safeEqual(provided, adminKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const adminApi = express.Router();
  adminApi.use(adminGuard);

  // reads
  adminApi.get("/agents", (_req, res) => {
    res.json(db.listAgents());
  });
  adminApi.get("/threads", (_req, res) => {
    res.json(intel.listThreads());
  });
  adminApi.get("/rewards", (_req, res) => {
    res.json(db.listRewards());
  });
  adminApi.get("/audit", (_req, res) => {
    res.json(db.listAudit());
  });
  adminApi.get("/thread/:id", (req, res) => {
    const got = intel.getThread(req.params.id);
    if (!got) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    res.json(got);
  });
  // Automated on-chain evidence verification for a thread's discovery (quality aid for scoring).
  // Returns ok:null ("unverified") unless an RPC is configured for the chain (EVIDENCE_RPCS).
  adminApi.get("/verify/:id", async (req, res) => {
    const got = intel.getThread(req.params.id);
    if (!got) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const t = got.thread;
    const evidence = await verifyEvidence(cfg, { chain: t.chain, anomalyType: t.anomalyType, contractAddress: t.contractAddress, txHash: t.txHash, walletAddress: t.walletAddress });
    res.json({ threadId: t.id, evidence });
  });

  // pre-register / manage an agent (OPTIONAL — join is permissionless; agents self-register on
  // first signed login. This endpoint is for pre-seeding, notes, or fixing an agentId mapping.)
  adminApi.post("/agents", async (req, res) => {
    const body = req.body ?? {};
    const owner = typeof body.owner === "string" ? body.owner : "";
    const agentWallet = typeof body.agentWallet === "string" ? body.agentWallet : "";
    const note = typeof body.note === "string" ? body.note : undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^0x[0-9a-fA-F]{40}$/.test(agentWallet)) {
      res.status(400).json({ error: "owner (0x..) and agentWallet (0x..) are required" });
      return;
    }
    // agentId is ALWAYS DERIVED from the wallet (never operator-set), matching self-registration, so
    // the reputation keyspace can't collide with a self-registered agent or an ERC-8004 tokenId.
    const agentId = BigInt(agentWallet).toString();
    const existing = db.getAgentByWallet(agentWallet);
    if (existing && existing.agentId !== agentId) {
      res.status(400).json({ error: "wallet already mapped to a different agentId" });
      return;
    }
    try {
      db.upsertAgent({ agentId, owner, agentWallet, ...(note !== undefined ? { note } : {}) });
      if (chain.mode === "mock") {
        chain.registerMock?.(agentId, owner as `0x${string}`, agentWallet as `0x${string}`);
      }
      db.audit("admin", "agent.upsert", { agentId, owner, agentWallet });
      res.json({ ok: true, agentId });
    } catch (e) {
      log.error("admin agent upsert failed", { err: (e as Error).message });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // score a message
  adminApi.post("/score", async (req, res) => {
    const body = req.body ?? {};
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    const useful = body.useful === true;
    const score = typeof body.score === "number" ? body.score : undefined;
    if (!messageId || typeof body.useful !== "boolean") {
      res.status(400).json({ error: "messageId and boolean useful are required" });
      return;
    }
    try {
      const result = await scoring.scoreMessage(messageId, useful, score);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      db.audit("admin", "message.score", { messageId, useful, score });
      res.json({ ok: true });
    } catch (e) {
      log.error("admin score failed", { err: (e as Error).message });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // resolve a thread's synthesis
  adminApi.post("/resolve", async (req, res) => {
    const body = req.body ?? {};
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const correct = body.correct === true;
    if (!threadId || typeof body.correct !== "boolean") {
      res.status(400).json({ error: "threadId and boolean correct are required" });
      return;
    }
    try {
      const result = await scoring.resolveSynthesis(threadId, correct);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      db.audit("admin", "thread.resolve", { threadId, correct });
      res.json({ ok: true });
    } catch (e) {
      log.error("admin resolve failed", { err: (e as Error).message });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // quarantine / un-quarantine an agent
  adminApi.post("/quarantine", (req, res) => {
    const body = req.body ?? {};
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const on = body.on === true;
    if (!agentId || typeof body.on !== "boolean") {
      res.status(400).json({ error: "agentId and boolean on are required" });
      return;
    }
    // Quarantine is enforced statelessly: verifyToken re-checks agent.status === "active" on EVERY
    // request (login, /mcp open, and each /mcp/messages tool call), so a quarantined agent's next
    // request is rejected. No session store needed.
    db.setAgentStatus(agentId, on ? "quarantined" : "active");
    db.audit("admin", "agent.quarantine", { agentId, on });
    res.json({ ok: true });
  });

  // global kill-switch
  adminApi.post("/killswitch", (req, res) => {
    const on = req.body?.on === true;
    if (typeof req.body?.on !== "boolean") {
      res.status(400).json({ error: "boolean on is required" });
      return;
    }
    killSwitch.engaged = on;
    db.setSetting("killSwitch", on ? "true" : "false"); // persist so it survives a restart
    db.audit("admin", "killswitch", { on });
    log.warn("kill-switch toggled", { engaged: on });
    res.json({ ok: true, engaged: killSwitch.engaged });
  });

  app.use("/admin/api", adminApi);

  // ── Human landing page ───────────────────────────────────────────────────────
  // swarm.wick.pics is an agents-only MCP endpoint, so a browser hitting "/" used
  // to get a bare JSON 404 (and showed up as a "dead site" on sites.wick.pics).
  // Serve an intentional page instead: tell humans what this is and send them to
  // the public Pangle site. Stays noindex via the header middleware above.
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(LANDING_HTML);
  });

  // Quiet, framework-agnostic 404 (no Express "Cannot GET /x" signature leak).
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Uniform JSON error handler — a malformed JSON body (express.json SyntaxError) or any unhandled
  // error returns a JSON shape, never Express's default HTML stack-trace page. No err.message leak.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { type?: string };
    if (e?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    log.error("unhandled request error", { err: (err as Error)?.message });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}
