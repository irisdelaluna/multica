/**
 * Path-template bindings.
 *
 * Fixtures need real subjects (a workspace, an issue) that exist on whatever
 * instance the harness is pointed at. Rather than hardcoding ids — which
 * would rot the moment the database is reseeded — the harness discovers them
 * from the target itself, so the same fixture set replays against a fresh
 * instance, a reseeded dev box, or a future Haskell implementation.
 */

import { call } from "./client.ts";

export type Bindings = Record<string, string>;

/** Read a list response that may be a bare array or an envelope. */
export function items(body: unknown, collection?: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && collection) {
    const inner = (body as Record<string, unknown>)[collection];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

export async function discover(token: string): Promise<Bindings> {
  const bindings: Bindings = {};

  const workspaces = await call("GET", "/api/workspaces", { token });
  const workspace = items(workspaces.body)[0] as { id?: string } | undefined;
  if (workspace?.id) bindings.workspace = workspace.id;

  const issues = await call("GET", "/api/issues", { token, workspace: true });
  const issue = items(issues.body, "issues")[0] as { id?: string } | undefined;
  if (issue?.id) bindings.issue = issue.id;

  return bindings;
}

export function fill(path: string, bindings: Bindings): string | null {
  let out = path;
  for (const [key, value] of Object.entries(bindings)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return /\{[a-z_]+\}/.test(out) ? null : out;
}
