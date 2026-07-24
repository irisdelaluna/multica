# Muninn memory — source map

Every claim in `SKILL.md` traces to an authority below. Unlike the other
built-in skills, this one documents an **external** MCP server (MuninnDB), not
Multica Go behavior, so the authorities are the runtime-injected MCP
instructions, the `muninn_guide` reference, and MuninnDB's tool contracts — not
file:line in this repo. Re-derive against the live `muninn_guide` output before
trusting any tool detail; the contract is the authority, the line is a pointer.

## Why this source map looks different

The other built-in skills pin `server/.../*.go` because they describe Multica
backend behavior. This skill describes MuninnDB, a separate long-term-memory
server reached over MCP. At the time this skill was authored, the server-side
MCP overlay that injects the `muninn` server into agent runtimes was **future
work** (project track 2: "flag-gated server-side MCP overlay injection,
Composio pattern"). When that overlay lands, its merge-by-server-name logic
already exists at `server/internal/handler/mcp_overlay.go` — a `muninn` entry
under `mcpServers` is where the live wiring will live, and this note should be
updated then.

## Authority for each claim

| Claim in SKILL.md | Authority |
| --- | --- |
| Two-vault architecture: personal `multica-<agent-slug>` (read-write) + shared `multica` (read-only) | This Multica project's configuration: each agent owns a personal vault `multica-<agent-slug>` for its own perspective, reads `multica` for organizational truth, and does not write there. Quiet Scribe is the sole gluer that reconciles personal vaults into the shared one. |
| Personal vault is single-user → `muninn_where_left_off` is safe | `muninn_where_left_off` tool doc ("vault-wide: in a vault shared by multiple users or agents this includes other users' activity") — the inverse: a single-user vault only surfaces your own activity. |
| Shared vault is multi-user → use scoped `muninn_recall`, never write | `muninn_where_left_off` tool doc ("vault-wide: in a vault shared by multiple users or agents this includes other users' activity") + the runtime MCP instruction to scope `muninn_recall` by per-user tag in shared vaults |
| Recall before work / remember after work loop; atomic memories; `evolve` over `forget+remember`; link related | Runtime-injected MCP server instructions for the `muninn` server (the `<mcp_instructions>` block a task receives at session start when the overlay is active) |
| Canonical tool parameters and the full reference | `muninn_guide` output — the authoritative parameter reference; call it to re-derive any tool detail |
| Whether a vault is shared or single-user decides the orientation call | `muninn_guide` → Vault Configuration section states whether the vault is shared |
| `muninn_recall` scoping via `context`, `tag_filter` / `tags_all`, `mode`, `profile` | `muninn_recall` tool schema (context, tag_filter, tags_all, tags_any, mode, profile, threshold, annotate, since/before) |
| Store with `type`, `summary`, `entities` (+ `entity_relationships`); one concept per memory | `muninn_remember` / `muninn_remember_batch` tool doc + runtime MCP instruction ("Store with muninn_remember (include type, summary, entities)") and ("Keep memories atomic — one concept each") |
| `muninn_evolve` updates in place, archives the old version, preserves provenance; `forget` is a soft-delete, not an update | `muninn_evolve` tool doc ("Creates a new version and archives the old one") + runtime MCP instruction ("Update with muninn_evolve, not forget+remember"); `muninn_forget` ("Soft-delete … remains recoverable") + `muninn_restore` ("within the 7-day recovery window") |
| `muninn_link` typed relations connect memories into a traversable graph | `muninn_link` tool doc (relation enum + weight) and the `rel_types` enumerated there |
| `allowed-tools: mcp__muninn__*` fences the skill to the `muninn` MCP server's tools | The injected MCP server is named `muninn`; the `mcp__<server>__*` form is the Claude-Code tool-permission convention. Exact per-runtime tool-name prefix is finalized when the overlay (track 2) wires the server; the meaningful, stable contract is that the fence targets the `muninn` server. |

## Explicit non-claim: no Multica Go backend for MuninnDB today

The skill deliberately does **not** cite Multica Go file:line for any MuninnDB
behavior, because there is none: `muninn` appears nowhere in `server/` at
authoring time. The recall/remember/evolve/link contract is MuninnDB's own,
served over MCP. The only Multica-side code that will touch this is the MCP
overlay merger (`server/internal/handler/mcp_overlay.go`, merges by server name
under `mcpServers`) once track 2 injects the `muninn` server. If that wiring
lands, update both this map and the skill's overlay note.
