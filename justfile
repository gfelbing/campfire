# Campfire task runner. Run `just` for help, `just <task>` to run a task.

default: help

help:
	@just --list

fmt:
	cargo fmt --all

lint:
	cargo clippy --workspace --all-targets -- -D warnings

test:
	cargo test --workspace

check: fmt lint test
	@echo "all checks passed"

build:
	cargo build --workspace --release

server:
	cargo run -p campfire-server --release --
