/**
 * Conformance runner.
 *
 * Replays recorded fixtures against any base URL and checks three things,
 * in increasing strictness:
 *
 *   1. status matches
 *   2. the response satisfies its zod schema from `@multica/core/api/schemas`
 *      — the same schema the real clients parse with
 *   3. the normalized body is structurally identical to the fixture
 *
 * (3) is the strict gate; (2) is what actually protects a client. A run that
 * passes 1+2 but fails 3 is reported as DRIFT rather than FAIL: the contract
 * still holds for consumers, but the shape moved and the fixture is stale.
 *
 *   CONTRACT_API_BASE=http://localhost:8080 pnpm --filter @multica/contract verify
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ZodType } from "zod";

import * as schemas from "@multica/core/api/schemas";

import { ENDPOINTS, type EndpointSpec } from "../endpoints.ts";
import { API_BASE, WORKSPACE_SLUG, call, login } from "../client.ts";
import { discover, fill, items, type Bindings } from "../bindings.ts";
import { firstDiff, normalize } from "../normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "fixtures");

type Verdict = "pass" | "drift" | "fail" | "skip";

interface Outcome {
  verdict: Verdict;
  label: string;
  detail?: string;
}

function schemaFor(name: string | null): ZodType | null {
  if (!name) return null;
  const found = (schemas as Record<string, unknown>)[name];
  return found && typeof (found as ZodType).safeParse === "function" ? (found as ZodType) : null;
}

/**
 * Apply a schema to a response that may be a bare list. Upstream list
 * endpoints return arrays of the element type, so a schema named for the
 * element is checked element-wise.
 */
function validate(schema: ZodType, body: unknown, collection?: string): string | null {
  const listed = items(body, collection);
  const isList = Array.isArray(body) || (collection !== undefined && listed.length > 0);
  const subjects = isList ? listed : [body];
  for (const [index, subject] of subjects.entries()) {
    const parsed = schema.safeParse(subject);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = isList ? `[${index}]` : "";
      return `${where}${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`;
    }
  }
  return null;
}

async function verifyOne(spec: EndpointSpec, token: string, bindings: Bindings): Promise<Outcome> {
  const label = `${spec.group}/${spec.name}`;
  const file = resolve(FIXTURE_DIR, spec.group, `${spec.name}.json`);

  let fixture: {
    schema: string | null;
    response: { status: number; body: unknown };
  };
  try {
    fixture = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { verdict: "skip", label, detail: "no fixture recorded" };
  }

  const path = fill(spec.path, bindings);
  if (!path) return { verdict: "skip", label, detail: "unbound template" };

  const result = await call(spec.method, path, { token, workspace: spec.workspace, body: spec.body });

  if (result.status !== fixture.response.status) {
    return {
      verdict: "fail",
      label,
      detail: `status ${result.status}, expected ${fixture.response.status}`,
    };
  }

  const schema = schemaFor(fixture.schema);
  if (schema) {
    const invalid = validate(schema, result.body, spec.collection);
    if (invalid) return { verdict: "fail", label, detail: `schema ${fixture.schema}${invalid}` };
  }

  const { value } = normalize(result.body);
  const diff = firstDiff(fixture.response.body, value);
  if (diff) return { verdict: "drift", label, detail: diff };

  return { verdict: "pass", label };
}

async function main() {
  const email = process.env.CONTRACT_EMAIL;
  if (!email) throw new Error("CONTRACT_EMAIL must name a user on the target instance");

  const recorded = await readdir(FIXTURE_DIR).catch(() => []);
  if (!recorded.length) throw new Error("no fixtures — run `record` against the reference server first");

  console.log(`verifying ${API_BASE} (workspace ${WORKSPACE_SLUG})`);
  const token = await login(email);
  const bindings = await discover(token);

  const outcomes: Outcome[] = [];
  for (const spec of ENDPOINTS) outcomes.push(await verifyOne(spec, token, bindings));

  const tally = (v: Verdict) => outcomes.filter((o) => o.verdict === v).length;
  for (const o of outcomes) {
    const mark = { pass: "ok  ", drift: "DRIFT", fail: "FAIL", skip: "skip" }[o.verdict];
    console.log(`  ${mark} ${o.label}${o.detail ? ` — ${o.detail}` : ""}`);
  }

  console.log(
    `\n${tally("pass")} pass, ${tally("drift")} drift, ${tally("fail")} fail, ${tally("skip")} skip`,
  );
  // Drift is not a failure of the implementation, but it must not pass silently.
  process.exit(tally("fail") > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
