---
name: multica-muninn-memory
description: "Use at the start and end of every Multica task to keep long-term memory across two MuninnDB vaults: a personal vault (multica-<agent-slug>) for your own perspective, and the shared 'multica' vault read-only for organizational orientation. Teaches the recall-before-work / remember-after-work discipline: recall prior context at task start (muninn_where_left_off in your personal vault, or a scoped muninn_recall in the shared vault), orient with muninn_guide and its Vault Configuration, store atomic one-concept memories with muninn_remember / muninn_remember_batch (type, summary, entities), update an existing memory with muninn_evolve rather than forget+remember, and link related memories with muninn_link so the knowledge graph accretes without human bookkeeping."
user-invocable: false
allowed-tools: mcp__muninn__*
---

# Muninn long-term memory discipline

The Multica workspace keeps durable long-term memory across **two** MuninnDB
vaults. This skill is the recall / remember loop every agent runs around a
task, so context survives across runs without a human writing it down.

## Two-vault architecture

| Vault | Purpose | Access |
| --- | --- | --- |
| `multica-<agent-slug>` | **Your own perspective** — what you learned, what surprised you, patterns you trust, approaches that failed. | Read-write |
| `multica` | **Organizational truth** — decisions, contracts, conventions shared across all agents and people. | Read-only |

Your personal vault (`multica-<agent-slug>`) is where you recall before work
and remember after work. The shared `multica` vault is for orientation only:
read it for context, but **never write to it**. Quiet Scribe is the sole agent
that reconciles personal vaults into the shared one.

Divergence between your personal vault and another agent's is **signal, not
error** — each agent has a unique perspective. The shared vault is the
convergent record.

The authoritative reference for tool parameters is `muninn_guide`; call it once
if a tool's shape is unclear. Every claim below traces to a source in
`references/muninn-memory-source-map.md`.

## The loop, once per task

1. **Recall before work** — orient in your personal vault, then read the shared
   vault for organizational context.
2. **Work** — do the task.
3. **Remember after work** — store atomic decisions and outcomes in your
   personal vault.
4. **Link** — connect related memories so the graph accretes.

## Step 1 — recall at task start

### Your personal vault (`multica-<agent-slug>`)

Your personal vault is **single-user** (your perspective only). Start here:

- `muninn_where_left_off` returns the most recently accessed active memories
  from your own prior runs — a good "where was I" snapshot.
- `muninn_recall` with `context` phrases naming the task, issue, and component
  you are about to touch, scoped to your personal vault.

### The shared vault (`multica`)

The `multica` vault is **shared** across agents and people (organizational
memory, not per-user). Read it for orientation, but **never write to it**.

- `muninn_where_left_off` is vault-wide: it surfaces *everyone's* recent
  activity. Do not treat it as your own resume.
- Use a **scoped** `muninn_recall` instead:
  - Semantic: `muninn_recall` with `context` phrases naming the task, issue,
    and component.
  - Tag: `muninn_recall` with `tag_filter` or `tags_all` bound to the issue key,
    project, or component (e.g. `tags_any: ["IRI-5"]`).
  - `mode` / `profile` tune breadth: `recent` for last-touch, `deep` for
    exhaustive graph traversal, `adversarial` to surface contradictions.

When in doubt, check `muninn_guide`'s Vault Configuration section — it states
whether a vault is shared.

## Step 2 — remember at task end, atomically

Store durable outcomes in **your personal vault** (`multica-<agent-slug>`) with
`muninn_remember` (or `muninn_remember_batch` for several at once). **One
concept per memory** — atomic memories produce sharper embeddings, cleaner
associations, and accurate contradiction detection. A task that produced three
decisions writes three memories, not one paragraph.

Always populate the fields that build the graph cheaply:

- `type` — built-in (`decision`, `observation`, `fact`, `task`, `procedure`,
  `goal`, `issue`, `constraint`) or a free-form `type_label`.
- `summary` — one line; providing it skips background summarization.
- `entities` + `entity_relationships` — named entities and typed edges
  (`uses`, `depends_on`, `belongs_to`, …) so the knowledge graph populates
  without a separate enrichment pass.

Remember what a future run will re-read: decisions and their rationale,
verified facts, outcomes, blockers, and the shape of a fix. Do **not** remember
ephemeral runtime bookkeeping (attempt counts, run timestamps, agent ids), raw
transcripts, secrets, or anything a single run consumes and discards.

## Step 3 — update with muninn_evolve, not forget + remember

When a fact **changes**, update the existing memory in place with
`muninn_evolve(id, new_content, reason)`. It creates a new version, archives the
old one, and preserves provenance. This is the update path — applies within
your personal vault.

`muninn_forget` is a **soft-delete** for a memory that is genuinely wrong or
should not exist (recoverable for 7 days via `muninn_restore`). It is **not** an
update. `forget` + `remember` discards identity, provenance, and every
association the old memory had earned — and the new memory gets a fresh ULID
that nothing points at. Reach for `evolve` first; reach for `forget` only to
remove.

## Step 4 — link related memories

After remembering, connect it to what it depends on, supersedes, or supports
with `muninn_link(source_id, target_id, relation, weight)`. Pick the most
specific relation: `supports`, `contradicts`, `depends_on`, `supersedes`,
`causes`, `precedes`, `resolves`, `blocks`, `implements`, `is_part_of`. Links
are what turn isolated facts into a traversable graph that `muninn_recall` and
`muninn_traverse` can walk.

## Incorrect → Correct

Incorrect: skip recall, do the task, dump a multi-topic summary as one memory.
  → Next run starts blind, and the bloated memory embeds poorly.

Incorrect: `forget` an old memory then `remember` the corrected fact.
  → Loses provenance, associations, and the old ULID every link pointed at.

Incorrect: write to the shared `multica` vault.
  → Quiet Scribe is the sole writer to the shared vault. Your writes there
     would be overwritten or create conflicts.

Correct:
  1. At start: `muninn_where_left_off` in your personal vault, then scoped
     `muninn_recall` in the shared `multica` vault for organizational context.
  2. At end: one `muninn_remember` per atomic decision/outcome in your personal
     vault, with `type`, `summary`, and `entities`.
  3. On a change: `muninn_evolve` on the existing id in your personal vault.
  4. `muninn_link` the new memory to what it relates to.

## Tool cheat-sheet

| Intent | Tool | Vault |
| --- | --- | --- |
| Full parameter reference; Vault Configuration (shared?) | `muninn_guide` | — |
| Vault health / capacity | `muninn_status` | — |
| Where I left off — personal vault | `muninn_where_left_off` | personal |
| Semantic / scoped recall (shared vault) | `muninn_recall` | shared |
| Store one atomic memory | `muninn_remember` | personal |
| Store several atomic memories | `muninn_remember_batch` | personal |
| Update an existing memory (NOT delete) | `muninn_evolve` | personal |
| Soft-delete a wrong memory (7-day recovery) | `muninn_forget` / `muninn_restore` | personal |
| Read one memory by id | `muninn_read` | either |
| Connect two memories | `muninn_link` | personal |
| Walk the graph from a memory | `muninn_traverse` | either |

## References

`references/muninn-memory-source-map.md` — where each claim's authority lives:
the runtime-injected MCP server instructions, `muninn_guide`'s Vault
Configuration, and the canonical MuninnDB tool semantics. The vault names
`multica` and `multica-<agent-slug>` come from this project's configuration,
not from Multica Go source.
