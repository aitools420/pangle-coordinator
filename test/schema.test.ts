/**
 * Schema validator tests — exercises the closed-vocabulary message schema and the
 * discovery txHash-or-walletAddress refinement. Pure, deterministic, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMessage } from "../src/schema.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);
const WALLET = "0x3333333333333333333333333333333333333333";
const NONCE = "11111111-1111-4111-8111-111111111111"; // a valid uuid

test("valid discovery (with txHash) passes", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "discovery",
    body: {
      chain: "Ethereum",
      anomalyType: "Large Token Transfer",
      contractAddress: CONTRACT,
      txHash: TX,
      timestamp: 1_700_000_000,
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.message.type, "discovery");
});

test("valid discovery (with walletAddress) passes", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "discovery",
    body: {
      chain: "PulseChain",
      anomalyType: "Liquidity Removal",
      contractAddress: CONTRACT,
      walletAddress: WALLET,
      timestamp: 1_700_000_000,
      note: "swept the pool",
    },
  });
  assert.equal(res.ok, true);
});

test("valid investigation passes", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "investigation",
    task: "thread_00000000000000aa",
    body: {
      investigationType: "Liquidity Impact Analysis",
      evidence: "LP removed in a single tx; no relock observed.",
      refs: [TX],
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.message.type, "investigation");
});

test("valid synthesis passes", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "synthesis",
    task: "thread_00000000000000aa",
    body: { conclusion: "High Risk", rationale: "rug pattern" },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.message.type, "synthesis");
});

test("bad enum is rejected", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "discovery",
    body: {
      chain: "Ethereum",
      anomalyType: "Not A Real Anomaly",
      contractAddress: CONTRACT,
      txHash: TX,
      timestamp: 1_700_000_000,
    },
  });
  assert.equal(res.ok, false);
});

test("unknown field is rejected (strict)", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "synthesis",
    task: "thread_00000000000000aa",
    body: { conclusion: "High Risk" },
    extra: "nope",
  });
  assert.equal(res.ok, false);
});

test("discovery missing both txHash and walletAddress is rejected", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: NONCE,
    type: "discovery",
    body: {
      chain: "Ethereum",
      anomalyType: "Large Token Transfer",
      contractAddress: CONTRACT,
      timestamp: 1_700_000_000,
    },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /txHash|walletAddress/);
});

test("missing nonce is rejected (anti-replay nonce is required)", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    type: "synthesis",
    task: "thread_00000000000000aa",
    body: { conclusion: "High Risk" },
  });
  assert.equal(res.ok, false);
});

test("non-uuid nonce is rejected", () => {
  const res = validateMessage({
    v: "0",
    from: ADDR,
    nonce: "not-a-uuid",
    type: "synthesis",
    task: "thread_00000000000000aa",
    body: { conclusion: "High Risk" },
  });
  assert.equal(res.ok, false);
});
