/** Runtime configuration, loaded from environment with sane local-dev defaults. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env loader (no dependency): populates process.env from a .env file if present.
function loadDotenv(path = ".env"): void {
  const p = resolve(process.cwd(), path);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenv();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

/** Read-only RPC per chain for automated on-chain evidence verification (chain name → URL).
 *  Configured via EVIDENCE_RPCS (a JSON map, e.g. {"Ethereum":"https://…","Base":"https://…"}).
 *  Empty by default → the evidence verifier no-ops ("unverified"). */
function parseEvidenceRpcs(): Record<string, string> {
  try {
    const v = JSON.parse(process.env.EVIDENCE_RPCS ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export type ChainMode = "local" | "mainnet";

export const config = {
  port: Number(process.env.PORT ?? 8920),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Max lifetime of a session auth-assertion (the self-signed bearer token). No secret is
  // involved — authentication is by off-chain ECDSA (EIP-191) signature, verified per request
  // (ERC-8004 is optional and off the auth path). See src/auth.ts.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 1800),
  // Public base URL the MCP server is reached at — the audience baked into the signed login
  // statement (an RFC-8707 resource indicator), so a token can't be replayed against another server.
  mcpResourceUrl: req("MCP_RESOURCE_URL", "http://localhost:8920/mcp"),

  // Settlement (hub) chain only — where $PANG reward mints are written. Reputation is off-chain
  // (cumulative $PANG earned); agent identity + auth are chain-agnostic off-chain ECDSA (src/auth.ts).
  chainMode: (process.env.CHAIN_MODE ?? "local") as ChainMode,
  rpcUrl: req("RPC_URL", "http://127.0.0.1:8545"),
  chainId: Number(process.env.CHAIN_ID ?? 31337),
  coordinatorPrivateKey: req(
    "COORDINATOR_PRIVATE_KEY",
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ) as `0x${string}`,

  identityRegistryAddress: (process.env.IDENTITY_REGISTRY_ADDRESS ?? "") as `0x${string}` | "",
  pangleTokenAddress: (process.env.PANGLE_TOKEN_ADDRESS ?? "") as `0x${string}` | "",

  synthesisWindowHours: Number(process.env.SYNTHESIS_WINDOW_HOURS ?? 48),

  // Mint-rate circuit breaker: max whole $PANG mintable per rolling 24h (0 = no cap). A safety
  // valve against a sybil flood once the token could carry value; a trip refuses the mint, and the
  // contribution stays re-scorable after the window resets (red-team rev 3 — rate-of-issuance cap).
  mintCapPerDay: Number(process.env.MINT_CAP_PER_DAY ?? 100000),
  // Per-AGENT rolling-24h mint cap (whole $PANG; 0 = no cap). Defense-in-depth alongside the global
  // cap: bounds how much any single identity can mint per day, so one farm/compromised key can't
  // drain the global bucket. The quality gates (scoring + evidence) remain the primary sybil defense.
  mintCapPerAgentPerDay: Number(process.env.MINT_CAP_PER_AGENT_PER_DAY ?? 200),
  dbPath: process.env.DB_PATH ?? "./data/pangle.db",

  // Sybil posture: we WELCOME agent swarms — protection is QUALITY-based (coordinator scoring +
  // automated on-chain evidence verification, incl. anomaly-type↔event-log consistency + anti-
  // duplicate rewards), with global + per-agent mint-rate caps as defense-in-depth backstops — NOT a
  // stake-to-join or proof-of-uniqueness barrier. See /design "Sybil posture".
  // Automated on-chain evidence verification: read-only RPC per chain. Empty = verifier no-ops.
  evidenceRpcs: parseEvidenceRpcs(),
} as const;

// Refuse the well-known public anvil dev key on a real chain — it must never own a mainnet coordinator.
const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
if (config.chainMode === "mainnet" && config.coordinatorPrivateKey.toLowerCase() === ANVIL_DEV_KEY) {
  throw new Error(
    "config: refusing the public anvil dev key with CHAIN_MODE=mainnet — set a fresh COORDINATOR_PRIVATE_KEY",
  );
}

export type Config = typeof config;
