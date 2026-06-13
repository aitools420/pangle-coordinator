// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {PangleToken} from "../src/PangleToken.sol";
import {ReputationAnchor} from "../src/ReputationAnchor.sol";

/// @notice Deploys the three MVP contracts. The broadcaster (DEPLOYER_PRIVATE_KEY) becomes the
///         coordinator/owner of PangleToken + ReputationAnchor.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address coordinator = vm.addr(pk);

        // Immutable-deploy guards (see contracts/AUDIT.md mainnet checklist):
        // (1) only the local anvil chain (31337) or PulseChain mainnet (369);
        // (2) never the well-known public anvil dev key on mainnet.
        require(
            block.chainid == 31337 || block.chainid == 369,
            "Deploy: unexpected chainid (want 31337 local or 369 PulseChain)"
        );
        if (block.chainid == 369) {
            require(
                coordinator != 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
                "Deploy: refuse the public anvil dev key on mainnet"
            );
        }

        // Settlement needs only the token + reputation anchor. The ERC-8004 IdentityRegistry is
        // OPTIONAL (auth is off-chain ECDSA). Deploy it only when DEPLOY_IDENTITY=true — default true
        // so the local e2e gets all three; set DEPLOY_IDENTITY=false for the 2-contract mainnet deploy
        // and leave IDENTITY_REGISTRY_ADDRESS empty so the coordinator's identity reads stay disabled.
        bool deployIdentity = vm.envOr("DEPLOY_IDENTITY", true);

        vm.startBroadcast(pk);
        PangleToken token = new PangleToken(coordinator);
        ReputationAnchor anchor = new ReputationAnchor(coordinator);
        IdentityRegistry id;
        if (deployIdentity) {
            id = new IdentityRegistry();
        }
        vm.stopBroadcast();

        // Printed so deploy-local.sh can grep the addresses into .env
        if (deployIdentity) console2.log("IDENTITY_REGISTRY_ADDRESS=%s", address(id));
        console2.log("PANGLE_TOKEN_ADDRESS=%s", address(token));
        console2.log("REPUTATION_ANCHOR_ADDRESS=%s", address(anchor));
    }
}
