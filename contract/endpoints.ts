/**
 * Curated endpoint inventory for contract conformance.
 *
 * Deliberately NOT all ~330 routes (see contract/maps/api.md for the full
 * survey). This is the slice the new clients and the first ported endpoint
 * groups actually depend on: authenticate, find your workspace, read and
 * write issues, read the people and agents an issue can point at.
 *
 * Each entry names the zod schema in `@multica/core/api/schemas` that the
 * response must satisfy. `schema: null` means the contract for that response
 * is currently unvalidated upstream — recorded so the gap is visible rather
 * than silently absent.
 */

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface EndpointSpec {
  /** Stable fixture name: `<group>/<name>.json`. */
  name: string;
  group: string;
  method: Method;
  /** Path template; `{issue}` etc. are filled from the recorder's seeded state. */
  path: string;
  /** Named export in `@multica/core/api/schemas`, or null when upstream has none. */
  schema: string | null;
  /** Workspace-scoped requests need the workspace header. */
  workspace?: boolean;
  /** Request body, if any. Templated the same way as `path`. */
  body?: unknown;
  /** Skip during replay: the request mutates state and is recorded for shape only. */
  readOnly?: boolean;
  /**
   * Where the list lives when the response is an envelope rather than a bare
   * array. Upstream is not uniform: `/api/workspaces` returns `Workspace[]`,
   * `/api/issues` returns `{issues, total}`. Naming the key lets schema
   * validation reach the elements either way.
   */
  collection?: string;
}

export const ENDPOINTS: EndpointSpec[] = [
  // --- config & identity -------------------------------------------------
  {
    name: "config",
    group: "public",
    method: "GET",
    path: "/api/config",
    schema: "ConfigSchema",
    readOnly: true,
  },
  {
    name: "me",
    group: "identity",
    method: "GET",
    path: "/api/me",
    schema: "UserSchema",
    readOnly: true,
  },

  // --- workspaces --------------------------------------------------------
  {
    name: "list",
    group: "workspaces",
    method: "GET",
    path: "/api/workspaces",
    schema: "WorkspaceSchema",
    readOnly: true,
  },

  // --- issues ------------------------------------------------------------
  {
    name: "list",
    group: "issues",
    method: "GET",
    path: "/api/issues",
    schema: "IssueSchema",
    workspace: true,
    readOnly: true,
    collection: "issues",
  },
  {
    name: "detail",
    group: "issues",
    method: "GET",
    path: "/api/issues/{issue}",
    schema: "IssueSchema",
    workspace: true,
    readOnly: true,
  },
  {
    name: "comments",
    group: "issues",
    method: "GET",
    path: "/api/issues/{issue}/comments",
    schema: "CommentSchema",
    workspace: true,
    readOnly: true,
  },

  // --- people & agents ---------------------------------------------------
  {
    name: "members",
    group: "workspace",
    method: "GET",
    path: "/api/workspaces/{workspace}/members",
    schema: "MemberSchema",
    workspace: true,
    readOnly: true,
  },
  {
    name: "agents",
    group: "agents",
    method: "GET",
    path: "/api/agents",
    schema: "AgentSchema",
    workspace: true,
    readOnly: true,
  },
  {
    name: "projects",
    group: "projects",
    method: "GET",
    path: "/api/projects",
    schema: "ProjectSchema",
    workspace: true,
    readOnly: true,
  },
  {
    name: "labels",
    group: "labels",
    method: "GET",
    path: "/api/labels",
    schema: "LabelSchema",
    workspace: true,
    readOnly: true,
    collection: "labels",
  },
];
