/**
 * scripts/e2e-smoke.ts — end-to-end acceptance for the Pangle coordinator MVP.
 *
 * Assumes the coordinator is ALREADY running (the runner / npm run deploy:local starts it)
 * at process.env.BASE_URL or http://localhost:8920, with admin key ADMIN_KEY or "dev-admin".
 *
 * Flow exercised (the full Signal Hive flow):
 *   1. Onboard two agents (admin API) — owner == agentWallet == their derived address.
 *      In mock mode the admin endpoint also registers them on the MockChain.
 *   2. agent1 contributes a discovery  → opens a thread (capture threadId).
 *   3. agent2 contributes an investigation on that thread.
 *   4. agent1 contributes a synthesis ("High Risk") on that thread.
 *   5. Admin scores the discovery + investigation useful (POST /admin/api/score).
 *   6. Admin resolves the synthesis correct (POST /admin/api/resolve).
 *   7. Assert: thread resolved correct; rewards exist for BOTH agents; a contributor
 *      (agent2) CAN fetch the report via coordinator_talk while a non-contributor CANNOT.
 *
 * Prints clear PASS/FAIL lines; exits nonzero on any failure.
 *
 * The anvil private keys below are the standard, public anvil test keys (accounts #1 / #2 of
 * the well-known mnemonic). They are intentionally hardcoded — local test fixtures only.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { runAgent, type AgentStep } from "./agent-sim.js";

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8920").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? "dev-admin";

// Standard anvil mnemonic accounts #1 and #2 (public well-known test keys — local only).
const PK1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PK2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const account1 = privateKeyToAccount(PK1);
const account2 = privateKeyToAccount(PK2);
const addr1 = account1.address; // 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
const addr2 = account2.address; // 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

// agentId is always derived from the wallet (coordinator self-register + admin pre-register both use
// BigInt(address)) — so the expected ids here derive from the agent addresses, not "1"/"2".
const AGENT1_ID = BigInt(addr1).toString();
const AGENT2_ID = BigInt(addr2).toString();

// A third key that is NEVER onboarded / never contributes — used to prove report gating.
const PK_OUTSIDER = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const accountOutsider = privateKeyToAccount(PK_OUTSIDER);

// Discovery fixture (chain Ethereum, Liquidity Removal, with a contract + tx hash + timestamp).
const CONTRACT = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // arbitrary checksummed test contract
const TXHASH = "0x" + "ab".repeat(32);
const nowSec = Math.floor(Date.now() / 1000);

// ── runAgent shape (boundary type) ──────────────────────────────────────────────
// scripts/agent-sim.ts is owned by another module; the SPEC leaves runAgent's `steps`/return
// loosely specified ("Array<...>"/"Promise<...>"). We model the natural contract structurally
// (steps = {tool,args}; result carries an ordered list of parsed tool outputs) and validate
// every returned shape at runtime so this smoke test never trusts an under-specified type.
type Step = AgentStep;
type RunAgentFn = (opts: {
  privateKey: Hex;
  baseUrl: string;
  steps: Step[];
}) => Promise<unknown>;

const run = runAgent as unknown as RunAgentFn;

// ── Tiny assertion + reporting harness ────────────────────────────────────────
let failed = 0;
function pass(label: string): void {
  console.log(`PASS: ${label}`);
}
function fail(label: string, detail?: unknown): void {
  failed++;
  console.log(`FAIL: ${label}${detail !== undefined ? ` — ${stringify(detail)}` : ""}`);
}
function check(cond: boolean, label: string, detail?: unknown): boolean {
  if (cond) pass(label);
  else fail(label, detail);
  return cond;
}
function stringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * runAgent's return is under-specified across implementations. Walk whatever it returns
 * (object, array, or nested {results:[...]}) and collect every plausible tool-output object,
 * then pull a field by name from the first object that has it. This keeps the smoke test
 * resilient to the agent-sim builder's exact return wrapper.
 */
