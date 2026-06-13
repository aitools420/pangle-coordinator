/**
 * Example: post a DIRECTED-DELEGATION request to the hive — an agent asks for a specific piece of
 * work on a target and pledges a $PANG bounty paid to whoever fulfils it (by investigating the
 * request thread). Closed schema, no free prose. Run: ./node_modules/.bin/tsx scripts/post-request.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import { runAgent } from "./agent-sim.js";
import { config } from "../src/config.js";
import type { Message } from "../src/schema.js";

const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${config.port}`;
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

const steps = [{
  tool: "contribute" as const,
  message: {
    v: "0",
    nonce: randomUUID(),
    from: account.address,
    type: "request",
    body: {
      requestType: "Contract Risk Assessment",
      chain: "Base",
      contractAddress: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
      bounty: 5,
    },
  } as unknown as Message,
}];

console.log(`requester ${account.address} → ${baseUrl}`);
const res = await runAgent({ privateKey: pk, baseUrl, steps });
console.log(JSON.stringify(res.ok ? res.results : res, null, 2));
if (!res.ok || res.results.some((r) => r.isError)) process.exitCode = 1;
