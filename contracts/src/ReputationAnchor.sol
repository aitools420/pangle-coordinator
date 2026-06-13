// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pangle Reputation Anchor (MVP)
/// @notice Single-writer reputation store. The coordinator is the sole scorer during the MVP;
///         peer review (ERC-8004 `giveFeedback`) is phased in later. Anyone can read.
///         Keyed by a coordinator-assigned uint256 agentId. NOTE: since agent auth is off-chain
///         ECDSA, the coordinator derives agentId from the agent's address (NOT the ERC-8004
///         tokenId). Do NOT also write scores here keyed by an ERC-8004 tokenId — the two would be
///         different slots in `scoreOf`. ERC-8004 identity is optional/separate.
/// @dev    We deliberately do NOT use ERC-8004's ReputationRegistry for the MVP: its
///         `giveFeedback` is a multi-client peer-feedback ledger that forbids the agent
///         owner/operator from scoring — the wrong shape for a single-authority MVP score.
contract ReputationAnchor {
    address public coordinator;
    mapping(uint256 => uint256) public scoreOf; // agentId => score (public getter = anyone reads)
    mapping(uint256 => uint64) public updatedAt; // agentId => last-update timestamp

    event ScoreUpdated(uint256 indexed agentId, uint256 score, uint64 timestamp);
    event CoordinatorChanged(address indexed from, address indexed to);

    error NotCoordinator();
    error ZeroAddress();

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator();
        _;
    }

    constructor(address coordinator_) {
        // Mirror setCoordinator's guard: a zero coordinator would permanently brick all writes
        // (no tx can originate from address(0)) on this non-upgradeable contract.
        if (coordinator_ == address(0)) revert ZeroAddress();
        coordinator = coordinator_;
        emit CoordinatorChanged(address(0), coordinator_);
    }

    /// @notice Coordinator sets (overwrites) an agent's reputation score.
    function setScore(uint256 agentId, uint256 score) external onlyCoordinator {
        scoreOf[agentId] = score;
        updatedAt[agentId] = uint64(block.timestamp);
        emit ScoreUpdated(agentId, score, uint64(block.timestamp));
    }

    /// @notice Hand the writer role to a new coordinator (progressive decentralization).
    /// @dev Reverts on the zero address: handing off to address(0) would permanently brick
    ///      writes (no one could ever call setScore or setCoordinator again).
    function setCoordinator(address next) external onlyCoordinator {
        if (next == address(0)) revert ZeroAddress();
        emit CoordinatorChanged(coordinator, next);
        coordinator = next;
    }
}
