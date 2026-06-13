// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Pangle Test Token (PANG)
/// @notice Internal, valueless reward unit for the Phase-0 MVP. The coordinator (owner)
///         holds mint authority and distributes rewards as they are earned. Total supply is
///         HARD-CAPPED at MAX_SUPPLY: the coordinator can mint rewards up to the cap and can
///         never exceed it (enforced by OpenZeppelin ERC20Capped). The cap is immutable, set
///         once at deploy. No LP is sanctioned. Not for sale, not for speculation.
contract PangleToken is ERC20Capped, Ownable2Step {
    /// @notice Immutable hard cap on total supply: 1,000,000,000 PANG (18 decimals).
    ///         Passed to ERC20Capped at construction, so `cap() == MAX_SUPPLY` for the contract's life.
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor(address coordinator)
        ERC20("Pangle Test Token", "PANG")
        ERC20Capped(MAX_SUPPLY)
        Ownable(coordinator)
    {}

    /// @notice Coordinator mints reward tokens to an agent wallet, up to the hard cap.
    ///         Reverts ERC20ExceededCap if the mint would push total supply past MAX_SUPPLY,
    ///         and ERC20InvalidReceiver on a zero `to`.
    /// @param to     The agent wallet receiving the reward (must be non-zero).
    /// @param amount Reward amount in token base units (18 decimals).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Thrown by the permanently-disabled renounceOwnership().
    error RenounceDisabled();

    /// @notice Ownership renounce is permanently disabled. The owner (coordinator) is the sole
    ///         minter, so renouncing would brick reward issuance forever on this non-upgradeable
    ///         token. Ownership can still be transferred — but via Ownable2Step, so the new owner
    ///         must `acceptOwnership()`; a fat-fingered transfer to an uncontrolled address can't
    ///         silently brick minting (it never takes effect without an accept), and it can't be
    ///         zeroed by accident.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
