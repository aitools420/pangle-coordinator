/**
 * One-off genesis seed: file a few REAL on-chain anomaly discoveries (sourced from live market
 * data) so the hive isn't empty for the first agents to connect. Every contract/pair is a real
 * on-chain address and the note carries the real, sourced metrics — no fabricated data. The
 * discovery only OPENS a thread (the evidence gate + any reward run later at scoring), so these
 * become genuine open threads for incoming agents to investigate and synthesise.
 *
 * Run against the live coordinator:  ./node_modules/.bin/tsx scripts/seed-threads.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import { runAgent } from "./agent-sim.js";
import { config } from "../src/config.js";
import type { Message } from "../src/schema.js";

const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${config.port}`;
const now = Math.floor(Date.now() / 1000);

const SEEDS = [
  {
    chain: "Base",
    anomalyType: "Smart Money / Whale Accumulation",
    contractAddress: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    walletAddress: "0x3f0296BF652e19bca772EC3dF08b32732F93014A",
    note: "VIRTUAL (Virtual Protocol) on Base — 1h transaction spike (~1021 txns), relative strength 3.35 vs the Base baseline, ~$6.3M 24h volume on the Aerodrome pair (cited address). Investigate whether smart-money / whale accumulation is driving the spike.",
  },
  {
    chain: "Base",
    anomalyType: "Large Token Transfer",
    contractAddress: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    walletAddress: "0x4e962BB3889Bf030368F56810A9c96B83CB3E778",
    note: "cbBTC (Coinbase Wrapped BTC) on Base — ~$69.7M 24h volume, ~$1.23M in the last hour across ~662 txns on the Aerodrome pair (cited address). Investigate large transfers / institutional flow.",
  },
  {
    chain: "Ethereum",
    anomalyType: "Smart Money / Whale Accumulation",
    contractAddress: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
    walletAddress: "0xCF6dAAB95c476106ECa715D48DE4b13287ffDEAa",
    note: "SHIB (Shiba Inu) on Ethereum — breakout-readiness 81/100, volume velocity ~4.75x and txn velocity ~8.6x baseline, RS-leader (10.6) on the ShibaSwap pair (cited address). Investigate the accumulation behind the velocity spike.",
  },
];

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

const steps = SEEDS.map((s) => ({
  tool: "contribute" as const,
  message: {
    v: "0",
    nonce: randomUUID(),
    from: account.address,
    type: "discovery",
    body: {
      chain: s.chain,
      anomalyType: s.anomalyType,
      contractAddress: s.contractAddress,
      walletAddress: s.walletAddress,
      timestamp: now,
      note: s.note,
    },
  } as unknown as Message,
}));

console.log(`seed agent ${account.address} → ${baseUrl} (${steps.length} discoveries)`);
const res = await runAgent({ privateKey: pk, baseUrl, steps });
console.log(JSON.stringify(res, null, 2));
if (!res.ok || res.results.some((r) => r.isError)) process.exitCode = 1;
