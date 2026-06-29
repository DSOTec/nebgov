#!/usr/bin/env bash
# ============================================================
# scripts/deploy-e2e-testnet.sh
#
# Deploy all NebGov contracts to Stellar testnet with minimal
# voting parameters suitable for the Playwright E2E governance
# lifecycle test.
#
# Output: app/.env.e2e
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${E2E_ENV_FILE:-$ROOT_DIR/app/.env.e2e}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[skip]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[error]${NC} %s\n" "$*" >&2; exit 1; }

# ---- Load / bootstrap env file -------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  info "Loading env from $ENV_FILE"
  set -a
  source "$ENV_FILE"
  set +a
else
  info "No $ENV_FILE found — will create it after deployment."
fi

# ---- Check prerequisites -------------------------------------------
command -v stellar >/dev/null 2>&1 || fail "stellar-cli not found. Install: cargo install stellar-cli --locked"
command -v cargo   >/dev/null 2>&1 || fail "cargo not found. Install Rust: https://rustup.rs"

IDENTITY="${STELLAR_IDENTITY:-e2e-test}"
NETWORK="${STELLAR_NETWORK:-testnet}"

# ---- Ensure identity exists and is funded ---------------------------
if stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  ok "Identity '$IDENTITY' already exists"
else
  info "Creating identity '$IDENTITY' on $NETWORK ..."
  stellar keys generate --global "$IDENTITY" --network "$NETWORK"
  ok "Identity '$IDENTITY' created"
fi

DEPLOYER_ADDR="$(stellar keys address "$IDENTITY")"
info "Deployer address: $DEPLOYER_ADDR"

if [[ "$NETWORK" == "testnet" ]]; then
  info "Funding identity via friendbot ..."
  stellar keys fund "$IDENTITY" --network "$NETWORK" 2>/dev/null || true
  ok "Identity funded (or was already funded)"
fi

# ---- Build WASM contracts -------------------------------------------
WASM_DIR="$ROOT_DIR/target/wasm32v1-none/release"

info "Building WASM contracts (release) ..."
cargo build --release --target wasm32v1-none --manifest-path "$ROOT_DIR/Cargo.toml" --workspace
ok "WASM build complete"

for wasm in sorogov_token_votes sorogov_timelock sorogov_governor; do
  [[ -f "$WASM_DIR/${wasm}.wasm" ]] || fail "Expected WASM not found: $WASM_DIR/${wasm}.wasm"
done

# ---- Helper: persist key=value into env file -----------------------
persist() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  export "$key=$value"
}

# ---- Helper: deploy contract if not already recorded ---------------
deploy_contract() {
  local wasm_file="$1" env_key="$2"
  local current_value="${!env_key:-}"

  if [[ -n "$current_value" ]]; then
    warn "$env_key already set ($current_value) — skipping deploy"
    return 0
  fi

  info "Deploying $(basename "$wasm_file") ..."
  local addr
  addr="$(stellar contract deploy \
    --wasm "$wasm_file" \
    --source "$IDENTITY" \
    --network "$NETWORK")"

  [[ -n "$addr" ]] || fail "Deploy returned empty address for $wasm_file"
  persist "$env_key" "$addr"
  ok "$env_key = $addr"
}

# ====================================================================
# Deploy contracts in dependency order
# ====================================================================

# 1. Token-Votes
deploy_contract "$WASM_DIR/sorogov_token_votes.wasm" "TOKEN_VOTES_ADDRESS"

# 2. Timelock
deploy_contract "$WASM_DIR/sorogov_timelock.wasm" "TIMELOCK_ADDRESS"

# 3. Governor
deploy_contract "$WASM_DIR/sorogov_governor.wasm" "GOVERNOR_ADDRESS"

# ====================================================================
# Initialize contracts
# ====================================================================

SEP41_TOKEN="${SEP41_TOKEN_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"

