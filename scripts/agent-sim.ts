/**
 * Pangle agent simulator — a real MCP client used by the e2e smoke + manual demo.
 *
 * Flow for a given viem private key:
 *   1. privateKeyToAccount(privateKey)
 *   2. POST {baseUrl}/auth/challenge {address}      -> { nonce, statement, issuedAt, expiresAt }
 *   3. account.signMessage({ message: statement })  -> signature (signs in with the ERC-8004 key)
 *   4. POST {baseUrl}/auth/verify {address, signature, nonce} -> { token, agentId, scopes, expiresAt }
 *      (token = the agent's own self-signed assertion; no shared secret is involved)
 *   5. open an MCP SSE client to {baseUrl}/mcp with the Authorization: Bearer <token> header
 *   6. run the requested tool steps; each contribution is additionally signed per-message and the
 *      coordinator verifies that signature against the agent's ERC-8004 identity
 *   7. return per-step results, then close the connection.
 *
 * The Bearer header is supplied via the SSEClientTransport `requestInit.headers` option: the SDK
 * merges those headers into BOTH the SSE GET (the stream open) and the per-message POSTs
 * (see node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.js `_commonHeaders`).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { canonicalMessageToSign } from "../src/auth.js";
import type { Message } from "../src/schema.js";
import { randomUUID } from "node:crypto";

/** One scripted MCP tool call. Discriminated on `tool`. */
export type AgentStep =
  | { tool: "contribute"; message: unknown }
  | { tool: "discover" }
  | { tool: "knowledge_read"; threadId?: string }
  | { tool: "coordinator_talk"; action: "report" | "standing"; threadId?: string };

export interface AgentStepResult {
  tool: AgentStep["tool"];
  /** Parsed JSON of the tool's text content (or the raw text if not JSON). */
  result: unknown;
  /** True when the MCP tool returned an error result (e.g. scope violation, submit error). */
  isError: boolean;
}

export interface RunAgentOptions {
  privateKey: `0x${string}`;
  baseUrl: string;
  steps: AgentStep[];
}

export interface RunAgentSuccess {
  ok: true;
  address: `0x${string}`;
  agentId: string;
  token: string;
  scopes: string[];
  results: AgentStepResult[];
}
export interface RunAgentFailure {
  ok: false;
  /** Address derived from the key, when we got that far. */
  address?: `0x${string}`;
  error: string;
}
export type RunAgentResult = RunAgentSuccess | RunAgentFailure;

/** POST JSON helper with robust error messages. */
async function postJson(url: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network error POSTing ${url}: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : text || `HTTP ${res.status}`;
    throw new Error(`${url} -> HTTP ${res.status}: ${detail}`);
  }
  return parsed;
}

/** Extract the first text-content payload from an MCP CallToolResult, parsed as JSON when possible. */
function readToolResult(raw: unknown): { result: unknown; isError: boolean } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const isError = obj.isError === true;
  const content = Array.isArray(obj.content) ? obj.content : [];
  const first = content.find(
    (c): c is { type: string; text: string } =>
      !!c && typeof c === "object" && (c as Record<string, unknown>).type === "text",
  );
  if (!first) return { result: raw, isError };
  try {
    return { result: JSON.parse(first.text), isError };
  } catch {
    return { result: first.text, isError };
  }
}

/** Map a scripted step to the MCP tool name + arguments. */
function toolCallFor(step: AgentStep): { name: string; args: Record<string, unknown> } {
  switch (step.tool) {
    case "contribute":
      return { name: "contribute", args: { message: step.message } };
    case "discover":
      return { name: "discover", args: {} };
    case "knowledge_read":
      return { name: "knowledge_read", args: step.threadId === undefined ? {} : { threadId: step.threadId } };
    case "coordinator_talk":
      return {
        name: "coordinator_talk",
        args: step.threadId === undefined ? { action: step.action } : { action: step.action, threadId: step.threadId },
      };
  }
}

