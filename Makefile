# 本机沙箱限制：cargo/npm 的全局缓存在工作区外不可写，统一指到仓库内。
export CARGO_HOME := $(CURDIR)/.cargo-home
export NPM_CONFIG_CACHE := $(CURDIR)/.npm-cache

.PHONY: check fmt clippy test build run web-install web-build web-dev dev e2e clean

check: fmt clippy test web-build  ## 提交前跑这个

fmt:
	cargo fmt --all

clippy:
	cargo clippy --workspace --all-targets --quiet -- -D warnings

test:
	cargo test --workspace --quiet

build:
	cargo build --workspace

run:
	cargo run -p pierwave-master

web-install:
	cd web && npm install --no-audit --no-fund

web-build:
	cd web && npm run build

e2e:  ## 端到端冒烟：master + agent + 期望态下发
	./scripts/e2e.sh

web-dev:
	cd web && npm run dev

dev:  ## 后端 + 前端并行（两个终端更稳）
	cargo run -p pierwave-master

clean:
	cargo clean && rm -rf web/dist
