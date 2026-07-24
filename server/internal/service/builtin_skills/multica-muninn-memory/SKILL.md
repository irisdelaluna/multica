---
name: multica-muninn-memory
description: "Use at the start and end of every Multica task to keep organizational long-term memory in the 'multica' MuninnDB vault. Teaches the recall-before-work / remember-after-work discipline: recall prior context at task start (muninn_where_left_off for a single-user vault, or a scoped muninn_recall for the shared 'multica' vault), orient with muninn_guide and its Vault Configuration, store atomic one-concept memories with muninn_remember / muninn_remember_batch (type, summary, entities), update an existing memory with muninn_evolve rather than forget+remember, and link related memories with muninn_link so the knowledge graph accretes without human bookkeeping."
user-invocable: false
allowed-tools: mcp__muninn__*
---

# Muninn long-term memory discipline

The Multica workspace keeps durable organizational memory in a MuninnDB vault
named **`multica`**. This skill is the recall / remember loop every agent runs
around a task, so context survives across runs without a human writing it down.

The authoritative reference for tool parameters is `muninn_guide`; call it once
if a tool's shape is unclear. Every claim below traces to a source in
`references/muninn-memory-source-map.md`.

## The loop, once per task

1. **Recall before work** — orient in the `multica` vault before doing anything.
2. **Work** — do the task.
3. **Remember after work** — store atomic decisions and outcomes.
4. **Link** — connect related memories so the graph accretes.

## Step 1 — recall at task start

The `multica` vault is **shared** across agents and people (organizational
memory, not per-user). That shapes which orientation call to use first:

- In a **single-user** vault, `muninn_where_left_off` returns the most recently
  accessed active memories — a good "where was I" snapshot.
- In a **shared** vault like `multica`, `muninn_where_left_off` is vault-wide:
  it surfaces *everyone's* recent activity, including other agents' and users'.
  Do not treat it as your own resume. Use a **scoped** `muninn_recall` instead.

How to scope recall in `multica`:

- Semantic: `muninn_recall` with `context` phrases naming the task, issue, and
  component you are about to touch.
- Tag: `muninn_recall` with `tag_filter` or `tags_all` bound to the issue key,
  project, or component (e.g. `tags_any: ["IRI-5"]`).
- `mode` / `profile` tune breadth: `recent` for last-touch, `deep` for
  exhaustive graph traversal, `adversarial` to surface contradictions.

If `muninn_guide` reports the vault as single-user, `muninn_where_left_off` is
fine as the first call. When in doubt, check `muninn_guide`'s Vault
Configuration section — it states whether the vault is shared.

## Step 2 — remember at task end, atomically

Store durable outcomes with `muninn_remember` (or `muninn_remember_batch` for
several at once). **One concept per memory** — atomic memories produce sharper
embeddings, cleaner associations, and accurate contradiction detection. A task
that produced three decisions writes three memories, not one paragraph.

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
old one, and preserves provenance. This is the update path.

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

Correct:
  1. At start: `muninn_recall` scoped to the issue/component (shared `multica`
     vault), or `muninn_where_left_off` only if `muninn_guide` says single-user.
  2. At end: one `muninn_remember` per atomic decision/outcome, with `type`,
     `summary`, and `entities`.
  3. On a change: `muninn_evolve` on the existing id.
  4. `muninn_link` the new memory to what it relates to.

## Tool cheat-sheet

| Intent | Tool |
| --- | --- |
| Full parameter reference; Vault Configuration (shared?) | `muninn_guide` |
| Vault health / capacity | `muninn_status` |
| Where I left off — single-user only | `muninn_where_left_off` |
| Semantic / scoped recall (use this in `multica`) | `muninn_recall` |
| Store one atomic memory | `muninn_remember` |
| Store several atomic memories | `muninn_remember_batch` |
| Update an existing memory (NOT delete) | `muninn_evolve` |
| Soft-delete a wrong memory (7-day recovery) | `muninn_forget` / `muninn_restore` |
| Read one memory by id | `muninn_read` |
| Connect two memories | `muninn_link` |
| Walk the graph from a memory | `muninn_traverse` |

## References

`references/muninn-memory-source-map.md` — where each claim's authority lives:
the runtime-injected MCP server instructions, `muninn_guide`'s Vault
Configuration, and the canonical MuninnDB tool semantics. The vault name
`multica` comes from this project's configuration, not from Multica Go source.
