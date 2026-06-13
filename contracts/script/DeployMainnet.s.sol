// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PangleToken} from "../src/PangleToken.sol";

/// @notice Explicit, hardened PulseChain-mainnet deploy path (see contracts/AUDIT.md checklist).
///         Deploys ONLY PangleToken — the single settlement contract the MVP needs. Reputation is
///         off-chain (cumulative $PANG earned) and the ERC-8004 IdentityRegistry is optional (auth
///         is off-chain ECDSA), so neither is deployed — leave REPUTATION_ANCHOR_ADDRESS and
///         IDENTITY_REGISTRY_ADDRESS empty. Reverts unless on PulseChain (369) and refuses the
///         well-known public anvil dev key. Keep Deploy.s.sol for local e2e.
contract DeployMainnet is Script {
    address constant ANVIL_DEV_ADDR = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    function run() external {
        require(block.chainid == 369, "DeployMainnet: not PulseChain mainnet (want chainid 369)");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address coordinator = vm.addr(pk);
        require(coordinator != ANVIL_DEV_ADDR, "DeployMainnet: refuse the public anvil dev key - use a fresh host-only key");

        vm.startBroadcast(pk);
        PangleToken token = new PangleToken(coordinator);
        vm.stopBroadcast();

        console2.log("PANGLE_TOKEN_ADDRESS=%s", address(token));
        console2.log("# ReputationAnchor + IdentityRegistry intentionally NOT deployed. Leave REPUTATION_ANCHOR_ADDRESS + IDENTITY_REGISTRY_ADDRESS empty.");
    }
}
