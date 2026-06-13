/**
 * Chain adapter: PangleToken reward mints — the hub-chain settlement layer — plus OPTIONAL
 * ERC-8004 identity reads. Auth does NOT use the identity reads (agent verification is pure
 * off-chain ECDSA, see auth.ts); ownerOf/getAgentWallet remain only for the optional ERC-8004
 * credential flow. Reputation is NOT on-chain: it is cumulative $PANG earned, tracked off-chain
 * by the coordinator (see scoring.ts), so the only settlement contract is PangleToken.
 *
 * Two implementations behind one interface:
 *  - RealChain: viem against an RPC (anvil locally / PulseChain) with the token deployed.
 *  - MockChain: in-memory, used when the token address is unset, so the coordinator runs
 *    end-to-end with no chain (unit tests, dashboard dev). The MVP is faithful either way.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";

export interface ChainAdapter {
  readonly mode: "real" | "mock";
  readonly coordinatorAddress: Address;
  ownerOf(agentId: string): Promise<Address | null>;
  getAgentWallet(agentId: string): Promise<Address | null>;
  mintReward(to: Address, amount: bigint): Promise<string>;
  tokenBalanceOf(addr: Address): Promise<bigint>;
  /** Present only on MockChain — lets the coordinator seed a mock identity at onboarding. */
  registerMock?(agentId: string, owner: Address, agentWallet: Address): void;
}

export const IDENTITY_ABI = parseAbi([
  "function register() returns (uint256)",
  "function register(string agentURI) returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
]);
export const TOKEN_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

// The 10 standard Anvil/Hardhat dev-mnemonic accounts ("test test ... junk"). Their private
// keys are public knowledge, so a reward minted to one is spendable by anyone. The deploy
// path already refuses the anvil deployer key on mainnet; this is the same refusal on the
// mint-RECIPIENT path (Keylith KL-04 — 35 PANG was smoke-test-minted to #1/#2 at deploy).
const WEAK_DEV_ADDRESSES = new Set([
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
]);

export function isWeakDevAddress(addr: Address): boolean {
  return WEAK_DEV_ADDRESSES.has(getAddress(addr));
}

function pangleChain(cfg: Config) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainMode === "mainnet" ? "PulseChain" : "Pangle Local",
    nativeCurrency: { name: "PLS", symbol: "PLS", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

class RealChain implements ChainAdapter {
  readonly mode = "real" as const;
  readonly coordinatorAddress: Address;
  private pub;
  private wallet;
  private account;
  private identity: Address | null;
  private token: Address;

  constructor(cfg: Config) {
    const chain = pangleChain(cfg);
    this.account = privateKeyToAccount(cfg.coordinatorPrivateKey);
    this.coordinatorAddress = this.account.address;
    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ chain, account: this.account, transport: http(cfg.rpcUrl) });
    // ERC-8004 IdentityRegistry is OPTIONAL (auth is off-chain ECDSA; identity reads serve only the
    // optional credential flow). Settlement needs only the token — so a single contract is enough.
    this.identity = cfg.identityRegistryAddress ? getAddress(cfg.identityRegistryAddress) : null;
    this.token = getAddress(cfg.pangleTokenAddress as string);
  }

  async ownerOf(agentId: string): Promise<Address | null> {
    if (!this.identity) return null; // ERC-8004 registry not deployed (optional)
    try {
      return (await this.pub.readContract({ address: this.identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(agentId)] })) as Address;
    } catch {
      return null;
    }
  }
  async getAgentWallet(agentId: string): Promise<Address | null> {
    if (!this.identity) return null; // ERC-8004 registry not deployed (optional)
    try {
      const w = (await this.pub.readContract({ address: this.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [BigInt(agentId)] })) as Address;
      return w === "0x0000000000000000000000000000000000000000" ? null : w;
    } catch {
      return null;
    }
  }
  async mintReward(to: Address, amount: bigint): Promise<string> {
    if (isWeakDevAddress(to)) {
      throw new Error(`mintReward refused: ${to} is a publicly-keyed Anvil/Hardhat dev account`);
    }
    // Explicit gas-price floor: viem's auto-estimate can under-price the mint on a congested public
    // RPC and get it dropped — which then leaves waitForTransactionReceipt to time out and strand the
    // reward (the receipt-timeout incident). Bumping to ~2x the current network price makes a drop
    // unlikely so the receipt resolves. Falls back to auto-estimation if the gas-price read fails.
    let gasPrice: bigint | undefined;
    try {
      gasPrice = (await this.pub.getGasPrice()) * 2n;
    } catch {
      gasPrice = undefined;
    }
    const hash = await this.wallet.writeContract({
      address: this.token,
      abi: TOKEN_ABI,
      functionName: "mint",
      args: [to, amount],
      ...(gasPrice !== undefined ? { gasPrice } : {}),
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }
  async tokenBalanceOf(addr: Address): Promise<bigint> {
    return (await this.pub.readContract({ address: this.token, abi: TOKEN_ABI, functionName: "balanceOf", args: [addr] })) as bigint;
  }
}

class MockChain implements ChainAdapter {
  readonly mode = "mock" as const;
  readonly coordinatorAddress: Address = "0x0000000000000000000000000000000000000369";
  private bal = new Map<string, bigint>();
  private owners = new Map<string, Address>(); // agentId -> owner (registered via registerMock)
  private wallets = new Map<string, Address>(); // agentId -> agentWallet

  /** Test helper: register a mock identity so ownerOf/getAgentWallet resolve. */
  registerMock(agentId: string, owner: Address, agentWallet: Address): void {
    this.owners.set(agentId, getAddress(owner));
    this.wallets.set(agentId, getAddress(agentWallet));
  }
  async ownerOf(agentId: string): Promise<Address | null> {
    return this.owners.get(agentId) ?? null;
  }
  async getAgentWallet(agentId: string): Promise<Address | null> {
    return this.wallets.get(agentId) ?? null;
  }
  async mintReward(to: Address, amount: bigint): Promise<string> {
    this.bal.set(to.toLowerCase(), (this.bal.get(to.toLowerCase()) ?? 0n) + amount);
    return `mock:mint:${to}:${amount}`;
  }
  async tokenBalanceOf(addr: Address): Promise<bigint> {
    return this.bal.get(addr.toLowerCase()) ?? 0n;
  }
}

export function createChain(cfg: Config): ChainAdapter {
  // Settlement needs only the PangleToken. The ERC-8004 IdentityRegistry is OPTIONAL (auth is
  // off-chain ECDSA) and reputation is off-chain (cumulative $PANG earned), so a single deployed
  // contract (the token) is enough to run on a real chain.
  if (cfg.pangleTokenAddress) {
    try {
      return new RealChain(cfg);
    } catch (e) {
      console.warn(`[chain] falling back to MockChain: ${(e as Error).message}`);
    }
  }
  console.warn("[chain] using MockChain (PANGLE_TOKEN_ADDRESS unset) — on-chain calls are simulated in-memory.");
  return new MockChain();
}

export { MockChain };
