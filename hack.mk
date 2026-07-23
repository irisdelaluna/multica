# Fork-local tooling for the iris transformation trunk.
# Included from the root Makefile via a single `-include hack.mk` line —
# keep everything fork-specific here so upstream merges stay cheap.

# Upstream CI runs Node 22 (.github/workflows/ci.yml). Homebrew's default
# node is 26, whose flag-gated global localStorage breaks the vitest suites
# in packages/{core,views} and apps/desktop in both directions (absent
# without --localstorage-file, shadowing jsdom's Storage with it). Pin all
# repo commands to the keg-only node@22 for exact CI parity.
ifneq ($(wildcard /opt/homebrew/opt/node@22/bin),)
export PATH := /opt/homebrew/opt/node@22/bin:$(PATH)
endif
