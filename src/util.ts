// Shared helpers: timestamp extraction, name/attribution picking, small utilities.

export const MODIFIED_KEYS = [
  "modified_on",
  "last_updated",
  "updated_at",
  "modified_at",
  "updated_on",
  "last_modified",
  "modified",
];

export const CREATED_KEYS = [
  "created_on",
  "created_at",
  "created",
  "creation_date",
  "uploaded_on",
  "published_on",
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  return !Number.isNaN(new Date(v.replace(" ", "T")).getTime());
}

/**
 * Generically extract created/modified timestamps from an API object.
 * Cloudflare products do not use one consistent field name, so scan top-level
 * keys for known timestamp fields instead of hardcoding per product.
 */
export function extractTimestamps(obj: unknown): { modified: string | null; created: string | null } {
  let modified: string | null = null;
  let created: string | null = null;
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!isIsoDate(v)) continue;
      if (MODIFIED_KEYS.includes(k)) modified ??= v;
      else if (CREATED_KEYS.includes(k)) created ??= v;
    }
  }
  return { modified, created };
}

const NAME_KEYS = [
  "name",
  "title",
  "hostname",
  "domain",
  "queue_name",
  "widget_name",
  "slug",
  "username",
  "identifier",
];

export function pickName(obj: unknown, fallbackId: string): string {
  if (obj && typeof obj === "object") {
    for (const k of NAME_KEYS) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  return fallbackId;
}

export function pickBys(obj: unknown): { createdBy: string | null; modifiedBy: string | null } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  return {
    createdBy: str(o.created_by),
    modifiedBy: str(o.modified_by) ?? str(o.updated_by),
  };
}

/** Parse human-friendly recency values: 90m, 24h, 30d, 6w, 12mo, or an ISO date. */
export function parseSince(s: string): Date {
  const m = /^(\d+)\s*(h|d|w|mo)$/i.exec(s.trim());
  if (m) {
    const n = Number.parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : unit === "w" ? 7 * 86_400_000 : 30 * 86_400_000;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid --since value: ${s} (use e.g. 30d, 6mo, or 2025-01-01)`);
  }
  return d;
}

export function trunc(v: unknown, n: number): string {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function appendNote(note: string | null | undefined, extra: string | null | undefined): string | null {
  const a = note?.trim();
  const b = extra?.trim();
  if (a && b) return `${a}; ${b}`;
  return a || b || null;
}

export function fmtShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Run async work over items with bounded concurrency. fn must not reject. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
