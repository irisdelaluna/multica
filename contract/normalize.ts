/**
 * Volatile-field normalization.
 *
 * A fixture is only useful if replaying it tomorrow, against a different
 * database, still compares equal. Identifiers and timestamps differ every
 * run and carry no contract information — what matters is that a field IS a
 * uuid, or IS an RFC3339 timestamp, in that position. So we replace those
 * values with stable placeholders and compare the normalized shapes.
 *
 * Placeholders are per-value-stable within one document: the same uuid seen
 * twice normalizes to the same `<uuid:1>`, so referential structure (this
 * comment's issue_id equals that issue's id) survives normalization and is
 * still checked.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Bearer tokens, PATs, daemon tokens: anything that would rot a fixture and
// should never be committed to the repo in the first place.
const SECRET_RE = /^(mul_|mcn_|mdt_|ey[A-Za-z0-9_-]+\.)/;

export interface NormalizeResult {
  value: unknown;
  /** Count of each placeholder class, useful for a quick fixture summary. */
  counts: Record<string, number>;
}

export function normalize(input: unknown): NormalizeResult {
  const uuids = new Map<string, string>();
  const counts: Record<string, number> = {};

  const bump = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      // Sort keys so fixture diffs are stable regardless of server field order.
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = walk((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    if (typeof value !== "string") return value;

    if (UUID_RE.test(value)) {
      let placeholder = uuids.get(value);
      if (!placeholder) {
        placeholder = `<uuid:${uuids.size + 1}>`;
        uuids.set(value, placeholder);
      }
      bump("uuid");
      return placeholder;
    }
    if (RFC3339_RE.test(value)) {
      bump("timestamp");
      return "<timestamp>";
    }
    if (SECRET_RE.test(value)) {
      bump("secret");
      return "<secret>";
    }
    return value;
  };

  return { value: walk(input), counts };
}

/** Deep structural equality over already-normalized documents. */
export function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * First differing path between two normalized documents, for a review-legible
 * failure message. Returns null when equal.
 */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (equal(a, b)) return null;

  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  if (typeOf(a) !== typeOf(b)) return `${path}: ${typeOf(a)} vs ${typeOf(b)}`;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const diff = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    const onlyA = ka.filter((k) => !kb.includes(k));
    const onlyB = kb.filter((k) => !ka.includes(k));
    if (onlyA.length) return `${path}: missing key "${onlyA[0]}"`;
    if (onlyB.length) return `${path}: unexpected key "${onlyB[0]}"`;
    for (const key of ka) {
      const diff = firstDiff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }

  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
