// Output writers: JSON (full fidelity) and CSV (flattened rows).

import fs from "node:fs";
import path from "node:path";
import type { Row } from "./types.js";

export const CSV_COLUMNS = [
  "object_type",
  "domain",
  "scope",
  "account_name",
  "zone_name",
  "object_id",
  "object_name",
  "created_at",
  "created_by",
  "modified_at",
  "modified_by",
  "modified_by_source",
  "notes",
] as const;

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[]): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape((row as unknown as Record<string, unknown>)[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function writeReports(
  outDir: string,
  baseName: string,
  payload: { rows: Row[] } & Record<string, unknown>,
  opts: { json: boolean; csv: boolean },
): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  if (opts.json) {
    const p = path.join(outDir, `${baseName}.json`);
    fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`);
    written.push(p);
  }
  if (opts.csv) {
    const p = path.join(outDir, `${baseName}.csv`);
    fs.writeFileSync(p, toCsv(payload.rows));
    written.push(p);
  }
  return written;
}
