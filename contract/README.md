# contract

The compatibility contract, frozen as replayable artifacts.

The Go server **is** the contract by definition. This package records what it
actually returns, and replays those recordings against any candidate
implementation — a future Haskell service, a refactored handler, an upstream
merge that moved something. The point is not to describe the API; it is to
make a change to it *impossible to miss*.

## Layout

| Path | What it is |
| --- | --- |
| `endpoints.ts` | Curated endpoint inventory — the slice clients and ports actually depend on, not all ~330 routes (see `contract/maps/api.md` for the full survey) |
| `bindings.ts` | Discovers real subjects (workspace, issue) from the target so fixtures survive a reseeded database |
| `normalize.ts` | Replaces volatile values (uuids, timestamps, secrets) with stable placeholders |
| `client.ts` | Raw-fetch driver — deliberately independent of the TypeScript client, so it can point at any implementation |
| `recorder/record.ts` | Drives the reference server, writes golden fixtures |
| `conformance/verify.ts` | Replays fixtures against a target and reports pass / drift / fail |
| `fixtures/` | The recordings |

## Running

```bash
export CONTRACT_EMAIL=you@example.com
export CONTRACT_TOKEN=mul_...          # a PAT; the email-code flow is rate limited
pnpm --filter @multica/contract record  # against the reference server
pnpm --filter @multica/contract verify  # against any CONTRACT_API_BASE
```

## Verdicts

- **pass** — status, schema, and normalized shape all match.
- **drift** — status and schema still hold, but the shape moved. Consumers are
  not broken; the fixture is stale. Re-record and read the diff.
- **fail** — status mismatch, or the response no longer satisfies the zod
  schema the real clients parse with. This breaks consumers.

Only **fail** exits non-zero. Drift is reported loudly but does not gate, because
an additive field is not a contract break.

## Normalization

Identifiers and timestamps differ every run and carry no contract information —
what matters is that a field *is* a uuid in that position. Each distinct uuid
maps to a stable placeholder within one document (`<uuid:1>`, `<uuid:2>`), so
referential structure — this comment's `issue_id` equals that issue's `id` —
survives normalization and is still compared. Object keys are sorted so fixture
diffs do not depend on server field order.

## Contract facts discovered while building this

- List responses are **not uniform**. `/api/workspaces` returns a bare
  `Workspace[]`; `/api/issues`, `/api/labels` return envelopes
  (`{issues, total}`, `{labels, total}`). Specs declare `collection` to say
  which. Any client or port must handle both.
- Workspace members are not at `/api/members` — they live under
  `/api/workspaces/{id}/members`.

## When upstream changes

Re-record against the Go server, commit the fixture diff, and read it: that diff
*is* the upstream API change, stated in the only terms that matter.
