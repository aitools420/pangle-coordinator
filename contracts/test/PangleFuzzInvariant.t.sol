// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {PangleToken} from "../src/PangleToken.sol";
import {ReputationAnchor} from "../src/ReputationAnchor.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

// ════════════════════════════ Fuzz tests ════════════════════════════
contract PangleFuzzTest is Test {
    IdentityRegistry id;
    PangleToken token;
    ReputationAnchor anchor;
    address coordinator = address(0xC0);

    function setUp() public {
        id = new IdentityRegistry();
        token = new PangleToken(coordinator);
        anchor = new ReputationAnchor(coordinator);
    }

    // Token: any single mint within the cap succeeds and never breaches the cap.
    function testFuzz_mint_within_cap(address to, uint256 amount) public {
        vm.assume(to != address(0));
        vm.assume(to.code.length == 0); // _mint has no callback, but keep recipients simple
        amount = bound(amount, 0, token.MAX_SUPPLY());
        vm.prank(coordinator);
        token.mint(to, amount);
        assertEq(token.balanceOf(to), amount);
        assertLe(token.totalSupply(), token.MAX_SUPPLY());
    }

    // Token: a mint that would exceed the cap always reverts.
    function testFuzz_mint_over_cap_reverts(uint256 amount) public {
        amount = bound(amount, token.MAX_SUPPLY() + 1, type(uint256).max);
        vm.prank(coordinator);
        vm.expectRevert(); // ERC20ExceededCap
        token.mint(address(0xBEEF), amount);
    }

    // Token: only the owner (coordinator) can mint, for ANY other caller.
    function testFuzz_only_owner_mints(address caller, uint256 amount) public {
        vm.assume(caller != coordinator);
        amount = bound(amount, 1, token.MAX_SUPPLY());
        vm.prank(caller);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        token.mint(caller, amount);
    }

    // Anchor: the coordinator can set any (agentId, score); it persists with a timestamp.
    function testFuzz_setScore(uint256 agentId, uint256 score, uint64 ts) public {
        vm.warp(ts);
        vm.prank(coordinator);
        anchor.setScore(agentId, score);
        assertEq(anchor.scoreOf(agentId), score);
        assertEq(anchor.updatedAt(agentId), ts);
    }

    // Anchor: ANY non-coordinator caller is rejected.
    function testFuzz_setScore_only_coordinator(address caller, uint256 agentId, uint256 score) public {
        vm.assume(caller != coordinator);
        vm.prank(caller);
        vm.expectRevert(ReputationAnchor.NotCoordinator.selector);
        anchor.setScore(agentId, score);
    }

    // Identity: register always mints to the caller, with sequential ids and wallet defaulting to owner.
    function testFuzz_register(address a, address b) public {
        vm.assume(a != address(0) && b != address(0));
        vm.assume(a.code.length == 0 && b.code.length == 0); // EOAs: _safeMint won't invoke a receiver hook
        vm.prank(a);
        uint256 id1 = id.register();
        vm.prank(b);
        uint256 id2 = id.register();
        assertEq(id.ownerOf(id1), a);
        assertEq(id.ownerOf(id2), b);
        assertEq(id2, id1 + 1);
        assertEq(id.getAgentWallet(id1), a);
    }

    // Identity: only the EXACT newWallet's signature binds; a signature from any other key reverts.
    function testFuzz_setAgentWallet_consent(uint256 walletPk, uint256 wrongPk) public {
        walletPk = bound(walletPk, 1, type(uint128).max);
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(walletPk != wrongPk);
        address owner = address(0xA1);
        vm.prank(owner);
        uint256 agentId = id.register();

        address newWallet = vm.addr(walletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = id.bindingDigest(agentId, newWallet, 0, deadline); // nonce 0 = first bind

        // correct signature from newWallet → binds
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletPk, digest);
        vm.prank(owner);
        id.setAgentWallet(agentId, newWallet, deadline, abi.encodePacked(r, s, v));
        assertEq(id.getAgentWallet(agentId), newWallet);

        // a signature over the same digest but from the wrong key → reverts
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(wrongPk, digest);
        vm.prank(owner);
        vm.expectRevert(IdentityRegistry.InvalidWalletSignature.selector);
        id.setAgentWallet(agentId, newWallet, deadline, abi.encodePacked(r2, s2, v2));
    }
}

