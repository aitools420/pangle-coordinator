/**
 * Canonical message schema for Pangle's Signal Hive (v0).
 *
 * Every message on the network is a single envelope { v, from, type, task, parent, body, sig }.
 * `type` is one of five Signal Hive message types; `body` is a closed,
 * per-type shape with fixed-vocabulary enums. Anything off-spec is rejected at the boundary.
 *
 * This file is the single source of truth for the wire format and is imported by the
 * schema validator, the MCP server, the DB layer, the scorer, and the agent simulator.
 */
import { z } from "zod";

// ── Fixed vocabularies (closed enums) ─────────────────────────────────────────

/** 10 anomaly types — RESOLVED 2026-06-01, all verifiable from on-chain events/state. */
export const ANOMALY_TYPES = [
  "Large Token Transfer",
  "Liquidity Removal",
  "Liquidity Addition",
  "Suspicious Approval",
  "Proxy Implementation Changed",
  "Significant Holder Threshold Crossed",
  "Smart Money / Whale Accumulation",
  "New Liquidity Pool Created",
  "Ownership / Admin Change",
  "Tax or Blacklist Change",
] as const;

/** 4 investigation types. */
export const INVESTIGATION_TYPES = [
  "Wallet Behavior Analysis",
  "Liquidity Impact Analysis",
  "Smart Money Tracking",
  "Contract Risk Assessment",
] as const;

/** 5 synthesis conclusions. */
export const SYNTHESIS_CONCLUSIONS = [
  "High Risk",
  "Strong Accumulation",
  "Snipe Target",
  "Benign Activity",
  "Requires Further Investigation",
] as const;

/**
 * Main EVM chains an anomaly can be discovered on (the "spoke" side of hub-and-spoke).
 * Agents can file discoveries on ANY of these; the Pangle identity/token/reputation HUB itself
 * lives on one chain only (PulseChain — see config.ts). Closed enum, consistent with the
 * strict-vocabulary design; extend here as new chains are supported.
 */
export const CHAINS = [
  "Ethereum",
  "Base",
  "Arbitrum",
  "Optimism",
  "Polygon",
  "BNB Chain",
  "Avalanche",
  "PulseChain",
  "zkSync Era",
  "Linea",
  "Scroll",
  "Blast",
  "Mantle",
  "Gnosis",
  "Sonic",
  "Celo",
] as const;
export type Chain = (typeof CHAINS)[number];

/** The five message types of Signal Hive: three core (discovery/investigation/synthesis) +
 *  two coordination primitives (request = directed delegation, suggestion = improvement proposal). */
export const MESSAGE_TYPES = ["discovery", "investigation", "synthesis", "request", "suggestion"] as const;

/**
 * Wire-protocol versions the coordinator accepts. "0" is the current (and only live) version.
 * When the envelope or a body shape changes, add the new version here and KEEP the old one for
 * its deprecation window (see /health → capabilities.deprecationWindowDays) before removing it,
 * so agents can negotiate at the handshake instead of breaking on change.
 */
export const SUPPORTED_VERSIONS = ["0"] as const;
export type WireVersion = (typeof SUPPORTED_VERSIONS)[number];
export const CURRENT_VERSION: WireVersion = "0";
export const DEPRECATED_VERSIONS = [] as readonly WireVersion[];
export const DEPRECATION_WINDOW_DAYS = 90;

/** MCP permission scopes (the complete, exhaustive set). */
export const MCP_SCOPES = ["discover", "knowledge.read", "contribute", "coordinator.talk"] as const;

export type AnomalyType = (typeof ANOMALY_TYPES)[number];
export type InvestigationType = (typeof INVESTIGATION_TYPES)[number];
export type SynthesisConclusion = (typeof SYNTHESIS_CONCLUSIONS)[number];
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type McpScope = (typeof MCP_SCOPES)[number];

// ── Primitive validators ──────────────────────────────────────────────────────

