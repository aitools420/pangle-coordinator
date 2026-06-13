import { test } from "node:test";
import assert from "node:assert/strict";
import { eventTopic0, expectedTopicsFor } from "../src/evidence.js";

test("eventTopic0 computes the canonical event topic0s (keccak of the signature)", () => {
  assert.equal(
    eventTopic0("Transfer(address,address,uint256)").toLowerCase(),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  assert.equal(
    eventTopic0("Approval(address,address,uint256)").toLowerCase(),
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  );
  assert.equal(
    eventTopic0("OwnershipTransferred(address,address)").toLowerCase(),
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  );
});

test("expectedTopicsFor maps event-anchored anomalies and leaves state-based ones unverified", () => {
  const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const large = expectedTopicsFor("Large Token Transfer");
  assert.ok(large && large.has(transfer), "Large Token Transfer should expect a Transfer log");

  const liq = expectedTopicsFor("Liquidity Removal");
  assert.ok(liq && liq.size >= 2, "Liquidity Removal should expect Burn/Sync logs");

  // state-based anomaly with no standard event → null (so the gate never blocks it)
  assert.equal(expectedTopicsFor("Tax or Blacklist Change"), null);
  // unknown / undefined → null (never blocks)
  assert.equal(expectedTopicsFor(undefined), null);
  assert.equal(expectedTopicsFor("not a real anomaly type"), null);
});

import { ANOMALY_TYPES } from "../src/schema.js";

test("expectedTopicsFor covers every event-anchored anomaly type; state-based ones map to null", () => {
  const STATE_BASED = new Set(["Tax or Blacklist Change"]); // no universal event → unverified (never blocks)
  for (const t of ANOMALY_TYPES) {
    const got = expectedTopicsFor(t);
    if (STATE_BASED.has(t)) {
      assert.equal(got, null, `${t} should be unverified (null), not blockable`);
    } else {
      assert.ok(got && got.size > 0, `${t} should map to a non-empty expected-topic set`);
    }
  }
});
