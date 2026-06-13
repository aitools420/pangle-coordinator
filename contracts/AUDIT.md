# Pangle Contracts — Pre-Mainnet Security Review

**Date:** 2026-06-02
**Reviewer:** Internal adversarial red-team (3 independent reviewers + builder verification). NOT a 3rd-party external audit — see "Residual recommendation".
**Scope:** `src/PangleToken.sol`, `src/ReputationAnchor.sol`, `src/IdentityRegistry.sol`, `script/Deploy.s.sol`, and the off-chain coordinator seam (`../src/chain.ts`).
**Stack:** Solidity 0.8.24, OpenZeppelin 5.6.1, Foundry. Target: PulseChain mainnet (chainId 369), **immutable deploy (no proxy/upgrade)**.
**Method:** Three concurrent adversarial reviewers (token+anchor / identity / integration+deploy), each writing throwaway Foundry PoCs to confirm exploitability, then every finding verified against source by the builder. Test suite: 22 passing (incl. 128k-call supply-cap + never-zero-owner/coordinator invariants).

## Verdict

**No Critical or High severity issues.** The contracts are small, idiomatic OZ wrappers. The headline properties are sound and proven:
- **Hard cap is airtight** — `MAX_SUPPLY` is an immutable `ERC20Capped` cap; the only mint path is `mint()`→`onlyOwner`→`_mint`, cap enforced at the exact boundary and across cumulative mints (128k-call invariant).
- **Access control is correct** — mint is `onlyOwner`; `setScore`/`setCoordinator` are `onlyCoordinator`; no unauthorized write path.
- **Signature replay is blocked** — the IdentityRegistry binding digest is bound to agentId + this contract's address + chainId (EIP-712 domain), so it can't be replayed across agentIds, contracts, or chains; signature malleability and bind-to-zero are rejected.
- **No reentrancy** — token `_mint` has no receiver hook; `register()` re-entry can't collide ids.

## Findings & status

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | MEDIUM | `ReputationAnchor` constructor had no zero-address check on `coordinator_` (could brick all writes at deploy; inconsistent with `setCoordinator`'s guard). | **FIXED** — added `if (coordinator_ == address(0)) revert ZeroAddress();` + test `test_anchor_constructor_rejects_zero_coordinator`. |
| 2 | MEDIUM | `ReputationAnchor` NatSpec claimed scores are "keyed by the ERC-8004 agentId so a score travels with the on-chain identity" — now FALSE (auth is off-chain; the coordinator keys by `BigInt(address)`, not the ERC-8004 tokenId). Misleading on an immutable contract + latent cross-keying hazard if the registry is ever wired in. | **FIXED** — corrected the NatSpec to state address-keying + a "do not also key by tokenId" warning. |
| 3 | LOW | `PangleToken` used single-step `Ownable`; a fat-fingered `transferOwnership` to a valid-but-wrong address would irreversibly brick the sole mint authority. | **FIXED** — switched to `Ownable2Step` (new owner must `acceptOwnership()`) + test `test_token_ownership_is_two_step`. `renounceOwnership()` stays disabled. |
| 4 | LOW | `IdentityRegistry.setAgentWallet` binding signature has no nonce → a consent sig is replayable on the same (agentId,newWallet) until `deadline` (incl. after unset / NFT transfer). Bounded: owner-gated, target already consented, and the registry is OPTIONAL / not used for auth. | **RESOLVED in source (undeployed) — 2026-06-04.** A per-agent `bindingNonce` (consumed on every bind, bumped on transfer, folded into `WALLET_BINDING_TYPEHASH`) was added, making each consent single-use and killing pending consent on transfer. Tests `test_setAgentWallet_requires_owner_and_wallet_consent` + `testFuzz_setAgentWallet_consent`. Ships if/when the optional registry is ever deployed. |
| 5 | LOW | `IdentityRegistry.getAgentWallet` returns `address(0)` for never-registered ids (no existence revert) — an off-chain foot-gun. | **DEFERRED + documented in-code** — `@dev` note added; callers must confirm existence via `ownerOf`. |
| 6 | LOW | Single-key blast radius: the deployer becomes sole owner/coordinator of both live contracts (full mint + reputation authority). | **ACCEPTED** (board: single-key until capital justifies) — mitigated by README M5 key-hygiene; `Ownable2Step` (fix #3) now also softens the brick path. |
| 7 | LOW | `Deploy.s.sol` deploys all 3 contracts; on mainnet `IdentityRegistry` would be a dead, self-registerable contract + the substrate for the cross-keying hazard, and populating `IDENTITY_REGISTRY_ADDRESS` silently re-enables identity reads. No `chainId`/key guard; the public anvil key is the documented default. | **DEFERRED to mainnet-deploy** (mainnet on HOLD) — see deploy checklist below. Local deploy intentionally keeps all 3 (e2e needs them). |
| 8 | INFO | `setScore` blind-overwrites (can zero a score with a fresh `updatedAt`); `uint64(block.timestamp)` truncates ~year 2554; no token burn (cap headroom one-way). | **ACCEPTED / by design.** |

## Pre-mainnet deploy checklist (from findings 6/7)
**Update 2026-06-03: items 1–3 are now CODE-ENFORCED in `Deploy.s.sol`** — it `require()`s `chainid ∈ {31337 local, 369 PulseChain}`, refuses the public anvil dev key on mainnet, and gates `IdentityRegistry` behind `DEPLOY_IDENTITY` (default true; set false for the 2-contract mainnet deploy). The operator still supplies a fresh host-only key + `DEPLOY_IDENTITY=false` at run time. (22/22 tests still pass; the local dry-run is unaffected.)

When mainnet is approved (currently HOLD):
1. **Update 2026-06-05: the live deploy is `PangleToken` ONLY.** Reputation is off-chain (cumulative $PANG earned), so `ReputationAnchor` was **not** deployed and `chain.ts` RealChain references only the token; both `ReputationAnchor` and `IdentityRegistry` remain in-repo but **undeployed and out of scope** for the live system. Leave `IDENTITY_REGISTRY_ADDRESS` empty. Only deploy the optional contracts if/when those features are actually offered (the finding-#4 nonce is already implemented in IdentityRegistry source).
2. Use a **fresh host-only coordinator key** — never the public anvil key (`0xac0974…`).
3. Add a `require(block.chainid == 369)` guard (or a dedicated mainnet deploy path) and refuse the anvil key on a non-local chain.
4. After deploy: publish verified source + addresses; transfer/accept ownership only via the 2-step flow.

## Residual recommendation
This was a thorough **internal** adversarial review and the contracts are in good shape. For immutable contracts that will hold value, an **independent 3rd-party audit before mainnet** remains cheap insurance and is recommended — not blocking the Phase-0 anvil dry-run (valueless, no real funds), but advisable before PulseChain mainnet or any token value.
