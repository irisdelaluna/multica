/**
 * Minimal API driver shared by the recorder and the conformance runner.
 *
 * Deliberately raw fetch, like `e2e/fixtures.ts`: the harness must be able to
 * point at ANY implementation of the contract — the Go server today, a
 * Haskell service later — so it cannot depend on the TypeScript client.
 */

import "dotenv/config";

export const API_BASE =
  process.env.CONTRACT_API_BASE ||
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.BACKEND_PORT || "8080"}`;

export const WORKSPACE_SLUG = process.env.CONTRACT_WORKSPACE || "iris";

export interface CallResult {
  status: number;
  body: unknown;
}

export async function call(
  method: string,
  path: string,
  opts: { token?: string; workspace?: boolean; body?: unknown } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.workspace) headers["X-Workspace-Slug"] = WORKSPACE_SLUG;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body IS contract information — keep it verbatim rather
      // than throwing, so the fixture records what actually came back.
      body = { __raw: text };
    }
  }
  return { status: res.status, body };
}

/**
 * Obtain a bearer token for the target instance.
 *
 * Prefers CONTRACT_TOKEN (a personal access token). The harness is meant to
 * run repeatedly — on every upstream merge, against every candidate
 * implementation — and the email-code flow is rate limited, so driving it on
 * each run both fails and is the wrong dependency: a future non-Go
 * implementation must be verifiable without reimplementing code delivery.
 *
 * Falls back to the fixed dev verification code
 * (MULTICA_DEV_VERIFICATION_CODE) for a local dev server with no PAT to hand.
 */
export async function login(email: string): Promise<string> {
  const pat = process.env.CONTRACT_TOKEN;
  if (pat) return pat;

  const devCode = process.env.MULTICA_DEV_VERIFICATION_CODE;
  if (!devCode) {
    throw new Error(
      "MULTICA_DEV_VERIFICATION_CODE is not set — the recorder needs a local dev server with a fixed login code.",
    );
  }

  const sent = await call("POST", "/auth/send-code", { body: { email } });
  if (sent.status !== 200) {
    throw new Error(`send-code failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  }

  const verified = await call("POST", "/auth/verify-code", { body: { email, code: devCode } });
  const token = (verified.body as { token?: string } | null)?.token;
  if (verified.status !== 200 || !token) {
    throw new Error(`verify-code failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return token;
}
