# Manual 48h Synthesis-Resolution Procedure (MVP)

The coordinator is the sole scorer in the MVP. A **synthesis** (a thread's accepted conclusion) is
judged correct/incorrect by **manual coordinator judgement within the resolution window**
(`config.synthesisWindowHours`, default 48h). This is the written, repeatable procedure so calls are
consistent and defensible across threads. Locking it is a Phase-0 prerequisite (changing the bar later
reads as retroactive slashing).

## When a thread is resolvable
A thread is ready to resolve when it has an accepted synthesis (`conclusionMsgId` set) AND its window
has elapsed (`db.listResolvableThreads(now)` lists exactly these). Resolve via
`POST /admin/api/resolve {threadId, correct}` → `scoring.resolveSynthesis`. Effect of `correct:true`:
the synthesizer earns the synthesis reward (20 PANG) + reputation. `correct:false` pays nothing.
Resolution is idempotent (once only). (There is **no** first-reporter bonus — only the first-unique
useful submission per slot scores.)

## The bar, per conclusion type
Judge against **independently verifiable on-chain reality** within the window — not the eloquence of the
write-up. Re-derive from chain data; do not trust the contribution's claims at face value.

- **High Risk** — CORRECT if the flagged risk materialised or is on-chain-confirmed: an actual rug/LP
  pull, a malicious tax/blacklist/owner change, a honeypot (sells blocked), an exploit/drain, or a
  proxy-implementation swap to malicious code. INCORRECT if the contract/token behaved normally through
  the window with no such event.
- **Strong Accumulation** — CORRECT if verifiable smart-money/whale accumulation actually continued
  (net inflows to tracked wallets, holder-concentration rising as called), not a one-off or a wash.
  INCORRECT if the accumulation thesis didn't hold (distribution, or the "smart money" was noise).
- **Snipe Target** — CORRECT if the called launch/liquidity event played out as a genuine opportunity
  (new pool / liquidity add / listing occurred as described and was actionable in-window). INCORRECT if
  it didn't happen or was a misread.
- **Benign Activity** — CORRECT if, after the window, nothing adverse occurred and the activity was
  indeed ordinary. INCORRECT if something the synthesis dismissed as benign turned harmful.
- **Requires Further Investigation** — this is a non-committal conclusion. Treat as **not a resolvable
  finding**: prefer to leave the thread open for more contributions, or resolve `correct:false` (no
  reward) if the window forces closure.

## Evidence checklist (do these before deciding)
1. Re-pull the cited `txHash` / `contractAddress` / `walletAddress` and confirm they say what the
   contribution claims (block explorer / RPC).
2. Check the state that the conclusion depends on: LP reserves + lock status, token tax/blacklist
   flags, owner/admin changes, holder distribution deltas, proxy implementation address.
3. Cross-check the thread's investigations — does the evidence chain actually support the conclusion?
4. Confirm the outcome falls **within the window** (events after `targetResolveAt` don't count for this
   resolution; they'd be a new thread).
5. If genuinely ambiguous or under-evidenced, lean **incorrect** (the bar is "demonstrably right"), and
   note why in the audit. Consistency over generosity.

## Consistency & record
- Apply the same standard to every thread; when unsure, compare to prior resolved threads of the same
  conclusion type.
- Every resolve is audited (`db.audit("admin","thread.resolve",…)`). Keep a one-line rationale for
  contested calls so the cohort sees the bar is consistent, not arbitrary.
- This procedure is **locked for the announced rubric window (~8 weeks)**; revisit only after it, so
  changes are forward-looking, never retroactive. Automating outcome-resolution (on-chain heuristics
  per conclusion type) is a Phase-3 item — until then, this manual procedure is authoritative.
