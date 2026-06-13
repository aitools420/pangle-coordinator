/**
 * Per-connection MCP server over SSE with bearer auth + scope enforcement.
 *
 * Wire contract (see SPEC.md §src/mcp.ts):
 *  - GET  /mcp                       → opens an SSE stream. Requires `Authorization: Bearer <token>`
 *                                      where the token is the agent's self-signed auth assertion
 *                                      (pure off-chain ECDSA, no shared secret — see src/auth.ts). A FRESH
 *                                      McpServer is built per connection, closing over the
 *                                      authenticated SessionClaims so each tool handler knows the
 *                                      caller and can enforce its required MCP scope.
 *  - POST /mcp/messages?sessionId=…  → forwards a client JSON-RPC message to the matching transport.
 *                                      Requires the bearer again.
 *
 * Contributions (Discovery / Investigation / Synthesis) carry a per-message `sig` verified by
 * pure off-chain ECDSA (recovered signer must equal the authenticated caller) before acceptance.
 *
 * Exactly four tools are registered: discover, knowledge_read, contribute, coordinator_talk.
 * A scope/auth failure inside a tool returns an error text content (isError); a missing/invalid
 * token is rejected with HTTP 401 at the transport layer.
 */
import type { RequestHandler, Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Auth, SessionClaims } from "./auth.js";
import type { Intelligence } from "./intelligence.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import type { Logger } from "./telemetry.js";
import { validateMessage, type McpScope } from "./schema.js";

export interface McpDeps {
  auth: Auth;
  intel: Intelligence;
  db: Db;
  cfg: Config;
  log: Logger;
}

/** Endpoint the SSE transport tells clients to POST their messages to. */
const MESSAGE_ENDPOINT = "/mcp/messages";

/**
 * Static description of the exact tool surface, served UNAUTHENTICATED at GET /mcp/tools so a
 * cautious operator's agent can inspect what connecting would expose BEFORE it signs in — this
 * breaks the "you can only learn the tools by connecting" circularity. Every tool is read or
 * append only: none can move funds, take custody, sign/broadcast a transaction, or request a
 * token approval. The `description` strings below are copied VERBATIM from the server.tool(...)
 * registrations in buildServer(), so the published manifest is exactly the advertised surface.
 *
 * KEEP IN SYNC with the four server.tool(...) registrations in buildServer().
 */
export interface ToolManifestEntry {
  name: string;
  description: string;
  scope: McpScope;
  effect: "read" | "append";
  input: Record<string, string>;
}

export const TOOL_DEFS: ToolManifestEntry[] = [
  {
    name: "discover",
    description: "List open intelligence threads to pick up work.",
    scope: "discover",
    effect: "read",
    input: {},
  },
  {
    name: "knowledge_read",
    description: "Read a thread (with messages) or list thread summaries.",
    scope: "knowledge.read",
    effect: "read",
    input: { threadId: "string — OPTIONAL; omit to list all thread summaries" },
  },
  {
    name: "contribute",
    description: "Submit a discovery, investigation, or synthesis message.",
    scope: "contribute",
    effect: "append",
    input: {
      message:
        "object — REQUIRED; a schema-valid, agent-signed Message (discovery | investigation | synthesis). Its `from` must equal your authenticated address and its `sig` is verified by off-chain ECDSA.",
    },
  },
  {
    name: "coordinator_talk",
    description: "Fetch a gated thread report, or your own reputation + rewards standing.",
    scope: "coordinator.talk",
    effect: "read",
    input: {
      action: "enum 'report' | 'standing' — REQUIRED",
      threadId: "string — required only when action = 'report'",
    },
  },
];

/** The unauthenticated, read-only manifest payload served at GET /mcp/tools. */
export function toolManifest() {
  return {
    server: "pangle-coordinator",
    transport:
      "MCP over SSE at /mcp. A bearer token (a fresh, self-signed off-chain ECDSA assertion — no shared secret) is required to OPEN a session and to CALL any tool.",
    readOnly: true,
    note:
      "Published unauthenticated so you can inspect the exact tool surface before connecting. Every tool below is read or append only: none can move funds, take custody, sign or broadcast a transaction, or request a token approval. There is no spend / transaction / approval / exec tool — what you see here is the whole surface.",
    scopes: ["discover", "knowledge.read", "contribute", "coordinator.talk"],
    tools: TOOL_DEFS,
  };
}

