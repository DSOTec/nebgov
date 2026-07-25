# Troubleshooting Guide

Common errors when interacting with NebGov on Stellar, along with their causes and fixes.

---

## Table of Contents

- [RPC Errors](#rpc-errors)
- [Wallet Errors](#wallet-errors)
- [Transaction Errors](#transaction-errors)
- [Contract Errors](#contract-errors)
- [Voting and Proposals](#voting-and-proposals)
- [Liquidity Contract Errors](#liquidity-contract-errors)
- [FAQ](#faq)

---

## RPC Errors

### `Error: Simulation failed: HostError`

**Cause:** The contract invocation failed during simulation. Common reasons: wrong function name, incorrect argument types, or the contract is not deployed at the configured address.

**Fix:**
1. Verify the function name matches the contract ABI exactly (case-sensitive).
2. Check that all argument types are correct (e.g., `u32` vs `i128`, `Address` vs `String`).
3. Confirm `NEXT_PUBLIC_GOVERNOR_ADDRESS` in your `.env` points to a deployed contract on the correct network.
4. Run the simulation manually with `stellar contract invoke --simulate-only` to inspect the full error.

---

### `RPC connection refused` / `Failed to fetch`

**Cause:** The app cannot reach the Stellar RPC endpoint. The `NEXT_PUBLIC_RPC_URL` environment variable is missing or points to the wrong host.

**Fix:**
1. Open your `.env` (or `.env.local`) and verify `NEXT_PUBLIC_RPC_URL`.
   - Testnet: `https://soroban-testnet.stellar.org`
   - Futurenet: `https://rpc-futurenet.stellar.org`
   - Mainnet: `https://soroban-mainnet.stellar.org`
2. Restart the dev server after changing `.env`.
3. Check that your firewall or VPN is not blocking outbound HTTPS to port 443.

---

### `Error: Network mismatch`

**Cause:** The wallet is connected to a different Stellar network than the one the app targets.

**Fix:**
1. In your wallet (Freighter, Lobstr, etc.), switch to the network specified in `NEXT_PUBLIC_NETWORK_PASSPHRASE`.
2. The passphrase values are:
   - Testnet: `Test SDF Network ; September 2015`
   - Mainnet: `Public Global Stellar Network ; September 2015`

---

## Wallet Errors

### `Wallet not connected` / `No wallet found`

**Cause:** `WalletKitProvider` is not wrapping the component tree, or the provider was initialized after the component mounted.

**Fix:**
1. Ensure `<WalletKitProvider>` wraps your root layout in `app/layout.tsx` (or equivalent).
2. Do not conditionally render the provider — it must wrap the tree unconditionally.
3. If using `useWalletKit()`, confirm you are inside a component that is a descendant of the provider.

---

### `User declined the transaction`

**Cause:** The user cancelled the signing prompt in their wallet extension.

**Fix:** This is expected behavior. Show a non-blocking notification and allow the user to retry. Do not treat this as an application error.

---

### `PublicKey is not valid`

**Cause:** The wallet returned an empty or malformed public key. This can happen when the wallet is locked or has not yet granted permission to the dApp.

**Fix:**
1. Unlock your wallet and approve the site connection request.
2. Disconnect and reconnect via the Connect Wallet button.
3. If the issue persists, clear wallet permissions for the site and reconnect.

---

## Transaction Errors

### `Transaction rejected: insufficient fee`

**Cause:** The submitted fee is too low for current network conditions. The Stellar network uses a fee market during congestion.

**Fix:**
1. Use fee bumping: submit the transaction with a higher `base_fee` (e.g., 1 000 000 stroops during high congestion).
2. The SDK's `submitTransaction` helper retries with fee bumping automatically. Ensure you are on SDK v0.3.0+.
3. Monitor current base fees with `stellar ledger fetch --network testnet | jq .base_fee`.

---

### `Transaction expired`

**Cause:** The transaction's `timeBounds` window elapsed before it was included in a ledger. This often happens when the user delays signing.

**Fix:**
1. Increase `timeboundsSeconds` in the transaction builder (default is 30 s; try 120 s for complex multi-step flows).
2. Prompt the user to sign promptly after building the transaction.

---

### `Error: Ledger entry not found`

**Cause:** A persistent storage entry (e.g., a proposal or LP position) does not exist at the queried key. The contract may be on a different network than expected.

**Fix:**
1. Confirm `NEXT_PUBLIC_GOVERNOR_ADDRESS` and `NEXT_PUBLIC_TIMELOCK_ADDRESS` are set for the correct network.
2. Verify the data was written in a transaction that was successfully included in the ledger (not just simulated).

---

## Contract Errors

### `Proposal not found` (`GovernorError::ProposalNotFound`)

**Cause:** The proposal ID does not exist in the governor contract. Either the wrong contract address is configured, or the proposal was never created on this network.

**Fix:**
1. Verify `NEXT_PUBLIC_GOVERNOR_ADDRESS` matches the deployed governor on the active network.
2. Confirm the proposal was created by checking the transaction that called `propose()`.

---

### `Not authorized` / `require_auth` failed

**Cause:** The caller's signature was not present in the transaction authorization envelope, or the wrong address was passed as the `caller` argument.

**Fix:**
1. Ensure the wallet's public key matches the address passed to privileged functions (e.g., `governor`, `admin`, `provider`).
2. When constructing the transaction, call `addSignatureBase64` or equivalent for each required signer before submitting.

---

### `Pool not found` (`LiquidityError::PoolNotFound`)

**Cause:** No liquidity pool exists for the given outcome pair, or the pair was registered under a different token ordering.

**Fix:**
1. Confirm `create_pool` and `initialize_pool` were called by the governor for this outcome pair.
2. Outcome pair ordering is canonical (smaller id first) — querying `(1, 2)` and `(2, 1)` resolve to the same pool.
3. Check that the `NEXT_PUBLIC_LIQUIDITY_ADDRESS` env var points to the correct contract.

---

## Voting and Proposals

### `Vote period not started`

**Cause:** `cast_vote` was called before the proposal's `start_ledger`. The proposal is in `Pending` state.

**Fix:**
1. Call `governor.state(proposal_id)` to get the current state.
2. Read `proposal.start_ledger` and wait until the current ledger sequence surpasses it.
3. The UI should disable the Vote button until the proposal is `Active`.

---

### `Already voted` (`GovernorError::AlreadyVoted`)

**Cause:** The wallet address has already cast a vote for this proposal. The contract rejects duplicate votes.

**Fix:** Each address may vote only once per proposal. Show the user their existing vote choice instead of the voting form.

---

### `Insufficient voting power`

**Cause:** The user has no delegated voting power at the proposal's snapshot ledger. Tokens must be delegated (self-delegated or to another account) before the proposal was created.

**Fix:**
1. Call `votes.delegate(account, account)` to self-delegate before the next proposal is created.
2. Wrapping tokens via `token_votes.wrap(amount)` and then delegating grants voting power.
3. Voting power is snapshotted at `proposal.start_ledger - 1`; delegation after that point does not count for this proposal.

---

### `Proposal not in voting period` (`GovernorError::ProposalNotActive`)

**Cause:** `cast_vote` was called when the proposal is in `Succeeded`, `Defeated`, `Queued`, `Executed`, or `Expired` state.

**Fix:** Check `governor.state(proposal_id)` before casting a vote. Only `Active` proposals accept new votes.

---

## Liquidity Contract Errors

### `Imbalanced deposit: amount_b below required ratio`

**Cause:** A subsequent deposit to a pool provided a `amount_b` that is less than the proportional amount required by the current reserve ratio. This prevents price manipulation.

**Fix:**
1. Fetch the current pool reserves with `liquidity.get_pool(outcome_a, outcome_b)`.
2. Compute `required_b = amount_a * reserve_b / reserve_a` before calling `add_liquidity`.
3. Pass `required_b` (or a value greater than it) as `amount_b`.

---

### `Below minimum liquidity`

**Cause:** The deposit amount is below `MIN_LIQUIDITY` (1 000 units). Tiny deposits are rejected to prevent dust griefing.

**Fix:** Ensure both `amount_a` and the computed `required_b` are at least 1 000 units.

---

### `Slippage exceeded`

**Cause:** The swap output `amount_out` after fees is less than the caller's `min_amount_out`. The pool moved between simulation and execution.

**Fix:**
1. Re-simulate the swap immediately before submitting to get the latest output.
2. Add a slippage tolerance (e.g., 0.5%) to `min_amount_out`: `min_amount_out = simulated_out * 995 / 1000`.

---

## FAQ

**Q: How do I find the correct contract addresses for my network?**

A: Contract addresses are published in [scripts/](../scripts/) after each deployment. You can also query the factory: `liquidity.governor()` returns the governor address linked to the liquidity contract.

**Q: My transaction simulates successfully but fails on-chain. Why?**

A: State can change between simulation and submission (another transaction was included first). Retry the simulation immediately before resubmitting, or add a short polling loop.

**Q: How do I run contract calls without the frontend?**

A: Use the Stellar CLI:
```bash
stellar contract invoke \
  --network testnet \
  --id <CONTRACT_ADDRESS> \
  --source <SECRET_KEY> \
  -- <function_name> --arg1 value1
```

**Q: Can I test on Futurenet before Testnet?**

A: Yes. Set `NEXT_PUBLIC_RPC_URL` to `https://rpc-futurenet.stellar.org` and `NEXT_PUBLIC_NETWORK_PASSPHRASE` to the Futurenet passphrase. Deploy contracts to Futurenet first using `stellar contract deploy --network futurenet`.

**Q: How do I reset local state during development?**

A: Re-initialize the contracts with fresh deployments:
```bash
stellar contract deploy --wasm target/wasm32v1-none/release/sorogov_governor.wasm --network testnet --source <KEY>
```
Update the address in `.env.local` and restart the dev server.

**Q: Why does `get_lp_position` return 0 even after adding liquidity?**

A: The provider address queried must exactly match the one used in `add_liquidity`. Also verify that `outcome_a` and `outcome_b` are in the correct order (use canonical order: smaller id first, e.g., `(0, 1)` not `(1, 0)`).