function collectObjects(v: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === "string") {
    // Tool results are JSON-encoded text per the MCP contract; try to parse.
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return collectObjects(JSON.parse(t), out, depth + 1);
      } catch {
        return out;
      }
    }
    return out;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectObjects(item, out, depth + 1);
    return out;
  }
  if (isObj(v)) {
    out.push(v);
    for (const key of Object.keys(v)) collectObjects(v[key], out, depth + 1);
  }
  return out;
}

function findField(result: unknown, field: string): unknown {
  for (const obj of collectObjects(result)) {
    if (Object.prototype.hasOwnProperty.call(obj, field) && obj[field] !== undefined && obj[field] !== null) {
      return obj[field];
    }
  }
  return undefined;
}

// ── Admin HTTP helpers ────────────────────────────────────────────────────────
async function adminPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function adminGet(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { "x-admin-key": ADMIN_KEY } });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const j = (await res.json()) as { ok?: boolean };
        if (j && j.ok) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`=== Pangle e2e smoke (BASE_URL=${BASE_URL}) ===`);
  console.log(`agent1=${addr1} (id ${AGENT1_ID})  agent2=${addr2} (id ${AGENT2_ID})  outsider=${accountOutsider.address}`);

  // 0. coordinator reachable
  const healthy = await waitForHealth();
  if (!check(healthy, "coordinator /health is up")) {
    finish();
    return;
  }

  // 1. Onboard both agents (owner == agentWallet == derived address; mock mode registers them).
  const ob1 = await adminPost("/admin/api/agents", { agentId: AGENT1_ID, owner: addr1, agentWallet: addr1, note: "e2e agent1" });
  check(ob1.status >= 200 && ob1.status < 300, "onboard agent1 (200)", ob1);
  const ob2 = await adminPost("/admin/api/agents", { agentId: AGENT2_ID, owner: addr2, agentWallet: addr2, note: "e2e agent2" });
  check(ob2.status >= 200 && ob2.status < 300, "onboard agent2 (200)", ob2);

  // 2. agent1 → discovery (opens a thread)
  const discoveryMsg = {
    v: "0",
    from: addr1,
    type: "discovery",
    body: {
      chain: "Ethereum",
      anomalyType: "Liquidity Removal",
      contractAddress: CONTRACT,
      txHash: TXHASH,
      timestamp: nowSec,
      note: "e2e: large LP pull detected",
    },
  };
  const r1 = await run({
    privateKey: PK1,
    baseUrl: BASE_URL,
    steps: [{ tool: "contribute", message: discoveryMsg }],
  });
  const threadId = findField(r1, "threadId");
  const discoveryMsgId = findField(r1, "messageId");
  const haveThread =
    check(typeof threadId === "string" && (threadId as string).length > 0, "agent1 discovery opened a thread (threadId returned)", r1) &&
    check(typeof discoveryMsgId === "string" && (discoveryMsgId as string).length > 0, "agent1 discovery returned a messageId", r1);
  if (!haveThread) {
    finish();
    return;
  }
  const tId = threadId as string;
  const discMsgId = discoveryMsgId as string;
  console.log(`  → threadId=${tId}  discoveryMsgId=${discMsgId}`);

  // 3. agent2 → investigation on that thread
  const investigationMsg = {
    v: "0",
    from: addr2,
    type: "investigation",
    task: tId,
    body: {
      investigationType: "Liquidity Impact Analysis",
      evidence: "e2e: 92% of pool liquidity removed in a single tx; remaining reserves negligible.",
      refs: [TXHASH],
    },
  };
  const r2 = await run({
    privateKey: PK2,
    baseUrl: BASE_URL,
    steps: [{ tool: "contribute", message: investigationMsg }],
  });
  const investMsgId = findField(r2, "messageId");
  check(typeof investMsgId === "string" && (investMsgId as string).length > 0, "agent2 investigation accepted (messageId returned)", r2);

  // 4. agent1 → synthesis ("High Risk") on that thread
  const synthesisMsg = {
    v: "0",
    from: addr1,
    type: "synthesis",
    task: tId,
    body: {
      conclusion: "High Risk",
      rationale: "e2e: liquidity rug pattern confirmed by the investigation.",
    },
  };
  const r3 = await run({
    privateKey: PK1,
    baseUrl: BASE_URL,
    steps: [{ tool: "contribute", message: synthesisMsg }],
  });
  const synthMsgId = findField(r3, "messageId");
  check(typeof synthMsgId === "string" && (synthMsgId as string).length > 0, "agent1 synthesis accepted (messageId returned)", r3);

  // 5. Admin scores discovery + investigation useful
  const s1 = await adminPost("/admin/api/score", { messageId: discMsgId, useful: true });
  check(s1.status >= 200 && s1.status < 300, "admin scored discovery useful", s1);
  if (typeof investMsgId === "string") {
    const s2 = await adminPost("/admin/api/score", { messageId: investMsgId, useful: true });
    check(s2.status >= 200 && s2.status < 300, "admin scored investigation useful", s2);
  } else {
    fail("admin scored investigation useful", "missing investigation messageId");
  }

  // 6. Admin resolves the synthesis correct
  const resv = await adminPost("/admin/api/resolve", { threadId: tId, correct: true });
  check(resv.status >= 200 && resv.status < 300, "admin resolved synthesis correct (200)", resv);

  // 7a. Assert thread resolved correct (admin view)
  const threadView = await adminGet(`/admin/api/thread/${tId}`);
  const tStatus = findField(threadView.json, "status");
  const tResolvedCorrect = findField(threadView.json, "resolvedCorrect");
  check(tStatus === "resolved", "thread status == resolved", threadView.json);
  check(
    tResolvedCorrect === 1 || tResolvedCorrect === true,
    "thread resolvedCorrect == true",
    { resolvedCorrect: tResolvedCorrect },
  );

  // 7b. Assert rewards exist for BOTH agents
  const rewardsView = await adminGet(`/admin/api/rewards`);
  const rewardRows = collectObjects(rewardsView.json).filter(
    (o) => typeof o["agentId"] === "string" && (o["amount"] !== undefined || o["reason"] !== undefined),
  );
  const agentIdsWithReward = new Set(rewardRows.map((o) => String(o["agentId"])));
  check(agentIdsWithReward.has(AGENT1_ID), "reward exists for agent1", [...agentIdsWithReward]);
  check(agentIdsWithReward.has(AGENT2_ID), "reward exists for agent2", [...agentIdsWithReward]);

  // 7c. Gating — a CONTRIBUTOR (agent2) can get the report via coordinator_talk.
  const repContrib = await run({
    privateKey: PK2,
    baseUrl: BASE_URL,
    steps: [{ tool: "coordinator_talk", action: "report", threadId: tId }],
  });
  const contributorReport = findField(repContrib, "report");
  const contributorErr = findField(repContrib, "error");
  check(
    contributorReport !== undefined && contributorErr === undefined,
    "contributor (agent2) CAN read the gated report",
    repContrib,
  );

  // 7d. Gating — a NON-contributor cannot. The outsider is not allow-listed, so login itself
  //     must fail (the strongest possible denial). If for any reason the runner pre-onboards
  //     it, we still require the report call to be denied with an error.
  let outsiderDenied = false;
  let outsiderDetail: unknown;
  try {
    const repOutsider = await run({
      privateKey: PK_OUTSIDER,
      baseUrl: BASE_URL,
      steps: [{ tool: "coordinator_talk", action: "report", threadId: tId }],
    });
    const outReport = findField(repOutsider, "report");
    const outErr = findField(repOutsider, "error");
    outsiderDenied = outReport === undefined || outErr !== undefined;
    outsiderDetail = repOutsider;
  } catch (e) {
    // Most likely: /auth/verify rejects a non-allow-listed agent → runAgent throws. That is a denial.
    outsiderDenied = true;
    outsiderDetail = (e as Error).message;
  }
  check(outsiderDenied, "non-contributor is DENIED the gated report", outsiderDetail);

  finish();
}

function finish(): never {
  console.log("===========================================");
  if (failed === 0) {
    console.log("E2E RESULT: PASS");
    process.exit(0);
  }
  console.log(`E2E RESULT: FAIL (${failed} check(s) failed)`);
  process.exit(1);
}

main().catch((e) => {
  fail("uncaught error", (e as Error)?.stack ?? String(e));
  finish();
});
