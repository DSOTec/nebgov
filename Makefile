.PHONY: test-contracts build-wasm deploy-testnet verify-testnet fmt lint

# Keep in sync with the package list in .github/workflows/rust.yml.
CONTRACTS := \
	sorogov-governor \
	sorogov-timelock \
	sorogov-token-votes \
	sorogov-governor-factory \
	sorogov-treasury \
	sorogov-liquidity \
	sorogov-token-votes-wrapper \
	sorogov-co-sponsorship \
	sorogov-conviction-voting \
	sorogov-signal-anchor \
	sorogov-proposal-bonds \
	sorogov-treasury-strategies \
	sorogov-optimistic-governor \
	sorogov-voting-rewards

CONTRACT_PACKAGES := $(foreach c,$(CONTRACTS),-p $(c))

test-contracts: build-wasm
	cargo test $(CONTRACT_PACKAGES) -- --nocapture

build-wasm:
	cargo build --release --target wasm32v1-none $(CONTRACT_PACKAGES)

deploy-testnet:
	./scripts/deploy-testnet.sh

verify-testnet:
	./scripts/verify-deployment.sh

fmt:
	cargo fmt --all

lint:
	cargo clippy $(CONTRACT_PACKAGES) -- -D warnings