/**
 * Authenticate as the agent owning `privateKey`, open an MCP session, run `steps`, return results.
 * Never throws for routine failures — returns `{ ok: false, error }`.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(opts.privateKey);
  } catch (e) {
    return { ok: false, error: `invalid private key: ${(e as Error).message}` };
  }
  const address: `0x${string}` = account.address;

  // 1) challenge
  let challenge: { nonce: string; statement: string; issuedAt: number };
  try {
    const raw = (await postJson(`${baseUrl}/auth/challenge`, { address })) as Record<string, unknown>;
    if (typeof raw?.nonce !== "string" || typeof raw?.statement !== "string") {
      return { ok: false, address, error: `bad /auth/challenge response: ${JSON.stringify(raw)}` };
    }
    challenge = { nonce: raw.nonce, statement: raw.statement, issuedAt: Number(raw.issuedAt) };
  } catch (e) {
    return { ok: false, address, error: (e as Error).message };
  }

  // 2) sign the human-readable statement (embeds the nonce)
  let signature: `0x${string}`;
  try {
    signature = await account.signMessage({ message: challenge.statement });
  } catch (e) {
    return { ok: false, address, error: `signMessage failed: ${(e as Error).message}` };
  }

  // 3) verify -> self-signed session token (the agent's own assertion; no shared secret)
  let token: string;
  let agentId: string;
  let scopes: string[];
  try {
    const raw = (await postJson(`${baseUrl}/auth/verify`, {
      address,
      signature,
      nonce: challenge.nonce,
    })) as Record<string, unknown>;
    if (typeof raw?.token !== "string") {
      return { ok: false, address, error: `bad /auth/verify response: ${JSON.stringify(raw)}` };
    }
    token = raw.token;
    agentId = typeof raw.agentId === "string" ? raw.agentId : "";
    scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String) : [];
  } catch (e) {
    return { ok: false, address, error: (e as Error).message };
  }

  // 4) open the MCP SSE client with the bearer header on every request.
  const transport = new SSEClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "pangle-agent-sim", version: "0.1.0" }, { capabilities: {} });

  const results: AgentStepResult[] = [];
  try {
    await client.connect(transport);
    for (const step of opts.steps) {
      // Contributions must carry a per-message signature over the canonical message, signed with
      // the agent's ERC-8004 identity key. Attach it before sending (the coordinator verifies it).
      let effectiveStep: AgentStep = step;
      if (step.tool === "contribute") {
        try {
          // Attach a fresh per-message anti-replay nonce (unless the caller set one), then sign.
          const m = step.message as Record<string, unknown>;
          const msgWithNonce = { ...m, nonce: typeof m.nonce === "string" ? m.nonce : randomUUID() } as Message;
          const canonical = canonicalMessageToSign(msgWithNonce);
          const sig = await account.signMessage({ message: canonical });
          effectiveStep = { tool: "contribute", message: { ...msgWithNonce, sig } };
        } catch (e) {
          results.push({ tool: "contribute", result: { error: `signing failed: ${(e as Error).message}` }, isError: true });
          continue;
        }
      }
      const { name, args } = toolCallFor(effectiveStep);
      let raw: unknown;
      try {
        raw = await client.callTool({ name, arguments: args });
      } catch (e) {
        results.push({ tool: step.tool, result: { error: (e as Error).message }, isError: true });
        continue;
      }
      const { result, isError } = readToolResult(raw);
      results.push({ tool: step.tool, result, isError });
    }
  } catch (e) {
    await client.close().catch(() => {});
    return { ok: false, address, error: `MCP connection failed: ${(e as Error).message}` };
  }
  await client.close().catch(() => {});

  return { ok: true, address, agentId, token, scopes, results };
}

// ── CLI demo ──────────────────────────────────────────────────────────────────
// Invoked directly (`npm run agent-sim`): authenticate with a demo key and exercise the
// read-only tools (discover + knowledge_read). Override the key/host via env:
//   PRIVATE_KEY=0x...  BASE_URL=http://localhost:8920  npm run agent-sim
function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return import.meta.url === `file://${entry}` || entry.endsWith("agent-sim.ts");
}

if (isDirectRun()) {
  // anvil account #1 (well-known dev key) by default — only useful once allow-listed by an admin.
  const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const privateKey = (process.env.PRIVATE_KEY ?? DEMO_KEY) as `0x${string}`;
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${config.port}`;

  runAgent({
    privateKey,
    baseUrl,
    steps: [{ tool: "discover" }, { tool: "knowledge_read" }],
  })
    .then((out) => {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      if (!out.ok) process.exitCode = 1;
    })
    .catch((e: unknown) => {
      process.stderr.write(`agent-sim fatal: ${(e as Error).message}\n`);
      process.exitCode = 1;
    });
}
