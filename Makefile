.PHONY: test-contracts build-wasm deploy-testnet verify-testnet fmt lint

CONTRACT_PACKAGES := \
	-p sorogov-governor \
	-p sorogov-timelock \
	-p sorogov-token-votes \
	-p sorogov-governor-factory \
	-p sorogov-treasury \
	-p sorogov-liquidity \
	-p sorogov-co-sponsorship \
	-p sorogov-conviction-voting \
	-p sorogov-token-votes-wrapper \
	-p sorogov-signal-anchor \
	-p sorogov-proposal-bonds \
	-p sorogov-treasury-strategies \
	-p sorogov-optimistic-governor \
	-p sorogov-voting-rewards

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