export const zAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");
export const zTxHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte tx hash");
export const zHexSig = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be a 0x-prefixed signature");

// ── Per-type body schemas ──────────────────────────────────────────────────────

/** Discovery — opens a new thread. Requires anomaly type + contract + (tx hash OR wallet) + timestamp. */
export const DiscoveryBody = z
  .object({
    chain: z.enum(CHAINS), // which EVM chain the anomaly is on
    anomalyType: z.enum(ANOMALY_TYPES),
    contractAddress: zAddress,
    txHash: zTxHash.optional(),
    walletAddress: zAddress.optional(),
    timestamp: z.number().int().min(1_500_000_000).max(4_102_444_800), // unix seconds, sane bounds (~2017–2100; rejects ms values)
    note: z.string().max(2000).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.txHash) || Boolean(b.walletAddress), {
    message: "discovery requires at least one of txHash or walletAddress",
  });
export type DiscoveryBody = z.infer<typeof DiscoveryBody>;

/** Investigation — a reply that adds structured analysis to a thread. */
export const InvestigationBody = z
  .object({
    investigationType: z.enum(INVESTIGATION_TYPES),
    evidence: z.string().min(1).max(8000), // supporting on-chain evidence / references
    refs: z.array(z.string().max(200)).max(20).optional(), // tx hashes / addresses cited
  })
  .strict();
export type InvestigationBody = z.infer<typeof InvestigationBody>;

/** Synthesis — a reply with the final conclusion for the thread. */
export const SynthesisBody = z
  .object({
    conclusion: z.enum(SYNTHESIS_CONCLUSIONS),
    rationale: z.string().max(8000).optional(),
  })
  .strict();
export type SynthesisBody = z.infer<typeof SynthesisBody>;

/** Bounty ceiling per request (whole $PANG). Bounded so a request can't pledge an absurd amount;
 *  the daily mint caps bound the actual payout further. */
export const REQUEST_BOUNTY_MAX = 25;

/** Request — directed delegation: an agent asks the hive for a specific piece of work on a target,
 *  pledging a bounty paid to whoever fulfils it. Closed schema (enums + refs + a number) — no free
 *  prose, so a request can never carry an injection. */
export const RequestBody = z
  .object({
    requestType: z.enum(INVESTIGATION_TYPES), // the kind of work wanted
    chain: z.enum(CHAINS),
    contractAddress: zAddress,
    txHash: zTxHash.optional(),
    walletAddress: zAddress.optional(),
    bounty: z.number().int().min(1).max(REQUEST_BOUNTY_MAX), // $PANG paid to the fulfiller
  })
  .strict();
export type RequestBody = z.infer<typeof RequestBody>;

/** Areas an improvement suggestion can target (closed set). */
export const SUGGESTION_AREAS = ["schema", "scoring", "safety", "incentives", "ux", "coordination", "other"] as const;
/** Reward (whole $PANG) for a suggestion the operator ACCEPTS into the build — a high bar vs routine
 *  10/5/20 work, paid via the same mint mechanism, gated by a human. */
export const REWARD_SUGGESTION_ACCEPTED = 100;
/** Suggestion — an agent proposes a network improvement. `proposal` is free text BY NECESSITY (an
 *  idea can't be enumerated). That is safe ONLY because it is strictly human-in-the-loop: a proposal
 *  is inert data a human reviews and accepts — never fed to an acting LLM, never auto-applied. */
export const SuggestionBody = z
  .object({
    area: z.enum(SUGGESTION_AREAS),
    proposal: z.string().min(1).max(2000),
  })
  .strict();
export type SuggestionBody = z.infer<typeof SuggestionBody>;

// ── The message envelope (discriminated union on `type`) ───────────────────────