// ═══════════ Invariant: token supply can never exceed the hard cap ═══════════
contract TokenMintHandler is Test {
    PangleToken public token;
    address public coordinator;

    constructor(PangleToken t, address c) {
        token = t;
        coordinator = c;
    }

    // Mint a fuzzed amount to a fuzzed recipient as the coordinator. Over-cap mints revert (caught),
    // so the handler can never push supply past the cap — exactly what the invariant asserts.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) to = address(0xBEEF);
        if (to.code.length != 0) to = address(0xBEEF);
        amount = bound(amount, 0, token.MAX_SUPPLY());
        vm.prank(coordinator);
        try token.mint(to, amount) {} catch {}
    }
}

contract PangleTokenInvariant is StdInvariant, Test {
    PangleToken token;
    TokenMintHandler handler;
    address coordinator = address(0xC0);

    function setUp() public {
        token = new PangleToken(coordinator);
        handler = new TokenMintHandler(token, coordinator);
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = TokenMintHandler.mint.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// CORE INVARIANT: total supply can never exceed the immutable hard cap.
    function invariant_supply_never_exceeds_cap() public view {
        assertLe(token.totalSupply(), token.MAX_SUPPLY());
    }

    /// Ownership can never be zeroed (renounce is disabled), so mint authority cannot be bricked by renounce.
    function invariant_owner_never_zero() public view {
        assertTrue(token.owner() != address(0));
    }
}

// ═══════════ Invariant: the anchor's writer role can never become address(0) ═══════════
contract AnchorHandler is Test {
    ReputationAnchor public anchor;

    constructor(ReputationAnchor a) {
        anchor = a;
    }

    function setCoordinator(address next) external {
        vm.prank(anchor.coordinator());
        try anchor.setCoordinator(next) {} catch {}
    }

    function setScore(uint256 agentId, uint256 score) external {
        vm.prank(anchor.coordinator());
        try anchor.setScore(agentId, score) {} catch {}
    }
}

contract AnchorInvariant is StdInvariant, Test {
    ReputationAnchor anchor;
    AnchorHandler handler;

    function setUp() public {
        anchor = new ReputationAnchor(address(0xC0));
        handler = new AnchorHandler(anchor);
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = AnchorHandler.setCoordinator.selector;
        sel[1] = AnchorHandler.setScore.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The writer role can never become the zero address (zero-addr guard), so writes can't be bricked.
    function invariant_coordinator_never_zero() public view {
        assertTrue(anchor.coordinator() != address(0));
    }
}

// ═══════════ Reentrancy: hostile ERC-721 receiver re-enters register() during _safeMint ═══════════
contract ReentrantReceiver is IERC721Receiver {
    IdentityRegistry id;
    bool public reentered;
    uint256 public firstId;
    uint256 public secondId;

    constructor(IdentityRegistry _id) {
        id = _id;
    }

    function attack() external {
        firstId = id.register(); // mints to this contract → fires onERC721Received
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            secondId = id.register(); // re-enter mid-mint
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract PangleReentrancyTest is Test {
    IdentityRegistry id;
    PangleToken token;
    address coordinator = address(0xC0);

    function setUp() public {
        id = new IdentityRegistry();
        token = new PangleToken(coordinator);
    }

    /// _safeMint calls back into a contract recipient; a re-entrant register() must NOT collide ids or
    /// corrupt state. `_nextId` is bumped BEFORE the mint, so the inner call gets a fresh, lower id and
    /// the outer call keeps the higher one — no double-mint, no id reuse.
    function test_reentrant_register_no_id_collision() public {
        ReentrantReceiver r = new ReentrantReceiver(id);
        r.attack();
        assertTrue(r.reentered(), "callback did not run");
        uint256 first = r.firstId();   // outer: id assigned first (lower)
        uint256 second = r.secondId(); // inner: assigned during the callback (next id)
        assertTrue(first != second);
        assertEq(first + 1, second);
        assertEq(id.ownerOf(first), address(r));
        assertEq(id.ownerOf(second), address(r));
        assertEq(id.getAgentWallet(first), address(r));
        assertEq(id.getAgentWallet(second), address(r));
    }

    /// PangleToken.mint uses _mint (no ERC-721-style receiver hook), so a contract recipient cannot
    /// re-enter on receipt — minting to a contract just credits the balance.
    function test_token_mint_to_contract_has_no_callback() public {
        ReentrantReceiver r = new ReentrantReceiver(id);
        vm.prank(coordinator);
        token.mint(address(r), 1e18);
        assertEq(token.balanceOf(address(r)), 1e18);
        assertFalse(r.reentered()); // no hook fired
    }
}
