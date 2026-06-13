// One-off: re-mint the investigation (5) + synthesis (20) PANG to the first tester that
// the admin endpoints broadcast but whose receipts viem timed out on (txs since dropped).
// Safe: confirmed dropped + coordinator nonce clean before running. Bumps gas to avoid re-drop,
// polls receipts robustly, then reconciles the DB (adds the 2 reward rows + sets reputation=35).
import { createWalletClient, createPublicClient, http, defineChain, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = getAddress(env.PANGLE_TOKEN_ADDRESS);
const RPC = env.RPC_URL;
const chain = defineChain({ id: Number(env.CHAIN_ID), name: 'PulseChain', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(env.COORDINATOR_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, account, transport: http(RPC) });
const ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)']);
const TESTER = getAddress('0xb77a6339855f937b50542bf6b5e26e07f8661827');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mintAndConfirm(amount, label) {
  const gp = await pub.getGasPrice();
  const bumped = gp * 2n; // avoid the under-pricing that dropped the first attempts
  const hash = await wallet.writeContract({ address: TOKEN, abi: ABI, functionName: 'mint', args: [TESTER, amount], gasPrice: bumped });
  console.log(`${label}: broadcast ${hash} (gasPrice ${bumped})`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    let rcpt = null;
    try { rcpt = await pub.getTransactionReceipt({ hash }); } catch {}
    if (rcpt) {
      console.log(`${label}: mined status=${rcpt.status} block=${rcpt.blockNumber}`);
      if (rcpt.status !== 'success') throw new Error(`${label} reverted`);
      return hash;
    }
  }
  throw new Error(`${label} not confirmed in 180s: ${hash}`);
}

const bal = a => pub.readContract({ address: TOKEN, abi: ABI, functionName: 'balanceOf', args: [TESTER] });
console.log('balance before:', (await bal()) / 10n ** 18n, 'PANG');

const invHash = await mintAndConfirm(5n * 10n ** 18n, 'investigation(5)');
const synHash = await mintAndConfirm(20n * 10n ** 18n, 'synthesis(20)');

const after = await bal();
console.log('balance after:', after / 10n ** 18n, 'PANG');
if (after !== 35n * 10n ** 18n) { console.error('!! UNEXPECTED BALANCE, aborting DB reconcile'); process.exit(1); }

// ---- reconcile off-chain accounting ----
const db = new Database('data/pangle.db');
db.pragma('busy_timeout = 8000');
const agentId = '1047474645664669110640934024382998693422710528039';
const threadId = 'thread_5b412296521d96fa860ad2d7c0e565fc';
const now = Math.floor(Date.now() / 1000);
const ins = db.prepare('INSERT INTO rewards (agentId,threadId,messageId,amount,reason,txHash,createdAt) VALUES (?,?,?,?,?,?,?)');
ins.run(agentId, threadId, 'msg_ce7120d4f20efea71632eb04db4d9f66', (5n * 10n ** 18n).toString(), 'investigation useful', invHash, now);
ins.run(agentId, threadId, 'msg_93ac5ea799fd47ebd4b775ae5abfdc00', (20n * 10n ** 18n).toString(), 'synthesis correct', synHash, now);
db.prepare('UPDATE agents SET reputation=? WHERE agentId=?').run(35, agentId);
const rows = db.prepare('SELECT reason,amount,txHash FROM rewards WHERE agentId=? ORDER BY createdAt').all(agentId);
const rep = db.prepare('SELECT reputation FROM agents WHERE agentId=?').get(agentId).reputation;
db.close();
console.log('DB reconciled. reputation=', rep, 'reward rows:', rows.length);
rows.forEach(r => console.log('  ', r.reason, BigInt(r.amount) / 10n ** 18n, 'PANG', r.txHash));
