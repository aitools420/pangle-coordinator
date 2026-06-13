// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Minimal ERC-8004-compatible Identity Registry (Pangle MVP instance)
/// @notice A subset of ERC-8004's Identity Registry deployed as Pangle's own instance on
///         PulseChain (the canonical 0x8004… singletons are not deployed there). Agents
///         SELF-REGISTER (the NFT is minted to msg.sender; agentId == tokenId, so the operator
///         owns the identity and pays their own gas), and an operator can bind a separate
///         operational wallet — which must PROVE CONTROL via an EIP-712 (EOA) or ERC-1271
///         (smart-wallet) signature from that wallet, per canonical ERC-8004. This prevents
///         binding an identity to a wallet that never consented.
/// @dev    Simplification vs full ERC-8004: metadata/registration-file entries are omitted. The
///         wallet-binding path is the canonical proof-of-control 4-arg form.
contract IdentityRegistry is ERC721, EIP712 {
    uint256 private _nextId = 1;
    mapping(uint256 => address) private _agentWallet;
    mapping(uint256 => string) public agentURI;
    /// @notice Per-agent wallet-binding nonce — incremented on every successful bind AND on transfer,
    ///         so each consent signature is single-use and any pending consent dies when the NFT moves.
    mapping(uint256 => uint256) public bindingNonce;

    /// @dev EIP-712 typehash for a wallet-binding consent, signed by the NEW wallet (incl. the nonce).
    bytes32 private constant WALLET_BINDING_TYPEHASH =
        keccak256("WalletBinding(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)");

    event Registered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);

    error NotAgentOwner();
    error BindingExpired();
    error InvalidWalletSignature();

    constructor() ERC721("Pangle Agent Identity", "PANGLID") EIP712("Pangle Identity Registry", "1") {}

    /// @notice Register a new agent identity to the caller. Returns the assigned agentId.
    function register() external returns (uint256 agentId) {
        return _register(msg.sender, "");
    }

    /// @notice Register with an agent registration-file URI.
    function register(string calldata uri) external returns (uint256 agentId) {
        return _register(msg.sender, uri);
    }

    function _register(address to, string memory uri) internal returns (uint256 agentId) {
        agentId = _nextId++;
        _safeMint(to, agentId);
        _agentWallet[agentId] = to; // defaults to the owner
        agentURI[agentId] = uri;
        emit Registered(agentId, to, uri);
        emit AgentWalletSet(agentId, to);
    }

    /// @notice The EIP-712 digest the NEW wallet must sign to consent to being bound to `agentId`.
    ///         Off-chain clients compute their binding signature over this digest.
    function bindingDigest(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(WALLET_BINDING_TYPEHASH, agentId, newWallet, nonce, deadline)));
    }

    /// @notice Bind a dedicated operational signing wallet to the identity (canonical ERC-8004).
    ///         The agent owner initiates, and `newWallet` proves control via an EIP-712 (EOA) or
    ///         ERC-1271 (smart-wallet) signature over `bindingDigest(agentId, newWallet, deadline)`.
    /// @dev    RESOLVED 2026-06-04 (red-team rev 3): the binding digest now includes a per-agent
    ///         `bindingNonce`, consumed (incremented) on every successful bind, so each consent
    ///         signature is SINGLE-USE — a captured signature cannot be replayed on the same
    ///         (agentId,newWallet) even before `deadline`, and `_update` bumps the nonce on transfer
    ///         so a pending consent dies when the NFT moves. The external 4-arg ABI is unchanged
    ///         (the nonce is read on-chain, not passed); off-chain signers compute the digest over
    ///         the current `bindingNonce(agentId)`.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (block.timestamp > deadline) revert BindingExpired();
        uint256 nonce = bindingNonce[agentId];
        bytes32 digest = bindingDigest(agentId, newWallet, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidWalletSignature();
        unchecked { bindingNonce[agentId] = nonce + 1; } // consume the consent — single-use, replay-proof
        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet);
    }

    /// @dev Returns address(0) for a never-registered agentId (no existence revert). Off-chain
    ///      callers must confirm existence via `ownerOf`; do not treat address(0) as a valid binding.
    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallet[agentId];
    }

    /// @notice Reset the bound wallet back to the owner (no consent signature needed — the target
    ///         is the owner's own address).
    function unsetAgentWallet(uint256 agentId) external {
        address owner = ownerOf(agentId);
        if (owner != msg.sender) revert NotAgentOwner();
        _agentWallet[agentId] = owner;
        emit AgentWalletSet(agentId, owner);
    }

    /// @dev ERC-8004 semantics: clear the bound wallet to the new owner on transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            _agentWallet[tokenId] = to;
            unchecked { bindingNonce[tokenId]++; } // invalidate any pending wallet-binding consent on transfer
            emit AgentWalletSet(tokenId, to);
        }
    }
}
