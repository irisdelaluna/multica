/**
 * Fixture recorder.
 *
 * Drives a running reference implementation (the Go server) through the
 * curated endpoint inventory and writes normalized golden fixtures. The Go
 * server IS the contract by definition — when upstream changes a response,
 * you re-record and the diff shows exactly what moved.
 *
 *   pnpm --filter @multica/contract record
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ENDPOINTS, type EndpointSpec } from "../endpoints.ts";
import { API_BASE, WORKSPACE_SLUG, call, login } from "../client.ts";
import { discover, fill, type Bindings } from "../bindings.ts";
import { normalize } from "../normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "fixtures");

async function record(spec: EndpointSpec, token: string, bindings: Bindings) {
  const path = fill(spec.path, bindings);
  if (!path) {
    console.warn(`  skip ${spec.group}/${spec.name}: unbound template ${spec.path}`);
    return false;
  }

  const result = await call(spec.method, path, {
    token,
    workspace: spec.workspace,
    body: spec.body,
  });
  const { value, counts } = normalize(result.body);

  const fixture = {
    request: { method: spec.method, path: spec.path, workspace: spec.workspace ?? false },
    schema: spec.schema,
    response: { status: result.status, body: value },
    normalized: counts,
  };

  const file = resolve(FIXTURE_DIR, spec.group, `${spec.name}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`  ${result.status} ${spec.method} ${path} -> ${spec.group}/${spec.name}.json`);
  return true;
}

async function main() {
  const email = process.env.CONTRACT_EMAIL;
  if (!email) throw new Error("CONTRACT_EMAIL must name a user on the target instance");

  console.log(`recording against ${API_BASE} (workspace ${WORKSPACE_SLUG})`);
  const token = await login(email);
  const bindings: Bindings = await discover(token);
  const missing = ["workspace", "issue"].filter((k) => !bindings[k]);
  if (missing.length) console.warn(`unbound: ${missing.join(", ")} — dependent fixtures will be skipped`);

  let written = 0;
  for (const spec of ENDPOINTS) {
    if (await record(spec, token, bindings)) written++;
  }
  console.log(`\n${written}/${ENDPOINTS.length} fixtures written to contract/fixtures/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