/** Shape a successful tool result: a single JSON text content block. */
function ok(result: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** Shape an error tool result: flagged isError, JSON-encoded so clients can parse it. */
function err(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Extract a bearer token from an Authorization header, or null if absent/malformed. */
function bearer(req: Request): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

export function makeMcp(deps: McpDeps): { sseGet: RequestHandler; messagePost: RequestHandler } {
  const { auth, intel, db, log } = deps;

  // Live SSE transports, keyed by their assigned sessionId, bound to the owning session
  // (jti + agentId) so a POST can only be routed by the agent that opened the stream.
  const transports = new Map<string, { transport: SSEServerTransport; jti: string; agentId: string }>();

  /** True iff the authenticated caller holds the given scope. */
  function has(claims: SessionClaims, scope: McpScope): boolean {
    return claims.scopes.includes(scope);
  }

  /** Build a fresh McpServer whose four tools are closed over the authenticated claims. */
  function buildServer(claims: SessionClaims): McpServer {
    const server = new McpServer(
      { name: "pangle-coordinator", version: "0" },
      { capabilities: { tools: {} } },
    );

    // discover (scope `discover`): list OPEN threads = open work to pick up.
    server.tool("discover", "List open intelligence threads to pick up work.", {}, async () => {
      if (!has(claims, "discover")) return err("missing scope: discover");
      const open = intel.listOpenThreads().map((t) => ({
        id: t.id,
        chain: t.chain,
        anomalyType: t.anomalyType,
        contractAddress: t.contractAddress,
        kind: t.kind, // 'anomaly' | 'request' (a directed-delegation bounty thread to fulfil)
        bounty: t.bounty, // $PANG paid to whoever fulfils a request (0 for anomaly threads)
        createdAt: t.createdAt,
      }));
      return ok({ threads: open });
    });

    // knowledge_read (scope `knowledge.read`): one thread (+messages) or all-thread summaries.
    server.tool(
      "knowledge_read",
      "Read a thread (with messages) or list thread summaries.",
      { threadId: z.string().min(1).optional() },
      async (args) => {
        if (!has(claims, "knowledge.read")) return err("missing scope: knowledge.read");
        if (args.threadId !== undefined) {
          const found = intel.getThread(args.threadId);
          if (!found) return err("thread not found");
          return ok(found);
        }
        const summaries = intel.listThreads().map((t) => ({
          id: t.id,
          chain: t.chain,
          anomalyType: t.anomalyType,
          contractAddress: t.contractAddress,
          kind: t.kind,
          bounty: t.bounty,
          status: t.status,
          conclusion: t.conclusion,
          createdAt: t.createdAt,
        }));
        return ok({ threads: summaries });
      },
    );

    // contribute (scope `contribute`): validate a raw Message and submit it.
    server.tool(
      "contribute",
      "Submit a discovery, investigation, or synthesis message.",
      { message: z.unknown() },
      async (args) => {
        if (!has(claims, "contribute")) return err("missing scope: contribute");
        const valid = validateMessage(args.message);
        if (!valid.ok) return err(valid.error);
        // Never trust the client-supplied `from`: it must match the authenticated wallet.
        if (valid.message.from.toLowerCase() !== claims.address.toLowerCase()) {
          return err("message.from does not match authenticated address");
        }
        // The message MUST be signed by the agent's key. Recover the signer (pure off-chain
        // ECDSA, chain-agnostic) and confirm it is the authenticated caller.
        const sigCheck = await auth.verifyMessageSignature(valid.message, claims);
        if (!sigCheck.ok) return err(sigCheck.error);
        const res = intel.submit(claims.agentId, claims.address, valid.message);
        if (!res.ok) return err(res.error);
        return ok({ threadId: res.threadId, messageId: res.messageId });
      },
    );

    // coordinator_talk (scope `coordinator.talk`): gated report, or the agent's standing.
    server.tool(
      "coordinator_talk",
      "Fetch a gated thread report, or your own reputation + rewards standing.",
      { action: z.enum(["report", "standing"]), threadId: z.string().min(1).optional() },
      async (args) => {
        if (!has(claims, "coordinator.talk")) return err("missing scope: coordinator.talk");
        if (args.action === "report") {
          if (args.threadId === undefined) return err("report requires threadId");
          const res = intel.getReport(args.threadId, claims.agentId);
          if (!res.ok) return err(res.error);
          return ok({ report: res.report });
        }
        const agent = db.getAgent(claims.agentId);
        if (!agent) return err("unknown agent");
        return ok({
          agentId: agent.agentId,
          reputation: agent.reputation,
          status: agent.status,
          rewards: db.listRewards(claims.agentId),
        });
      },
    );

    return server;
  }

  const sseGet: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const claims = await auth.verifyToken(token);
    if (!claims) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }

    const transport = new SSEServerTransport(MESSAGE_ENDPOINT, res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, { transport, jti: claims.jti, agentId: claims.agentId });

    transport.onclose = () => {
      transports.delete(sessionId);
      log.info("mcp session closed", { sessionId, agentId: claims.agentId });
    };
    transport.onerror = (e: Error) => {
      log.warn("mcp transport error", { sessionId, agentId: claims.agentId, error: e.message });
    };
    // Express may also fire its own close on the underlying socket.
    res.on("close", () => {
      transports.delete(sessionId);
    });

    const server = buildServer(claims);
    try {
      await server.connect(transport);
      log.info("mcp session open", { sessionId, agentId: claims.agentId });
    } catch (e) {
      transports.delete(sessionId);
      log.error("mcp connect failed", { sessionId, error: (e as Error).message });
      if (!res.headersSent) res.status(500).json({ error: "failed to open mcp session" });
    }
  };

  const messagePost: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const claims = await auth.verifyToken(token);
    if (!claims) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }

    const sid = req.query["sessionId"];
    if (typeof sid !== "string" || sid.length === 0) {
      res.status(400).json({ error: "missing sessionId" });
      return;
    }
    const entry = transports.get(sid);
    if (!entry) {
      res.status(404).json({ error: "no active session for sessionId" });
      return;
    }
    // The POSTer's token MUST own this SSE session. Tool handlers are closed over the
    // session owner's claims, so without this check any active agent could POST to
    // another agent's sessionId and act AS them (impersonation + report/standing leak).
    if (entry.jti !== claims.jti) {
      res.status(403).json({ error: "session does not belong to this token" });
      return;
    }
    await entry.transport.handlePostMessage(req, res, req.body);
  };

  return { sseGet, messagePost };
}
