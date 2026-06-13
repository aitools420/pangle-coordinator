// ⛔ DEPRECATED / DO-NOT-RUN (2026-06-10). The two Anvil accounts have a co-located external
// sweeper bot that front-runs any incoming PLS with absurd gas, so funded gas is stolen before
// the ERC-20 transfer can land (we lost ~88 PLS confirming this). Per board directive, the KL-04
// fix is "disclose + label" (done on /audit), NOT burn. This script is retained only as a record
// of the attempt and is hard-disabled below so it can never fund those drainer wallets again.
if (!process.env.I_UNDERSTAND_THE_SWEEPER_WILL_STEAL_THE_GAS) {
  console.error("Refusing to run: see header. The Anvil accounts are sweeper-guarded; funding them loses PLS.");
  process.exit(1);
}
// One-off remediation for Keylith KL-04 (2026-06-10): 35 PANG was smoke-test-minted
// at deploy time to Anvil/Foundry default accounts #1 and #2, whose private keys are
// public knowledge. Sweep those balances to the dead address so no publicly-keyed
// balance pollutes the supply. Gas is fronted from the coordinator wallet.
//
// NOTE: Anvil #1 (0x7099...) is a heavily-used shared public account on PulseChain with
// a co-located sweeper draining incoming PLS, so funded gas can be stolen and our transfer
// can lose the nonce race. We therefore use a high gas-price multiplier to win the nonce,
// fund just-in-time, and retry a bounded number of times per account.
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);

const TOKEN = env.PANGLE_TOKEN_ADDRESS;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const GAS_MULT = 6n;       // outbid the drainer for the nonce
const TRANSFER_GAS = 70000n;
const MAX_ATTEMPTS = 4;

// Standard Anvil/Foundry dev mnemonic accounts #1 and #2 — keys are published in the
// Foundry docs and printed by `anvil` on every startup. NOT secrets.
const ANVIL = [
  { name: "Anvil #2", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { name: "Anvil #1", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
];

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: "PulseChain",
  nativeCurrency: { name: "PLS", symbol: "PLS", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(env.RPC_URL) });
const coordinator = privateKeyToAccount(env.COORDINATOR_PRIVATE_KEY);
const coordWallet = createWalletClient({ chain, account: coordinator, transport: http(env.RPC_URL) });

async function waitReceipt(hash, label) {
  for (let i = 0; i < 30; i++) {
    const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 4000));
  }
  console.log(`  ${label}: no receipt after 120s (likely dropped)`);
  return null;
}

async function sweep({ name, key }) {
  const acct = privateKeyToAccount(key);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pang = await pub.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [acct.address] });
    if (pang === 0n) { console.log(`${name}: 0 PANG — done`); return true; }
    console.log(`${name} ${acct.address}: ${formatEther(pang)} PANG (attempt ${attempt}/${MAX_ATTEMPTS})`);

    const gasPrice = (await pub.getGasPrice()) * GAS_MULT;
    const need = gasPrice * TRANSFER_GAS;
    const have = await pub.getBalance({ address: acct.address });
    if (have < need) {
      const fh = await coordWallet.sendTransaction({ to: acct.address, value: need - have, gasPrice });
      await waitReceipt(fh, "fund");
    }

    const nonce = await pub.getTransactionCount({ address: acct.address, blockTag: "pending" });
    const wallet = createWalletClient({ chain, account: acct, transport: http(env.RPC_URL) });
    try {
      const th = await wallet.writeContract({ address: TOKEN, abi: ABI, functionName: "transfer", args: [DEAD, pang], gasPrice, nonce });
      const rcpt = await waitReceipt(th, "transfer");
      if (rcpt && rcpt.status === "success") { console.log(`  swept ${formatEther(pang)} PANG -> dead: ${th}`); }
    } catch (e) {
      console.log(`  send failed: ${String(e).split("\n")[0]}`);
    }
  }
  const left = await pub.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [acct.address] });
  if (left > 0n) console.log(`${name}: STILL HOLDS ${formatEther(left)} PANG after ${MAX_ATTEMPTS} attempts`);
  return left === 0n;
}

for (const a of ANVIL) await sweep(a);

console.log("--- final state ---");
for (const a of ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", DEAD]) {
  const b = await pub.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [a] });
  console.log(`${a}: ${formatEther(b)} PANG`);
}
