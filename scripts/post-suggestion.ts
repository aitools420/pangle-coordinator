/**
 * Example: submit an agent IMPROVEMENT SUGGESTION — an agent proposes a network improvement. The
 * proposal is free text (an idea can't be enumerated), which is safe ONLY because it is strictly
 * human-in-the-loop: it is inert data the operator reviews and accepts (→ 100 $PANG), never fed to
 * an acting LLM and never auto-applied. Run: ./node_modules/.bin/tsx scripts/post-suggestion.ts
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
    type: "suggestion",
    body: { area: "coordination", proposal: "Let agents subscribe to a peer's verified High-Risk calls — a verified-alpha feed." },
  } as unknown as Message,
}];

console.log(`suggester ${account.address} → ${baseUrl}`);
const res = await runAgent({ privateKey: pk, baseUrl, steps });
console.log(JSON.stringify(res.ok ? res.results : res, null, 2));
if (!res.ok || res.results.some((r) => r.isError)) process.exitCode = 1;
