// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {PangleToken} from "../src/PangleToken.sol";
import {ReputationAnchor} from "../src/ReputationAnchor.sol";

contract PangleTest is Test {
    IdentityRegistry id;
    PangleToken token;
    ReputationAnchor anchor;

    address coordinator = address(0xC0);
    address operator = address(0xA1);
    address stranger = address(0xBAD);

    function setUp() public {
        id = new IdentityRegistry();
        token = new PangleToken(coordinator);
        anchor = new ReputationAnchor(coordinator);
    }

    // ── IdentityRegistry ──
    function test_register_mints_to_caller_and_defaults_wallet() public {
        vm.prank(operator);
        uint256 agentId = id.register();
        assertEq(id.ownerOf(agentId), operator);
        assertEq(id.getAgentWallet(agentId), operator);
        assertEq(agentId, 1);
    }

    /// Canonical ERC-8004 binding: owner initiates, the NEW wallet must prove control (EIP-712).
    function test_setAgentWallet_requires_owner_and_wallet_consent() public {
        vm.prank(operator);
        uint256 agentId = id.register();

        uint256 newWalletPk = 0xA11CE;
        address newWallet = vm.addr(newWalletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = id.bindingDigest(agentId, newWallet, 0, deadline); // nonce 0 = first bind
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newWalletPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // owner calls + new wallet consented → bound
        vm.prank(operator);
        id.setAgentWallet(agentId, newWallet, deadline, sig);
        assertEq(id.getAgentWallet(agentId), newWallet);

        // replay the SAME consent signature → revert (the per-agent nonce was consumed on the bind)
        vm.prank(operator);
        vm.expectRevert(IdentityRegistry.InvalidWalletSignature.selector);
        id.setAgentWallet(agentId, newWallet, deadline, sig);

        // non-owner caller → revert
        vm.prank(stranger);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        id.setAgentWallet(agentId, newWallet, deadline, sig);

        // signature from a key other than the target wallet → revert (scoped to free stack slots)
        {
            address other = vm.addr(0xC0FFEE);
            bytes32 d2 = id.bindingDigest(agentId, other, 1, deadline); // nonce advanced to 1 after the first bind
            (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(uint256(0xBEEF), d2);
            vm.prank(operator);
            vm.expectRevert(IdentityRegistry.InvalidWalletSignature.selector);
            id.setAgentWallet(agentId, other, deadline, abi.encodePacked(r2, s2, v2));
        }

        // expired deadline → revert
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        vm.expectRevert(IdentityRegistry.BindingExpired.selector);
        id.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    // ── PangleToken ──
    function test_only_owner_mints() public {
        vm.prank(stranger);
        vm.expectRevert();
        token.mint(operator, 1e18);
        vm.prank(coordinator);
        token.mint(operator, 5e18);
        assertEq(token.balanceOf(operator), 5e18);
    }

    function test_mint_reverts_past_cap() public {
        uint256 cap = token.MAX_SUPPLY();
        vm.prank(coordinator);
        token.mint(operator, cap); // exactly the cap is allowed
        assertEq(token.totalSupply(), cap);
        vm.prank(coordinator);
        vm.expectRevert(); // ERC20ExceededCap
        token.mint(operator, 1);
    }

    function test_renounce_ownership_disabled() public {
        vm.expectRevert(PangleToken.RenounceDisabled.selector);
        token.renounceOwnership();
    }

    // ── ReputationAnchor ──
    function test_only_coordinator_sets_score_anyone_reads() public {
        vm.prank(stranger);
        vm.expectRevert(ReputationAnchor.NotCoordinator.selector);
        anchor.setScore(1, 100);

        vm.prank(coordinator);
        anchor.setScore(1, 100);
        assertEq(anchor.scoreOf(1), 100); // public getter — anyone reads
    }

    function test_coordinator_handoff() public {
        vm.prank(coordinator);
        anchor.setCoordinator(operator);
        assertEq(anchor.coordinator(), operator);
        vm.prank(operator);
        anchor.setScore(2, 42);
        assertEq(anchor.scoreOf(2), 42);
    }

    function test_setCoordinator_rejects_zero_address() public {
        vm.prank(coordinator);
        vm.expectRevert(ReputationAnchor.ZeroAddress.selector);
        anchor.setCoordinator(address(0));
        assertEq(anchor.coordinator(), coordinator); // unchanged after revert
    }

    /// Red-team fix: constructor must reject a zero coordinator (else writes are bricked at birth).
    function test_anchor_constructor_rejects_zero_coordinator() public {
        vm.expectRevert(ReputationAnchor.ZeroAddress.selector);
        new ReputationAnchor(address(0));
    }

    /// Red-team fix: token ownership is two-step, so a fat-fingered transfer to an uncontrolled
    /// address can't silently brick mint authority — it never takes effect without acceptOwnership().
    function test_token_ownership_is_two_step() public {
        vm.prank(coordinator);
        token.transferOwnership(operator);
        // pending only — coordinator still the owner/minter until the new owner accepts
        assertEq(token.owner(), coordinator);
        assertEq(token.pendingOwner(), operator);
        // a wrong/uncontrolled address cannot accept → no silent brick
        vm.prank(stranger);
        vm.expectRevert();
        token.acceptOwnership();
        // the intended owner accepts and gains mint authority
        vm.prank(operator);
        token.acceptOwnership();
        assertEq(token.owner(), operator);
        vm.prank(operator);
        token.mint(operator, 1e18);
        assertEq(token.balanceOf(operator), 1e18);
    }
}
