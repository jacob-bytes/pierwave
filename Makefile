# 本机沙箱限制：cargo/npm 的全局缓存在工作区外不可写，统一指到仓库内。
export CARGO_HOME := $(CURDIR)/.cargo-home
export NPM_CONFIG_CACHE := $(CURDIR)/.npm-cache

.PHONY: check fmt fmt-check clippy test build run web-install web-build web-test web-dev dev e2e verify-xray clean

check: fmt-check clippy test web-build web-test  ## 提交前跑这个（只校验格式，不改文件）

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

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

web-test:  ## 前端纯逻辑单测（node:test）
	cd web && npm test

e2e:  ## 端到端冒烟：master + agent + 期望态下发
	./scripts/e2e.sh

verify-xray:  ## 真机验证：用真实 Xray 起节点并实际连一次（退出时清理干净）
	cargo build --release -p pierwave-master
	./scripts/verify-xray.sh

web-dev:
	cd web && npm run dev

dev:  ## 后端 + 前端并行（两个终端更稳）
	cargo run -p pierwave-master

clean:
	cargo clean && rm -rf web/dist