# -- Initialize token-votes ------------------------------------------
info "Initializing token-votes ..."
stellar contract invoke \
  --id "$TOKEN_VOTES_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --token "$SEP41_TOKEN" \
  2>/dev/null && ok "token-votes initialized" \
  || warn "token-votes already initialized"

# -- Delegate to self so the test identity has voting power -----------
info "Delegating voting power to deployer ..."
stellar contract invoke \
  --id "$TOKEN_VOTES_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- delegate \
  --delegator "$DEPLOYER_ADDR" \
  --delegatee "$DEPLOYER_ADDR" \
  2>/dev/null && ok "Delegation set" \
  || warn "Delegation already set or failed"

# -- Initialize timelock (min_delay=0 for instant execution) ----------
TIMELOCK_GOVERNOR="${GOVERNOR_ADDRESS:-$DEPLOYER_ADDR}"
TIMELOCK_DELAY="${TIMELOCK_MIN_DELAY:-0}"

info "Initializing timelock (min_delay=$TIMELOCK_DELAY) ..."
stellar contract invoke \
  --id "$TIMELOCK_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --governor "$TIMELOCK_GOVERNOR" \
  --min_delay "$TIMELOCK_DELAY" \
  2>/dev/null && ok "timelock initialized" \
  || warn "timelock already initialized"

# -- Initialize governor with minimal E2E-friendly settings -----------
# voting_delay=1 (≈5s), voting_period=10 (≈50s), quorum_numerator=0, proposal_threshold=0
DELAY="${VOTING_DELAY:-1}"
PERIOD="${VOTING_PERIOD:-10}"
QUORUM="${QUORUM_NUMERATOR:-0}"
THRESHOLD="${PROPOSAL_THRESHOLD:-0}"

info "Initializing governor (delay=$DELAY, period=$PERIOD, quorum=$QUORUM, threshold=$THRESHOLD) ..."
stellar contract invoke \
  --id "$GOVERNOR_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --votes_token "$TOKEN_VOTES_ADDRESS" \
  --timelock "$TIMELOCK_ADDRESS" \
  --voting_delay "$DELAY" \
  --voting_period "$PERIOD" \
  --quorum_numerator "$QUORUM" \
  --proposal_threshold "$THRESHOLD" \
  2>/dev/null && ok "governor initialized" \
  || warn "governor already initialized"

# ====================================================================
# Persist NEXT_PUBLIC_* vars for the frontend
# ====================================================================
persist "NEXT_PUBLIC_GOVERNOR_ADDRESS" "$GOVERNOR_ADDRESS"
persist "NEXT_PUBLIC_TIMELOCK_ADDRESS" "$TIMELOCK_ADDRESS"
persist "NEXT_PUBLIC_VOTES_ADDRESS" "$TOKEN_VOTES_ADDRESS"
persist "NEXT_PUBLIC_NETWORK" "testnet"

# ====================================================================
# Summary
# ====================================================================
printf '\n'
info "============================================================"
info "  E2E testnet deployment complete"
info "============================================================"
info "  Env file ............. $ENV_FILE"
info "  Identity ............ $DEPLOYER_ADDR"
info "  Token-Votes ......... $TOKEN_VOTES_ADDRESS"
info "  Timelock ............ $TIMELOCK_ADDRESS"
info "  Governor ............ $GOVERNOR_ADDRESS"
info ""
info "  voting_delay ........ 1 ledger (~5 s)"
info "  voting_period ....... 10 ledgers (~50 s)"
info "  quorum_numerator .... 0"
info "  proposal_threshold .. 0"
info "  timelock min_delay .. 0"
info "============================================================"
printf '\n'

info "Next steps:"
info "  1. Export the deployer secret key:"
info "     stellar keys show $IDENTITY"
info "  2. Set TESTNET_SECRET_KEY in $ENV_FILE"
info "  3. Run: pnpm --filter app test:e2e"
