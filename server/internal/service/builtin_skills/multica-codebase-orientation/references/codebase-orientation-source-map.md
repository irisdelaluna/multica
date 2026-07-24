# Codebase orientation — source map

Every claim in `SKILL.md` traces to an authority below. Like the other repo
skills this map pins real files (not `file:line`, which rots on every commit);
re-derive against the live tree before trusting a detail. A claim is "still true"
while the named file/dir/target exists and still says what the skill says it says
— the `_test.go` checks that mechanically for the structural claims.

## Authority for each claim

| Claim in SKILL.md | Authority |
| --- | --- |
| Go backend under `server/`; HTTP in `internal/handler`, domain in `internal/service`, entrypoints in `cmd` | `server/` layout: `server/cmd/{server,multica,migrate}`, `server/internal/handler/`, `server/internal/service/`. |
| sqlc queries in `server/pkg/db/queries`, generated code in `server/pkg/db/generated`, migrations in `server/migrations` | `server/sqlc.yaml` (`queries: pkg/db/queries/`, `out: pkg/db/generated`, `schema: migrations/`); migration files in `server/migrations/`. |
| `packages/core` headless logic, no `react-dom`/`localStorage`/`process.env`; `packages/ui` primitives, no `@multica/core`; `packages/views` no `next/*`/router | `CLAUDE.md` → Package Boundaries (hard constraints); packages exist under `packages/`. |
| `apps/web/platform` only place for Next.js APIs; `apps/desktop/.../platform` only place for `react-router-dom` | `CLAUDE.md` → Package Boundaries / Web/Desktop Features. |
| `apps/mobile` independent; read `apps/mobile/CLAUDE.md` first | `CLAUDE.md` → Mobile Rules; `apps/mobile/CLAUDE.md` exists. |
| Dependency direction `views → core + ui`; `core` and `ui` independent; server state = TanStack Query, client state = Zustand in `packages/core` | `CLAUDE.md` → Project Shape, State Rules. |
| `contract/maps/` files: `api.md`, `api-shape-conventions.md`, `realtime.md`, `storage.md`, `agent-pipeline.md` | `contract/maps/` directory listing. |
| `make dev` bootstraps; `make start`/`stop` run/stop backend+frontend; `stop` kills only the listener not daemon connections | `Makefile` targets `dev`, `start`, `stop`; `stop` recipe comment cites IRI-64 (`-sTCP:LISTEN`). |
| `make check` = typecheck → Vititest → Go tests → Playwright E2E, starts the stack itself | `scripts/check.sh` steps 1–5 (starts backend+frontend before Playwright). |
| `make test` = Go tests with `-race` after migrate; `make sqlc` regenerates; `migrate-up/down`; `worktree-env` | `Makefile` targets `test`, `sqlc`, `migrate-up`, `migrate-down`, `worktree-env`; `scripts/test-go.sh`. |
| Worktrees share one PostgreSQL container, isolate DB name + ports via `.env.worktree`; main uses `.env` | `Makefile` (`MAIN_ENV_FILE`/`WORKTREE_ENV_FILE`, `db-up`); `scripts/init-worktree-env.sh` (unique `POSTGRES_DB`, backend/frontend ports). |
| Node 22 pinned in CI; Go 1.26.1 in `server/go.mod`; other Node versions give phantom failures | `.github/workflows/ci.yml` (`node-version: 22`); `server/go.mod` (`go 1.26.1`); `CLAUDE.md` → Commands ("CI runs Node 22"). |
| Playwright needs an already-running stack | `scripts/check.sh` step 4 starts services before step 5 Playwright; `CLAUDE.md` → Commands. |
| No new foreign keys; existing FKs are legacy | `CLAUDE.md` → Database and Migration Rules. Legacy FKs survive in early migrations (`001_init`, `004`, `018`, `109`); recent migrations add none. |
| Every index `CREATE INDEX CONCURRENTLY`, one per single-statement migration | `CLAUDE.md` → Database and Migration Rules; observed in recent single-statement index migrations. |
| Parse API JSON via `parseWithFallback` + zod, never cast | `CLAUDE.md` → API Compatibility; `packages/core/api/schema.ts` (`parseWithFallback`). |
| Nothing to trunk; trunk is `iris`; changes via branch + PR against `iris`; `main` mirrors upstream | Workspace runtime brief (repo changes go on a branch with a PR against `iris`); `multica-working-on-issues` skill; default branch `iris` with `main` mirroring upstream. |
| Gotchas live in the muninn vaults; recall/remember per `multica-muninn-memory` | `multica-muninn-memory` skill (two-vault architecture, recall-before-work / remember-after-work). |
| Conventions in `apps/docs/content/docs/developers/conventions.mdx`; `CLAUDE.md` authoritative, `AGENTS.md` a pointer | `CLAUDE.md` → Conventions; `AGENTS.md` ("concise pointer document … live in CLAUDE.md"). |

## What this skill deliberately does NOT do

- No `file:line` citations in the body — they rot on every commit. Structural
  anchors (directory names, make targets, config files) are stable enough that a
  change is a real restructuring, which is exactly when the skill becomes a lie
  and the test should fail.
- No restatement of gotchas — they live in the vaults and would drift from the
  convergent record. This skill points at `multica-muninn-memory`.
- No restatement of wire shapes, enums, or cache semantics — those live in
  `contract/maps/` and are kept source-cited there.
- No Haskell packages claim. The repo was once polyglot (a Haskell API mirror
  consumed by `contract/maps`); that line was folded into mainline and no
  `.hs`/`.cabal` sources remain. A dangling `cabal.project` exists at the root
  but resolves to nothing. Do not re-add a Haskell claim unless sources return.