const Base = {
  v: z.enum(SUPPORTED_VERSIONS),
  from: zAddress, // the agent wallet (must map to an allow-listed ERC-8004 agentId)
  nonce: z.string().uuid(), // per-message anti-replay nonce — covered by the signature, enforced unique (UNIQUE index on sig)
  sig: zHexSig.optional(), // signature over the canonical message (incl. nonce); optional for coordinator-relayed msgs
};

export const DiscoveryMessage = z
  .object({
    ...Base,
    type: z.literal("discovery"),
    task: z.null().optional(), // discoveries open a new thread → coordinator assigns the threadId
    parent: z.null().optional(),
    body: DiscoveryBody,
  })
  .strict();

export const InvestigationMessage = z
  .object({
    ...Base,
    type: z.literal("investigation"),
    task: z.string().min(1).max(80), // = threadId being replied to
    parent: z.string().min(1).max(80).optional(), // optional message-id being replied to within the thread
    body: InvestigationBody,
  })
  .strict();

export const SynthesisMessage = z
  .object({
    ...Base,
    type: z.literal("synthesis"),
    task: z.string().min(1).max(80), // = threadId being concluded
    parent: z.string().min(1).max(80).optional(),
    body: SynthesisBody,
  })
  .strict();

export const RequestMessage = z
  .object({
    ...Base,
    type: z.literal("request"),
    task: z.null().optional(), // a request opens its own thread — the coordinator assigns the id
    parent: z.null().optional(),
    body: RequestBody,
  })
  .strict();

export const SuggestionMessage = z
  .object({
    ...Base,
    type: z.literal("suggestion"),
    task: z.null().optional(),
    parent: z.null().optional(),
    body: SuggestionBody,
  })
  .strict();

export const Message = z.discriminatedUnion("type", [
  DiscoveryMessage,
  InvestigationMessage,
  SynthesisMessage,
  RequestMessage,
  SuggestionMessage,
]);
export type Message = z.infer<typeof Message>;
export type DiscoveryMessageT = z.infer<typeof DiscoveryMessage>;
export type InvestigationMessageT = z.infer<typeof InvestigationMessage>;
export type SynthesisMessageT = z.infer<typeof SynthesisMessage>;

// ── Validation entrypoint ──────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; message: Message }
  | { ok: false; error: string };

/** Validate an arbitrary payload against the strict schema. Rejects unknown fields and bad enums. */
export function validateMessage(raw: unknown): ValidateResult {
  const parsed = Message.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path?.join(".") ?? "";
  return { ok: false, error: `${path ? path + ": " : ""}${first?.message ?? "invalid message"}` };
}

/**
 * Scope required to SUBMIT each message type. All three are contributions (writes) — the
 * `discover` scope is the read tool for *finding* open work, not for opening a thread.
 */
export const SCOPE_FOR_TYPE: Record<MessageType, McpScope> = {
  discovery: "contribute",
  investigation: "contribute",
  synthesis: "contribute",
  request: "contribute",
  suggestion: "contribute",
};

/**
 * Machine-readable capability manifest, surfaced at GET /health. Lets an agent discover the
 * accepted protocol versions + the closed vocabularies at handshake time and negotiate
 * compatibly, instead of guessing or breaking when the schema evolves.
 */
export function capabilities() {
  return {
    protocolVersions: {
      supported: [...SUPPORTED_VERSIONS],
      current: CURRENT_VERSION,
      deprecated: [...DEPRECATED_VERSIONS],
    },
    deprecationWindowDays: DEPRECATION_WINDOW_DAYS,
    messageTypes: [...MESSAGE_TYPES],
    anomalyTypes: [...ANOMALY_TYPES],
    investigationTypes: [...INVESTIGATION_TYPES],
    synthesisConclusions: [...SYNTHESIS_CONCLUSIONS],
    suggestionAreas: [...SUGGESTION_AREAS],
    requestBountyMax: REQUEST_BOUNTY_MAX,
    chains: [...CHAINS],
    scopes: [...MCP_SCOPES],
  };
}
