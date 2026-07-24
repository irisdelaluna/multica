---
name: multica-codebase-orientation
description: "Use on any task in this repository to orient before acting. The shared floor every agent holds so any idle agent can take any issue. Maps where things live (Go backend under server/ with handlers, services, sqlc queries and migrations; pnpm/turbo monorepo with headless logic in packages/core, shared views in packages/views, primitives in packages/ui, thin shells in apps/web and apps/desktop; deep source-cited reference under contract/maps), how to run and check things (make dev/start/check/test/sqlc, worktree isolation via .env.worktree, the Node 22 pin, Playwright needs a running stack), the non-negotiable rules that are not obvious (no new foreign keys, every index CONCURRENTLY in its own single-statement migration, parse API JSON through zod not cast, nothing to the iris trunk), and where the hard-won gotchas live (the muninn vaults and contract/maps). A map to reread deliberately, not an encyclopaedia; CLAUDE.md and contract/maps hold the depth."
user-invocable: false
allowed-tools: Bash(make *), Bash(pnpm *), Bash(go *), Bash(git *), Bash(gh *)
---

# Multica codebase orientation

The shared floor. This is the map of *this* repository — where anything lives,
what to run, the rules that bite, and where the depth is kept — so any agent can
be handed any issue here and know where to start. It is a map, not an
encyclopaedia: `CLAUDE.md` holds the authoritative rules, `contract/maps/` holds
source-cited depth, and the muninn vaults hold the gotchas. Read those for depth
rather than expanding this skill.

## Where things live

| Area | What it is |
| --- | --- |
| `server/` | Go backend (Chi router, sqlc, gorilla/websocket). HTTP in `server/internal/handler`, domain logic in `server/internal/service`, hand-written SQL in `server/pkg/db/queries`, sqlc-generated code in `server/pkg/db/generated`, migrations in `server/migrations`, entrypoints (`server`, `multica`, `migrate`) in `server/cmd`. |
| `packages/core/` | Headless business logic — API client, React Query hooks, Zustand stores. No `react-dom`, no `localStorage`, no `process.env`. |
| `packages/ui/` | Atomic primitives only. No `@multica/core` imports, no business logic. |
| `packages/views/` | Shared business pages/components for web and desktop. No `next/*`, no router imports — use the `NavigationAdapter`. |
| `packages/tsconfig/` | Shared TypeScript config. |
| `apps/web/` | Next.js App Router shell. `apps/web/platform/` is the only place for Next.js APIs. |
| `apps/desktop/` | Electron shell. `apps/desktop/.../platform/` is the only place for `react-router-dom` wiring. |
| `apps/mobile/` | Expo / React Native. Independent — read `apps/mobile/CLAUDE.md` before touching it. |
| `contract/maps/` | Comprehension maps (`api.md`, `api-shape-conventions.md`, `realtime.md`, `storage.md`, `agent-pipeline.md`). Deep, file-cited reference. |
| `contract/rfcs/` | Design RFCs. |

Dependency direction is `views → core + ui`; `core` and `ui` must stay
independent. Server state is TanStack Query; client/view state is Zustand, and
all shared Zustand stores live in `packages/core/`.

## Run and check

| Command | Covers |
| --- | --- |
| `make dev` | Bootstrap this checkout end-to-end — env, DB, migrations, then start services. |
| `make start` / `make stop` | Start (migrate first) / stop backend + frontend for this checkout. `stop` kills only the port *listener*, never the daemon's open connections. |
| `make server` | Run the Go server only. |
| `make check` | Full pipeline: `pnpm typecheck` → `pnpm test` (Vitest) → Go tests → Playwright E2E. It starts backend + frontend itself for the E2E leg. |
| `make test` | Go tests with `-race`, after migrating. |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | TypeScript side (Vitest via Turborepo). |
| `make sqlc` | Regenerate sqlc after editing anything in `server/pkg/db/queries/`. |
| `make migrate-up` / `make migrate-down` | Apply / roll back migrations. |
| `make worktree-env` | Generate `.env.worktree` with a unique DB name + ports for this worktree. |

Worktrees: anything needing its own database or ports runs in a worktree off
`.env.worktree`; the main checkout uses `.env`. Worktrees share one PostgreSQL
container (`make db-up` starts it); each gets an isolated DB name and app ports.

Runtimes: Node 22 is pinned in CI (`.github/workflows/*.yml`); Go 1.26.1
(`server/go.mod`). Use Node 22 — the repo is shaped around it and other versions
produce phantom failures that are not real bugs.

Playwright (`pnpm exec playwright test`) needs an already-running stack. `make
check` brings one up for you; if you run Playwright standalone, `make start`
first.

## Hard rules (non-negotiable, and not obvious)

These cost real time when missed. `CLAUDE.md` is the authority.

- **No new database foreign keys**, cascading deletes, or cascading updates.
  Existing foreign keys are legacy from early migrations; resolve relationships
  and dependent cleanup in application code, with a transaction when it must be
  atomic.
- **Every index a migration creates** — including unique indexes and indexes on
  new tables — uses `CREATE INDEX CONCURRENTLY`, each in its own
  single-statement migration file. Concurrent builds cannot run inside a
  transaction or a multi-command string.
- **Parse API JSON through zod** via `parseWithFallback`
  (`packages/core/api/schema.ts`); never cast network JSON to `T`. Downstream UI
  optional-chains and defaults defensively.
- **Nothing pushed straight to the trunk.** The trunk is `iris`; repo changes go
  on a branch with a PR against `iris` (see `multica-working-on-issues`). `main`
  mirrors upstream.

## Gotchas and depth

- **Gotchas live in the muninn vaults.** The thing that cost someone hours — a
  phantom failure, a silent contract, a non-obvious dependency — is recalled
  before work and remembered after, per `multica-muninn-memory`. That is where
  such things go; this skill points at them rather than restating them.
- **Depth lives in `contract/maps/`.** Before changing a subsystem, read its map
  (e.g. `api-shape-conventions.md` before touching wire shapes, `realtime.md`
  before WebSocket/cache work).
- **Conventions** (naming, i18n glossary, product voice) live in
  `apps/docs/content/docs/developers/conventions.mdx`. `CLAUDE.md` is the
  authoritative rules file; `AGENTS.md` is a short pointer to it.

## Why this is a skill, not the runtime brief

A rule every agent must be reminded of on *every* task, regardless of repo,
belongs in the runtime brief. This skill is different: it is **repo-specific
orientation an agent can reread deliberately** — the map of this codebase, which
the workspace-generic runtime brief cannot carry. The two do not overlap: the
brief carries platform and agent process; this skill carries the repo map, the
repo-specific hard rules, and the pointers to depth. If anything here ever
becomes a repo-agnostic directive every agent needs on every task, move it to
the runtime brief.

## Incorrect → Correct

Incorrect: start editing from the issue title alone.
  → Read this map, then the relevant `contract/maps/` file, then recall the vault.

Incorrect: `const issue = await res.json() as Issue`.
  → `parseWithFallback(res, IssueSchema)` through a zod schema.

Incorrect: add a `FOREIGN KEY`, or a two-statement migration that builds a
concurrent index.
  → Application-layer relationship; one `CREATE INDEX CONCURRENTLY` per file.

Incorrect: push a commit straight to `iris`.
  → Branch + PR against `iris`; link the issue key.

## References

`references/codebase-orientation-source-map.md` — where each claim's authority
lives: `CLAUDE.md` sections, `Makefile` targets, `scripts/check.sh`, `sqlc.yaml`,
the CI workflow, the package layout, and the runtime brief.
