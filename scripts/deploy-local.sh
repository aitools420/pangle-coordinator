#!/usr/bin/env bash
# Deploy the three MVP contracts to a local anvil chain and write their addresses into .env.
# Usage: npm run deploy:local   (starts anvil if it isn't already running on :8545)
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC=http://127.0.0.1:8545

if ! curl -s -o /dev/null "$RPC" 2>/dev/null; then
  echo "[deploy-local] starting anvil on :8545 ..."
  anvil --silent >/tmp/pangle-anvil.log 2>&1 &
  for i in $(seq 1 20); do curl -s -o /dev/null "$RPC" 2>/dev/null && break; sleep 0.3; done
fi

echo "[deploy-local] deploying contracts ..."
cd contracts
OUT=$(DEPLOYER_PRIVATE_KEY=$ANVIL_KEY forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1) || { echo "$OUT"; exit 1; }
cd ..

ID=$(printf '%s\n' "$OUT" | grep "IDENTITY_REGISTRY_ADDRESS=" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
TK=$(printf '%s\n' "$OUT" | grep "PANGLE_TOKEN_ADDRESS=" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
AN=$(printf '%s\n' "$OUT" | grep "REPUTATION_ANCHOR_ADDRESS=" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)

if [ -z "${ID:-}" ] || [ -z "${TK:-}" ] || [ -z "${AN:-}" ]; then
  echo "[deploy-local] FAILED to parse addresses:"; echo "$OUT"; exit 1
fi

[ -f .env ] || cp .env.example .env
# upsert helper
setenv() { local k="$1" v="$2"; if grep -qE "^${k}=" .env; then sed -i "s|^${k}=.*|${k}=${v}|" .env; else echo "${k}=${v}" >> .env; fi; }
setenv CHAIN_MODE local
setenv RPC_URL "$RPC"
setenv CHAIN_ID 31337
setenv IDENTITY_REGISTRY_ADDRESS "$ID"
setenv PANGLE_TOKEN_ADDRESS "$TK"
setenv REPUTATION_ANCHOR_ADDRESS "$AN"

echo "[deploy-local] done:"
echo "  IDENTITY_REGISTRY_ADDRESS=$ID"
echo "  PANGLE_TOKEN_ADDRESS=$TK"
echo "  REPUTATION_ANCHOR_ADDRESS=$AN"
echo "[deploy-local] addresses written to .env (CHAIN_MODE=local). Start the coordinator with: npm start"
